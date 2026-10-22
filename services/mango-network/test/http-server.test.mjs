import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { loadConfig, MangoService } from '../src/index.mjs';
import { createHttpServer } from '../src/http-server.mjs';
import { createRateLimiter } from '../src/rate-limit.mjs';

const config = loadConfig({
  TOKEN_PEPPER: 'http-test-pepper-value-with-at-least-32-characters',
  MAX_SNAPSHOT_BYTES: '1024'
});

function fixture(options = {}) {
  const delivered = [];
  const service = new MangoService({
    config,
    verificationDelivery: async (message) => delivered.push(message)
  });
  const server = createHttpServer({ service, bodyLimitBytes: 2048, ...options });
  return { service, server, delivered };
}

async function listen(server) {
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function json(response) {
  const value = await response.json();
  return { response, value };
}

async function post(root, path, body, headers = {}) {
  return fetch(`${root}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

async function createActiveSession(root, delivered) {
  let response = await post(root, '/v1/auth/register', {
    email: 'player@example.com', password: 'correct horse battery staple'
  });
  assert.equal(response.status, 201);
  response = await post(root, '/v1/auth/verify', { email: 'player@example.com', code: delivered[0].code });
  assert.equal(response.status, 200);
  response = await post(root, '/v1/auth/login', {
    email: 'player@example.com', password: 'correct horse battery staple'
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('HTTP adapter is unstarted, enforces loopback, and exposes the complete auth flow', async (t) => {
  const f = fixture();
  assert.equal(f.server.listening, false);
  assert.throws(() => f.server.listen({ port: 0, host: '0.0.0.0' }), /loopback host/);
  const root = await listen(f.server);
  t.after(() => f.server.close());

  const auth = await createActiveSession(root, f.delivered);
  assert.match(auth.accessToken, /\./);
  assert.match(auth.refreshToken, /\./);

  const refreshed = await json(await post(root, '/v1/auth/refresh', { refreshToken: auth.refreshToken }));
  assert.equal(refreshed.response.status, 200);
  assert.notEqual(refreshed.value.refreshToken, auth.refreshToken);

  const logout = await post(root, '/v1/auth/logout', { refreshToken: refreshed.value.refreshToken });
  assert.equal(logout.status, 204);
  const rejected = await fetch(`${root}/v1/cloud-saves`, {
    headers: { authorization: `Bearer ${refreshed.value.accessToken}` }
  });
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json()).error.code, 'INVALID_ACCESS_TOKEN');
});

test('Bearer cloud-save routes exchange metadata and small base64 snapshots', async (t) => {
  const f = fixture();
  const root = await listen(f.server);
  t.after(() => f.server.close());
  const auth = await createActiveSession(root, f.delivered);
  const headers = { authorization: `Bearer ${auth.accessToken}` };

  let result = await json(await post(root, '/v1/cloud-saves', {
    id: 'world-1', name: 'Test World', data: Buffer.from('one').toString('base64')
  }, headers));
  assert.equal(result.response.status, 201);
  assert.equal(result.value.save.version, 1);
  assert.equal(result.value.save.data, undefined);

  result = await json(await fetch(`${root}/v1/cloud-saves/world-1/snapshots`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ expectedVersion: 1, data: Buffer.from('two').toString('base64') })
  }));
  assert.equal(result.response.status, 200);
  assert.equal(result.value.save.version, 2);

  result = await json(await fetch(`${root}/v1/cloud-saves`, { headers }));
  assert.deepEqual(result.value.saves.map(({ id, version }) => ({ id, version })), [{ id: 'world-1', version: 2 }]);

  result = await json(await fetch(`${root}/v1/cloud-saves/world-1/snapshots/2`, { headers }));
  assert.equal(result.response.status, 200);
  assert.equal(result.value.snapshot.encoding, 'base64');
  assert.equal(Buffer.from(result.value.snapshot.data, 'base64').toString(), 'two');

  const missingBearer = await fetch(`${root}/v1/cloud-saves`);
  assert.equal(missingBearer.status, 401);
  assert.match(missingBearer.headers.get('www-authenticate'), /^Bearer/);
});

test('JSON body limits, media validation, route/IP rate limits, and error redaction are enforced', async (t) => {
  const f = fixture({ bodyLimitBytes: 64, rateLimit: { limit: 2, windowMs: 60_000 } });
  const root = await listen(f.server);
  t.after(() => f.server.close());

  let response = await fetch(`${root}/v1/auth/register`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE');

  response = await post(root, '/v1/auth/login', { padding: 'x'.repeat(100) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'BODY_TOO_LARGE');

  response = await post(root, '/v1/auth/login', { email: 'nobody@example.com', password: 'not secret' });
  assert.equal(response.status, 401);
  response = await post(root, '/v1/auth/login', { email: 'nobody@example.com', password: 'not secret' });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'RATE_LIMITED');
  assert.equal(response.headers.get('retry-after'), '60');

  const secret = 'Bearer should-never-appear-in-errors';
  const server = createHttpServer({
    service: { config, register: async () => { throw new Error(secret); } },
    rateLimit: { limit: 10, windowMs: 1000 }
  });
  const secondRoot = await listen(server);
  t.after(() => server.close());
  const failure = await post(secondRoot, '/v1/auth/register', { email: 'a@b.co', password: 'x' });
  assert.equal(failure.status, 500);
  const raw = await failure.text();
  assert.equal(raw.includes(secret), false);
  assert.deepEqual(JSON.parse(raw), { error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred' } });
});

test('rate limiter resets windows and keeps route keys independent', () => {
  let now = 1000;
  const limiter = createRateLimiter({ limit: 1, windowMs: 500, clock: () => now });
  assert.equal(limiter.consume('ip\0route-a').allowed, true);
  assert.equal(limiter.consume('ip\0route-a').allowed, false);
  assert.equal(limiter.consume('ip\0route-b').allowed, true);
  now += 500;
  assert.equal(limiter.consume('ip\0route-a').allowed, true);
});
