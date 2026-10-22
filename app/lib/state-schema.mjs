import { createAccount } from '../../core/src/account-model.mjs';
import { launcherSettings } from '../../core/src/server-mode.mjs';

export const STATE_SCHEMA_VERSION = 2;

const INSTANCE_KEYS = new Set(['id', 'name', 'version', 'root', 'managed', 'javaMajor', 'installedAt']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/;

function record(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function exactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${name} contains unsupported field: ${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${name} is missing field: ${key}`);
  }
}

function text(value, name, { empty = false, max = 4096 } = {}) {
  if (typeof value !== 'string' || (!empty && value.length === 0) || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function validateSettings(value) {
  record(value, 'state.settings');
  exactKeys(value, ['schemaVersion', 'mode', 'providers'], 'state.settings');
  if (value.schemaVersion !== 1) throw new TypeError('state.settings.schemaVersion must be 1');
  if (!Array.isArray(value.providers)) throw new TypeError('state.settings.providers must be an array');
  for (const [index, provider] of value.providers.entries()) {
    record(provider, `state.settings.providers[${index}]`);
    exactKeys(provider, ['id', 'name', 'apiRoot', 'enabled'], `state.settings.providers[${index}]`);
  }
  const settings = launcherSettings(value);
  settings.providers = Object.freeze(settings.providers.map(provider => Object.freeze(provider)));
  return Object.freeze(settings);
}

function validateInstance(value, index) {
  const name = `state.instances[${index}]`;
  record(value, name);
  for (const key of Object.keys(value)) {
    if (!INSTANCE_KEYS.has(key)) throw new TypeError(`${name} contains unsupported field: ${key}`);
  }
  for (const key of ['id', 'name', 'version', 'root', 'managed', 'javaMajor']) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${name} is missing field: ${key}`);
  }
  if (typeof value.id !== 'string' || !SAFE_ID.test(value.id)) throw new TypeError(`${name}.id is invalid`);
  const output = {
    id: value.id,
    name: text(value.name, `${name}.name`, { max: 100 }),
    version: text(value.version, `${name}.version`, { max: 100 }),
    root: text(value.root, `${name}.root`),
    managed: value.managed,
    javaMajor: value.javaMajor,
  };
  if (typeof output.managed !== 'boolean') throw new TypeError(`${name}.managed must be a boolean`);
  if (!Number.isSafeInteger(output.javaMajor) || output.javaMajor < 1 || output.javaMajor > 999) {
    throw new TypeError(`${name}.javaMajor is invalid`);
  }
  if (Object.hasOwn(value, 'installedAt')) {
    if (typeof value.installedAt !== 'string' || new Date(value.installedAt).toISOString() !== value.installedAt) {
      throw new TypeError(`${name}.installedAt must be a canonical ISO timestamp`);
    }
    output.installedAt = value.installedAt;
  }
  return Object.freeze(output);
}

function commonState(value) {
  const settings = validateSettings(value.settings);
  if (!Array.isArray(value.instances)) throw new TypeError('state.instances must be an array');
  const instances = Object.freeze(value.instances.map(validateInstance));
  if (new Set(instances.map(item => item.id)).size !== instances.length) throw new TypeError('state.instances contains duplicate ids');
  if (typeof value.javaPath !== 'string' || value.javaPath.length > 4096 || /[\u0000\r\n]/u.test(value.javaPath)) {
    throw new TypeError('state.javaPath is invalid');
  }
  if (!Number.isSafeInteger(value.memoryMB) || value.memoryMB < 1024 || value.memoryMB > 32768) {
    throw new TypeError('state.memoryMB must be between 1024 and 32768');
  }
  return { settings, instances, javaPath: value.javaPath, memoryMB: value.memoryMB };
}

function validateV1Profile(profile) {
  if (profile === null) return null;
  record(profile, 'state.profile');
  exactKeys(profile, ['provider', 'name', 'uuid', 'verified'], 'state.profile');
  if (profile.provider !== 'offline' || profile.verified !== false) throw new TypeError('state.profile must be an offline profile');
  const name = text(profile.name, 'state.profile.name', { max: 16 });
  if (!UUID.test(profile.uuid)) throw new TypeError('state.profile.uuid is invalid');
  return { name, id: profile.uuid.replaceAll('-', '').toLowerCase() };
}

function validateV1(value) {
  exactKeys(value, ['schemaVersion', 'settings', 'profile', 'instances', 'javaPath', 'memoryMB'], 'state');
  const profile = validateV1Profile(value.profile);
  return { ...commonState(value), profile };
}

/** Strictly validates schema v2 and returns a detached, immutable state value. */
export function validateState(value) {
  record(value, 'state');
  exactKeys(value, ['schemaVersion', 'settings', 'accounts', 'selectedAccountId', 'instances', 'javaPath', 'memoryMB'], 'state');
  if (value.schemaVersion !== STATE_SCHEMA_VERSION) throw new TypeError('state.schemaVersion must be 2');
  if (!Array.isArray(value.accounts)) throw new TypeError('state.accounts must be an array');
  const accounts = value.accounts.map(createAccount);
  if (new Set(accounts.map(account => account.id)).size !== accounts.length) throw new TypeError('state.accounts contains duplicate ids');
  const selectedAccountId = value.selectedAccountId;
  if (selectedAccountId !== null && (typeof selectedAccountId !== 'string' || !accounts.some(account => account.id === selectedAccountId))) {
    throw new TypeError('state.selectedAccountId must identify an account');
  }
  if ((accounts.length === 0) !== (selectedAccountId === null)) {
    throw new TypeError('state.selectedAccountId is required exactly when accounts are present');
  }
  return Object.freeze({
    schemaVersion: STATE_SCHEMA_VERSION,
    ...commonState(value),
    accounts: Object.freeze(accounts),
    selectedAccountId,
  });
}

/** Migrates persisted launcher state without carrying credentials or other unknown fields. */
export function migrateState(value) {
  record(value, 'state');
  if (value.schemaVersion === STATE_SCHEMA_VERSION) return validateState(value);
  if (value.schemaVersion !== 1) throw new TypeError(`unsupported state schema version: ${String(value.schemaVersion)}`);
  const old = validateV1(value);
  const account = old.profile === null ? null : createAccount({
    id: `offline:${old.profile.id}`,
    provider: 'offline',
    profile: old.profile,
    credentialRef: null,
  });
  return validateState({
    schemaVersion: STATE_SCHEMA_VERSION,
    settings: old.settings,
    accounts: account ? [account] : [],
    selectedAccountId: account?.id ?? null,
    instances: old.instances,
    javaPath: old.javaPath,
    memoryMB: old.memoryMB,
  });
}

export const migrateLauncherState = migrateState;
