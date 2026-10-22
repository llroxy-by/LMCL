const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;
const DEFAULT_MAX_BASE64_BYTES = 16 * 1024 * 1024;
const MAX_LIMIT = 64 * 1024 * 1024;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class MangoClientError extends Error {
  constructor(message, { operation, status = null, code = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'MangoClientError';
    this.operation = operation;
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }

  toJSON() {
    return { name: this.name, message: this.message, operation: this.operation,
      status: this.status, code: this.code, retryAfter: this.retryAfter };
  }
}

function plainObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${name} must be a plain object`);
  return value;
}

function positiveLimit(value, fallback, name) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) throw new TypeError(`${name} is invalid`);
  return value;
}

/** Validate and canonicalize an API root without performing network or DNS I/O. */
export function validateMangoApiRoot(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('apiRoot must be a valid URL'); }
  if (url.protocol !== 'https:') throw new TypeError('apiRoot must use HTTPS');
  if (url.username || url.password) throw new TypeError('apiRoot must not contain credentials');
  if (url.search || url.hash) throw new TypeError('apiRoot must not contain a query or fragment');
  if (!url.hostname || url.hostname.endsWith('.') || /^(?:localhost|.*\.localhost|.*\.local)$/iu.test(url.hostname)) {
    throw new TypeError('apiRoot hostname is not allowed');
  }
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.includes(':')) {
    throw new TypeError('apiRoot must use a public DNS hostname');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/$/u, '');
}

function endpoint(root, path) {
  const base = new URL(`${root}/`);
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new TypeError('unsafe Mango endpoint');
  return url.toString();
}

function checkedId(value) {
  if (typeof value !== 'string' || !RESOURCE_ID.test(value)) throw new TypeError('id is invalid');
  return value;
}

function utf8Size(text) { return new TextEncoder().encode(text).byteLength; }

function encodeJson(value, maximum, name = 'request body') {
  let text;
  try { text = JSON.stringify(value); } catch { throw new TypeError(`${name} is not JSON serializable`); }
  if (text === undefined || utf8Size(text) > maximum) throw new TypeError(`${name} is too large`);
  return text;
}

async function readLimited(response, maximum) {
  const declared = response.headers?.get?.('content-length');
  if (declared != null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) throw new TypeError('response is too large');
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximum) throw new TypeError('response is too large');
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  if (typeof response.text !== 'function') throw new TypeError('fetch returned an invalid response');
  const text = await response.text();
  if (utf8Size(text) > maximum) throw new TypeError('response is too large');
  return text;
}

function safeCode(text) {
  try {
    const value = JSON.parse(text);
    const code = value?.error?.code ?? value?.code ?? (typeof value?.error === 'string' ? value.error : null);
    return typeof code === 'string' && SAFE_CODE.test(code) ? code : null;
  } catch { return null; }
}

function retryAfter(response) {
  const value = response.headers?.get?.('retry-after');
  return typeof value === 'string' && /^[\x20-\x7e]{1,128}$/u.test(value) ? value : null;
}

function bearer(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new TypeError('accessToken is invalid');
  }
  return value;
}

function splitAuthenticatedOptions(value, name) {
  plainObject(value, `${name} options`);
  const accessToken = bearer(value.accessToken ?? value.token);
  const body = {};
  for (const [key, item] of Object.entries(value)) if (key !== 'accessToken' && key !== 'token') body[key] = item;
  return { accessToken, body };
}

function validBase64(value, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maximum / 3) * 4 + 4 ||
      value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError('download data is invalid base64');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if ((value.length / 4) * 3 - padding > maximum) throw new TypeError('download data is too large');
  return value;
}

function validateBodyBase64(body, maximum) {
  for (const key of ['data', 'content', 'base64', 'contentBase64']) {
    if (body[key] !== undefined) validBase64(body[key], maximum);
  }
}

function decodeBase64(value) {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Create a stateless Mango Network client. Tokens are supplied per call and are
 * never retained. onRefresh is called at most once after an authenticated 401.
 */
export function createMangoClient(options) {
  plainObject(options, 'options');
  const apiRoot = validateMangoApiRoot(options.apiRoot ?? options.baseUrl);
  const fetchImpl = options.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('options.fetch must be a function');
  const onRefresh = options.onRefresh ?? options.refreshAccessToken;
  if (onRefresh !== undefined && typeof onRefresh !== 'function') throw new TypeError('options.onRefresh must be a function');
  const maxJsonBytes = positiveLimit(options.maxJsonBytes ?? options.maxResponseBytes, DEFAULT_MAX_JSON_BYTES, 'maxJsonBytes');
  const maxBase64Bytes = positiveLimit(options.maxBase64Bytes, DEFAULT_MAX_BASE64_BYTES, 'maxBase64Bytes');

  async function request(operation, path, { method = 'POST', body, accessToken, retry = true } = {}) {
    const headers = { accept: 'application/json' };
    let encoded;
    if (body !== undefined) {
      encoded = encodeJson(body, maxJsonBytes);
      headers['content-type'] = 'application/json';
    }
    if (accessToken !== undefined) headers.authorization = `Bearer ${bearer(accessToken)}`;
    let response;
    try {
      response = await fetchImpl(endpoint(apiRoot, path), {
        method, headers: Object.freeze(headers), ...(encoded === undefined ? {} : { body: encoded }),
        redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new MangoClientError(`Mango ${operation} request failed`, { operation });
    }
    if (!response || typeof response.status !== 'number') {
      throw new MangoClientError(`Mango ${operation} returned an invalid response`, { operation });
    }
    if (response.status === 401 && accessToken !== undefined && retry && onRefresh) {
      let replacement;
      try { replacement = await onRefresh(Object.freeze({ operation, accessToken })); }
      catch { throw new MangoClientError(`Mango ${operation} token refresh failed`, { operation, status: 401 }); }
      const token = typeof replacement === 'string' ? replacement : replacement?.accessToken ?? replacement?.token;
      if (token !== undefined) return request(operation, path, { method, body, accessToken: bearer(token), retry: false });
    }
    let text;
    try { text = await readLimited(response, maxJsonBytes); }
    catch { throw new MangoClientError(`Mango ${operation} response was rejected`, { operation, status: response.status }); }
    if (response.status < 200 || response.status >= 300) {
      throw new MangoClientError(`Mango ${operation} was rejected`, {
        operation, status: response.status, code: safeCode(text), retryAfter: retryAfter(response),
      });
    }
    if (text.trim() === '') return null;
    try { return JSON.parse(text); }
    catch { throw new MangoClientError(`Mango ${operation} returned invalid JSON`, { operation, status: response.status }); }
  }

  function publicPost(operation, path, value) {
    plainObject(value, `${operation} options`);
    return request(operation, path, { body: value });
  }

  return Object.freeze({
    apiRoot,
    register: value => publicPost('register', 'v1/auth/register', value),
    verify: value => publicPost('verify', 'v1/auth/verify', value),
    login: value => publicPost('login', 'v1/auth/login', value),
    refresh: value => publicPost('refresh', 'v1/auth/refresh', value),
    async logout(value) {
      const { accessToken, body } = splitAuthenticatedOptions(value, 'logout');
      return request('logout', 'v1/auth/logout', { body, accessToken });
    },
    async list(value) {
      const { accessToken, body } = splitAuthenticatedOptions(value, 'list');
      if (Object.keys(body).length) throw new TypeError('list options contains unsupported fields');
      return request('list', 'v1/saves', { method: 'GET', accessToken });
    },
    async create(value) {
      const { accessToken, body } = splitAuthenticatedOptions(value, 'create');
      validateBodyBase64(body, maxBase64Bytes);
      return request('create', 'v1/saves', { body, accessToken });
    },
    async update(id, value) {
      if (value === undefined) { value = id; plainObject(value, 'update options'); id = value.id; }
      const { accessToken, body } = splitAuthenticatedOptions(value, 'update');
      delete body.id;
      validateBodyBase64(body, maxBase64Bytes);
      return request('update', `v1/saves/${encodeURIComponent(checkedId(id))}`, { method: 'PUT', body, accessToken });
    },
    async download(id, value) {
      if (value === undefined) { value = id; plainObject(value, 'download options'); id = value.id; }
      const { accessToken, body } = splitAuthenticatedOptions(value, 'download');
      delete body.id;
      if (Object.keys(body).length) throw new TypeError('download options contains unsupported fields');
      const result = await request('download', `v1/saves/${encodeURIComponent(checkedId(id))}/download`, { method: 'GET', accessToken });
      const encoded = typeof result === 'string' ? result
        : result?.data ?? result?.content ?? result?.base64 ?? result?.contentBase64;
      return decodeBase64(validBase64(encoded, maxBase64Bytes));
    },
  });
}

export const createClient = createMangoClient;
