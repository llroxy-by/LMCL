import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { describePostgresMigrations, generatePostgresDDL } from '../src/persistence-schema.mjs';
import { encodeObjectKey, StorageNodeClient, validateObjectKey } from '../src/storage-node.mjs';

const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' }
});

function metadata(objectKey, data, overrides = {}) {
  return {
    objectKey,
    size: data.length,
    checksumSha256: checksum(data),
    contentType: 'application/octet-stream',
    storageVersion: 'version-1',
    updatedAt: '2025-01-02T03:04:05.000Z',
    deletedAt: null,
    ...overrides
  };
}

function client(fetch) {
  return new StorageNodeClient({
    baseUrl: 'https://friend.example/storage/',
    keyId: 'friend-a',
    secret: 'test-secret-with-at-least-thirty-two-bytes',
    fetch,
    clock: () => 1_735_786_800_000,
    nonce: () => 'nonce-12345678'
  });
}

test('PostgreSQL migration description and DDL include durable constraints', () => {
  const migrations = describePostgresMigrations();
  assert.deepEqual(migrations.map(({ version }) => version), [1, 2]);
  migrations[0].statements.push('caller mutation');
  assert.equal(describePostgresMigrations()[0].statements.includes('caller mutation'), false);

  const ddl = generatePostgresDDL({ schema: 'mango_network' });
  assert.match(ddl, /CREATE TABLE users/);
  assert.match(ddl, /CREATE UNIQUE INDEX users_email_uq/);
  assert.match(ddl, /FOREIGN KEY \(user_id, save_id\).*ON DELETE CASCADE/);
  assert.match(ddl, /checksum_sha256 char\(64\).*\^\[0-9a-f\]\{64\}\$/);
  assert.match(ddl, /CREATE TABLE storage_objects/);
  assert.match(ddl, /INSERT INTO schema_migrations \(version, name\) VALUES \(2,/);
  assert.equal(generatePostgresDDL({ fromVersion: 1 }).includes('CREATE TABLE users'), false);
  assert.throws(() => generatePostgresDDL({ schema: 'public; DROP TABLE users' }), TypeError);
});

test('object keys are canonical and traversal-safe', () => {
  assert.equal(validateObjectKey('users/u-1/saves/world_1/v1.bin'), 'users/u-1/saves/world_1/v1.bin');
  assert.equal(encodeObjectKey('users/u-1/v1.bin'), 'users/u-1/v1.bin');
  for (const key of ['', '/absolute', 'trailing/', 'a//b', 'a/../b', 'a/./b', 'a\\b', 'a/%2e%2e/b', 'a/space here']) {
    assert.throws(() => validateObjectKey(key), { code: 'INVALID_OBJECT_KEY' });
  }
});

test('upload signs the canonical request and validates returned metadata', async () => {
  const body = Buffer.from('snapshot-data');
  let observed;
  const storage = client(async (url, init) => {
    observed = { url, init };
    return jsonResponse({ object: metadata('users/u-1/save.bin', body) });
  });

  const result = await storage.upload('users/u-1/save.bin', body);
  assert.equal(result.storageVersion, 'version-1');
  assert.equal(observed.url.href, 'https://friend.example/storage/v1/objects/users/u-1/save.bin');
  assert.equal(observed.init.redirect, 'error');
  assert.deepEqual(Buffer.from(observed.init.body), body);
  const bodyHash = checksum(body);
  const canonical = ['PUT', '/storage/v1/objects/users/u-1/save.bin', '1735786800000', 'nonce-12345678', bodyHash].join('\n');
  const signature = createHmac('sha256', 'test-secret-with-at-least-thirty-two-bytes').update(canonical).digest('hex');
  assert.equal(observed.init.headers.authorization, `Mango-HMAC friend-a:${signature}`);
  assert.equal(observed.init.headers['x-mango-body-sha256'], bodyHash);
});

test('download verifies metadata, length, and checksum', async () => {
  const body = Buffer.from('trusted bytes');
  const headers = {
    'content-type': 'application/octet-stream',
    'x-mango-object-key': 'users/u/data.bin',
    'x-mango-object-size': String(body.length),
    'x-mango-content-sha256': checksum(body),
    'x-mango-storage-version': 'v2',
    'x-mango-updated-at': '2025-01-02T03:04:05.000Z'
  };
  const storage = client(async () => new Response(body, { status: 200, headers }));
  const downloaded = await storage.download('users/u/data.bin');
  assert.deepEqual(downloaded.data, body);
  assert.equal(downloaded.metadata.size, body.length);

  const corrupt = client(async () => new Response(Buffer.from('tampered'), { status: 200, headers }));
  await assert.rejects(corrupt.download('users/u/data.bin'), { code: 'INVALID_RESPONSE' });
});

test('delete returns tombstone metadata and remote failures are normalized', async () => {
  const empty = Buffer.alloc(0);
  const storage = client(async (_url, init) => {
    assert.equal(init.method, 'DELETE');
    return jsonResponse({ object: metadata('users/u/old.bin', empty, {
      storageVersion: 'v3', deletedAt: '2025-01-02T03:05:00.000Z'
    }) });
  });
  const deleted = await storage.delete('users/u/old.bin', { ifStorageVersion: 'v2' });
  assert.equal(deleted.deletedAt, '2025-01-02T03:05:00.000Z');

  const denied = client(async () => jsonResponse({ error: { code: 'signature_expired' } }, 401));
  await assert.rejects(denied.download('users/u/old.bin'), (error) => {
    assert.equal(error.code, 'STORAGE_REJECTED');
    assert.deepEqual(error.details, { status: 401, code: 'signature_expired' });
    return true;
  });
});

test('client requires injected fetch, strong secret, and HTTPS off loopback', () => {
  const base = { baseUrl: 'https://friend.example', keyId: 'k', secret: 'x'.repeat(32), fetch: async () => {} };
  assert.throws(() => new StorageNodeClient({ ...base, fetch: undefined }), /fetch must be injected/);
  assert.throws(() => new StorageNodeClient({ ...base, secret: 'short' }), /at least 32 bytes/);
  assert.throws(() => new StorageNodeClient({ ...base, baseUrl: 'http://friend.example' }), /require HTTPS/);
  assert.doesNotThrow(() => new StorageNodeClient({ ...base, baseUrl: 'http://127.0.0.1:9000' }));
});
