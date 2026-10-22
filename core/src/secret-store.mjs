import { createCredentialRef } from './account-model.mjs';

function secretId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError('secret id is invalid');
  }
  return value;
}

function copySecret(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('secret must be a non-null object');
  }
  const copy = structuredClone(value);
  if (Object.keys(copy).length === 0) throw new TypeError('secret must not be empty');
  return copy;
}

/** Interface implemented by platform-backed credential storage. */
export class SecretStore {
  async put(_id, _secret) { throw new Error('SecretStore.put is not implemented'); }
  async get(_ref) { throw new Error('SecretStore.get is not implemented'); }
  async delete(_ref) { throw new Error('SecretStore.delete is not implemented'); }
}

/** Test/development implementation. Secrets live only in this process. */
export class MemorySecretStore extends SecretStore {
  #storeId;
  #secrets = new Map();

  constructor(storeId = 'memory') {
    super();
    this.#storeId = createCredentialRef({ store: storeId, id: 'validation' }).store;
  }

  async put(id, secret) {
    const normalizedId = secretId(id);
    this.#secrets.set(normalizedId, copySecret(secret));
    return createCredentialRef({ store: this.#storeId, id: normalizedId });
  }

  async get(ref) {
    const normalized = createCredentialRef(ref);
    if (normalized.store !== this.#storeId) throw new TypeError('credentialRef belongs to another store');
    const value = this.#secrets.get(normalized.id);
    return value === undefined ? null : copySecret(value);
  }

  async delete(ref) {
    const normalized = createCredentialRef(ref);
    if (normalized.store !== this.#storeId) throw new TypeError('credentialRef belongs to another store');
    return this.#secrets.delete(normalized.id);
  }

  async clear() {
    this.#secrets.clear();
  }
}
