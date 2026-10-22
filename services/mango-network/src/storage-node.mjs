import { createHash, createHmac, randomUUID } from 'node:crypto';

const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class StorageProtocolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'StorageProtocolError';
    this.code = code;
    this.details = details;
  }
}

function reject(code, message, details) {
  throw new StorageProtocolError(code, message, details);
}

export function validateObjectKey(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) reject('INVALID_OBJECT_KEY', 'object key must contain 1-512 ASCII characters');
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//') || value.includes('\\') || value.includes('%')) {
    reject('INVALID_OBJECT_KEY', 'object key is not canonical');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || !KEY_SEGMENT.test(segment))) {
    reject('INVALID_OBJECT_KEY', 'object key contains an unsafe segment');
  }
  return value;
}

export function encodeObjectKey(value) {
  return validateObjectKey(value).split('/').map(encodeURIComponent).join('/');
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseDate(value, field) {
  if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) reject('INVALID_RESPONSE', `${field} must be an ISO date`);
  return value;
}

function validateMetadata(value, expectedKey, { deleted = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('INVALID_RESPONSE', 'object metadata is missing');
  if (value.objectKey !== expectedKey) reject('INVALID_RESPONSE', 'response object key does not match request');
  if (!Number.isSafeInteger(value.size) || value.size < 0) reject('INVALID_RESPONSE', 'metadata size is invalid');
  if (!SHA256.test(value.checksumSha256 ?? '')) reject('INVALID_RESPONSE', 'metadata checksum is invalid');
  if (typeof value.contentType !== 'string' || !value.contentType || value.contentType.length > 255) reject('INVALID_RESPONSE', 'metadata content type is invalid');
  if (!VERSION.test(value.storageVersion ?? '')) reject('INVALID_RESPONSE', 'metadata storage version is invalid');
  parseDate(value.updatedAt, 'updatedAt');
  if (deleted) parseDate(value.deletedAt, 'deletedAt');
  else if (value.deletedAt != null) reject('INVALID_RESPONSE', 'live object cannot have deletedAt');
  return Object.freeze({
    objectKey: value.objectKey,
    size: value.size,
    checksumSha256: value.checksumSha256,
    contentType: value.contentType,
    storageVersion: value.storageVersion,
    updatedAt: value.updatedAt,
    deletedAt: value.deletedAt ?? null
  });
}

async function parseJson(response) {
  const type = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(type)) reject('INVALID_RESPONSE', 'storage node response must be JSON');
  try {
    return await response.json();
  } catch {
    reject('INVALID_RESPONSE', 'storage node returned malformed JSON');
  }
}

function parseDownloadMetadata(headers, objectKey) {
  const rawSize = headers.get('x-mango-object-size');
  const size = rawSize != null && /^\d+$/.test(rawSize) ? Number(rawSize) : NaN;
  return validateMetadata({
    objectKey: headers.get('x-mango-object-key'),
    size,
    checksumSha256: headers.get('x-mango-content-sha256'),
    contentType: headers.get('content-type'),
    storageVersion: headers.get('x-mango-storage-version'),
    updatedAt: headers.get('x-mango-updated-at'),
    deletedAt: null
  }, objectKey);
}

