import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { portablePath } from '../../core/src/sync-plan.mjs';

function abort(signal) {
  signal?.throwIfAborted();
}

function relativePath(value) {
  if (typeof value !== 'string' || !value) throw new Error('加载器安装路径无效');
  portablePath(value);
  return value;
}

function planParts(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('加载器安装计划无效');
  const candidate = plan.versionJson ?? plan.metadata ?? plan.profile ?? plan.version?.json;
  const metadata = candidate && typeof candidate === 'object' && !Array.isArray(candidate) && !candidate.url
    ? candidate : (plan.version && typeof plan.version === 'object' && plan.version.id ? plan.version : undefined);
  const versionId = plan.versionId ?? plan.targetVersion ?? plan.id ?? metadata?.id ?? plan.version?.id;
  if (typeof versionId !== 'string' || !versionId || metadata?.id !== versionId) {
    throw new Error('加载器版本 JSON 与安装版本不匹配');
  }
  relativePath(versionId);
  if (versionId.includes('/')) throw new Error('加载器版本 ID 无效');

  const input = plan.libraries ?? plan.files ?? plan.downloads ?? [];
  if (!Array.isArray(input)) throw new Error('加载器库文件清单无效');
  const libraries = input.map((file) => {
    if (!file || typeof file !== 'object') throw new Error('加载器库文件清单无效');
    let libraryPath = file.path ?? file.relativePath ?? file.destination;
    libraryPath = relativePath(libraryPath);
    if (libraryPath.startsWith('libraries/')) libraryPath = libraryPath.slice('libraries/'.length);
    libraryPath = relativePath(libraryPath);
    if (!libraryPath || libraryPath.startsWith('versions/')) throw new Error('加载器库文件路径无效');
    const sha1 = file.sha1 ?? file.hashes?.sha1;
    const sha256 = file.sha256 ?? file.hashes?.sha256;
    if (sha1 !== undefined && !/^[a-f0-9]{40}$/i.test(sha1)) throw new Error('SHA-1 校验值无效');
    if (sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('SHA-256 校验值无效');
    if (!sha1 && !sha256) throw new Error('库文件缺少完整性哈希');
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 2 ** 31) throw new Error('库文件大小无效');
    return { ...file, path: libraryPath, sha1: sha1?.toLowerCase(), sha256: sha256?.toLowerCase() };
  });
  const duplicates = new Set();
  for (const file of libraries) {
    const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
    if (duplicates.has(key)) throw new Error(`加载器计划包含重复路径：${file.path}`);
    duplicates.add(key);
  }
  return { versionId, metadata, libraries };
}

async function directory(root, relative = '') {
  let current = root;
  const rootInfo = await lstat(root).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!rootInfo) await mkdir(root, { recursive: true });
  else if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('安装目录不能是符号链接');
  for (const part of relative ? relative.split('/') : []) {
    current = path.join(current, part);
    const info = await lstat(current).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) await mkdir(current);
    else if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`安装路径包含符号链接或非目录：${relative}`);
  }
  return current;
}

async function safeTarget(root, relative) {
  relativePath(relative);
  const parts = relative.split('/');
  const parent = await directory(root, parts.slice(0, -1).join('/'));
  const target = path.join(parent, parts.at(-1));
  const info = await lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (info?.isSymbolicLink() || info?.isDirectory()) throw new Error(`拒绝覆盖符号链接或目录：${relative}`);
  return target;
}

async function integrity(filename, file) {
  const hashes = {};
  if (file.sha1) hashes.sha1 = createHash('sha1');
  if (file.sha256) hashes.sha256 = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(filename)) {
    size += chunk.length;
    for (const hash of Object.values(hashes)) hash.update(chunk);
  }
  if (size !== file.size) throw new Error(`库文件大小校验失败：${file.path}`);
  for (const [name, hash] of Object.entries(hashes)) {
    if (hash.digest('hex') !== file[name]) throw new Error(`${name.toUpperCase()} 校验失败：${file.path}`);
  }
}

