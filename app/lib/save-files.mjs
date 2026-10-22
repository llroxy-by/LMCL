import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import { once } from 'node:events';
import yauzl from 'yauzl';

export const MANIFEST_ENTRY = 'lmcl-save-manifest.json';
export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 20_000,
  maxTotalSize: 2 * 1024 * 1024 * 1024,
  maxFileSize: 256 * 1024 * 1024,
  maxPathLength: 1024,
  maxCompressionRatio: 200,
  maxManifestSize: 8 * 1024 * 1024,
});

function limitsWith(overrides = {}) {
  const result = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`无效的存档限制：${key}`);
  }
  return result;
}

function safeRelative(value, maxPathLength = DEFAULT_LIMITS.maxPathLength) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) throw new Error('存档包含非法路径');
  if (Buffer.byteLength(value, 'utf8') > maxPathLength || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) throw new Error('存档路径过长或为绝对路径');
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('存档包含路径穿越');
  }
  return normalized;
}

function excluded(parts) {
  return parts.some(part => part === 'session.lock' || part === 'logs' || part === 'crash-reports');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crcUpdate(crc, bytes) {
  let c = crc;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

async function digestFile(file) {
  const sha = createHash('sha256');
  let crc = 0xffffffff;
  for await (const chunk of createReadStream(file)) { sha.update(chunk); crc = crcUpdate(crc, chunk); }
  return { sha256: sha.digest('hex'), crc32: (crc ^ 0xffffffff) >>> 0 };
}

/** Scan a world without following symlinks. Volatile Minecraft files are omitted. */
export async function scanWorld(worldDir, options = {}) {
  const limits = limitsWith(options.limits);
  const root = path.resolve(worldDir);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('世界存档目录无效');
  const files = [];
  let totalSize = 0;
  async function walk(directory, parts) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const nextParts = [...parts, entry.name];
      if (excluded(nextParts)) continue;
      const relative = safeRelative(nextParts.join('/'), limits.maxPathLength);
      const absolute = path.join(root, ...nextParts);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) { await walk(absolute, nextParts); continue; }
      if (!info.isFile()) continue;
      if (files.length + 1 > limits.maxFiles) throw new Error('存档文件数超出限制');
      if (info.size > limits.maxFileSize) throw new Error(`存档单文件过大：${relative}`);
      totalSize += info.size;
      if (totalSize > limits.maxTotalSize) throw new Error('存档总大小超出限制');
      const digest = await digestFile(absolute);
      const after = await lstat(absolute);
      if (!after.isFile() || after.isSymbolicLink() || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error(`扫描期间文件发生变化：${relative}`);
      files.push({ path: relative, size: info.size, sha256: digest.sha256, crc32: digest.crc32 });
    }
  }
  await walk(root, []);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { version: 1, algorithm: 'sha256', files, totalSize };
}

function u16(value) { const b = Buffer.allocUnsafe(2); b.writeUInt16LE(value); return b; }
function u32(value) { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(value >>> 0); return b; }
async function outputWrite(stream, bytes) {
  if (!stream.write(bytes)) await once(stream, 'drain');
}

