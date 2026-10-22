import { fail } from './errors.mjs';

const integer = (value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (!/^\d+$/.test(String(value ?? ''))) fail('INVALID_CONFIG', `${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fail('INVALID_CONFIG', `${name} must be between ${min} and ${max}`);
  }
  return parsed;
};

const secret = (value, name) => {
  if (typeof value !== 'string' || value.length < 32) fail('INVALID_CONFIG', `${name} must contain at least 32 characters`);
  return value;
};

/** Validates an explicitly supplied environment-like object. This module never reads process.env or .env. */
export function loadConfig(values) {
  if (!values || typeof values !== 'object') fail('INVALID_CONFIG', 'configuration object is required');
  const host = values.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    fail('INVALID_CONFIG', 'HOST must be loopback; public listening is disabled');
  }
  return Object.freeze({
    host,
    port: integer(values.PORT ?? '8787', 'PORT', { max: 65535 }),
    tokenPepper: secret(values.TOKEN_PEPPER, 'TOKEN_PEPPER'),
    verificationTtlMs: integer(values.VERIFICATION_TTL_MS ?? '600000', 'VERIFICATION_TTL_MS'),
    accessTtlMs: integer(values.ACCESS_TTL_MS ?? '900000', 'ACCESS_TTL_MS'),
    refreshTtlMs: integer(values.REFRESH_TTL_MS ?? '2592000000', 'REFRESH_TTL_MS'),
    maxSnapshotBytes: integer(values.MAX_SNAPSHOT_BYTES ?? '10485760', 'MAX_SNAPSHOT_BYTES')
  });
}
