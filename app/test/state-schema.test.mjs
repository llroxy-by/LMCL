import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateState, validateState } from '../lib/state-schema.mjs';
import { CredentialVault } from '../lib/credential-vault.mjs';

const profile = { provider: 'offline', name: 'LMCL_Test', uuid: '4ed5a678-24fb-32bc-9d8d-0f6a5dff3da9', verified: false };
const v1 = {
  schemaVersion: 1,
  settings: { schemaVersion: 1, mode: 'normal', providers: [] },
  profile,
  instances: [],
  javaPath: '',
  memoryMB: 4096,
};

test('schema v1 single profile migrates to v2 accounts selection', () => {
  const state = migrateState(v1);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.accounts.length, 1);
  assert.deepEqual(state.accounts[0], {
    id: 'offline:4ed5a67824fb32bc9d8d0f6a5dff3da9',
    provider: 'offline',
    profile: { id: '4ed5a67824fb32bc9d8d0f6a5dff3da9', name: 'LMCL_Test' },
    credentialRef: null,
  });
  assert.equal(state.selectedAccountId, state.accounts[0].id);
  assert.equal('profile' in state, false);
  assert.equal(JSON.stringify(state).includes('token'), false);
  assert.ok(Object.isFrozen(state));
});

test('empty v1 profile migrates to an empty valid account selection', () => {
  const state = migrateState({ ...v1, profile: null });
  assert.deepEqual(state.accounts, []);
  assert.equal(state.selectedAccountId, null);
});

test('state schema is strict and never admits token or password fields', () => {
  const valid = migrateState(v1);
  assert.deepEqual(validateState(valid), valid);
  assert.throws(() => migrateState({ ...v1, token: 'secret' }), /unsupported field/);
  assert.throws(() => migrateState({ ...v1, profile: { ...profile, password: 'secret' } }), /unsupported field/);
  assert.throws(() => validateState({ ...valid, accessToken: 'secret' }), /unsupported field/);
  assert.throws(() => validateState({ ...valid, accounts: [{ ...valid.accounts[0], password: 'secret' }] }), /unsupported field/);
  assert.throws(() => validateState({ ...valid, selectedAccountId: 'missing' }), /identify an account/);
  assert.throws(() => migrateState({ ...v1, schemaVersion: 99 }), /unsupported state schema/);
});

test('credential vault encrypts one atomic file and exposes an opaque credentialRef', async () => {
  let stored = null;
  const writes = [];
  const atomicIO = {
    async readFile(file) {
      assert.equal(file, '/data/credentials.vault');
      if (stored === null) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
      return stored;
    },
    async writeFileAtomic(file, bytes) {
      writes.push({ file, bytes });
      stored = bytes;
    },
  };
  const encrypt = async plaintext => `cipher:${Buffer.from(plaintext).toString('base64')}`;
  const decrypt = async ciphertext => Buffer.from(ciphertext.slice(7), 'base64').toString();
  const vault = new CredentialVault({ file: '/data/credentials.vault', storeId: 'file-vault', encrypt, decrypt, atomicIO });

  const secret = { accessToken: 'private', nested: { refreshToken: 'refresh' } };
  const ref = await vault.put('microsoft-1', secret);
  assert.deepEqual(ref, { store: 'file-vault', id: 'microsoft-1' });
  assert.equal(JSON.stringify(ref).includes('private'), false);
  assert.equal(String(stored).includes('private'), false);
  assert.equal(writes.length, 1);

  secret.accessToken = 'mutated';
  const resolved = await vault.resolve(ref);
  assert.equal(resolved.accessToken, 'private');
  resolved.nested.refreshToken = 'mutated';
  assert.equal((await vault.get(ref)).nested.refreshToken, 'refresh');
  assert.equal(await vault.delete(ref), true);
  assert.equal(await vault.resolve(ref), null);
  assert.equal(await vault.delete(ref), false);
  await assert.rejects(vault.resolve({ store: 'other', id: ref.id }), /another vault/);
});

test('vault serializes concurrent updates so atomic writes cannot lose credentials', async () => {
  let stored;
  const atomicIO = {
    async readFile() { if (stored === undefined) { const error = new Error(); error.code = 'ENOENT'; throw error; } return stored; },
    async writeFileAtomic(_file, bytes) { await new Promise(resolve => setTimeout(resolve, 2)); stored = bytes; },
  };
  const vault = new CredentialVault({ file: 'vault', encrypt: value => value, decrypt: value => value, atomicIO });
  const [a, b] = await Promise.all([vault.put('a', { token: 'one' }), vault.put('b', { token: 'two' })]);
  assert.equal((await vault.resolve(a)).token, 'one');
  assert.equal((await vault.resolve(b)).token, 'two');
  assert.equal(stored.includes('"a"'), true);
  assert.equal(stored.includes('"b"'), true);
});
