import test from 'node:test';
import assert from 'node:assert/strict';
import { createMangoClient, validateMangoApiRoot, MangoClientError } from '../src/mango-client.mjs';

const json = (value, status = 200, headers) => new Response(JSON.stringify(value), { status, headers });
const callsFor = (handler, options = {}) => {
  const calls = [];
  const client = createMangoClient({
    apiRoot: 'https://cloud.example.org/mango/',
    fetch: async (url, init) => {
      calls.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
      return handler(url, init, calls.length - 1);
    },
    ...options,
  });
  return { client, calls };
};

test('validates a credential-free HTTPS public DNS API root', () => {
  assert.equal(validateMangoApiRoot('https://cloud.example.org/mango///'), 'https://cloud.example.org/mango');
  for (const root of [
    'http://cloud.example.org/mango', 'https://user:pass@cloud.example.org/mango',
    'https://cloud.example.org/mango?q=1', 'https://cloud.example.org/mango#x',
    'https://localhost/mango', 'https://127.0.0.1/mango', 'https://[::1]/mango',
  ]) assert.throws(() => validateMangoApiRoot(root), root);
});

test('implements registration, verification, login, refresh, and logout wire calls', async () => {
  const { client, calls } = callsFor(() => json({ ok: true }));
  await client.register({ email: 'a@example.org', password: 'secret' });
  await client.verify({ email: 'a@example.org', code: '123456' });
  await client.login({ email: 'a@example.org', password: 'secret' });
  await client.refresh({ refreshToken: 'refresh-secret' });
  await client.logout({ accessToken: 'access-secret', refreshToken: 'refresh-secret' });

  assert.deepEqual(calls.map(call => [call.init.method, new URL(call.url).pathname]), [
    ['POST', '/mango/v1/auth/register'], ['POST', '/mango/v1/auth/verify'],
    ['POST', '/mango/v1/auth/login'], ['POST', '/mango/v1/auth/refresh'],
    ['POST', '/mango/v1/auth/logout'],
  ]);
  assert.equal(calls[4].init.headers.authorization, 'Bearer access-secret');
  assert.deepEqual(calls[4].body, { refreshToken: 'refresh-secret' });
  for (const call of calls) {
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.credentials, 'omit');
  }
});

test('implements authenticated save list, create, update, and bounded base64 download', async () => {
  const content = Buffer.from('world bytes').toString('base64');
  const { client, calls } = callsFor((_url, _init, index) => index === 3 ? json({ data: content }) : json({ ok: true }));
  await client.list({ accessToken: 'token' });
  await client.create({ accessToken: 'token', name: 'World', data: 'YWJjZA==' });
  await client.update('save.1', { accessToken: 'token', revision: 2, data: 'ZWZnaA==' });
  const bytes = await client.download({ id: 'save.1', accessToken: 'token' });

  assert.deepEqual(calls.map(call => [call.init.method, new URL(call.url).pathname]), [
    ['GET', '/mango/v1/saves'], ['POST', '/mango/v1/saves'],
    ['PUT', '/mango/v1/saves/save.1'], ['GET', '/mango/v1/saves/save.1/download'],
  ]);
  assert.deepEqual(calls[2].body, { revision: 2, data: 'ZWZnaA==' });
  assert.equal(new TextDecoder().decode(bytes), 'world bytes');
  assert.ok(calls.every(call => call.init.headers.authorization === 'Bearer token'));
});

test('one 401 invokes refresh callback once and retries with replacement bearer', async () => {
  let refreshes = 0;
  const { client, calls } = callsFor((_url, _init, index) => index === 0
    ? json({ error: { code: 'expired', message: 'do not expose old-token' } }, 401)
    : json({ saves: [] }), {
    onRefresh: async context => {
      refreshes++;
      assert.equal(context.operation, 'list');
      assert.equal(context.accessToken, 'old-token');
      return { accessToken: 'new-token' };
    },
  });
  assert.deepEqual(await client.list({ accessToken: 'old-token' }), { saves: [] });
  assert.equal(refreshes, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.authorization, 'Bearer old-token');
  assert.equal(calls[1].init.headers.authorization, 'Bearer new-token');
});

test('a second 401 is not refreshed and yields a sanitized structured error', async () => {
  const secret = 'token-that-must-not-leak';
  let refreshes = 0;
  const { client, calls } = callsFor(() => json({
    error: { code: 'TOKEN_EXPIRED', message: `rejected ${secret}` }, refreshToken: secret,
  }, 401), { onRefresh: async () => { refreshes++; return 'replacement'; } });

  await assert.rejects(() => client.list({ accessToken: secret }), error => {
    assert.ok(error instanceof MangoClientError);
    assert.equal(error.operation, 'list');
    assert.equal(error.status, 401);
    assert.equal(error.code, 'TOKEN_EXPIRED');
    assert.equal(error.message.includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal('cause' in error, false);
    return true;
  });
  assert.equal(refreshes, 1);
  assert.equal(calls.length, 2);
});

test('refresh callback failure is sanitized and does not retain callback errors', async () => {
  const secret = 'refresh-secret';
  const { client } = callsFor(() => json({}, 401), {
    onRefresh: async () => { throw new Error(`failed with ${secret}`); },
  });
  await assert.rejects(() => client.list({ accessToken: 'old' }), error => {
    assert.ok(error instanceof MangoClientError);
    assert.equal(error.message.includes(secret), false);
    assert.equal('cause' in error, false);
    return true;
  });
});

test('JSON request/response and decoded base64 sizes are bounded', async () => {
  const smallRequest = callsFor(() => json({}), { maxJsonBytes: 32 }).client;
  await assert.rejects(() => smallRequest.create({ accessToken: 'token', value: 'x'.repeat(64) }), /too large/);

  const declared = callsFor(() => new Response('{}', {
    status: 200, headers: { 'content-length': '1000' },
  }), { maxJsonBytes: 32 }).client;
  await assert.rejects(() => declared.list({ accessToken: 'token' }), error =>
    error instanceof MangoClientError && error.message.includes('response was rejected'));

  const badJson = callsFor(() => new Response('not-json', { status: 200 })).client;
  await assert.rejects(() => badJson.list({ accessToken: 'token' }), /invalid JSON/);

  const oversizedBase64 = callsFor(() => json({ data: Buffer.alloc(9).toString('base64') }), {
    maxBase64Bytes: 8,
  }).client;
  await assert.rejects(() => oversizedBase64.download('save', { accessToken: 'token' }), /too large/);

  for (const data of ['abc', '!!!!', 'AAAA=AAA']) {
    const malformed = callsFor(() => json({ data })).client;
    await assert.rejects(() => malformed.download('save', { accessToken: 'token' }), /invalid base64/);
  }
});

test('rejects unsafe ids, token syntax, unsupported read options, and network error leakage', async () => {
  const secret = 'network-secret';
  const client = createMangoClient({
    apiRoot: 'https://cloud.example.org/mango',
    fetch: async () => { throw new Error(secret); },
  });
  await assert.rejects(() => client.list({ accessToken: 'safe' }), error => {
    assert.ok(error instanceof MangoClientError);
    assert.equal(error.message.includes(secret), false);
    assert.equal('cause' in error, false);
    return true;
  });
  await assert.rejects(() => client.download('../admin', { accessToken: 'safe' }));
  await assert.rejects(() => client.list({ accessToken: 'bad token' }));
  await assert.rejects(() => client.list({ accessToken: 'safe', page: 1 }));
});
