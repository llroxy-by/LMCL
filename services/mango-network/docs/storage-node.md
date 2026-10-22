# Mango Network persistence and friend storage-node protocol

This module defines production-oriented boundaries without opening a database or network connection. Applications own PostgreSQL execution, retries, pooling, secret loading, TLS policy, and server implementation.

## PostgreSQL schema

`src/persistence-schema.mjs` exports:

- `POSTGRES_MIGRATIONS`: immutable, ordered migration descriptors.
- `describePostgresMigrations()`: defensive copies suitable for a migration runner.
- `generatePostgresDDL({ schema, fromVersion, toVersion })`: PostgreSQL-first transactional DDL.

Migration 1 persists normalized users, hashed credentials/verification state, rotating sessions, cloud-save heads, and immutable snapshot metadata. Migration 2 tracks live/deleted storage objects. Primary, unique, foreign-key, format, state, non-negative size, timestamp-order, and checksum constraints are enforced in SQL. Snapshot bytes remain in object storage; `cloud_save_snapshots.object_key` links immutable versions to objects.

A production runner should acquire an advisory lock, read `schema_migrations`, apply each missing migration once in version order, and retain backups before destructive future migrations. The generated SQL intentionally uses plain `INSERT` for migration records so an accidental replay fails instead of silently succeeding. Do not interpolate untrusted schema names; the generator accepts only lowercase PostgreSQL identifiers.

## Storage client construction

```js
import { StorageNodeClient } from '../src/storage-node.mjs';

const storage = new StorageNodeClient({
  baseUrl: 'https://friend.example/mango/',
  keyId: 'node-a',
  secret: secretFromRuntime, // >= 32 bytes; never commit it
  fetch: applicationFetch,  // explicit injection; easy to mock
  maxObjectBytes: 64 * 1024 * 1024
});
```

HTTPS is mandatory except for loopback development. Redirect following is disabled to prevent signed requests or bodies from being forwarded to another origin. Apply egress allow-listing and DNS/IP controls outside this client if `baseUrl` is configurable.

## Object keys

Keys are 1–512 ASCII characters split by `/`. Each segment starts with an alphanumeric character and then contains only alphanumerics, `.`, `_`, or `-`. Absolute paths, empty segments, `.`/`..`, backslashes, percent escapes, whitespace, controls, and trailing slashes are rejected. Servers must apply the same validation and must never map a key to a filesystem path without an additional sandboxed mapping layer.

Recommended layout:

```text
users/{user-id}/saves/{save-id}/{version}-{sha256}.bin
```

## HTTP and HMAC protocol

Endpoints:

- `PUT {base}/v1/objects/{key}` uploads bytes and returns JSON metadata.
- `GET {base}/v1/objects/{key}` downloads bytes with metadata in headers.
- `DELETE {base}/v1/objects/{key}` creates a tombstone and returns JSON metadata.

Every request includes:

```text
X-Mango-Date: Unix milliseconds
X-Mango-Nonce: unique request nonce
X-Mango-Body-SHA256: lowercase hex SHA-256 of the exact body (empty for GET/DELETE)
Authorization: Mango-HMAC {keyId}:{lowercase hex signature}
```

The signature is `HMAC-SHA256(secret, canonical)` where canonical is the newline-joined string:

```text
METHOD
/path-and-query
X-Mango-Date
X-Mango-Nonce
X-Mango-Body-SHA256
```

The server should reject dates outside a narrow window (recommended ±5 minutes), store `(keyId, nonce)` until that window expires to prevent replay, compare signatures in constant time, hash the received body before accepting it, rate-limit key IDs, and support overlapping keys during rotation. Authorization is separate from authentication: constrain each key ID to allowed tenant/key prefixes.

Optional optimistic conditions use quoted storage versions:

- Upload/delete: `If-Match: "{storageVersion}"`.
- Download: `If-None-Match: "{storageVersion}"` (a server returning `304` is surfaced as a rejection; callers can decide whether to add cache semantics later).

## Metadata protocol

Successful upload JSON:

```json
{
  "object": {
    "objectKey": "users/u/saves/world/1.bin",
    "size": 123,
    "checksumSha256": "64-lowercase-hex-characters",
    "contentType": "application/octet-stream",
    "storageVersion": "opaque-version-1",
    "updatedAt": "2025-01-02T03:04:05.000Z",
    "deletedAt": null
  }
}
```

Delete returns the same shape with a non-null `deletedAt`. Download returns the raw body and these headers:

```text
Content-Type
X-Mango-Object-Key
X-Mango-Object-Size
X-Mango-Content-SHA256
X-Mango-Storage-Version
X-Mango-Updated-At
```

The client validates key equality, integer size, SHA-256 syntax, content type, storage version, dates, upload metadata against submitted bytes, and download length/checksum against the received body. Non-2xx responses become `STORAGE_REJECTED`; transport failures become `STORAGE_UNAVAILABLE`; malformed or inconsistent responses become `INVALID_RESPONSE`.

Recommended server error body:

```json
{ "error": { "code": "signature_expired", "message": "request date is outside the accepted window" } }
```

Do not place secrets, signatures, raw object contents, or user-sensitive keys in logs. Log request IDs, key IDs, status, latency, byte counts, and coarse error codes. Object deletion should be idempotent server-side, use tombstones for audit/replication, and defer physical reclamation according to retention policy.

## Testing

`test/persistence-storage.test.mjs` uses injected mock `fetch` functions only. It verifies DDL constraints, migration ranges, key traversal rejection, exact HMAC canonicalization, upload/download/delete metadata, checksum validation, normalized errors, and transport construction policy. No real PostgreSQL instance or storage server is contacted.
