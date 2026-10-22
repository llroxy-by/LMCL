import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, MangoService, MemorySessionRepository, MemoryUserRepository } from '../src/index.mjs';

const config = loadConfig({ TOKEN_PEPPER: 'test-only-pepper-value-with-32-characters', VERIFICATION_TTL_MS: '1000' });

function fixture() {
  let now = 1_700_000_000_000;
  const delivered = [];
  const users = new MemoryUserRepository();
  const sessions = new MemorySessionRepository();
  const service = new MangoService({
    config, users, sessions, clock: () => now,
    verificationDelivery: async (message) => delivered.push(message)
  });
  return { service, users, sessions, delivered, advance: (ms) => { now += ms; } };
}

async function activeUser(f) {
  await f.service.register({ email: 'Player@Example.com', password: 'correct horse battery staple' });
  f.service.verifyEmail({ email: 'player@example.com', code: f.delivered[0].code });
  return f.service.login({ email: 'player@example.com', password: 'correct horse battery staple' });
}

test('configuration rejects public listeners and weak secrets', () => {
  assert.throws(() => loadConfig({ HOST: '0.0.0.0', TOKEN_PEPPER: 'x'.repeat(32) }), { code: 'INVALID_CONFIG' });
  assert.throws(() => loadConfig({ TOKEN_PEPPER: 'short' }), { code: 'INVALID_CONFIG' });
});

test('registration requires unexpired email verification and stores no plaintext secrets', async () => {
  const f = fixture();
  const pending = await f.service.register({ email: 'Player@Example.com', password: 'correct horse battery staple' });
  assert.equal(pending.status, 'pending_email_verification');
  assert.equal(pending.passwordHash, undefined);
  assert.equal(pending.verification, undefined);
  const stored = f.users.getByEmail('player@example.com');
  assert.match(stored.passwordHash, /^scrypt\$/);
  assert.notEqual(stored.passwordHash, 'correct horse battery staple');
  assert.notEqual(stored.verification.codeHash, f.delivered[0].code);
  await assert.rejects(f.service.login({ email: 'player@example.com', password: 'correct horse battery staple' }), { code: 'EMAIL_NOT_VERIFIED' });
  f.service.verifyEmail({ email: 'player@example.com', code: f.delivered[0].code });
  const auth = await f.service.login({ email: 'player@example.com', password: 'correct horse battery staple' });
  assert.equal(f.service.authenticate(auth.accessToken).userId, stored.id);

  const expired = fixture();
  await expired.service.register({ email: 'later@example.com', password: 'correct horse battery staple' });
  expired.advance(1000);
  assert.throws(() => expired.service.verifyEmail({ email: 'later@example.com', code: expired.delivered[0].code }), { code: 'VERIFICATION_EXPIRED' });
});

test('refresh tokens rotate, cannot be reused, and family revocation invalidates descendants', async () => {
  const f = fixture();
  const first = await activeUser(f);
  const oldStored = f.sessions.get(first.sessionId);
  assert.notEqual(oldStored.refreshHash, first.refreshToken);
  const second = f.service.refresh(first.refreshToken);
  assert.throws(() => f.service.refresh(first.refreshToken), { code: 'REFRESH_REVOKED' });
  assert.throws(() => f.service.authenticate(second.accessToken), { code: 'INVALID_ACCESS_TOKEN' });
  assert.throws(() => f.service.refresh(second.refreshToken), { code: 'REFRESH_REVOKED' });

  const independent = await f.service.login({ email: 'player@example.com', password: 'correct horse battery staple' });
  f.service.revoke(independent.refreshToken);
  assert.throws(() => f.service.authenticate(independent.accessToken), { code: 'INVALID_ACCESS_TOKEN' });
});

test('cloud save snapshots expose metadata and enforce optimistic concurrency', async () => {
  const f = fixture();
  const auth = await activeUser(f);
  const v1 = f.service.createCloudSave(auth.accessToken, { id: 'world-1', name: 'My World', data: Buffer.from('one') });
  assert.equal(v1.version, 1);
  const v2 = f.service.putCloudSnapshot(auth.accessToken, 'world-1', { expectedVersion: 1, data: Buffer.from('two') });
  assert.equal(v2.version, 2);
  assert.throws(() => f.service.putCloudSnapshot(auth.accessToken, 'world-1', {
    expectedVersion: 1, data: Buffer.from('stale')
  }), { code: 'VERSION_CONFLICT' });
  assert.equal(f.service.getCloudSnapshot(auth.accessToken, 'world-1', 1).data.toString(), 'one');
  assert.equal(f.service.getCloudSnapshot(auth.accessToken, 'world-1', 2).data.toString(), 'two');
  assert.deepEqual(f.service.listCloudSaves(auth.accessToken).map(({ id, version }) => ({ id, version })), [{ id: 'world-1', version: 2 }]);
});
