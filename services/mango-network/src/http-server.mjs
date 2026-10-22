import http from 'node:http';
import { ServiceError } from './errors.mjs';
import { createRateLimiter } from './rate-limit.mjs';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const JSON_TYPE = 'application/json; charset=utf-8';

const statusByCode = new Map([
  ['INVALID_EMAIL', 400], ['INVALID_VERIFICATION', 400], ['INVALID_STATE', 409],
  ['VERIFICATION_EXPIRED', 410], ['VERIFICATION_LOCKED', 429], ['EMAIL_TAKEN', 409],
  ['INVALID_CREDENTIALS', 401], ['EMAIL_NOT_VERIFIED', 403], ['INVALID_ACCESS_TOKEN', 401],
  ['INVALID_REFRESH_TOKEN', 401], ['REFRESH_REVOKED', 401], ['REFRESH_EXPIRED', 401],
  ['INVALID_SAVE_ID', 400], ['INVALID_SAVE_NAME', 400], ['INVALID_SNAPSHOT', 400],
  ['SNAPSHOT_TOO_LARGE', 413], ['INVALID_VERSION', 400], ['SAVE_EXISTS', 409],
  ['SAVE_NOT_FOUND', 404], ['SNAPSHOT_NOT_FOUND', 404], ['VERSION_CONFLICT', 409]
]);

class HttpError extends Error {
  constructor(status, code, message, headers = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function sendJson(res, status, value, headers = undefined) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  });
  res.end(body);
}

function sendError(res, error) {
  if (res.headersSent) return res.end();
  if (error instanceof HttpError) {
    return sendJson(res, error.status, { error: { code: error.code, message: error.message } }, error.headers);
  }
  if (error instanceof ServiceError) {
    const status = statusByCode.get(error.code) ?? 400;
    return sendJson(res, status, { error: { code: error.code, message: error.message } });
  }
  return sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred' } });
}

async function readJson(req, limit) {
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'BODY_TOO_LARGE', 'JSON body exceeds the configured limit');

  const chunks = [];
  let size = 0;
  let exceeded = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      exceeded = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (exceeded) throw new HttpError(413, 'BODY_TOO_LARGE', 'JSON body exceeds the configured limit');
  if (size === 0) throw new HttpError(400, 'INVALID_JSON', 'A JSON object body is required');
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_JSON', 'A JSON object body is required');
  }
  return value;
}

function bearer(req) {
  const header = req.headers.authorization;
  const match = typeof header === 'string' && /^Bearer ([^\s]+)$/.exec(header);
  if (!match) throw new HttpError(401, 'BEARER_REQUIRED', 'A Bearer access token is required', {
    'www-authenticate': 'Bearer realm="mango"'
  });
  return match[1];
}

function decodeSnapshot(value) {
  if (typeof value !== 'string' || value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new HttpError(400, 'INVALID_SNAPSHOT', 'snapshot data must be canonical base64');
  }
  return Buffer.from(value, 'base64');
}

function snapshotJson(snapshot) {
  return { ...snapshot, data: Buffer.from(snapshot.data).toString('base64'), encoding: 'base64' };
}

function clientIp(req) {
  const address = req.socket.remoteAddress ?? 'unknown';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function routeFor(method, pathname) {
  if (method === 'POST' && pathname === '/v1/auth/register') return ['auth.register'];
  if (method === 'POST' && pathname === '/v1/auth/verify') return ['auth.verify'];
  if (method === 'POST' && pathname === '/v1/auth/login') return ['auth.login'];
  if (method === 'POST' && pathname === '/v1/auth/refresh') return ['auth.refresh'];
  if (method === 'POST' && pathname === '/v1/auth/logout') return ['auth.logout'];
  if (method === 'GET' && pathname === '/v1/cloud-saves') return ['saves.list'];
  if (method === 'POST' && pathname === '/v1/cloud-saves') return ['saves.create'];
  let match = /^\/v1\/cloud-saves\/([^/]+)\/snapshots$/.exec(pathname);
  if (method === 'PUT' && match) return ['saves.snapshot.put', decodeURIComponent(match[1])];
  match = /^\/v1\/cloud-saves\/([^/]+)\/snapshots\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && match) return ['saves.snapshot.get', decodeURIComponent(match[1]), decodeURIComponent(match[2])];
  return undefined;
}

