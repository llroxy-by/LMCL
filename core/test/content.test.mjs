import test from 'node:test';
import assert from 'node:assert/strict';
import { mirrorURL, sourceOrder, resolveSources, tooSlow, recordFailure, coolingDown,
  normalizeDownloadMode, mirrorAvailable, MOJANG_MIRROR, FAILURE_COOLDOWN_MS,
  FIRST_BYTE_TIMEOUT_MS, MIN_BYTES_PER_SECOND, SLOW_WINDOW_MS } from '../src/download-source.mjs';
import { contentKind, projectTypeOf, directoryOf, contentPath, contentFileName,
  installsAsInstance, hasCatalogue, projectSummary, primaryFile, CONTENT_KINDS } from '../src/content.mjs';

test('mirror rewrites each Mojang layout used by the launcher', () => {
  assert.equal(mirrorURL('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'),
    `${MOJANG_MIRROR}/mc/game/version_manifest_v2.json`);
  assert.equal(mirrorURL('https://piston-meta.mojang.com/v1/packages/abc/5.json'),
    `${MOJANG_MIRROR}/v1/packages/abc/5.json`);
  assert.equal(mirrorURL('https://piston-data.mojang.com/v1/objects/dead/client.jar'),
    `${MOJANG_MIRROR}/v1/objects/dead/client.jar`);
  assert.equal(mirrorURL('https://libraries.minecraft.net/org/ow2/asm/asm/9.3/asm-9.3.jar'),
    `${MOJANG_MIRROR}/maven/org/ow2/asm/asm/9.3/asm-9.3.jar`);
  assert.equal(mirrorURL('https://resources.download.minecraft.net/b6/b62ca8ec10d0'),
    `${MOJANG_MIRROR}/assets/b6/b62ca8ec10d0`);
});

test('mirror leaves foreign hosts alone and rejects insecure or credentialed URLs', () => {
  assert.equal(mirrorURL('https://cdn.modrinth.com/data/x/versions/y/file.jar'), null);
  assert.throws(() => mirrorURL('http://piston-meta.mojang.com/mc/game/version_manifest_v2.json'));
  assert.throws(() => mirrorURL('https://user:pass@piston-meta.mojang.com/x'));
  assert.throws(() => mirrorURL('https://piston-meta.mojang.com/x', 'http://mirror.example'));
});

test('auto prefers the mirror and keeps the official host as fallback', () => {
  assert.deepEqual(sourceOrder({ mode: 'auto', channel: 'mojang' }), ['mirror', 'official']);
  assert.deepEqual(sourceOrder({ mode: 'official', channel: 'mojang' }), ['official']);
  assert.deepEqual(sourceOrder({ mode: 'mirror', channel: 'mojang' }), ['mirror']);
});

test('content channel has no public mirror, so it always uses the official host', () => {
  assert.equal(mirrorAvailable({ channel: 'content' }), false);
  assert.deepEqual(sourceOrder({ mode: 'auto', channel: 'content' }), ['official']);
  assert.deepEqual(sourceOrder({ mode: 'auto', channel: 'content', mirrorBase: 'https://mirror.example' }), ['mirror', 'official']);
  assert.throws(() => sourceOrder({ channel: 'unknown' }));
});

test('unknown download modes are rejected rather than silently defaulted', () => {
  assert.equal(normalizeDownloadMode(undefined), 'auto');
  assert.equal(normalizeDownloadMode('official'), 'official');
  assert.throws(() => normalizeDownloadMode('fastest'));
});

test('slow transfers are only judged after the grace window', () => {
  assert.equal(tooSlow({ bytes: 1, elapsedMs: SLOW_WINDOW_MS - 1 }), false);
  assert.equal(tooSlow({ bytes: MIN_BYTES_PER_SECOND * 5, elapsedMs: 5000 }), false);
  assert.equal(tooSlow({ bytes: 1024, elapsedMs: 60000 }), true);
  assert.throws(() => tooSlow({ bytes: -1, elapsedMs: 5000 }));
});

