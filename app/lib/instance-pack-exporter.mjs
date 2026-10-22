import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { once } from 'node:events';

export const SERVER_PACK_MANIFEST = 'lmcl-server-pack.json';

const EXCLUDED_DIRS = new Set([
  'saves', 'screenshots', 'logs', 'crash-reports', '.lmcl', 'backups'
]);

const EXCLUDED_FILES = new Set([
  'session.lock', 'usernamecache.json', 'usercache.json', 'options.txt',
  'launcher_accounts.json', 'launcher_profiles.json', 'servers.dat'
]);

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
  for await (const chunk of createReadStream(file)) {
    sha.update(chunk);
    crc = crcUpdate(crc, chunk);
  }
  return { sha256: sha.digest('hex'), crc32: (crc ^ 0xffffffff) >>> 0 };
}

export function validateServerConnection(connection) {
  if (!connection || typeof connection !== 'object') {
    throw new TypeError('serverConnection 必须是一个对象');
  }
  const { host, port } = connection;
  if (typeof host !== 'string' || !host.trim() || host.length > 255 ||
      /[<>:"/\\|?*\p{Cc}\p{Cs}\s]/u.test(host)) {
    throw new TypeError('服务器 host 非法');
  }
  const p = Number(port);
  if (!Number.isSafeInteger(p) || p < 1 || p > 65535) {
    throw new TypeError('服务器 port 必须是 1 到 65535 之间的整数');
  }
  return { host: host.trim(), port: p };
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) {
    throw new Error('路径包含非法字符');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('路径包含跨级穿越');
  }
  return normalized;
}

export async function scanInstanceOverrides(instanceDir) {
  const root = path.resolve(instanceDir);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('实例目录无效');

  const files = [];
  let totalSize = 0;

  async function walk(directory, parts) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (parts.length === 0 && EXCLUDED_DIRS.has(entry.name)) continue;
      if (EXCLUDED_FILES.has(entry.name)) continue;

      const nextParts = [...parts, entry.name];
      const relative = safeRelative(nextParts.join('/'));
      const absolute = path.join(root, ...nextParts);
      const st = await lstat(absolute);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { await walk(absolute, nextParts); continue; }
      if (!st.isFile()) continue;

      totalSize += st.size;
      const digest = await digestFile(absolute);
      files.push({ path: relative, size: st.size, sha256: digest.sha256, crc32: digest.crc32 });
    }
  }

  await walk(root, []);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, totalSize };
}

function u16(value) { const b = Buffer.allocUnsafe(2); b.writeUInt16LE(value); return b; }
function u32(value) { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(value >>> 0); return b; }
async function outputWrite(stream, bytes) {
  if (!stream.write(bytes)) await once(stream, 'drain');
}

export async function exportServerPackArchive({ instanceDir, archivePath, packId, name, version, serverConnection }) {
  const verifiedConn = validateServerConnection(serverConnection);
  if (!packId || typeof packId !== 'string') throw new TypeError('缺少有效的 packId');
  if (!name || typeof name !== 'string') throw new TypeError('缺少有效的 name');

  const { files, totalSize } = await scanInstanceOverrides(instanceDir);
  const manifest = {
    schemaVersion: 1,
    type: 'server-pack',
    packId: packId.trim(),
    name: name.trim(),
    version: version || '1.0.0',
    serverConnection: verifiedConn,
    exportedAt: new Date().toISOString(),
    overrides: files.map(({ crc32, ...file }) => file),
    totalSize
  };

  await mkdir(path.dirname(path.resolve(archivePath)), { recursive: true });
  const temporary = `${archivePath}.${randomUUID()}.tmp`;
  const output = createWriteStream(temporary, { flags: 'wx' });
  const central = [];
  let offset = 0;

  async function add(nameStr, size, crc32, source) {
    const nameBytes = Buffer.from(nameStr);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x800), u16(0), u16(0), u16(0),
      u32(crc32), u32(size), u32(size), u16(nameBytes.length), u16(0), nameBytes
    ]);
    const localOffset = offset;
    await outputWrite(output, local);
    offset += local.length;

    if (Buffer.isBuffer(source)) {
      await outputWrite(output, source);
      offset += source.length;
    } else {
      for await (const chunk of createReadStream(source)) {
        await outputWrite(output, chunk);
        offset += chunk.length;
      }
    }

    const header = Buffer.concat([
      u32(0x02014b50), u16(0x0314), u16(20), u16(0x800), u16(0), u16(0), u16(0),
      u32(crc32), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0), u16(0),
      u16(0), u32(0), u32(localOffset), nameBytes
    ]);
    central.push(header);
  }

  try {
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
    let crc = 0xffffffff;
    crc = (crcUpdate(crc, manifestBytes) ^ 0xffffffff) >>> 0;
    await add(SERVER_PACK_MANIFEST, manifestBytes.length, crc, manifestBytes);

    for (const file of files) {
      await add(`overrides/${file.path}`, file.size, file.crc32, path.join(instanceDir, ...file.path.split('/')));
    }

    const centralOffset = offset;
    for (const header of central) {
      await outputWrite(output, header);
      offset += header.length;
    }
    const centralSize = offset - centralOffset;

    await outputWrite(output, Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
      u32(centralSize), u32(centralOffset), u16(0)
    ]));

    output.end();
    await once(output, 'close');
    await rename(temporary, archivePath);
    return manifest;
  } catch (error) {
    output.destroy();
    await rm(temporary, { force: true });
    throw error;
  }
}
