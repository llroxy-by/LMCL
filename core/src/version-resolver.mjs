const DEFAULT_MAX_DEPTH = 64;

export class VersionResolutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VersionResolutionError';
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

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function versionId(version) {
  if (typeof version.id !== 'string' || version.id.length === 0) {
    throw new TypeError('version.id must be a non-empty string');
  }
  return version.id;
}

function libraryKey(library, index) {
  return library && typeof library === 'object' && typeof library.name === 'string'
    ? `name:${library.name}`
    : `anonymous:${index}:${JSON.stringify(library)}`;
}

/** Parent order is retained; a child library with the same Maven name replaces it in place. */
export function mergeLibraries(parent = [], child = []) {
  if (!Array.isArray(parent) || !Array.isArray(child)) throw new TypeError('libraries must be arrays');
  const result = [];
  const positions = new Map();
  for (const library of [...parent, ...child]) {
    const key = libraryKey(library, result.length);
    const copy = clone(library);
    if (positions.has(key)) result[positions.get(key)] = copy;
    else {
      positions.set(key, result.length);
      result.push(copy);
    }
  }
  return result;
}

function argumentArray(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return clone(value);
}

/** JVM and game arguments are independently concatenated, parent first. */
export function mergeArguments(parent, child) {
  if (parent === undefined && child === undefined) return undefined;
  if (parent !== undefined) object(parent, 'parent arguments');
  if (child !== undefined) object(child, 'child arguments');
  return {
    game: [...argumentArray(parent?.game, 'arguments.game'), ...argumentArray(child?.game, 'arguments.game')],
    jvm: [...argumentArray(parent?.jvm, 'arguments.jvm'), ...argumentArray(child?.jvm, 'arguments.jvm')],
  };
}

function mergeRecords(parent, child, name) {
  if (parent === undefined && child === undefined) return undefined;
  if (parent !== undefined) object(parent, `parent ${name}`);
  if (child !== undefined) object(child, `child ${name}`);
  return { ...clone(parent ?? {}), ...clone(child ?? {}) };
}

/** Merge one already-resolved parent with its child without mutating either input. */
export function mergeVersion(parent, child) {
  object(parent, 'parent version');
  object(child, 'child version');
  versionId(child);

  const result = { ...clone(parent), ...clone(child) };
  result.id = child.id;
  delete result.inheritsFrom;

  if (parent.libraries !== undefined || child.libraries !== undefined) {
    result.libraries = mergeLibraries(parent.libraries ?? [], child.libraries ?? []);
  }
  const argumentsValue = mergeArguments(parent.arguments, child.arguments);
  if (argumentsValue !== undefined) result.arguments = argumentsValue;

  const downloads = mergeRecords(parent.downloads, child.downloads, 'downloads');
  if (downloads !== undefined) result.downloads = downloads;

  // These fields are selected atomically: a child declaration replaces the parent declaration.
  if (child.mainClass === undefined && parent.mainClass !== undefined) result.mainClass = clone(parent.mainClass);
  if (child.javaVersion === undefined && parent.javaVersion !== undefined) result.javaVersion = clone(parent.javaVersion);
  return result;
}

function lookup(source, id) {
  if (typeof source === 'function') return source(id);
  if (source instanceof Map) return source.get(id);
  if (source !== null && typeof source === 'object') return source[id];
  throw new TypeError('versions must be a lookup function, Map, or object');
}

/**
 * Resolves Minecraft version inheritance synchronously and without I/O.
 * `version` may be a version object or an id present in `versions`.
 */
export function resolveVersion(version, versions, options = {}) {
  object(options, 'options');
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new TypeError('options.maxDepth must be a non-negative integer');

  let initial = version;
  if (typeof initial === 'string') {
    initial = lookup(versions, initial);
    if (initial === undefined) {
      throw new VersionResolutionError('MISSING_VERSION', `version not found: ${version}`, { versionId: version });
    }
  }
  object(initial, 'version');

  const visit = (current, path, depth) => {
    object(current, 'version');
    const id = versionId(current);
    if (path.includes(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id];
      throw new VersionResolutionError('INHERITANCE_CYCLE', `version inheritance cycle: ${cycle.join(' -> ')}`, { cycle });
    }
    if (depth > maxDepth) {
      throw new VersionResolutionError('MAX_DEPTH_EXCEEDED', `version inheritance exceeds maximum depth ${maxDepth}`, {
        maxDepth, versionId: id,
      });
    }
    if (current.inheritsFrom === undefined) return clone(current);
    if (typeof current.inheritsFrom !== 'string' || current.inheritsFrom.length === 0) {
      throw new TypeError('version.inheritsFrom must be a non-empty string');
    }
    const parent = lookup(versions, current.inheritsFrom);
    if (parent === undefined) {
      throw new VersionResolutionError('MISSING_PARENT', `parent version not found: ${current.inheritsFrom}`, {
        versionId: id, parentId: current.inheritsFrom,
      });
    }
    return mergeVersion(visit(parent, [...path, id], depth + 1), current);
  };

  return visit(initial, [], 0);
}

export const resolveVersionInheritance = resolveVersion;