test('a failed source cools down but the last resort stays available', () => {
  const health = new Map();
  recordFailure(health, 'mirror', 1000);
  assert.equal(coolingDown(health, 'mirror', 1000 + FAILURE_COOLDOWN_MS - 1), true);
  assert.equal(coolingDown(health, 'mirror', 1000 + FAILURE_COOLDOWN_MS), false);
  assert.deepEqual(resolveSources({ mode: 'auto', health, now: 2000 }), ['official']);
  health.set('official', 9e15);
  assert.deepEqual(resolveSources({ mode: 'auto', health, now: 2000 }), ['mirror', 'official']);
  // 显式模式不受冷却影响
  assert.deepEqual(resolveSources({ mode: 'mirror', health, now: 2000 }), ['mirror']);
});

test('first-byte timeout is shorter than the slow-transfer window', () => {
  assert.ok(FIRST_BYTE_TIMEOUT_MS > SLOW_WINDOW_MS / 2);
});

test('each content kind maps to its conventional directory and extension', () => {
  assert.deepEqual(CONTENT_KINDS, ['mod', 'modpack', 'resourcepack', 'shader', 'schematic']);
  assert.equal(directoryOf('mod'), 'mods');
  assert.equal(directoryOf('resourcepack'), 'resourcepacks');
  assert.equal(directoryOf('shader'), 'shaderpacks');
  assert.equal(directoryOf('schematic'), 'schematics');
  assert.equal(directoryOf('modpack'), null);
  assert.equal(installsAsInstance('modpack'), true);
  assert.equal(installsAsInstance('mod'), false);
  assert.equal(hasCatalogue('schematic'), false);
  assert.equal(hasCatalogue('shader'), true);
  assert.throws(() => contentKind('plugin'));
});

test('file names cannot escape the instance or smuggle the wrong extension', () => {
  assert.equal(contentPath('mod', 'example.jar'), 'mods/example.jar');
  assert.equal(contentPath('shader', 'Bliss.zip'), 'shaderpacks/Bliss.zip');
  assert.equal(contentPath('schematic', 'castle.litematic'), 'schematics/castle.litematic');
  for (const name of ['../evil.jar', 'sub/dir/a.jar', 'a.exe', 'a.jar.exe', '', 'C:evil.jar', 'a.jar ']) {
    assert.throws(() => contentFileName(name, 'mod'), `expected ${name} to be rejected`);
  }
  // 以点开头在 Windows 上只是普通文件名，不是路径逃逸，允许通过。
  assert.equal(contentFileName('.hidden.jar', 'mod'), '.hidden.jar');
  assert.throws(() => contentPath('modpack', 'pack.mrpack'));
});

test('search hits are reduced to display-safe fields', () => {
  const hit = projectSummary({ project_id: 'P7dR8mSH', slug: 'fabric-api', title: 'Fabric API',
    description: 'x'.repeat(999), author: 'modmuss50', downloads: 123, follows: 4,
    icon_url: 'https://cdn.modrinth.com/data/P7dR8mSH/icon.png', categories: ['fabric', 5],
    versions: ['1.20.1'], extra: 'dropped' });
  assert.equal(hit.iconUrl.startsWith('https://cdn.modrinth.com/'), true);
  assert.equal(hit.description.length, 400);
  assert.deepEqual(hit.categories, ['fabric']);
  assert.equal('extra' in hit, false);
  assert.equal(projectSummary({ title: 'no icon', icon_url: 'https://evil.example/i.png' }).iconUrl, '');
});

test('the primary file is chosen among files matching the kind', () => {
  const version = { files: [
    { filename: 'sources.jar', primary: false, url: 'https://cdn.modrinth.com/a' },
    { filename: 'mod.jar', primary: true, url: 'https://cdn.modrinth.com/b' },
  ] };
  assert.equal(primaryFile(version, 'mod').filename, 'mod.jar');
  assert.throws(() => primaryFile(version, 'shader'));
  assert.throws(() => primaryFile({ files: [] }, 'mod'));
});
