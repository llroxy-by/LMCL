import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, rename, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { inside, libraryPlan } from './minecraft-rules.mjs';
import { getJSON, downloadQueue } from './network.mjs';

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
export async function versionCatalog(signal) {
  const catalog = await getJSON(MANIFEST, { signal, official: true });
  return catalog.versions.filter(v => ['release', 'snapshot'].includes(v.type) && v.complianceLevel === 1);
}

async function extractNatives(archive, destination) {
  const zip = await new Promise((resolve, reject) => yauzl.open(archive, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)));
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', entry => {
        if (!/\.(dll|so|dylib|jnilib)$/i.test(entry.fileName)) { zip.readEntry(); return; }
        if (entry.uncompressedSize > 128 * 1024 * 1024) { reject(new Error('原生库文件过大')); return; }
        let output;
        try {
          inside(destination, entry.fileName);
          output = inside(destination, path.posix.basename(entry.fileName));
        } catch (error) { reject(error); return; }
        zip.openReadStream(entry, async (error, stream) => {
          if (error) { reject(error); return; }
          try {
            await mkdir(path.dirname(output), { recursive: true });
            await pipeline(stream, createWriteStream(output));
            zip.readEntry();
          } catch (failure) { reject(failure); }
        });
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
}

export async function installVanilla({ version, name, gamesRoot, signal, onProgress }) {
  const id = randomUUID();
  const stage = path.join(gamesRoot, `${id}.installing`), root = path.join(gamesRoot, id);
  await mkdir(stage, { recursive: true });
  try {
    onProgress({ phase: '读取版本信息', done: 0, total: 0 });
    const catalog = await versionCatalog(signal);
    const selected = catalog.find(v => v.id === version);
    if (!selected) throw new Error('未找到支持的原版版本，请刷新版本列表');
    const metadata = await getJSON(selected.url, { signal, official: true, sha1: selected.sha1 });
    if (metadata.id !== version || !metadata.arguments || !metadata.downloads?.client) throw new Error('暂不支持该版本');
    const { artifacts, natives } = libraryPlan(metadata);
    const metadataPath = inside(stage, `versions/${version}/${version}.json`);
    await mkdir(path.dirname(metadataPath), { recursive: true });
    await writeFile(metadataPath, JSON.stringify(metadata));
    const assets = await getJSON(metadata.assetIndex.url, { signal, official: true, sha1: metadata.assetIndex.sha1 });
    if (assets.virtual || assets.map_to_resources) throw new Error('暂不支持旧版虚拟资源格式');
    const assetIndex = inside(stage, `assets/indexes/${metadata.assetIndex.id}.json`);
    await mkdir(path.dirname(assetIndex), { recursive: true });
    await writeFile(assetIndex, JSON.stringify(assets));
    const files = [{ ...metadata.downloads.client, destination: inside(stage, `versions/${version}/${version}.jar`) }];
    for (const library of [...artifacts, ...natives]) files.push({ ...library, destination: inside(stage, `libraries/${library.path}`) });
    if (metadata.logging?.client?.file) {
      const file = metadata.logging.client.file;
      files.push({ ...file, destination: inside(stage, `assets/log_configs/${file.id}`) });
    }
    for (const asset of Object.values(assets.objects ?? {})) {
      if (!/^[a-f0-9]{40}$/.test(asset.hash)) throw new Error('资源索引格式不正确');
      const relative = `${asset.hash.slice(0, 2)}/${asset.hash}`;
      files.push({ url: `https://resources.download.minecraft.net/${relative}`, sha1: asset.hash,
        size: asset.size, destination: inside(stage, `assets/objects/${relative}`) });
    }
    const unique = [...new Map(files.map(file => [file.destination, file])).values()];
    if (unique.length > 30000) throw new Error('版本文件数超出限制');
    let lastUpdate = 0;
    await downloadQueue(unique, signal, progress => {
      if (Date.now() - lastUpdate > 120 || progress.done === progress.total) {
        lastUpdate = Date.now(); onProgress({ phase: '下载并校验游戏文件', ...progress });
      }
    });
    signal.throwIfAborted();
    onProgress({ phase: '准备原生库', done: 0, total: 0 });
    await mkdir(path.join(stage, 'natives'), { recursive: true });
    for (const file of natives) {
      signal.throwIfAborted();
      await extractNatives(inside(stage, `libraries/${file.path}`), path.join(stage, 'natives'));
    }
    signal.throwIfAborted();
    await rename(stage, root);
    return { id, name: name.trim() || version, version, root, managed: true,
      javaMajor: metadata.javaVersion?.majorVersion ?? 8, installedAt: new Date().toISOString() };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function importDirectory(root) {
  const versions = await readdir(path.join(root, 'versions'), { withFileTypes: true }).catch(() => []);
  const instances = [];
  for (const entry of versions.filter(v => v.isDirectory()).slice(0, 500)) {
    try {
      const metadata = JSON.parse(await readFile(inside(root, `versions/${entry.name}/${entry.name}.json`), 'utf8'));
      if (metadata.id !== entry.name || metadata.inheritsFrom || !metadata.arguments) continue;
      instances.push({ id: randomUUID(), name: entry.name, version: entry.name, root,
        managed: false, javaMajor: metadata.javaVersion?.majorVersion ?? 8 });
    } catch { /* Skip unsupported or incomplete version folders. */ }
  }
  if (!instances.length) throw new Error('未找到支持的原版游戏，请选择包含 versions 文件夹的游戏目录（暂不支持加载器实例）');
  return instances;
}

export async function readMetadata(instance) {
  const file = inside(instance.root, `versions/${instance.version}/${instance.version}.json`);
  const metadata = JSON.parse(await readFile(file, 'utf8'));
  if (metadata.id !== instance.version) throw new Error('实例的版本信息不匹配');
  return metadata;
}

export { extractNatives };
