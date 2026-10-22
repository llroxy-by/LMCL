// Download source policy only. This module performs no network requests: the
// caller decides when a source is too slow and reports the outcome back.
//
// Mojang 官方源与第三方镜像（BMCLAPI）的文件布局并不完全一致：库文件在镜像上
// 多一层 /maven，资源文件多一层 /assets，其余主机保持原路径。
export const DOWNLOAD_MODES = ['auto', 'official', 'mirror'];
export const MOJANG_MIRROR = 'https://bmclapi2.bangbang93.com';

const SAME_PATH = new Set(['piston-meta.mojang.com', 'piston-data.mojang.com',
  'launchermeta.mojang.com', 'launcher.mojang.com']);

export function normalizeDownloadMode(value) {
  if (value === undefined || value === null || value === '') return 'auto';
  if (typeof value !== 'string' || !DOWNLOAD_MODES.includes(value)) throw new TypeError('Unknown download mode');
  return value;
}

/** Returns the mirror equivalent of a Mojang URL, or null for other hosts. */
export function mirrorURL(value, base = MOJANG_MIRROR) {
  const url = new URL(value), root = new URL(base);
  if (url.protocol !== 'https:' || root.protocol !== 'https:') throw new TypeError('Download URLs must use HTTPS');
  if (url.username || url.password) throw new TypeError('Download URLs must not embed credentials');
  const prefix = root.origin + root.pathname.replace(/\/+$/, '');
  if (SAME_PATH.has(url.hostname)) return prefix + url.pathname + url.search;
  if (url.hostname === 'libraries.minecraft.net') return `${prefix}/maven${url.pathname}${url.search}`;
  if (url.hostname === 'resources.download.minecraft.net') return `${prefix}/assets${url.pathname}${url.search}`;
  return null;
}

/** Whether a channel has a usable mirror. Content sites have no public mirror. */
export function mirrorAvailable({ channel = 'mojang', mirrorBase = null } = {}) {
  if (!['mojang', 'content'].includes(channel)) throw new TypeError('Unknown download channel');
  return channel === 'mojang' ? true : Boolean(mirrorBase);
}

/**
 * Ordered candidate sources for one transfer.
 * auto tries the mirror first and falls back to the official host; an explicit
 * choice never silently switches, so a deliberate mirror preference stays put.
 */
export function sourceOrder({ mode = 'auto', channel = 'mojang', mirrorBase = null } = {}) {
  const chosen = normalizeDownloadMode(mode);
  if (chosen === 'official') return ['official'];
  if (!mirrorAvailable({ channel, mirrorBase })) return ['official'];
  if (chosen === 'mirror') return ['mirror'];
  return ['mirror', 'official'];
}

// 判定「太慢」的阈值：首字节 8 秒，之后每 6 秒窗口平均低于 48 KB/s 就换源。
// 阈值不能太高：家用宽带上一个 2 MB 的模组本就不快，误判会让下载反复重来。
// 这些阈值只用来「换源」；没有备用源时用 LAST_RESORT_FIRST_BYTE_MS，宁可等也不报错。
export const FIRST_BYTE_TIMEOUT_MS = 8000;
export const LAST_RESORT_FIRST_BYTE_MS = 45000;
export const MIN_BYTES_PER_SECOND = 48 * 1024;
export const SLOW_WINDOW_MS = 6000;

export function tooSlow({ bytes, elapsedMs }) {
  if (!Number.isFinite(bytes) || !Number.isFinite(elapsedMs) || bytes < 0 || elapsedMs < 0) {
    throw new TypeError('Invalid transfer sample');
  }
  if (elapsedMs < SLOW_WINDOW_MS) return false;
  return bytes / (elapsedMs / 1000) < MIN_BYTES_PER_SECOND;
}

// 失败源冷却，避免每次下载都先撞一次墙。键是 'mirror' / 'official'。
export const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

export function coolingDown(health, name, now = Date.now()) {
  if (!(health instanceof Map)) throw new TypeError('Expected health map');
  const until = health.get(name);
  return Number.isFinite(until) && until > now;
}

export function recordFailure(health, name, now = Date.now()) {
  if (!(health instanceof Map)) throw new TypeError('Expected health map');
  health.set(name, now + FAILURE_COOLDOWN_MS);
  return health;
}

export function recordSuccess(health, name) {
  if (!(health instanceof Map)) throw new TypeError('Expected health map');
  health.delete(name);
  return health;
}

/** Applies the cooldown to an auto order, keeping the last resort available. */
export function resolveSources({ mode = 'auto', channel = 'mojang', mirrorBase = null,
  health = new Map(), now = Date.now() } = {}) {
  const order = sourceOrder({ mode, channel, mirrorBase });
  if (normalizeDownloadMode(mode) !== 'auto') return order;
  const usable = order.filter(name => !coolingDown(health, name, now));
  return usable.length ? usable : order;
}
