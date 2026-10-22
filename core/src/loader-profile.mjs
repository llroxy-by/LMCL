import { mergeLibraries } from './version-resolver.mjs';

const LOADERS = new Set(['fabric', 'quilt']);
const COORDINATES = Object.freeze({
  fabric: 'net.fabricmc:fabric-loader:',
  quilt: 'org.quiltmc:quilt-loader:',
});

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function nonEmpty(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function loaderName(value) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : value;
  if (!LOADERS.has(normalized)) throw new TypeError(`unsupported loader: ${String(value)}`);
  return normalized;
}

function detectLoader(profile) {
  const evidence = [profile.id, profile.mainClass, ...(profile.libraries ?? []).map(x => x?.name)]
    .filter(x => typeof x === 'string').join('\n').toLowerCase();
  if (evidence.includes('quilt')) return 'quilt';
  if (evidence.includes('fabric')) return 'fabric';
  throw new TypeError('unable to detect Fabric or Quilt loader profile');
}

function normalizedArguments(profile) {
  if (profile.arguments !== undefined) object(profile.arguments, 'profile.arguments');
  const game = profile.arguments?.game ?? [];
  const jvm = profile.arguments?.jvm ?? [];
  if (!Array.isArray(game) || !Array.isArray(jvm)) throw new TypeError('profile arguments must be arrays');
  if (profile.minecraftArguments !== undefined && typeof profile.minecraftArguments !== 'string') {
    throw new TypeError('profile.minecraftArguments must be a string');
  }
  // Legacy arguments remain one opaque item; parsing command-line strings is platform-dependent.
  return {
    game: [...structuredClone(game), ...(profile.minecraftArguments === undefined ? [] : [profile.minecraftArguments])],
    jvm: structuredClone(jvm),
  };
}

function loaderVersion(profile, loader) {
  const prefix = COORDINATES[loader];
  for (const library of profile.libraries ?? []) {
    if (typeof library?.name === 'string' && library.name.startsWith(prefix)) {
      const version = library.name.slice(prefix.length);
      if (version) return version;
    }
  }
  const escaped = loader === 'fabric' ? 'fabric-loader-' : 'quilt-loader-';
  if (typeof profile.id === 'string') {
    const position = profile.id.toLowerCase().lastIndexOf(escaped);
    if (position >= 0) return profile.id.slice(position + escaped.length);
  }
  return null;
}

/**
 * Converts Fabric and Quilt version JSON into one transport-independent shape.
 * The operation performs no network or filesystem access and never mutates input.
 */
export function normalizeLoaderProfile(profile, loaderOrOptions) {
  object(profile, 'profile');
  const requested = typeof loaderOrOptions === 'string'
    ? loaderOrOptions
    : loaderOrOptions?.loader;
  if (loaderOrOptions !== undefined && typeof loaderOrOptions !== 'string') object(loaderOrOptions, 'options');
  const loader = requested === undefined ? detectLoader(profile) : loaderName(requested);

  const libraries = profile.libraries ?? [];
  if (!Array.isArray(libraries)) throw new TypeError('profile.libraries must be an array');
  const minecraftVersion = nonEmpty(profile.inheritsFrom ?? profile.minecraftVersion, 'profile.inheritsFrom');
  const result = {
    loader,
    loaderVersion: loaderVersion(profile, loader),
    minecraftVersion,
    id: nonEmpty(profile.id, 'profile.id'),
    mainClass: nonEmpty(profile.mainClass, 'profile.mainClass'),
    libraries: mergeLibraries([], libraries),
    arguments: normalizedArguments(profile),
  };
  if (profile.downloads !== undefined) {
    object(profile.downloads, 'profile.downloads');
    result.downloads = structuredClone(profile.downloads);
  }
  if (profile.javaVersion !== undefined) {
    object(profile.javaVersion, 'profile.javaVersion');
    result.javaVersion = structuredClone(profile.javaVersion);
  }
  return result;
}

export function normalizeFabricProfile(profile) {
  return normalizeLoaderProfile(profile, 'fabric');
}

export function normalizeQuiltProfile(profile) {
  return normalizeLoaderProfile(profile, 'quilt');
}

export const normalizeProfile = normalizeLoaderProfile;
