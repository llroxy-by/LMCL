const HASH_LENGTHS = Object.freeze({ sha1: 40, sha256: 64 });
const SAFE_PART = /^[A-Za-z0-9_][A-Za-z0-9_.+~-]*$/;

export class LoaderInstallPlanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LoaderInstallPlanError';
    this.code = code;
    Object.assign(this, details);
  }
}

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function safePart(value, name) {
  if (typeof value !== 'string' || value.length === 0 || !SAFE_PART.test(value)
    || value === '.' || value === '..' || value.includes('..')) {
    throw new LoaderInstallPlanError('UNSAFE_MAVEN_COORDINATE', `unsafe ${name}: ${value}`, { value });
  }
  return value;
}

/** Convert a Maven coordinate to its canonical, relative artifact path. */
export function mavenArtifactPath(coordinate) {
  text(coordinate, 'coordinate');
  if (coordinate.includes('/') || coordinate.includes('\\') || /%2f|%5c/i.test(coordinate)) {
    throw new LoaderInstallPlanError('UNSAFE_MAVEN_COORDINATE', `unsafe Maven coordinate: ${coordinate}`, { coordinate });
  }
  const at = coordinate.split('@');
  if (at.length > 2) throw new LoaderInstallPlanError('INVALID_MAVEN_COORDINATE', `invalid Maven coordinate: ${coordinate}`);
  const extension = safePart(at[1] ?? 'jar', 'Maven extension');
  const parts = at[0].split(':');
  if (parts.length < 3 || parts.length > 4) {
    throw new LoaderInstallPlanError('INVALID_MAVEN_COORDINATE', `invalid Maven coordinate: ${coordinate}`, { coordinate });
  }
  const [group, artifact, version, classifier] = parts;
  const groups = group.split('.');
  if (groups.length === 0) throw new LoaderInstallPlanError('INVALID_MAVEN_COORDINATE', `invalid Maven coordinate: ${coordinate}`);
  groups.forEach((part, index) => safePart(part, `Maven group segment ${index}`));
  safePart(artifact, 'Maven artifact');
  safePart(version, 'Maven version');
  if (classifier !== undefined) safePart(classifier, 'Maven classifier');
  const file = `${artifact}-${version}${classifier === undefined ? '' : `-${classifier}`}.${extension}`;
  return [...groups, artifact, version, file].join('/');
}

function portableRelativePath(value, name) {
  text(value, name);
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0') || /^[A-Za-z]:/.test(value)) {
    throw new LoaderInstallPlanError('UNSAFE_TARGET_PATH', `unsafe ${name}: ${value}`, { path: value });
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new LoaderInstallPlanError('UNSAFE_TARGET_PATH', `unsafe ${name}: ${value}`, { path: value });
  }
  return value;
}

function secureUrl(value, name) {
  text(value, name);
  let parsed;
  try { parsed = new URL(value); } catch {
    throw new LoaderInstallPlanError('INVALID_URL', `invalid ${name}: ${value}`, { url: value });
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new LoaderInstallPlanError('INSECURE_URL', `${name} must be credential-free HTTPS`, { url: value });
  }
  return parsed.toString();
}

function repositoryUrl(base, path) {
  const url = secureUrl(base, 'repository URL');
  return new URL(path, url.endsWith('/') ? url : `${url}/`).toString();
}

function hash(value, algorithm, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !new RegExp(`^[a-fA-F0-9]{${HASH_LENGTHS[algorithm]}}$`).test(value)) {
    throw new LoaderInstallPlanError('INVALID_HASH', `${name} must be a ${HASH_LENGTHS[algorithm]} digit ${algorithm.toUpperCase()} hash`, {
      algorithm, value,
    });
  }
  return value.toLowerCase();
}

function collectHashes(library, artifact, index) {
  const candidates = { sha1: [], sha256: [] };
  for (const source of [library, artifact]) {
    if (!source) continue;
    if (source.sha1 !== undefined) candidates.sha1.push(source.sha1);
    if (source.sha256 !== undefined) candidates.sha256.push(source.sha256);
  }
  if (library.checksums !== undefined) {
    if (!Array.isArray(library.checksums)) throw new TypeError(`libraries[${index}].checksums must be an array`);
    for (const checksum of library.checksums) {
      if (typeof checksum === 'string' && checksum.length === 40) candidates.sha1.push(checksum);
      else if (typeof checksum === 'string' && checksum.length === 64) candidates.sha256.push(checksum);
      else throw new LoaderInstallPlanError('INVALID_HASH', `unsupported checksum in libraries[${index}]`);
    }
  }
  const result = {};
  for (const algorithm of ['sha256', 'sha1']) {
    const values = candidates[algorithm].map((value, n) => hash(value, algorithm, `libraries[${index}] ${algorithm}[${n}]`));
    if (new Set(values).size > 1) {
      throw new LoaderInstallPlanError('HASH_CONFLICT', `conflicting ${algorithm} values for ${library.name}`, { library: library.name, algorithm });
    }
    if (values.length) result[algorithm] = values[0];
  }
  if (!result.sha256 && !result.sha1) {
    throw new LoaderInstallPlanError('MISSING_HASH', `library has no SHA-256 or SHA-1 constraint: ${library.name}`, { library: library.name });
  }
  return result;
}