async function nodeArchive({ worldDir, archivePath, manifest }) {
  await mkdir(path.dirname(path.resolve(archivePath)), { recursive: true });
  const temporary = `${archivePath}.${randomUUID()}.tmp`;
  const output = createWriteStream(temporary, { flags: 'wx' });
  const central = [];
  let offset = 0;
  async function add(name, size, crc32, source) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x800), u16(0), u16(0), u16(0), u32(crc32), u32(size), u32(size), u16(nameBytes.length), u16(0), nameBytes]);
    const localOffset = offset;
    await outputWrite(output, local); offset += local.length;
    if (Buffer.isBuffer(source)) { await outputWrite(output, source); offset += source.length; }
    else for await (const chunk of createReadStream(source)) { await outputWrite(output, chunk); offset += chunk.length; }
    const header = Buffer.concat([u32(0x02014b50), u16(0x0314), u16(20), u16(0x800), u16(0), u16(0), u16(0), u32(crc32), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(localOffset), nameBytes]);
    central.push(header);
  }
  try {
    const publicManifest = { ...manifest, files: manifest.files.map(({ crc32, ...file }) => file) };
    const manifestBytes = Buffer.from(JSON.stringify(publicManifest));
    let crc = 0xffffffff; crc = (crcUpdate(crc, manifestBytes) ^ 0xffffffff) >>> 0;
    await add(MANIFEST_ENTRY, manifestBytes.length, crc, manifestBytes);
    for (const file of manifest.files) await add(`world/${file.path}`, file.size, file.crc32, path.join(worldDir, ...file.path.split('/')));
    const centralOffset = offset;
    for (const header of central) { await outputWrite(output, header); offset += header.length; }
    const centralSize = offset - centralOffset;
    if (central.length > 0xffff || offset > 0xffffffff) throw new Error('存档过大，无法使用标准 ZIP');
    await outputWrite(output, Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(centralSize), u32(centralOffset), u16(0)]));
    output.end(); await once(output, 'close');
    await rename(temporary, archivePath);
  } catch (error) {
    output.destroy(); await rm(temporary, { force: true }); throw error;
  }
}

export async function createSaveArchive({ worldDir, archivePath, gameLocked = false, limits, archiveAdapter } = {}) {
  if (gameLocked) throw new Error('游戏正在运行，拒绝归档存档');
  if (!worldDir || !archivePath) throw new TypeError('缺少世界目录或归档路径');
  const manifest = await scanWorld(worldDir, { limits });
  const args = { worldDir: path.resolve(worldDir), archivePath: path.resolve(archivePath), manifest, limits: limitsWith(limits) };
  if (archiveAdapter) {
    const create = archiveAdapter.createArchive ?? archiveAdapter.pack;
    if (typeof create !== 'function') throw new TypeError('archive adapter 必须提供 createArchive 或 pack');
    await create.call(archiveAdapter, args);
  } else await nodeArchive(args);
  return { ...manifest, files: manifest.files.map(({ crc32, ...file }) => file) };
}

function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip)));
}
function entryStream(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
}

async function extractZip(archivePath, stageRoot, limits) {
  const zip = await openZip(archivePath);
  let fileCount = 0, declaredTotal = 0, manifest = null;
  const seen = new Set();
  const extracted = [];
  try {
    await new Promise((resolve, reject) => {
      let stopped = false;
      const fail = error => { if (!stopped) { stopped = true; reject(error); } };
      zip.on('error', fail); zip.on('end', () => { if (!stopped) resolve(); });
      zip.on('entry', entry => (async () => {
        try {
          const name = safeRelative(entry.fileName, limits.maxPathLength + 6);
          if (seen.has(name)) throw new Error(`ZIP 包含重复路径：${name}`); seen.add(name);
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((unixMode & 0xf000) === 0xa000) throw new Error('ZIP 不允许符号链接');
          if (name.endsWith('/')) { zip.readEntry(); return; }
          if (entry.uncompressedSize > limits.maxFileSize && name !== MANIFEST_ENTRY) throw new Error('ZIP 单文件超出限制');
          if (entry.compressedSize === 0 ? entry.uncompressedSize > 0 : entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio) throw new Error('ZIP 压缩比超出限制');
          if (name === MANIFEST_ENTRY) {
            if (entry.uncompressedSize > limits.maxManifestSize) throw new Error('manifest 过大');
          } else {
            if (!name.startsWith('world/')) throw new Error('ZIP 包含未知顶层文件');
            if (++fileCount > limits.maxFiles) throw new Error('ZIP 文件数超出限制');
            declaredTotal += entry.uncompressedSize;
            if (declaredTotal > limits.maxTotalSize) throw new Error('ZIP 总大小超出限制');
          }
          const stream = await entryStream(zip, entry);
          if (name === MANIFEST_ENTRY) {
            const chunks = []; let bytes = 0;
            for await (const chunk of stream) { bytes += chunk.length; if (bytes > limits.maxManifestSize) throw new Error('manifest 过大'); chunks.push(chunk); }
            manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } else {
            const relative = safeRelative(name.slice(6), limits.maxPathLength);
            const destination = path.join(stageRoot, 'world', ...relative.split('/'));
            await mkdir(path.dirname(destination), { recursive: true });
            const handle = await open(destination, 'wx');
            const sha = createHash('sha256'); let bytes = 0;
            try {
              for await (const chunk of stream) { bytes += chunk.length; if (bytes > limits.maxFileSize || declaredTotal - entry.uncompressedSize + bytes > limits.maxTotalSize) throw new Error('解压数据超出限制'); sha.update(chunk); await handle.write(chunk); }
            } finally { await handle.close(); }
            if (bytes !== entry.uncompressedSize) throw new Error('ZIP 文件大小不匹配');
            extracted.push({ path: relative, size: bytes, sha256: sha.digest('hex') });
          }
          zip.readEntry();
        } catch (error) { fail(error); }
      })());
      zip.readEntry();
    });
  } finally { zip.close(); }
  return { manifest, extracted };
}

