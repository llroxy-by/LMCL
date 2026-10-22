import path from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { contentKind, contentPath, contentFileName, installsAsInstance } from '../../core/src/content.mjs';
import { mirrorURL, resolveSources, recordFailure, recordSuccess } from '../../core/src/download-source.mjs';
import { transfer } from './transfer.mjs';

function candidateURLs(file, { mode, mirrorBase, health }) {
  const official = typeof file.url === 'string' ? file.url : '';
  if (!/^https:\/\//.test(official)) throw new Error('下载地址无效');
  const mirrored = mirrorBase ? mirrorURL(official, mirrorBase) : null;
  const order = resolveSources({ mode, channel: 'content', mirrorBase: mirrored ? mirrorBase : null, health });
  const urls = order.map(name => (name === 'mirror' ? mirrored : official)).filter(Boolean);
  if (mirrored && !urls.includes(mirrored)) urls.push(mirrored);
  return { urls, mirrored: Boolean(mirrored) };
}

/** 把单个内容文件装进实例对应目录，带源回退与哈希校验。 */
export async function installContentFile({ kind, instanceRoot, file, mode = 'auto', mirrorBase = '',
  health = new Map(), signal, onProgress }) {
  contentKind(kind);
  if (installsAsInstance(kind)) throw new Error('整合包不能按文件安装');
  if (typeof instanceRoot !== 'string' || !instanceRoot) throw new Error('请先选择目标实例');
  const fileName = contentFileName(file.fileName, kind);
  const destination = path.join(instanceRoot, contentPath(kind, fileName));
  const { urls } = candidateURLs(file, { mode, mirrorBase, health });
  onProgress?.({ phase: `下载 ${fileName}`, done: 0, total: file.size || null });
  const result = await transfer({
    urls, destination, size: file.size || null, sha1: file.sha1 || null, sha512: file.sha512 || null,
    signal, onProgress: progress => onProgress?.({ phase: `下载 ${fileName}`, ...progress }),
  });
  if (result.index > 0) recordFailure(health, 'mirror'); else recordSuccess(health, 'mirror');
  return { path: destination, fileName, size: file.size || 0, fellBack: result.index > 0 };
}

/** 整合包先落到 dataRoot/modpacks，安装成实例留待后续版本。 */
export async function downloadModpack({ dataRoot, file, mode = 'auto', mirrorBase = '',
  health = new Map(), signal, onProgress }) {
  const fileName = contentFileName(file.fileName, 'modpack');
  const directory = path.join(dataRoot, 'modpacks');
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, fileName);
  const { urls } = candidateURLs(file, { mode, mirrorBase, health });
  onProgress?.({ phase: `下载 ${fileName}`, done: 0, total: file.size || null });
  const result = await transfer({
    urls, destination, size: file.size || null, sha1: file.sha1 || null, sha512: file.sha512 || null,
    signal, onProgress: progress => onProgress?.({ phase: `下载 ${fileName}`, ...progress }),
  });
  return { path: destination, fileName, size: file.size || 0, fellBack: result.index > 0 };
}

/** 从本地文件导入投影原理图或手动下载的整合包。 */
export async function importContent({ kind, instanceRoot, dataRoot, sourcePath }) {
  contentKind(kind);
  if (typeof sourcePath !== 'string' || !sourcePath) throw new Error('没有选择文件');
  const fileName = contentFileName(path.basename(sourcePath), kind);
  if (installsAsInstance(kind)) {
    const directory = path.join(dataRoot, 'modpacks');
    await mkdir(directory, { recursive: true });
    const destination = path.join(directory, fileName);
    await copyFile(sourcePath, destination);
    return { path: destination, fileName };
  }
  if (typeof instanceRoot !== 'string' || !instanceRoot) throw new Error('请先选择目标实例');
  const destination = path.join(instanceRoot, contentPath(kind, fileName));
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(sourcePath, destination);
  return { path: destination, fileName };
}

// 投影原理图没有公共目录，只能链接导入。限制大小，避免误点一个超大文件。
export const LINK_MAX_BYTES = 128 * 1024 * 1024;

export async function importFromLink({ kind, instanceRoot, url, fileName, signal, onProgress }) {
  contentKind(kind);
  if (installsAsInstance(kind)) throw new Error('整合包请使用目录或本地导入');
  if (typeof instanceRoot !== 'string' || !instanceRoot) throw new Error('请先选择目标实例');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('只支持 HTTPS 链接');
  if (parsed.username || parsed.password) throw new Error('链接不能包含账号密码');
  const name = contentFileName(fileName || decodeURIComponent(parsed.pathname.split('/').pop() || ''), kind);
  const destination = path.join(instanceRoot, contentPath(kind, name));
  onProgress?.({ phase: `下载 ${name}`, done: 0, total: null });
  await transfer({ urls: [parsed.href], destination, maxBytes: LINK_MAX_BYTES, signal,
    onProgress: progress => onProgress?.({ phase: `下载 ${name}`, ...progress }) });
  return { path: destination, fileName: name };
}
