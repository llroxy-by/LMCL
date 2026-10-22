const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOKEN_LENGTH = 8192;
const MAX_PROFILES = 100;
const PROFILE_ID = /^[0-9a-fA-F]{32}$/;
const PROFILE_NAME = /^[^\u0000-\u001f\u007f]{1,16}$/u;
const SAFE_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

export class YggdrasilAuthError extends Error {
  constructor(message, { operation, status = null, code = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'YggdrasilAuthError';
    this.operation = operation;
    this.status = status;
    this.code = code;
  }
}

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${name} contains unsupported field: ${key}`);
  }
}

function nonEmptyString(value, name, maxLength = MAX_TOKEN_LENGTH) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

/** Validates an authentication API root without performing DNS or network I/O. */
export function validateYggdrasilApiRoot(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('apiRoot must be a valid URL'); }
  if (url.protocol !== 'https:') throw new TypeError('apiRoot must use HTTPS');
  if (url.username || url.password) throw new TypeError('apiRoot must not contain credentials');
  if (url.search || url.hash) throw new TypeError('apiRoot must not contain a query or fragment');
  if (!url.hostname || url.hostname.endsWith('.') || /^(?:localhost|.*\.localhost|.*\.local)$/iu.test(url.hostname)) {
    throw new TypeError('apiRoot hostname is not allowed');
  }
  // Literal addresses make accidental access to loopback/link-local/private services too easy.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    throw new TypeError('apiRoot must use a public DNS hostname');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  if (!url.pathname) url.pathname = '';
  return url.toString().replace(/\/$/u, '');
}

function endpoint(apiRoot, operation) {
  const url = new URL(`${apiRoot}/${operation}`);
  // Defensive invariant: endpoint construction may never change origin.
  if (url.origin !== new URL(apiRoot).origin) throw new TypeError('unsafe authentication endpoint');
  return url.toString();
}

function profile(value, name = 'profile') {
  object(value, name);
  exactKeys(value, ['id', 'name'], name);
  if (typeof value.id !== 'string' || !PROFILE_ID.test(value.id)) throw new TypeError(`${name}.id is invalid`);
  if (typeof value.name !== 'string' || !PROFILE_NAME.test(value.name)) throw new TypeError(`${name}.name is invalid`);
  return Object.freeze({ id: value.id.toLowerCase(), name: value.name });
}

function profiles(value) {
  if (!Array.isArray(value) || value.length > MAX_PROFILES) throw new TypeError('availableProfiles is invalid');
  const result = value.map((item, index) => profile(item, `availableProfiles[${index}]`));
  if (new Set(result.map(item => item.id)).size !== result.length) throw new TypeError('availableProfiles contains duplicate ids');
  return Object.freeze(result);
}

function authResult(value, operation) {
  object(value, `${operation} response`);
  const accessToken = nonEmptyString(value.accessToken, 'accessToken');
  const clientToken = nonEmptyString(value.clientToken, 'clientToken');
  const availableProfiles = value.availableProfiles === undefined ? Object.freeze([]) : profiles(value.availableProfiles);
  const selectedProfile = value.selectedProfile == null ? null : profile(value.selectedProfile, 'selectedProfile');
  if (selectedProfile && availableProfiles.length && !availableProfiles.some(item => item.id === selectedProfile.id)) {
    throw new TypeError('selectedProfile is not in availableProfiles');
  }
  return Object.freeze({ accessToken, clientToken, availableProfiles, selectedProfile });
}

function credentials(value, includePassword, operation, allowed) {
  object(value, `${operation} options`);
  exactKeys(value, allowed, `${operation} options`);
  if (includePassword) {
    const username = nonEmptyString(value.username, 'username', 320);
    if (typeof value.password !== 'string' || value.password.length === 0 || value.password.length > MAX_TOKEN_LENGTH) {
      throw new TypeError('password is invalid');
    }
    return { username, password: value.password };
  }
  return {
    accessToken: nonEmptyString(value.accessToken, 'accessToken'),
    clientToken: nonEmptyString(value.clientToken, 'clientToken'),
  };
}

async function readLimited(response, maximum) {
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined && (/^\d+$/u.test(declared) === false || Number(declared) > maximum)) {
    throw new TypeError('authentication response is too large');
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximum) throw new TypeError('authentication response is too large');
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
  if (new TextEncoder().encode(text).byteLength > maximum) throw new TypeError('authentication response is too large');
  return text;
}

function safeServerCode(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.error === 'string' && SAFE_ERROR_CODE.test(parsed.error) ? parsed.error : null;
  } catch { return null; }
}

/** Creates a stateless Yggdrasil protocol client. Passwords are only placed in request bodies. */
export function createYggdrasilAuth(options) {
  object(options, 'options');
  exactKeys(options, ['apiRoot', 'baseUrl', 'fetch', 'maxResponseBytes'], 'options');
  const apiRoot = validateYggdrasilApiRoot(options.apiRoot ?? options.baseUrl);
  const fetchImpl = options.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('options.fetch must be a function');
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 16 * 1024 * 1024) {
    throw new TypeError('maxResponseBytes is invalid');
  }

  async function request(operation, payload, { empty = false, invalidIsFalse = false } = {}) {
    let response;
    try {
      response = await fetchImpl(endpoint(apiRoot, operation), {
        method: 'POST',
        headers: Object.freeze({ 'content-type': 'application/json', accept: 'application/json' }),
        body: JSON.stringify(payload),
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch (cause) {
      // Do not retain the injected fetch error: an adapter may include the secret request body in it.
      throw new YggdrasilAuthError(`Yggdrasil ${operation} request failed`, { operation });
    }
    if (!response || typeof response.status !== 'number') {
      throw new YggdrasilAuthError(`Yggdrasil ${operation} returned an invalid response`, { operation });
    }
    let text;
    try { text = await readLimited(response, maxResponseBytes); }
    catch (cause) { throw new YggdrasilAuthError(`Yggdrasil ${operation} response was rejected`, { operation, status: response.status, cause }); }
    if (invalidIsFalse && (response.status === 401 || response.status === 403)) return false;
    if (response.status < 200 || response.status >= 300) {
      throw new YggdrasilAuthError(`Yggdrasil ${operation} was rejected`, {
        operation, status: response.status, code: safeServerCode(text),
      });
    }
    if (empty) {
      if (text.trim() !== '') throw new YggdrasilAuthError(`Yggdrasil ${operation} returned unexpected content`, { operation, status: response.status });
      return true;
    }
    try { return JSON.parse(text); }
    catch (cause) { throw new YggdrasilAuthError(`Yggdrasil ${operation} returned invalid JSON`, { operation, status: response.status, cause }); }
  }

  async function refresh(options) {
    const tokenPair = credentials(options, false, 'refresh', ['accessToken', 'clientToken', 'selectedProfile', 'requestUser']);
    const payload = { ...tokenPair };
    if (options.selectedProfile !== undefined) payload.selectedProfile = profile(options.selectedProfile, 'selectedProfile');
    if (options.requestUser !== undefined) {
      if (typeof options.requestUser !== 'boolean') throw new TypeError('requestUser must be boolean');
      payload.requestUser = options.requestUser;
    }
    return authResult(await request('refresh', payload), 'refresh');
  }

  async function selectProfile(session, selector) {
    object(session, 'session');
    const list = profiles(session.availableProfiles);
    let selected;
    if (typeof selector === 'string') {
      const normalized = selector.replaceAll('-', '').toLowerCase();
      selected = list.find(item => item.id === normalized || item.name === selector);
    } else {
      const wanted = profile(selector, 'selector');
      selected = list.find(item => item.id === wanted.id && item.name === wanted.name);
    }
    if (!selected) throw new TypeError('selected profile is not available');
    return refresh({ accessToken: session.accessToken, clientToken: session.clientToken, selectedProfile: selected });
  }

  return Object.freeze({
    apiRoot,
    async authenticate(options) {
      const login = credentials(options, true, 'authenticate', ['username', 'password', 'clientToken', 'requestUser', 'profile', 'profileId']);
      const payload = { agent: { name: 'Minecraft', version: 1 }, ...login };
      if (options.clientToken !== undefined) payload.clientToken = nonEmptyString(options.clientToken, 'clientToken');
      if (options.requestUser !== undefined) {
        if (typeof options.requestUser !== 'boolean') throw new TypeError('requestUser must be boolean');
        payload.requestUser = options.requestUser;
      }
      const result = authResult(await request('authenticate', payload), 'authenticate');
      const selector = options.profile ?? options.profileId;
      return selector === undefined ? result : selectProfile(result, selector);
    },
    refresh,
    async validate(options) {
      const tokenPair = credentials(options, false, 'validate', ['accessToken', 'clientToken']);
      return request('validate', tokenPair, { empty: true, invalidIsFalse: true });
    },
    async invalidate(options) {
      const tokenPair = credentials(options, false, 'invalidate', ['accessToken', 'clientToken']);
      return request('invalidate', tokenPair, { empty: true });
    },
    async signout(options) {
      const login = credentials(options, true, 'signout', ['username', 'password']);
      return request('signout', login, { empty: true });
    },
    selectProfile,
  });
}

export const createYggdrasilClient = createYggdrasilAuth;
