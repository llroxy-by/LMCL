import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_PROVIDER_IDS, createAccount, createCredentialRef,
  createLaunchSession, validateLaunchSession,
} from '../src/account-model.mjs';
import { MemorySecretStore, SecretStore } from '../src/secret-store.mjs';

const profile = { id: 'b50ad385829d3141a2167e7d7539ba7f', name: 'Notch' };
const onlineRef = { store: 'os-keychain', id: 'account-1' };
const issuedAt = '2025-01-01T00:00:00.000Z';
const expiresAt = '2025-01-01T01:00:00.000Z';

test('account model supports Microsoft, LittleSkin, and offline providers', () => {
  assert.deepEqual(ACCOUNT_PROVIDER_IDS, ['microsoft', 'littleskin', 'offline']);
  for (const provider of ['microsoft', 'littleskin']) {
    const account = createAccount({ id: `${provider}-1`, provider, profile, credentialRef: onlineRef });
    assert.equal(account.provider, provider);
    assert.deepEqual(account.credentialRef, onlineRef);
    assert.ok(Object.isFrozen(account));
    assert.ok(Object.isFrozen(account.profile));
  }
  assert.equal(createAccount({ id: 'local-1', provider: 'offline', profile }).credentialRef, null);
});

test('public account metadata accepts only opaque credential references', () => {
  assert.deepEqual(createCredentialRef('keychain', 'entry-1'), { store: 'keychain', id: 'entry-1' });
  for (const bad of [
    { id: 'a', provider: 'microsoft', profile },
    { id: 'a', provider: 'offline', profile, credentialRef: onlineRef },
    { id: 'a', provider: 'microsoft', profile, credentialRef: { ...onlineRef, accessToken: 'hidden' } },
    { id: 'a', provider: 'microsoft', profile, credentialRef: onlineRef, password: 'hidden' },
  ]) assert.throws(() => createAccount(bad));
});

test('LaunchSession strictly validates shape, provider rules, timestamps, and expiry', () => {
  const session = createLaunchSession({
    id: 'launch-1', accountId: 'microsoft-1', provider: 'microsoft', profile,
    credentialRef: onlineRef, issuedAt, expiresAt,
  });
  assert.equal(validateLaunchSession(session, { now: Date.parse(issuedAt) }).id, 'launch-1');
  assert.throws(() => validateLaunchSession(session, { now: Date.parse(expiresAt) }));
  assert.throws(() => createLaunchSession({ ...session, accessToken: 'hidden' }));
  assert.throws(() => createLaunchSession({ ...session, expiresAt: issuedAt }));
  assert.throws(() => createLaunchSession({ ...session, expiresAt: undefined }));
  assert.throws(() => createLaunchSession({ ...session, issuedAt: '2025-01-01' }));
  assert.throws(() => createLaunchSession({ ...session, provider: 'unknown' }));

  const offline = createLaunchSession({
    id: 'launch-local', accountId: 'local-1', provider: 'offline', profile,
    issuedAt, expiresAt: null,
  });
  assert.equal(validateLaunchSession(offline, { now: Date.parse(expiresAt) }).expiresAt, null);
  assert.throws(() => createLaunchSession({ ...offline, credentialRef: onlineRef }));
});

test('MemorySecretStore isolates secret values from references and caller mutation', async () => {
  const store = new MemorySecretStore('test-memory');
  assert.ok(store instanceof SecretStore);
  const input = { accessToken: 'private-value', nested: { refreshToken: 'refresh-value' } };
  const ref = await store.put('microsoft-1', input);
  assert.deepEqual(ref, { store: 'test-memory', id: 'microsoft-1' });
  assert.equal(JSON.stringify(ref).includes('private-value'), false);

  input.accessToken = 'changed';
  const first = await store.get(ref);
  assert.equal(first.accessToken, 'private-value');
  first.nested.refreshToken = 'changed';
  assert.equal((await store.get(ref)).nested.refreshToken, 'refresh-value');

  assert.equal(await store.delete(ref), true);
  assert.equal(await store.get(ref), null);
  assert.equal(await store.delete(ref), false);
  await assert.rejects(() => store.get({ store: 'other', id: ref.id }));
});