export class StorageNodeClient {
  constructor({ baseUrl, keyId, secret, fetch: fetchImpl, clock = () => Date.now(), nonce = () => randomUUID(), maxObjectBytes = 64 * 1024 * 1024 }) {
    let parsed;
    try { parsed = new URL(baseUrl); } catch { throw new TypeError('baseUrl must be an absolute URL'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError('baseUrl must be a clean HTTP(S) URL');
    if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) throw new TypeError('non-loopback storage nodes require HTTPS');
    if (typeof keyId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new TypeError('keyId is invalid');
    if (typeof secret !== 'string' && !Buffer.isBuffer(secret)) throw new TypeError('secret must be a string or Buffer');
    if (Buffer.byteLength(secret) < 32) throw new TypeError('secret must contain at least 32 bytes');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch must be injected');
    if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 0) throw new TypeError('maxObjectBytes is invalid');
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/`;
    this.baseUrl = parsed;
    this.keyId = keyId;
    this.secret = secret;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.nonce = nonce;
    this.maxObjectBytes = maxObjectBytes;
  }

  async upload(objectKey, data, { contentType = 'application/octet-stream', ifStorageVersion } = {}) {
    validateObjectKey(objectKey);
    if (!(data instanceof Uint8Array)) throw new TypeError('data must be a Uint8Array');
    if (data.byteLength > this.maxObjectBytes) reject('OBJECT_TOO_LARGE', 'object exceeds configured size limit');
    if (typeof contentType !== 'string' || !contentType || contentType.length > 255 || /[\r\n]/.test(contentType)) throw new TypeError('contentType is invalid');
    if (ifStorageVersion !== undefined && !VERSION.test(ifStorageVersion)) throw new TypeError('ifStorageVersion is invalid');
    const bytes = Buffer.from(data);
    const checksumSha256 = digest(bytes);
    const headers = { 'content-type': contentType, 'x-mango-content-sha256': checksumSha256 };
    if (ifStorageVersion) headers['if-match'] = `"${ifStorageVersion}"`;
    const response = await this.#request('PUT', objectKey, bytes, headers);
    const payload = await parseJson(response);
    const metadata = validateMetadata(payload.object, objectKey);
    if (metadata.size !== bytes.length || metadata.checksumSha256 !== checksumSha256 || metadata.contentType !== contentType) {
      reject('INVALID_RESPONSE', 'uploaded object metadata does not match request');
    }
    return metadata;
  }

  async download(objectKey, { ifStorageVersion } = {}) {
    validateObjectKey(objectKey);
    if (ifStorageVersion !== undefined && !VERSION.test(ifStorageVersion)) throw new TypeError('ifStorageVersion is invalid');
    const headers = ifStorageVersion ? { 'if-none-match': `"${ifStorageVersion}"` } : {};
    const response = await this.#request('GET', objectKey, Buffer.alloc(0), headers);
    const metadata = parseDownloadMetadata(response.headers, objectKey);
    if (metadata.size > this.maxObjectBytes) reject('OBJECT_TOO_LARGE', 'downloaded object exceeds configured size limit');
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length !== metadata.size || digest(data) !== metadata.checksumSha256) reject('INVALID_RESPONSE', 'download body does not match signed metadata');
    return Object.freeze({ metadata, data });
  }

  async delete(objectKey, { ifStorageVersion } = {}) {
    validateObjectKey(objectKey);
    if (ifStorageVersion !== undefined && !VERSION.test(ifStorageVersion)) throw new TypeError('ifStorageVersion is invalid');
    const headers = ifStorageVersion ? { 'if-match': `"${ifStorageVersion}"` } : {};
    const response = await this.#request('DELETE', objectKey, Buffer.alloc(0), headers);
    const payload = await parseJson(response);
    return validateMetadata(payload.object, objectKey, { deleted: true });
  }

  async #request(method, objectKey, body, extraHeaders) {
    const url = new URL(`v1/objects/${encodeObjectKey(objectKey)}`, this.baseUrl);
    const timestamp = String(this.clock());
    const nonce = String(this.nonce());
    if (!/^\d{13}$/.test(timestamp)) throw new TypeError('clock must return Unix time in milliseconds');
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(nonce)) throw new TypeError('nonce is invalid');
    const bodyHash = digest(body);
    const canonical = [method, `${url.pathname}${url.search}`, timestamp, nonce, bodyHash].join('\n');
    const signature = createHmac('sha256', this.secret).update(canonical).digest('hex');
    const headers = {
      accept: 'application/json',
      ...extraHeaders,
      'x-mango-date': timestamp,
      'x-mango-nonce': nonce,
      'x-mango-body-sha256': bodyHash,
      authorization: `Mango-HMAC ${this.keyId}:${signature}`
    };
    let response;
    try {
      response = await this.fetch(url, { method, headers, body: method === 'GET' || method === 'DELETE' ? undefined : body, redirect: 'error' });
    } catch (cause) {
      reject('STORAGE_UNAVAILABLE', 'storage node request failed', { cause });
    }
    if (!(response instanceof Response) && (!response || typeof response.status !== 'number' || !response.headers)) reject('INVALID_RESPONSE', 'fetch returned an invalid response');
    if (response.status < 200 || response.status >= 300) {
      let remote;
      try { remote = await response.json(); } catch { remote = undefined; }
      reject('STORAGE_REJECTED', 'storage node rejected request', { status: response.status, code: remote?.error?.code });
    }
    return response;
  }
}