function libraryDownload(library, index) {
  object(library, `libraries[${index}]`);
  const name = text(library.name, `libraries[${index}].name`);
  const canonicalPath = mavenArtifactPath(name);
  const artifact = library.downloads?.artifact;
  if (library.downloads !== undefined) object(library.downloads, `libraries[${index}].downloads`);
  if (artifact !== undefined) object(artifact, `libraries[${index}].downloads.artifact`);
  if (artifact?.path !== undefined && portableRelativePath(artifact.path, 'artifact path') !== canonicalPath) {
    throw new LoaderInstallPlanError('MAVEN_PATH_MISMATCH', `artifact path does not match Maven coordinate: ${name}`, {
      library: name, expected: canonicalPath, actual: artifact.path,
    });
  }
  const sourceUrl = artifact?.url ?? (library.url === undefined ? undefined : repositoryUrl(library.url, canonicalPath));
  if (sourceUrl === undefined) {
    throw new LoaderInstallPlanError('MISSING_URL', `library has no artifact or repository URL: ${name}`, { library: name });
  }
  const size = artifact?.size ?? library.size;
  if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) {
    throw new LoaderInstallPlanError('INVALID_SIZE', `invalid library size: ${name}`, { library: name, size });
  }
  const hashes = collectHashes(library, artifact, index);
  const result = {
    name,
    path: `libraries/${canonicalPath}`,
    artifactPath: canonicalPath,
    url: secureUrl(sourceUrl, 'artifact URL'),
    hashes,
    constraints: Object.entries(hashes).map(([algorithm, digest]) => ({ algorithm, digest })),
  };
  if (size !== undefined) result.size = size;
  return result;
}

function equivalent(a, b) {
  return a.url === b.url && a.size === b.size
    && a.hashes.sha1 === b.hashes.sha1 && a.hashes.sha256 === b.hashes.sha256;
}

function loaderKind(profile) {
  if (profile.loader === 'fabric' || profile.loader === 'quilt') return profile.loader;
  const evidence = `${profile.id ?? ''}\n${profile.mainClass ?? ''}\n${(profile.libraries ?? []).map(x => x?.name).join('\n')}`.toLowerCase();
  if (evidence.includes('quilt')) return 'quilt';
  if (evidence.includes('fabric')) return 'fabric';
  throw new TypeError('unable to detect Fabric or Quilt profile');
}

/**
 * Produce a deterministic Fabric/Quilt installation plan. This function performs no I/O.
 */
export function createLoaderInstallPlan(vanillaMetadata, loaderProfile, options = {}) {
  object(vanillaMetadata, 'vanillaMetadata');
  object(loaderProfile, 'loaderProfile');
  object(options, 'options');
  const minecraftVersion = text(vanillaMetadata.id, 'vanillaMetadata.id');
  const inherited = loaderProfile.inheritsFrom ?? loaderProfile.minecraftVersion;
  if (inherited !== minecraftVersion) {
    throw new LoaderInstallPlanError('MINECRAFT_VERSION_MISMATCH', 'loader profile does not inherit from the supplied vanilla version', {
      expected: minecraftVersion, actual: inherited,
    });
  }
  const versionId = options.versionId ?? loaderProfile.id;
  safePart(versionId, 'version id');
  const libraries = loaderProfile.libraries ?? [];
  if (!Array.isArray(libraries)) throw new TypeError('loaderProfile.libraries must be an array');

  const libraryDownloads = [];
  const destinations = new Map();
  for (let index = 0; index < libraries.length; index += 1) {
    const download = libraryDownload(libraries[index], index);
    const key = download.path.toLowerCase();
    const previous = destinations.get(key);
    if (previous && !equivalent(previous, download)) {
      throw new LoaderInstallPlanError('DUPLICATE_TARGET_CONFLICT', `conflicting downloads target ${download.path}`, {
        path: download.path, first: previous, second: download,
      });
    }
    if (!previous) {
      destinations.set(key, download);
      libraryDownloads.push(download);
    }
  }

  const versionJson = structuredClone(loaderProfile);
  versionJson.id = versionId;
  versionJson.inheritsFrom = minecraftVersion;
  delete versionJson.loader;
  delete versionJson.loaderVersion;
  delete versionJson.minecraftVersion;
  const versionJsonPath = `versions/${versionId}/${versionId}.json`;
  const loader = loaderKind(loaderProfile);
  return {
    loader,
    minecraftVersion,
    versionId,
    versionJson,
    versionJsonPath,
    target: { versionId, versionJsonPath, versionJson },
    libraryDownloads,
    downloads: libraryDownloads,
  };
}

export const planLoaderInstall = createLoaderInstallPlan;
export const createInstallPlan = createLoaderInstallPlan;
