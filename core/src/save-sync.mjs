import { createHash } from 'node:crypto';

// Pure synchronization logic. This module never reads, writes, watches, archives,
// uploads, or downloads files; hashes supplied by the caller describe file bytes.
const SHA256 = /^[a-f0-9]{64}$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const ACTIVE = new Set(['ready', 'pending-offline', 'blocked-game']);

/** Return one portable, NFC, relative path or reject ambiguous filesystem syntax. */
export function normalizeSavePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError('Save path must be a non-empty relative string');
  }
  if (value.includes('\\') || value.startsWith('/') || /^[a-z]:/iu.test(value)) {
    throw new TypeError(`Absolute or platform-specific save path: ${value}`);
  }
  let normalized;
  try {
    normalized = value.normalize('NFC');
  } catch {
    throw new TypeError('Save path is not valid Unicode');
  }
  const parts = normalized.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.length > 255 ||
        /[<>:"|?*\p{Cc}\p{Cs}]/u.test(part) || /[. ]$/u.test(part) || WINDOWS_DEVICE.test(part)) {
      throw new TypeError(`Unsafe save path: ${value}`);
    }
  }
  return parts.join('/');
}

function pathKey(path) {
  // Save manifests are portable to case-insensitive filesystems.
  return normalizeSavePath(path).toLowerCase();
}

function ownObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate and deterministically order a content manifest. Unknown metadata is discarded. */
export function normalizeSaveManifest(input) {
  const files = Array.isArray(input) ? input : input?.files;
  if (!Array.isArray(files)) throw new TypeError('Manifest files must be an array');
  if (files.length > 100_000) throw new TypeError('Manifest has too many files');

  const byKey = new Map();
  let totalSize = 0;
  for (const candidate of files) {
    if (!ownObject(candidate)) throw new TypeError('Invalid manifest entry');
    const path = normalizeSavePath(candidate.path);
    const sha256 = typeof candidate.sha256 === 'string' ? candidate.sha256.toLowerCase() : '';
    if (!SHA256.test(sha256) || !Number.isSafeInteger(candidate.size) || candidate.size < 0) {
      throw new TypeError(`Invalid hash or size for ${path}`);
    }
    const key = pathKey(path);
    if (byKey.has(key)) throw new TypeError(`Case-colliding save path: ${path}`);
    totalSize += candidate.size;
    if (!Number.isSafeInteger(totalSize)) throw new TypeError('Manifest size overflow');
    byKey.set(key, { path, sha256, size: candidate.size });
  }

  for (const key of byKey.keys()) {
    const parts = key.split('/');
    for (let end = 1; end < parts.length; end++) {
      if (byKey.has(parts.slice(0, end).join('/'))) {
        throw new TypeError(`File used as a directory: ${byKey.get(key).path}`);
      }
    }
  }

  const ordered = [...byKey.values()].sort((a, b) => {
    const folded = a.path.toLowerCase().localeCompare(b.path.toLowerCase(), 'en');
    return folded || a.path.localeCompare(b.path, 'en');
  });
  return { version: 1, files: ordered, totalSize };
}