async function saveDownloaderResult(result, destination) {
  if (result === undefined || result === null) return;
  if (Buffer.isBuffer(result) || result instanceof Uint8Array) {
    const handle = await open(destination, 'wx');
    try { await handle.writeFile(result); } finally { await handle.close(); }
    return;
  }
  const body = result.body ?? result;
  const stream = typeof body?.getReader === 'function' ? Readable.fromWeb(body) : body;
  if (!stream || typeof stream.pipe !== 'function') throw new Error('下载器返回值无效');
  await pipeline(stream, createWriteStream(destination, { flags: 'wx' }));
}

async function moveWithBackup(source, destination, backupRoot, relative, changes) {
  const existing = await lstat(destination).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  let backup;
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`拒绝覆盖符号链接或非文件：${relative}`);
    backup = await safeTarget(backupRoot, relative);
    await rename(destination, backup);
  }
  try {
    await rename(source, destination);
    changes.push({ destination, backup });
  } catch (error) {
    if (backup) await rename(backup, destination).catch(() => {});
    throw error;
  }
}

/** Execute a validated loader-install-plan using an injected, non-network-specific downloader. */
export async function installLoader({ plan, gamesRoot, root, downloader, signal, onProgress = () => {} }) {
  const installRoot = gamesRoot ?? root;
  if (typeof installRoot !== 'string' || !installRoot) throw new Error('游戏目录无效');
  if (typeof downloader !== 'function') throw new Error('必须注入下载器');
  abort(signal);
  const { versionId, metadata, libraries } = planParts(plan);
  const transactionRoot = path.join(installRoot, `.loader-installing-${randomUUID()}`);
  const stageRoot = path.join(transactionRoot, 'stage');
  const backupRoot = path.join(transactionRoot, 'backup');
  const changes = [];
  await directory(installRoot);
  await directory(transactionRoot);
  await directory(stageRoot);
  await directory(backupRoot);
  try {
    onProgress({ phase: 'staging', done: 0, total: libraries.length });
    for (let index = 0; index < libraries.length; index++) {
      abort(signal);
      const file = libraries[index];
      const destination = await safeTarget(stageRoot, `libraries/${file.path}`);
      const result = await downloader(file, destination, signal, progress => onProgress({
        phase: 'download', done: index, total: libraries.length, file: file.path, ...progress,
      }));
      await saveDownloaderResult(result, destination);
      abort(signal);
      const info = await lstat(destination).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`下载器未生成普通文件：${file.path}`);
      await integrity(destination, file);
      onProgress({ phase: 'download', done: index + 1, total: libraries.length, file: file.path });
    }
    abort(signal);
    const stagedJSON = await safeTarget(stageRoot, `versions/${versionId}/${versionId}.json`);
    const jsonHandle = await open(stagedJSON, 'wx');
    try { await jsonHandle.writeFile(JSON.stringify(metadata)); } finally { await jsonHandle.close(); }

    onProgress({ phase: 'commit', done: 0, total: libraries.length + 1 });
    for (let index = 0; index < libraries.length; index++) {
      abort(signal);
      const file = libraries[index];
      const source = path.join(stageRoot, 'libraries', ...file.path.split('/'));
      const destination = await safeTarget(installRoot, `libraries/${file.path}`);
      await moveWithBackup(source, destination, backupRoot, `libraries/${file.path}`, changes);
      onProgress({ phase: 'commit', done: index + 1, total: libraries.length + 1, file: file.path });
    }
    abort(signal);
    const jsonDestination = await safeTarget(installRoot, `versions/${versionId}/${versionId}.json`);
    await moveWithBackup(stagedJSON, jsonDestination, backupRoot, `versions/${versionId}/${versionId}.json`, changes);
    onProgress({ phase: 'commit', done: libraries.length + 1, total: libraries.length + 1 });
    await rm(transactionRoot, { recursive: true, force: true });
    return { versionId, metadata, libraries: libraries.length };
  } catch (error) {
    for (const change of changes.reverse()) {
      await rm(change.destination, { force: true }).catch(() => {});
      if (change.backup) await rename(change.backup, change.destination).catch(() => {});
    }
    await rm(transactionRoot, { recursive: true, force: true });
    throw error;
  }
}

export const executeLoaderInstall = installLoader;
