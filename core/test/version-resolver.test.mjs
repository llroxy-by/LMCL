import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeArguments, mergeLibraries, resolveVersion, VersionResolutionError,
} from '../src/version-resolver.mjs';
import {
  normalizeFabricProfile, normalizeLoaderProfile, normalizeQuiltProfile,
} from '../src/loader-profile.mjs';

const base = {
  id: '1.20.1', mainClass: 'net.minecraft.client.main.Main',
  libraries: [{ name: 'a:base:1' }, { name: 'shared:lib:1', downloads: { artifact: 'old' } }],
  arguments: { game: ['--base'], jvm: ['-Xbase'] },
  downloads: { client: { url: 'base' }, server: { url: 'server' } },
  javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
};
const middle = {
  id: 'middle', inheritsFrom: '1.20.1',
  libraries: [{ name: 'shared:lib:1', downloads: { artifact: 'new' } }, { name: 'b:middle:1' }],
  arguments: { game: ['--middle'] }, downloads: { client: { url: 'middle' } },
};
const leaf = {
  id: 'leaf', inheritsFrom: 'middle', mainClass: 'loader.Main',
  libraries: [{ name: 'c:leaf:1' }], arguments: { jvm: ['-Xleaf'] },
  javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
};

test('recursively resolves inheritance and deterministically merges selected fields', () => {
  const source = new Map([[base.id, base], [middle.id, middle], [leaf.id, leaf]]);
  const result = resolveVersion('leaf', source);
  assert.equal(result.id, 'leaf');
  assert.equal(result.inheritsFrom, undefined);
  assert.equal(result.mainClass, 'loader.Main');
  assert.deepEqual(result.libraries.map(x => x.name), ['a:base:1', 'shared:lib:1', 'b:middle:1', 'c:leaf:1']);
  assert.equal(result.libraries[1].downloads.artifact, 'new');
  assert.deepEqual(result.arguments, { game: ['--base', '--middle'], jvm: ['-Xbase', '-Xleaf'] });
  assert.deepEqual(result.downloads, { client: { url: 'middle' }, server: { url: 'server' } });
  assert.equal(result.javaVersion.majorVersion, 21);
  result.libraries[0].name = 'changed';
  assert.equal(base.libraries[0].name, 'a:base:1');
});

test('merge helpers preserve order and child library replacement is stable', () => {
  assert.deepEqual(mergeLibraries(
    [{ name: 'x:one:1' }, { name: 'x:two:1', marker: 'parent' }],
    [{ name: 'x:two:1', marker: 'child' }, { name: 'x:three:1' }],
  ), [{ name: 'x:one:1' }, { name: 'x:two:1', marker: 'child' }, { name: 'x:three:1' }]);
  assert.deepEqual(mergeArguments({ game: ['a'] }, { game: ['b'], jvm: ['c'] }), {
    game: ['a', 'b'], jvm: ['c'],
  });
});

test('reports missing parent, cycles, and excessive depth with stable codes', () => {
  assert.throws(() => resolveVersion({ id: 'child', inheritsFrom: 'missing' }, {}),
    error => error instanceof VersionResolutionError && error.code === 'MISSING_PARENT' && error.parentId === 'missing');
  const cyclic = { a: { id: 'a', inheritsFrom: 'b' }, b: { id: 'b', inheritsFrom: 'a' } };
  assert.throws(() => resolveVersion('a', cyclic),
    error => error.code === 'INHERITANCE_CYCLE' && error.cycle.join(',') === 'a,b,a');
  const chain = { a: { id: 'a', inheritsFrom: 'b' }, b: { id: 'b', inheritsFrom: 'c' }, c: { id: 'c' } };
  assert.throws(() => resolveVersion('a', chain, { maxDepth: 1 }), error => error.code === 'MAX_DEPTH_EXCEEDED');
});

test('normalizes Fabric profile into the common loader structure', () => {
  const profile = {
    id: 'fabric-loader-0.15.11-1.20.1', inheritsFrom: '1.20.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.11' }, { name: 'x:y:1' }],
    arguments: { game: ['--fabric'], jvm: ['-Dfabric=true'] },
  };
  const normalized = normalizeFabricProfile(profile);
  assert.deepEqual(normalized, {
    loader: 'fabric', loaderVersion: '0.15.11', minecraftVersion: '1.20.1',
    id: profile.id, mainClass: profile.mainClass, libraries: profile.libraries,
    arguments: profile.arguments,
  });
  normalized.libraries[0].name = 'changed';
  assert.equal(profile.libraries[0].name, 'net.fabricmc:fabric-loader:0.15.11');
});

test('normalizes Quilt, auto-detects loader, and supports legacy game arguments', () => {
  const profile = {
    id: 'quilt-loader-0.26.3-1.21', inheritsFrom: '1.21',
    mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotClient',
    libraries: [{ name: 'org.quiltmc:quilt-loader:0.26.3' }],
    minecraftArguments: '--username ${auth_player_name}',
    javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
  };
  const expected = normalizeQuiltProfile(profile);
  assert.equal(expected.loader, 'quilt');
  assert.equal(expected.loaderVersion, '0.26.3');
  assert.deepEqual(expected.arguments, { game: ['--username ${auth_player_name}'], jvm: [] });
  assert.deepEqual(normalizeLoaderProfile(profile), expected);
});

test('loader normalization rejects unsupported or incomplete profiles', () => {
  assert.throws(() => normalizeLoaderProfile({ id: 'unknown', inheritsFrom: '1', mainClass: 'Main' }));
  assert.throws(() => normalizeLoaderProfile({ id: 'x', mainClass: 'Main' }, 'fabric'));
  assert.throws(() => normalizeLoaderProfile({ id: 'x', inheritsFrom: '1', mainClass: 'Main' }, 'forge'));
});
