import { createCredentialRef } from '../../core/src/account-model.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function record(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
}

function cloneCredential(value) {
  record(value, 'credential');
  try { return structuredClone(value); }
  catch { throw new TypeError('credential must be structured-cloneable'); }
}

function assertJSON(value, name = 'credential') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertJSON(item, name);
    return;
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new TypeError(`${name} contains an unsafe key`);
      assertJSON(item, name);
    }
    return;
  }
  throw new TypeError(`${name} must contain only JSON values`);
}

function validateDocument(value) {
  record(value, 'vault document');
  if (Object.keys(value).length !== 2 || value.schemaVersion !== 1 || !Object.hasOwn(value, 'credentials')) {
    throw new TypeError('unsupported vault document');
  }
  record(value.credentials, 'vault credentials');
  const credentials = Object.create(null);
  for (const [id, credential] of Object.entries(value.credentials)) {
    if (!ID.test(id)) throw new TypeError('vault contains an invalid credential id');
    assertJSON(credential);
    credentials[id] = cloneCredential(credential);
  }
  return credentials;
}

function missing(error) {
  return error?.code === 'ENOENT' || error?.name === 'NotFoundError';
}

/**
 * Encrypted single-file credential repository. Encryption and atomic file I/O
 * are adapters, so this pure module has no Electron or platform dependency.
 *
 * atomicIO must expose readFile(path) and writeFileAtomic(path, encryptedData).
 */
export class CredentialVault {
  #file;
  #storeId;
  #encrypt;
  #decrypt;
  #io;
  #queue = Promise.resolve();

  constructor({ file, storeId = 'credential-vault', encrypt, decrypt, atomicIO }) {
    if (typeof file !== 'string' || file.length === 0) throw new TypeError('file is required');
    if (!ID.test(storeId)) throw new TypeError('storeId is invalid');
    if (typeof encrypt !== 'function' || typeof decrypt !== 'function') throw new TypeError('encrypt and decrypt functions are required');
    if (!atomicIO || typeof atomicIO.readFile !== 'function' || typeof atomicIO.writeFileAtomic !== 'function') {
      throw new TypeError('atomicIO must provide readFile and writeFileAtomic');
    }
    this.#file = file;
    this.#storeId = storeId;
    this.#encrypt = encrypt;
    this.#decrypt = decrypt;
    this.#io = atomicIO;
  }

  #serial(operation) {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #load() {
    let encrypted;
    try { encrypted = await this.#io.readFile(this.#file); }
    catch (error) {
      if (missing(error)) return Object.create(null);
      throw error;
    }
    if (encrypted === null || encrypted === undefined) return Object.create(null);
    const plaintext = await this.#decrypt(encrypted);
    const text = typeof plaintext === 'string' ? plaintext : new TextDecoder().decode(plaintext);
    return validateDocument(JSON.parse(text));
  }

  async #save(credentials) {
    const plaintext = JSON.stringify({ schemaVersion: 1, credentials });
    const encrypted = await this.#encrypt(plaintext);
    if (!(typeof encrypted === 'string' || encrypted instanceof Uint8Array)) {
      throw new TypeError('encrypt must return a string or Uint8Array');
    }
    await this.#io.writeFileAtomic(this.#file, encrypted);
  }

  #reference(id) {
    return createCredentialRef(this.#storeId, id);
  }

  #id(reference) {
    const normalized = createCredentialRef(reference);
    if (normalized.store !== this.#storeId) throw new TypeError('credentialRef belongs to another vault');
    return normalized.id;
  }

  /** Stores secret material and returns only its opaque public locator. */
  put(id, credential) {
    if (typeof id !== 'string' || !ID.test(id)) return Promise.reject(new TypeError('credential id is invalid'));
    const copy = cloneCredential(credential);
    assertJSON(copy);
    return this.#serial(async () => {
      const credentials = await this.#load();
      credentials[id] = copy;
      await this.#save(credentials);
      return this.#reference(id);
    });
  }

  /** Resolves a locator at the trusted adapter boundary; null means absent. */
  resolve(reference) {
    let id;
    try { id = this.#id(reference); }
    catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const credentials = await this.#load();
      return Object.hasOwn(credentials, id) ? cloneCredential(credentials[id]) : null;
    });
  }

  get(reference) { return this.resolve(reference); }

  delete(reference) {
    let id;
    try { id = this.#id(reference); }
    catch (error) { return Promise.reject(error); }
    return this.#serial(async () => {
      const credentials = await this.#load();
      if (!Object.hasOwn(credentials, id)) return false;
      delete credentials[id];
      await this.#save(credentials);
      return true;
    });
  }
}

export function createCredentialVault(options) {
  return new CredentialVault(options);
}
