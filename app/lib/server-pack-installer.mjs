import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { SERVER_PACK_MANIFEST, validateServerConnection } from './instance-pack-exporter.mjs';

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (err, zip) => {
      if (err) return reject(err);
      resolve(zip);
    });
  });
}

function getStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      resolve(stream);
    });
  });
}

export function resolveInstanceServer(instanceMetadata) {
  if (!instanceMetadata?.serverConnection) return null;
  try {
    return validateServerConnection(instanceMetadata.serverConnection);
  } catch {
    return null;
  }
}

export async function installServerPack({ archivePath, targetInstanceDir, baseVersionId }) {
  const root = path.resolve(targetInstanceDir);
  await mkdir(root, { recursive: true });
  const staging = `${root}.${randomUUID()}.staging`;
  await mkdir(staging, { recursive: true });

  const zip = await openZip(archivePath);
  let manifest = null;

  try {
    await new Promise((resolve, reject) => {
      zip.on('entry', async entry => {
        try {
          if (entry.fileName.includes('\0') || entry.fileName.includes('\\') || entry.fileName.startsWith('/')) {
            throw new Error(`非法压缩包路径: ${entry.fileName}`);
          }
          if (entry.fileName === SERVER_PACK_MANIFEST) {
            const stream = await getStream(zip, entry);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
            return;
          }
          if (entry.fileName.startsWith('overrides/')) {
            const rel = path.posix.normalize(entry.fileName.slice('overrides/'.length));
            if (!rel || rel === '.' || rel.startsWith('../') || rel.includes('..')) {
              throw new Error(`非法 overrides 路径: ${entry.fileName}`);
            }
            if (!entry.fileName.endsWith('/')) {
              const dest = path.join(staging, ...rel.split('/'));
              await mkdir(path.dirname(dest), { recursive: true });
              const stream = await getStream(zip, entry);
              const out = createWriteStream(dest);
              await pipeline(stream, out);
            }
            zip.readEntry();
            return;
          }
          zip.readEntry();
        } catch (err) {
          reject(err);
        }
      });
      zip.on('end', resolve);
      zip.on('error', reject);
      zip.readEntry();
    });

    if (!manifest) throw new Error('整合包缺失有效的 lmcl-server-pack.json 清单');
    const serverConnection = validateServerConnection(manifest.serverConnection);

    // 将 staging 文件合并到目标实例目录
    async function copyTree(src, dest) {
      const entries = await readdir(src, { withFileTypes: true });
      for (const e of entries) {
        const s = path.join(src, e.name);
        const d = path.join(dest, e.name);
        if (e.isDirectory()) {
          await mkdir(d, { recursive: true });
          await copyTree(s, d);
        } else if (e.isFile()) {
          await mkdir(path.dirname(d), { recursive: true });
          await rename(s, d);
        }
      }
    }
    await copyTree(staging, root);

    // 写入 instance.json
    const instanceFile = path.join(root, 'instance.json');
    let existingMeta = {};
    try {
      existingMeta = JSON.parse(await readFile(instanceFile, 'utf8'));
    } catch {}

    const updatedMeta = {
      ...existingMeta,
      name: manifest.name || existingMeta.name || 'Server Instance',
      version: baseVersionId || existingMeta.version,
      serverConnection,
      serverPack: {
        packId: manifest.packId,
        version: manifest.version,
        installedAt: new Date().toISOString()
      }
    };
    await writeFile(instanceFile, JSON.stringify(updatedMeta, null, 2), 'utf8');

    return { ok: true, manifest, serverConnection };
  } finally {
    zip.close();
    await rm(staging, { recursive: true, force: true });
  }
}
