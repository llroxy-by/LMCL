import { fail } from './errors.mjs';

const copy = (value) => {
  if (value == null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [copy(key), copy(item)]));
  if (Array.isArray(value)) return value.map(copy);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
};

export class MemoryUserRepository {
  #byId = new Map();
  #idByEmail = new Map();

  create(user) {
    if (this.#idByEmail.has(user.email)) fail('EMAIL_TAKEN', 'email is already registered');
    this.#byId.set(user.id, copy(user));
    this.#idByEmail.set(user.email, user.id);
    return copy(user);
  }
  getById(id) { return copy(this.#byId.get(id)); }
  getByEmail(email) { return this.getById(this.#idByEmail.get(email)); }
  update(user) {
    if (!this.#byId.has(user.id)) fail('USER_NOT_FOUND', 'user does not exist');
    this.#byId.set(user.id, copy(user));
    return copy(user);
  }
}

export class MemorySessionRepository {
  #sessions = new Map();
  put(session) { this.#sessions.set(session.id, copy(session)); return copy(session); }
  get(id) { return copy(this.#sessions.get(id)); }
  update(session) {
    if (!this.#sessions.has(session.id)) fail('SESSION_NOT_FOUND', 'session does not exist');
    this.#sessions.set(session.id, copy(session));
    return copy(session);
  }
  listByFamily(familyId) {
    return [...this.#sessions.values()].filter((item) => item.familyId === familyId).map(copy);
  }
}

export class MemoryCloudSaveRepository {
  #saves = new Map();
  #key(userId, saveId) { return `${userId}\0${saveId}`; }

  list(userId) {
    return [...this.#saves.values()].filter((save) => save.userId === userId).map(({ snapshots, ...meta }) => copy(meta));
  }
  getMetadata(userId, saveId) {
    const save = this.#saves.get(this.#key(userId, saveId));
    if (!save) return undefined;
    const { snapshots, ...meta } = save;
    return copy(meta);
  }
  getSnapshot(userId, saveId, version) {
    const save = this.#saves.get(this.#key(userId, saveId));
    return copy(save?.snapshots.get(version));
  }
  create(save, snapshot) {
    const key = this.#key(save.userId, save.id);
    if (this.#saves.has(key)) fail('SAVE_EXISTS', 'cloud save already exists');
    this.#saves.set(key, { ...copy(save), snapshots: new Map([[snapshot.version, copy(snapshot)]]) });
    return this.getMetadata(save.userId, save.id);
  }
  appendSnapshot(userId, saveId, expectedVersion, next, metadataPatch) {
    const save = this.#saves.get(this.#key(userId, saveId));
    if (!save) fail('SAVE_NOT_FOUND', 'cloud save does not exist');
    if (save.version !== expectedVersion) {
      fail('VERSION_CONFLICT', 'cloud save version changed', { expectedVersion, actualVersion: save.version });
    }
    save.version = next.version;
    save.updatedAt = next.createdAt;
    save.size = next.size;
    save.checksum = next.checksum;
    if (metadataPatch?.name !== undefined) save.name = metadataPatch.name;
    save.snapshots.set(next.version, copy(next));
    return this.getMetadata(userId, saveId);
  }
}
