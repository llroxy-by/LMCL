import http from 'node:http';
import path from 'node:path';
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || '/data/mango-storage');
const SECRET = process.env.STORAGE_SECRET || 'mango_storage_hmac_secret_key_2026';
const PORT = Number(process.env.PORT || 9005);
const HOST = process.env.HOST || '127.0.0.1';

function verifySignature(method, pathStr, timestamp, signature) {
  if (!signature || !timestamp) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > 300) return false; // 5分钟有效

  const payload = `${method.toUpperCase()}\n${pathStr}\n${ts}`;
  const expected = createHmac('sha256', SECRET).update(payload).digest('hex');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function safePath(key) {
  const norm = path.posix.normalize(key);
  if (norm !== key || norm.startsWith('/') || norm.startsWith('../') || norm.includes('..')) {
    throw new Error('Unsafe object key');
  }
  return path.join(STORAGE_ROOT, ...norm.split('/'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const objKey = url.pathname.slice(1);
  const sig = req.headers['x-signature'];
  const ts = req.headers['x-timestamp'];

  if (!verifySignature(req.method, url.pathname, ts, sig)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'FORBIDDEN_SIGNATURE' }));
  }

  try {
    const fullPath = safePath(objKey);

    if (req.method === 'PUT') {
      await mkdir(path.dirname(fullPath), { recursive: true });
      const tmp = `${fullPath}.${randomUUID()}.tmp`;
      const out = createWriteStream(tmp);
      const sha = createHash('sha256');
      let bytes = 0;

      req.on('data', chunk => {
        sha.update(chunk);
        bytes += chunk.length;
      });

      await pipeline(req, out);
      await rename(tmp, fullPath);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        key: objKey,
        size: bytes,
        sha256: sha.digest('hex')
      }));
    }

    if (req.method === 'GET') {
      try {
        const st = await stat(fullPath);
        if (!st.isFile()) throw new Error('Not file');
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': st.size
        });
        return pipeline(createReadStream(fullPath), res);
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'OBJECT_NOT_FOUND' }));
      }
    }

    if (req.method === 'DELETE') {
      try {
        await unlink(fullPath);
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, deleted: objKey }));
    }

    res.writeHead(405);
    res.end();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Mango Storage Node listening on ${HOST}:${PORT}, root: ${STORAGE_ROOT}`);
});