function validateManifest(manifest, extracted, limits) {
  if (!manifest || manifest.version !== 1 || manifest.algorithm !== 'sha256' || !Array.isArray(manifest.files)) throw new Error('存档 manifest 无效或缺失');
  if (manifest.files.length > limits.maxFiles || manifest.files.length !== extracted.length) throw new Error('存档 manifest 文件数不匹配');
  const expected = new Map(); let total = 0;
  for (const file of manifest.files) {
    const relative = safeRelative(file?.path, limits.maxPathLength);
    if (expected.has(relative) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > limits.maxFileSize || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('存档 manifest 条目无效');
    total += file.size; if (total > limits.maxTotalSize) throw new Error('存档 manifest 总大小超出限制');
    expected.set(relative, file);
  }
  if (manifest.totalSize !== total) throw new Error('存档 manifest 总大小不匹配');
  for (const actual of extracted) {
    const wanted = expected.get(actual.path);
    if (!wanted || wanted.size !== actual.size || wanted.sha256 !== actual.sha256) throw new Error(`存档校验失败：${actual.path}`);
  }
}

/** Restore through a same-parent staging directory, retaining the previous world as a backup. */
export async function restoreSaveArchive({ archivePath, worldDir, gameLocked = false, limits, fileOps = {} } = {}) {
  if (gameLocked) throw new Error('游戏正在运行，拒绝恢复存档');
  if (!archivePath || !worldDir) throw new TypeError('缺少归档路径或世界目录');
  const bounded = limitsWith(limits);
  const destination = path.resolve(worldDir), parent = path.dirname(destination), name = path.basename(destination);
  await mkdir(parent, { recursive: true });
  const token = randomUUID();
  const stage = path.join(parent, `.${name}.restore-${token}`);
  const backup = path.join(parent, `.${name}.backup-${token}`);
  const move = fileOps.rename ?? rename;
  await mkdir(path.join(stage, 'world'), { recursive: true });
  let oldMoved = false;
  try {
    const result = await extractZip(path.resolve(archivePath), stage, bounded);
    validateManifest(result.manifest, result.extracted, bounded);
    const existing = await lstat(destination).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) { await move(destination, backup); oldMoved = true; }
    try { await move(path.join(stage, 'world'), destination); }
    catch (error) {
      if (oldMoved) await move(backup, destination).catch(rollback => { error.rollbackError = rollback; });
      throw error;
    }
    await rm(stage, { recursive: true, force: true });
    return { worldDir: destination, backupPath: oldMoved ? backup : null, manifest: result.manifest };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export const packSave = createSaveArchive;
export const restoreSave = restoreSaveArchive;