/** Creates an unstarted HTTP adapter. It never reads process.env or starts a resident listener. */
export function createHttpServer({
  service,
  host = service?.config?.host ?? '127.0.0.1',
  bodyLimitBytes = Math.max(65_536, Math.ceil((service?.config?.maxSnapshotBytes ?? 1_048_576) * 4 / 3) + 4096),
  rateLimit = { limit: 60, windowMs: 60_000 },
  clock = () => Date.now()
} = {}) {
  if (!service) throw new TypeError('service is required');
  if (!LOOPBACK_HOSTS.has(host)) throw new TypeError('host must be a loopback address');
  if (!Number.isSafeInteger(bodyLimitBytes) || bodyLimitBytes < 1) throw new TypeError('bodyLimitBytes must be a positive integer');
  const limiter = createRateLimiter({ ...rateLimit, clock });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://loopback.invalid');
      const route = routeFor(req.method, url.pathname);
      if (!route) throw new HttpError(404, 'NOT_FOUND', 'Route not found');

      const rate = limiter.consume(`${clientIp(req)}\0${req.method}\0${route[0]}`);
      res.setHeader('x-ratelimit-limit', String(rate.limit));
      res.setHeader('x-ratelimit-remaining', String(rate.remaining));
      if (!rate.allowed) {
        throw new HttpError(429, 'RATE_LIMITED', 'Too many requests', { 'retry-after': String(rate.retryAfterSeconds) });
      }

      let result;
      switch (route[0]) {
        case 'auth.register': {
          const body = await readJson(req, bodyLimitBytes);
          result = await service.register({ email: body.email, password: body.password });
          return sendJson(res, 201, { user: result });
        }
        case 'auth.verify': {
          const body = await readJson(req, bodyLimitBytes);
          result = await service.verifyEmail({ email: body.email, code: body.code });
          return sendJson(res, 200, { user: result });
        }
        case 'auth.login': {
          const body = await readJson(req, bodyLimitBytes);
          result = await service.login({ email: body.email, password: body.password });
          return sendJson(res, 200, result);
        }
        case 'auth.refresh': {
          const body = await readJson(req, bodyLimitBytes);
          return sendJson(res, 200, await service.refresh(body.refreshToken));
        }
        case 'auth.logout': {
          const body = await readJson(req, bodyLimitBytes);
          await service.revoke(body.refreshToken);
          res.writeHead(204, { 'cache-control': 'no-store' });
          return res.end();
        }
        case 'saves.list':
          return sendJson(res, 200, { saves: await service.listCloudSaves(bearer(req)) });
        case 'saves.create': {
          const token = bearer(req);
          const body = await readJson(req, bodyLimitBytes);
          result = await service.createCloudSave(token, { id: body.id, name: body.name, data: decodeSnapshot(body.data) });
          return sendJson(res, 201, { save: result });
        }
        case 'saves.snapshot.put': {
          const token = bearer(req);
          const body = await readJson(req, bodyLimitBytes);
          result = await service.putCloudSnapshot(token, route[1], {
            expectedVersion: body.expectedVersion, name: body.name, data: decodeSnapshot(body.data)
          });
          return sendJson(res, 200, { save: result });
        }
        case 'saves.snapshot.get': {
          const version = Number(route[2]);
          if (!/^\d+$/.test(route[2]) || !Number.isSafeInteger(version) || version < 1) {
            throw new HttpError(400, 'INVALID_VERSION', 'version must be a positive integer');
          }
          result = await service.getCloudSnapshot(bearer(req), route[1], version);
          return sendJson(res, 200, { snapshot: snapshotJson(result) });
        }
      }
    } catch (error) {
      sendError(res, error);
    }
  });

  // A numeric/default listen call would otherwise bind every interface.
  const nativeListen = server.listen.bind(server);
  server.listen = function loopbackListen(...args) {
    if (typeof args[0] === 'object' && args[0] !== null) {
      const options = { ...args[0] };
      if (options.path) throw new TypeError('Unix socket listening is not supported');
      if (options.host !== undefined && options.host !== host) throw new TypeError('listener host must match configured loopback host');
      options.host = host;
      return nativeListen(options, ...args.slice(1));
    }
    if (typeof args[1] === 'string') {
      if (args[1] !== host) throw new TypeError('listener host must match configured loopback host');
      return nativeListen(...args);
    }
    return nativeListen(args[0], host, ...args.slice(1));
  };
  return server;
}
