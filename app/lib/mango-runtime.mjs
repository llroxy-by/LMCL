import { createMangoClient, validateMangoApiRoot } from '../../core/src/mango-client.mjs';
import { createOfflineProfile } from '../../core/src/accounts.mjs';
import { migrateState } from './state-schema.mjs';

const SECRET_KEY = /^(?:password|token|accessToken|refreshToken)$/iu;
const CREDENTIAL_ID = 'mango-session';
const CREDENTIAL_REF = Object.freeze({ store: 'credential-vault', id: CREDENTIAL_ID });

function record(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function string(value, name, maximum = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function publicValue(value, depth = 0) {
  if (depth > 8) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.slice(0, 500).map(item => publicValue(item, depth + 1));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (!SECRET_KEY.test(key) && !/(?:password|token)/iu.test(key)) output[key] = publicValue(item, depth + 1);
    }
    return output;
  }
  return null;
}

function tokens(value, fallbackRefreshToken) {
  record(value, 'Mango authentication response');
  const accessToken = string(value.accessToken ?? value.token, 'Mango access token', 8192);
  const refreshToken = value.refreshToken === undefined
    ? fallbackRefreshToken
    : string(value.refreshToken, 'Mango refresh token', 8192);
  if (refreshToken === undefined) throw new TypeError('Mango refresh token is missing');
  return { accessToken, refreshToken };
}

function apiRootFrom(state) {
  const value = state?.settings?.mangoApiRoot;
  if (value === undefined || value === null || value === '') return '';
  return validateMangoApiRoot(value);
}

/** Migrate persisted state to v2 while preserving the non-secret Mango API setting. */
export function migrateRuntimeState(value) {
  record(value, 'state');
  const rawSettings = record(value.settings, 'state.settings');
  const mangoApiRoot = rawSettings.mangoApiRoot ?? '';
  if (typeof mangoApiRoot !== 'string') throw new TypeError('state.settings.mangoApiRoot must be a string');
  const base = structuredClone(value);
  delete base.settings.mangoApiRoot;
  const migrated = migrateState(base);
  const canonicalRoot = mangoApiRoot === '' ? '' : validateMangoApiRoot(mangoApiRoot);
  return {
    ...structuredClone(migrated),
    settings: { ...structuredClone(migrated.settings), mangoApiRoot: canonicalRoot },
  };
}

export function selectedOfflineProfile(state) {
  const account = state.accounts?.find(item => item.id === state.selectedAccountId);
  return account?.provider === 'offline' ? createOfflineProfile(account.profile.name) : null;
}

/** Renderer-safe state, including the legacy profile projection used by the current UI. */
export function runtimeSnapshot(state, additions = {}) {
  const copy = structuredClone(state);
  const snapshot = { ...copy, profile: selectedOfflineProfile(copy), ...structuredClone(additions) };
  const encoded = JSON.stringify(snapshot);
  if (/"(?:password|accessToken|refreshToken|token)"\s*:/iu.test(encoded)) throw new Error('snapshot contains credential material');
  return snapshot;
}

/** Main-process-only Mango session manager. It never returns or retains passwords. */
export class MangoRuntime {
  #getState;
  #vault;
  #fetch;
  #session = null;

  constructor({ getState, vault, fetch = globalThis.fetch }) {
    if (typeof getState !== 'function') throw new TypeError('getState is required');
    if (!vault || typeof vault.put !== 'function' || typeof vault.resolve !== 'function' || typeof vault.delete !== 'function') {
      throw new TypeError('vault is invalid');
    }
    if (typeof fetch !== 'function') throw new TypeError('fetch is required');
    this.#getState = getState;
    this.#vault = vault;
    this.#fetch = fetch;
  }

  #root() {
    const root = apiRootFrom(this.#getState());
    if (!root) throw new Error('Mango API 未配置');
    return root;
  }

  async #credentials() {
    const credential = await this.#vault.resolve(CREDENTIAL_REF);
    if (!credential) throw new Error('尚未登录 Mango');
    return tokens(credential);
  }

  async #store(value, fallbackRefreshToken) {
    const credential = tokens(value, fallbackRefreshToken);
    await this.#vault.put(CREDENTIAL_ID, credential);
    return credential;
  }

  #client(onRefresh) {
    return createMangoClient({ apiRoot: this.#root(), fetch: this.#fetch, ...(onRefresh ? { onRefresh } : {}) });
  }

  async register(email, password) {
    const result = await this.#client().register({ email: string(email, 'email', 320), password: string(password, 'password', 1024) });
    return publicValue(result);
  }

  async verify(email, code) {
    const result = await this.#client().verify({ email: string(email, 'email', 320), code: string(code, 'code', 128) });
    return publicValue(result);
  }

  async login(email, password) {
    const result = await this.#client().login({ email: string(email, 'email', 320), password: string(password, 'password', 1024) });
    await this.#store(result);
    this.#session = publicValue(result);
    return this.status();
  }

  async #authenticatedClient(credential) {
    return this.#client(async () => {
      const result = await this.#client().refresh({ refreshToken: credential.refreshToken });
      const replacement = await this.#store(result, credential.refreshToken);
      credential.accessToken = replacement.accessToken;
      credential.refreshToken = replacement.refreshToken;
      return replacement.accessToken;
    });
  }

  async logout() {
    const credential = await this.#vault.resolve(CREDENTIAL_REF);
    if (credential) {
      const normalized = tokens(credential);
      try { await this.#client().logout(normalized); }
      finally { await this.#vault.delete(CREDENTIAL_REF); }
    }
    this.#session = null;
    return { authenticated: false, configured: Boolean(apiRootFrom(this.#getState())) };
  }

  async status() {
    const configured = Boolean(apiRootFrom(this.#getState()));
    if (!configured) return { configured: false, authenticated: false };
    const credential = await this.#vault.resolve(CREDENTIAL_REF);
    return { configured: true, authenticated: Boolean(credential), ...(this.#session ? { session: publicValue(this.#session) } : {}) };
  }

  async saves() {
    const credential = await this.#credentials();
    const client = await this.#authenticatedClient(credential);
    return publicValue(await client.list({ accessToken: credential.accessToken }));
  }
}

export function createMangoRuntime(options) { return new MangoRuntime(options); }
