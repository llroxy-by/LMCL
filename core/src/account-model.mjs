const PROVIDERS = new Set(['microsoft', 'littleskin', 'offline']);
const PROVIDER_REQUIRES_SECRET = Object.freeze({ microsoft: true, littleskin: true, offline: false });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/;

export const ACCOUNT_PROVIDER_IDS = Object.freeze([...PROVIDERS]);

function record(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function exactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${name} contains unsupported field: ${key}`);
  }
}

function safeId(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function providerId(value) {
  if (!PROVIDERS.has(value)) throw new TypeError(`unsupported account provider: ${String(value)}`);
  return value;
}

function minecraftId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('profile.id must be a Minecraft UUID');
  return value.replaceAll('-', '').toLowerCase();
}

function profileName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('profile.name must contain 1 to 16 characters and no control characters');
  }
  return value;
}

function isoInstant(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be an ISO timestamp`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical ISO timestamp`);
  }
  return value;
}

function frozenProfile(value) {
  record(value, 'profile');
  exactKeys(value, ['id', 'name'], 'profile');
  return Object.freeze({ id: minecraftId(value.id), name: profileName(value.name) });
}

/** Creates an opaque locator. It identifies a secret but never contains secret material. */
export function createCredentialRef(storeOrValue, id) {
  const value = typeof storeOrValue === 'object' && storeOrValue !== null
    ? storeOrValue
    : { store: storeOrValue, id };
  record(value, 'credentialRef');
  exactKeys(value, ['store', 'id'], 'credentialRef');
  return Object.freeze({
    store: safeId(value.store, 'credentialRef.store'),
    id: safeId(value.id, 'credentialRef.id'),
  });
}

export function validateCredentialRef(value) {
  return createCredentialRef(value);
}

/**
 * Builds immutable public account state. Passwords and tokens are intentionally
 * not fields of this model; online accounts only retain an opaque credentialRef.
 */
export function createAccount(value) {
  record(value, 'account');
  exactKeys(value, ['id', 'provider', 'profile', 'credentialRef'], 'account');
  const provider = providerId(value.provider);
  const credentialRef = value.credentialRef == null ? null : createCredentialRef(value.credentialRef);
  if (PROVIDER_REQUIRES_SECRET[provider] && credentialRef === null) {
    throw new TypeError(`${provider} account requires credentialRef`);
  }
  if (!PROVIDER_REQUIRES_SECRET[provider] && credentialRef !== null) {
    throw new TypeError(`${provider} account must not have credentialRef`);
  }
  return Object.freeze({
    id: safeId(value.id, 'account.id'),
    provider,
    profile: frozenProfile(value.profile),
    credentialRef,
  });
}

export function validateAccount(value) {
  return createAccount(value);
}

/**
 * A launch session is public launch metadata, not an authentication response.
 * Runtime adapters resolve credentialRef through a SecretStore immediately
 * before launch and must not copy the resulting token into this object.
 */
export function createLaunchSession(value) {
  record(value, 'launchSession');
  exactKeys(value, [
    'id', 'accountId', 'provider', 'profile', 'credentialRef', 'issuedAt', 'expiresAt',
  ], 'launchSession');

  const provider = providerId(value.provider);
  const credentialRef = value.credentialRef == null ? null : createCredentialRef(value.credentialRef);
  if (PROVIDER_REQUIRES_SECRET[provider] && credentialRef === null) {
    throw new TypeError(`${provider} launch session requires credentialRef`);
  }
  if (!PROVIDER_REQUIRES_SECRET[provider] && credentialRef !== null) {
    throw new TypeError(`${provider} launch session must not have credentialRef`);
  }

  const issuedAt = isoInstant(value.issuedAt, 'launchSession.issuedAt');
  const expiresAt = value.expiresAt == null ? null : isoInstant(value.expiresAt, 'launchSession.expiresAt');
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    throw new TypeError('launchSession.expiresAt must be later than issuedAt');
  }
  if (provider !== 'offline' && expiresAt === null) {
    throw new TypeError(`${provider} launch session requires expiresAt`);
  }
  if (provider === 'offline' && expiresAt !== null) {
    throw new TypeError('offline launch session must not expire');
  }

  return Object.freeze({
    id: safeId(value.id, 'launchSession.id'),
    accountId: safeId(value.accountId, 'launchSession.accountId'),
    provider,
    profile: frozenProfile(value.profile),
    credentialRef,
    issuedAt,
    expiresAt,
  });
}

export function validateLaunchSession(value, options = {}) {
  const session = createLaunchSession(value);
  record(options, 'options');
  exactKeys(options, ['now'], 'options');
  const now = options.now === undefined
    ? Date.now()
    : (options.now instanceof Date ? options.now.getTime() : options.now);
  if (!Number.isFinite(now)) throw new TypeError('options.now must be a timestamp or Date');
  if (session.expiresAt !== null && Date.parse(session.expiresAt) <= now) {
    throw new TypeError('launch session is expired');
  }
  return session;
}
