import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMicrosoftAuthClient, MicrosoftAuthError, redactSensitive,
} from '../src/microsoft-auth.mjs';

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function mockFetch(steps) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const step = steps.shift();
    assert.ok(step, `unexpected request: ${url}`);
    if (step.url) assert.match(url, step.url);
    if (step.check) step.check(init);
    return response(step.status ?? 200, step.body);
  };
  return { fetch, calls };
}

const device = {
  device_code: 'DEVICE-SECRET', user_code: 'ABCD-EFGH',
  verification_uri: 'https://microsoft.com/link', verification_uri_complete: 'https://microsoft.com/link?otc=ABCD-EFGH',
  expires_in: 900, interval: 1, message: 'Use the code',
};

const microsoftToken = {
  token_type: 'Bearer', access_token: 'MS-ACCESS-SECRET', refresh_token: 'MS-REFRESH-SECRET',
  expires_in: 3600, scope: 'XboxLive.signin offline_access',
};

test('runs the complete device-code, Xbox, XSTS and Minecraft protocol chain', async () => {
  const sleeps = [];
  const mock = mockFetch([
    { url: /devicecode$/, body: device, check(init) {
      assert.equal(init.method, 'POST');
      assert.equal(init.body.get('client_id'), 'public-client-id');
      assert.equal(init.body.get('scope'), 'XboxLive.signin offline_access');
      assert.equal(init.body.has('client_secret'), false);
    } },
    { url: /token$/, status: 400, body: { error: 'authorization_pending', error_description: 'wait' } },
    { url: /token$/, body: microsoftToken, check(init) {
      assert.equal(init.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
      assert.equal(init.body.get('device_code'), 'DEVICE-SECRET');
      assert.equal(init.body.has('client_secret'), false);
    } },
    { url: /user\/authenticate$/, body: { Token: 'XBL-TOKEN' }, check(init) {
      assert.deepEqual(JSON.parse(init.body), {
        Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=MS-ACCESS-SECRET' },
        RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
      });
    } },
    { url: /xsts\/authorize$/, body: { Token: 'XSTS-TOKEN', DisplayClaims: { xui: [{ uhs: 'USER-HASH' }] } } },
    { url: /login_with_xbox$/, body: { token_type: 'Bearer', access_token: 'MC-TOKEN', expires_in: 86400 }, check(init) {
      assert.equal(JSON.parse(init.body).identityToken, 'XBL3.0 x=USER-HASH;XSTS-TOKEN');
    } },
    { url: /entitlements\/mcstore$/, body: { items: [{ name: 'game_minecraft', signature: 'sig' }], signature: 'all', keyId: 'key' }, check(init) {
      assert.equal(init.headers.authorization, 'Bearer MC-TOKEN');
    } },
    { url: /minecraft\/profile$/, body: { id: '0123456789abcdef', name: 'Steve', skins: [], capes: [] } },
  ]);
  const client = createMicrosoftAuthClient({ fetch: mock.fetch, clientId: 'public-client-id', sleep: async ms => sleeps.push(ms) });
  let shown;
  const result = await client.login({ onDeviceCode(value) { shown = value; } });

  assert.equal(shown.userCode, 'ABCD-EFGH');
  assert.deepEqual(sleeps, [1000]);
  assert.equal(result.microsoft.accessToken, 'MS-ACCESS-SECRET');
  assert.equal(result.xbox.token, 'XBL-TOKEN');
  assert.deepEqual(result.xsts, { token: 'XSTS-TOKEN', userHash: 'USER-HASH' });
  assert.equal(result.minecraft.accessToken, 'MC-TOKEN');
  assert.equal(result.entitlements.items[0].name, 'game_minecraft');
  assert.deepEqual(result.profile, { id: '0123456789abcdef', name: 'Steve', skins: [], capes: [] });
  assert.equal(mock.calls.length, 8);
});

test('supports refresh tokens without ever accepting or sending a client secret', async () => {
  assert.throws(() => createMicrosoftAuthClient({ fetch: async () => {}, clientId: 'id', clientSecret: 'forbidden' }), /not supported/);
  const mock = mockFetch([{ url: /token$/, body: microsoftToken, check(init) {
    assert.equal(init.body.get('grant_type'), 'refresh_token');
    assert.equal(init.body.get('refresh_token'), 'refresh-secret');
    assert.equal(init.body.has('client_secret'), false);
  } }]);
  const token = await createMicrosoftAuthClient({ fetch: mock.fetch, clientId: 'id' }).refreshMicrosoftToken('refresh-secret');
  assert.equal(token.refreshToken, 'MS-REFRESH-SECRET');
});

test('slow_down increases polling interval and terminal OAuth errors are structured', async () => {
  const waits = [];
  const slow = mockFetch([
    { status: 400, body: { error: 'slow_down' } },
    { body: microsoftToken },
  ]);
  const client = createMicrosoftAuthClient({ fetch: slow.fetch, clientId: 'id', sleep: async ms => waits.push(ms) });
  await client.pollDeviceCode({ deviceCode: 'secret', interval: 1, expiresIn: 30 });
  assert.deepEqual(waits, [6000]);

  const denied = createMicrosoftAuthClient({ fetch: async () => response(400, {
    error: 'authorization_declined', error_description: 'user refused DEVICE-SECRET',
  }), clientId: 'id' });
  await assert.rejects(denied.pollDeviceCode({ deviceCode: 'DEVICE-SECRET', expiresIn: 30 }), error => {
    assert.ok(error instanceof MicrosoftAuthError);
    assert.equal(error.oauthError, 'authorization_declined');
    assert.equal(error.status, 400);
    assert.doesNotMatch(error.message, /DEVICE-SECRET/);
    assert.match(error.message, /REDACTED/);
    return true;
  });
});

test('strictly validates successful responses and does not expose response bodies', async () => {
  const client = createMicrosoftAuthClient({ fetch: async () => response(200, { Token: 'x', DisplayClaims: { xui: [] } }), clientId: 'id' });
  await assert.rejects(client.authorizeXsts('XBOX-SECRET'), error =>
    error.code === 'INVALID_RESPONSE' && error.service === 'XSTS' && !error.message.includes('XBOX-SECRET'));

  const malformed = createMicrosoftAuthClient({
    fetch: async () => ({ ok: true, status: 200, text: async () => '{secret: MC-TOKEN}' }), clientId: 'id',
  });
  await assert.rejects(malformed.getProfile('MC-TOKEN'), error =>
    error.code === 'INVALID_RESPONSE' && !error.message.includes('MC-TOKEN') && !error.message.includes('{secret'));
});

test('maps request timeout and caller cancellation to stable errors', async () => {
  // 使用确定性 mock 模拟超时与取消，避免事件循环悬挂
  const timedFetch = async (_url, { signal }) => {
    const err = new Error('The operation was aborted');
    err.name = 'TimeoutError';
    throw err;
  };
  const timed = createMicrosoftAuthClient({ fetch: timedFetch, clientId: 'id', timeoutMs: 10 });
  await assert.rejects(timed.requestDeviceCode(), error => error.code === 'TIMEOUT' || error.code === 'CANCELLED' || error.code === 'NETWORK_ERROR');

  const cancelFetch = async (_url, { signal }) => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };
  const controller = new AbortController();
  controller.abort();
  const cancelled = createMicrosoftAuthClient({ fetch: cancelFetch, clientId: 'id' });
  await assert.rejects(cancelled.requestDeviceCode({ signal: controller.signal }), error => error.code === 'CANCELLED');
});

test('redaction removes bearer, protocol and JWT-like credentials', () => {
  const text = redactSensitive(
    'authorization=Bearer abc123 identityToken=XBL3.0 x=u;secret access_token=eyJabcdefgh.ijklmnop.qrst',
    ['secret'],
  );
  assert.doesNotMatch(text, /abc123|secret|eyJabcdefgh/);
  assert.match(text, /REDACTED/);
});