/** SHA-256 of the canonical, metadata-free manifest representation. */
export function digestSaveManifest(input) {
  const manifest = normalizeSaveManifest(input);
  const canonical = JSON.stringify({ version: manifest.version, files: manifest.files });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function indexManifest(input) {
  const manifest = normalizeSaveManifest(input ?? []);
  return { manifest, files: new Map(manifest.files.map(file => [pathKey(file.path), file])) };
}

function sameFile(a, b) {
  return a === undefined ? b === undefined : b !== undefined && a.sha256 === b.sha256 && a.size === b.size;
}

function snapshot(file) {
  return file && { sha256: file.sha256, size: file.size };
}

/**
 * Three-way content decision. A missing entry represents deletion. Returned
 * operations are intents for a separate, security-checked executor.
 */
export function planSaveSync({ base = [], local = [], remote = [], online = true, gameRunning = false } = {}) {
  if (typeof online !== 'boolean' || typeof gameRunning !== 'boolean') {
    throw new TypeError('online and gameRunning must be booleans');
  }
  const baseIndex = indexManifest(base);
  const localIndex = indexManifest(local);
  const remoteIndex = indexManifest(remote);
  const keys = new Set([...baseIndex.files.keys(), ...localIndex.files.keys(), ...remoteIndex.files.keys()]);
  const result = {
    baseDigest: digestSaveManifest(baseIndex.manifest),
    localDigest: digestSaveManifest(localIndex.manifest),
    remoteDigest: digestSaveManifest(remoteIndex.manifest),
    uploads: [], downloads: [], deleteLocal: [], deleteRemote: [], conflicts: [], unchanged: [],
    online, gameRunning,
  };

  for (const key of [...keys].sort()) {
    const b = baseIndex.files.get(key), l = localIndex.files.get(key), r = remoteIndex.files.get(key);
    const path = l?.path ?? r?.path ?? b.path;
    if (sameFile(l, r)) {
      result.unchanged.push({ path, state: l ? 'present' : 'deleted' });
    } else if (sameFile(l, b)) {
      if (r) result.downloads.push({ path: r.path, file: { ...r } });
      else result.deleteLocal.push({ path: l.path });
    } else if (sameFile(r, b)) {
      if (l) result.uploads.push({ path: l.path, file: { ...l } });
      else result.deleteRemote.push({ path: r.path });
    } else {
      result.conflicts.push({
        path,
        reason: !l || !r ? 'delete-vs-change' : 'both-changed',
        base: snapshot(b), local: snapshot(l), remote: snapshot(r),
      });
    }
  }

  result.operationCount = result.uploads.length + result.downloads.length +
    result.deleteLocal.length + result.deleteRemote.length;
  result.deferredReasons = [
    ...(result.operationCount && gameRunning ? ['game-running'] : []),
    ...(result.operationCount && !online ? ['offline'] : []),
  ];
  result.status = result.conflicts.length ? 'conflict'
    : result.operationCount === 0 ? 'up-to-date'
      : gameRunning ? 'blocked-game'
        : !online ? 'pending-offline' : 'ready';
  result.canSync = result.status === 'ready';
  return result;
}

export function createSaveSyncState() {
  return { status: 'idle', online: true, gameRunning: false, plan: null, error: null };
}

function statusFor(plan, online, gameRunning) {
  if (plan.conflicts.length) return 'conflict';
  if (plan.operationCount === 0) return 'synced';
  if (gameRunning) return 'blocked-game';
  return online ? 'ready' : 'pending-offline';
}

function checkedState(state) {
  if (!ownObject(state) || typeof state.status !== 'string') throw new TypeError('Invalid sync state');
  return state;
}

/** Strict reducer for orchestration. Invalid or racy transitions throw. */
export function transitionSaveSync(state, event) {
  state = checkedState(state);
  if (!ownObject(event) || typeof event.type !== 'string') throw new TypeError('Invalid sync event');
  const next = patch => ({ ...state, ...patch });

  if (event.type === 'RESET') return createSaveSyncState();
  if (event.type === 'START') {
    if (!['idle', 'synced', 'failed', 'conflict'].includes(state.status)) throw new Error(`Cannot START from ${state.status}`);
    return next({ status: 'evaluating', plan: null, error: null });
  }
  if (event.type === 'PLANNED') {
    if (state.status !== 'evaluating' || !ownObject(event.plan) || !Array.isArray(event.plan.conflicts) ||
        !Number.isSafeInteger(event.plan.operationCount)) throw new Error('PLANNED requires an evaluated sync plan');
    const online = event.plan.online;
    const gameRunning = event.plan.gameRunning;
    if (typeof online !== 'boolean' || typeof gameRunning !== 'boolean') throw new TypeError('Plan lacks lock/connectivity state');
    return next({ status: statusFor(event.plan, online, gameRunning), plan: structuredClone(event.plan), online, gameRunning });
  }
  if (event.type === 'NETWORK_OFFLINE' || event.type === 'NETWORK_ONLINE') {
    if (!ACTIVE.has(state.status)) throw new Error(`Cannot change connectivity from ${state.status}`);
    const online = event.type === 'NETWORK_ONLINE';
    return next({ online, status: statusFor(state.plan, online, state.gameRunning) });
  }
  if (event.type === 'GAME_STARTED' || event.type === 'GAME_EXITED') {
    if (!ACTIVE.has(state.status)) throw new Error(`Cannot change game lock from ${state.status}`);
    const gameRunning = event.type === 'GAME_STARTED';
    return next({ gameRunning, status: statusFor(state.plan, state.online, gameRunning) });
  }
  if (event.type === 'APPLY') {
    if (state.status !== 'ready' || !state.online || state.gameRunning) throw new Error(`Cannot APPLY from ${state.status}`);
    return next({ status: 'syncing' });
  }
  if (event.type === 'SUCCEEDED') {
    if (state.status !== 'syncing') throw new Error(`Cannot SUCCEED from ${state.status}`);
    return next({ status: 'synced', plan: null, error: null });
  }
  if (event.type === 'FAILED') {
    if (state.status !== 'syncing' || typeof event.error !== 'string' || !event.error) throw new Error('FAILED requires a syncing state and message');
    return next({ status: 'failed', error: event.error });
  }
  throw new Error(`Unknown sync event: ${event.type}`);
}
