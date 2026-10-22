import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createYggdrasilAuth, validateYggdrasilApiRoot, YggdrasilAuthError,
} from '../src/yggdrasil-auth.mjs';

const profiles = [
  { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Alice' },
  { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Bob' },
];
const success = (extra = {}) => ({
  accessToken: 'access-token', clientToken: 'client-token', availableProfiles: profiles, ...extra,
});
const jsonResponse = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
const emptyResponse = (status = 204) => new Response(null, { status });

function mockClient(handler, options = {}) {
  const calls = [];
  const client = createYggdrasilAuth({
    apiRoot: 'https://littleskin.cn/api/yggdrasil/',
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return handler(url, init, calls.length - 1);
    },
    ...options,
  });
  return { client, calls };
}

test('authenticate uses the Yggdrasil wire shape and exposes immutable profiles without password', async () => {
  const password = 'never-store-this';
  const { client, calls } = mockClient(() => jsonResponse(success()));
  const result = await client.authenticate({ username: 'user@example.com', password, clientToken: 'client-token' });

  assert.equal(calls[0].url, 'https://littleskin.cn/api/yggdrasil/authenticate');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.deepEqual(calls[0].body, {
    agent: { name: 'Minecraft', version: 1 }, username: 'user@example.com', password,
    clientToken: 'client-token',
  });
  assert.deepEqual(result.availableProfiles, profiles);
  assert.equal(result.selectedProfile, null);
  assert.equal(JSON.stringify(result).includes(password), false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.availableProfiles), true);
});

test('authenticate supports multi-profile selection through refresh', async () => {
  const { client, calls } = mockClient((_url, _init, index) => index === 0
    ? jsonResponse(success())
    : jsonResponse(success({ selectedProfile: profiles[1] })));
  const result = await client.authenticate({ username: 'user', password: 'secret', profileId: profiles[1].id });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.endsWith('/refresh'), true);
  assert.deepEqual(calls[1].body, {
    accessToken: 'access-token', clientToken: 'client-token', selectedProfile: profiles[1],
  });
  assert.deepEqual(result.selectedProfile, profiles[1]);

  await assert.rejects(
    () => client.selectProfile(success(), 'Missing'),
    /selected profile is not available/,
  );
});

test('refresh, validate, invalidate, and signout implement protocol operations', async () => {
  const { client, calls } = mockClient((_url, _init, index) => {
    if (index === 0) return jsonResponse(success({ selectedProfile: profiles[0] }));
    return emptyResponse();
  });
  const pair = { accessToken: 'old-access', clientToken: 'client-token' };

  assert.equal((await client.refresh({ ...pair, selectedProfile: profiles[0] })).accessToken, 'access-token');
  assert.equal(await client.validate(pair), true);
  assert.equal(await client.invalidate(pair), true);
  assert.equal(await client.signout({ username: 'user', password: 'secret' }), true);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname.split('/').at(-1)), [
    'refresh', 'validate', 'invalidate', 'signout',
  ]);
  assert.deepEqual(calls[3].body, { username: 'user', password: 'secret' });
});

test('validate maps rejected credentials to false but other operations throw sanitized errors', async () => {
  const secret = 'top-secret-password';
  const { client } = mockClient(url => url.endsWith('/validate')
    ? jsonResponse({ error: 'ForbiddenOperationException', errorMessage: `bad ${secret}` }, 403)
    : jsonResponse({ error: 'ForbiddenOperationException', errorMessage: `bad ${secret}`, cause: secret }, 403));

  assert.equal(await client.validate({ accessToken: 'bad', clientToken: 'client-token' }), false);
  await assert.rejects(
    () => client.signout({ username: 'user', password: secret }),
    error => {
      assert.ok(error instanceof YggdrasilAuthError);
      assert.equal(error.status, 403);
      assert.equal(error.code, 'ForbiddenOperationException');
      assert.equal(JSON.stringify(error).includes(secret), false);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test('URL validation requires credential-free HTTPS public DNS roots', () => {
  assert.equal(
    validateYggdrasilApiRoot('https://littleskin.cn/api/yggdrasil///'),
    'https://littleskin.cn/api/yggdrasil',
  );
  for (const value of [
    'http://littleskin.cn/api/yggdrasil',
    'https://user:password@littleskin.cn/api/yggdrasil',
    'https://littleskin.cn/api/yggdrasil?q=1',
    'https://littleskin.cn/api/yggdrasil#fragment',
    'https://localhost/api/yggdrasil',
    'https://127.0.0.1/api/yggdrasil',
    'https://[::1]/api/yggdrasil',
  ]) assert.throws(() => validateYggdrasilApiRoot(value), value);
});

test('response size, JSON, and authentication response structures are bounded and checked', async () => {
  const pair = { accessToken: 'access', clientToken: 'client' };
  const oversized = mockClient(() => new Response('x'.repeat(65), { status: 200 }), { maxResponseBytes: 64 }).client;
  await assert.rejects(() => oversized.refresh(pair), /response was rejected/);

  const declaredOversized = mockClient(
    () => new Response('{}', { status: 200, headers: { 'content-length': '1000' } }),
    { maxResponseBytes: 64 },
  ).client;
  await assert.rejects(() => declaredOversized.refresh(pair), /response was rejected/);

  const invalidJson = mockClient(() => new Response('not json', { status: 200 })).client;
  await assert.rejects(() => invalidJson.refresh(pair), /invalid JSON/);

  for (const body of [
    { clientToken: 'client' },
    { accessToken: 'access', clientToken: 'client', availableProfiles: [{ id: 'bad', name: 'Alice' }] },
    { accessToken: 'access', clientToken: 'client', availableProfiles: profiles, selectedProfile: { id: 'c'.repeat(32), name: 'Carol' } },
  ]) {
    const malformed = mockClient(() => jsonResponse(body)).client;
    await assert.rejects(() => malformed.refresh(pair));
  }
});

test('request inputs reject unknown fields and never place password in returned state', async () => {
  const { client } = mockClient(() => jsonResponse(success()));
  await assert.rejects(() => client.authenticate({ username: 'u', password: 'p', persistPassword: true }));
  await assert.rejects(() => client.signout({ username: 'u', password: 'p', accessToken: 'nope' }));
  await assert.rejects(() => client.refresh({ accessToken: 'a', clientToken: 'c', password: 'nope' }));
});
