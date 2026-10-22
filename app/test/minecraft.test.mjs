import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { allowed, libraryPlan, expandArguments, launchArguments, inside } from '../lib/minecraft-rules.mjs';
import { officialURL, download, downloadQueue, getJSON } from '../lib/network.mjs';
import { createOfflineProfile } from '../../core/src/accounts.mjs';

const artifact = { path: 'org/example/library/1/library-1.jar', sha1: 'a'.repeat(40), size: 10, url: 'https://libraries.minecraft.net/library.jar' };
const native = { ...artifact, path: 'org/example/native/1/native-windows.jar' };
const metadata = {
  id: '1.20.1', type: 'release', mainClass: 'net.minecraft.client.main.Main', assetIndex: { id: '5' },
  libraries: [{ name: 'org.example:library:1', downloads: { artifact } },
    { name: 'org.example:native:1', natives: { windows: 'natives-windows' }, downloads: { classifiers: { 'natives-windows': native } } }],
  arguments: { jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
    game: ['--username', '${auth_player_name}', '--gameDir', '${game_directory}', '--uuid', '${auth_uuid}',
      { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}'] }] },
};

test('Minecraft rules obey platform exclusions and disabled features', () => {
  const rules = [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }];
  assert.equal(allowed(rules, 'win32', 'x64'), true);
  assert.equal(allowed(rules, 'darwin', 'arm64'), false);
  assert.deepEqual(expandArguments(metadata.arguments.game.slice(-1), {}, 'win32', 'x64'), []);
});

test('library plan selects Windows natives without adding classifier to classpath', () => {
  const planned = libraryPlan(metadata, 'win32', 'x64');
  assert.deepEqual(planned.artifacts, [artifact]);
  assert.deepEqual(planned.natives, [native]);
  assert.deepEqual(libraryPlan(metadata, 'linux', 'x64').natives, []);
});

test('launch keeps arguments separate and never adds a server target or a shell command', () => {
  const root = path.join(os.tmpdir(), 'Game Directory');
  const profile = createOfflineProfile('LMCL_Test');
  const args = launchArguments(metadata, { root, profile, platform: 'win32' });
  assert.equal(args[0], '-Xmx4096M');
  assert.equal(args[args.indexOf('--gameDir') + 1], root);
  assert.equal(args[args.indexOf('--username') + 1], 'LMCL_Test');
  assert.equal(args[args.indexOf('--uuid') + 1], profile.uuid.replaceAll('-', ''));
  assert.equal(args.includes('--server'), false);
  assert.equal(args.includes('--width'), false);
  assert.ok(args[args.indexOf('-cp') + 1].includes(';'));
});

test('modern native artifact classifiers select the target CPU even when Mojang only specifies OS rules', () => {
  const libraries = ['', '-x86', '-arm64'].map(suffix => ({
    name: `org.lwjgl:lwjgl:3.3.1:natives-windows${suffix}`,
    rules: [{ action: 'allow', os: { name: 'windows' } }],
    downloads: { artifact: { ...artifact, path: `org/lwjgl/lwjgl-3.3.1-natives-windows${suffix}.jar` } },
  }));
  for (const [arch, suffix] of [['x64', ''], ['ia32', '-x86'], ['arm64', '-arm64']]) {
    const plan = libraryPlan({ libraries }, 'win32', arch);
    assert.equal(plan.artifacts.length, 1);
    assert.equal(plan.natives.length, 1);
    assert.equal(plan.natives[0].path, `org/lwjgl/lwjgl-3.3.1-natives-windows${suffix}.jar`);
  }
});

test('unsupported inheritance, missing placeholders and unsafe filesystem paths are rejected', () => {
  assert.throws(() => launchArguments({ ...metadata, inheritsFrom: '1.20.1' }, { root: '.', profile: createOfflineProfile('Player') }));
  assert.throws(() => expandArguments(['${not_supported}'], {}));
  for (const file of ['../evil', 'libs/../../evil', 'libs\\evil', 'libs/NUL.dll']) assert.throws(() => inside('/tmp/game', file));
  assert.throws(() => launchArguments(metadata, { root: '.', profile: createOfflineProfile('Player'), memoryMB: 1 }));
});

test('Apple Silicon uses only ARM native artifacts and keeps the first-thread JVM flag', () => {
  const libraries = ['', '-arm64'].map(suffix => ({
    name: `org.lwjgl:lwjgl:3.3.1:natives-macos${suffix}`,
    rules: [{ action: 'allow', os: { name: 'osx' } }],
    downloads: { artifact: { ...artifact, path: `org/lwjgl/lwjgl-3.3.1-natives-macos${suffix}.jar` } },
  }));
  const mac = { ...metadata, libraries,
    arguments: { ...metadata.arguments, jvm: [...metadata.arguments.jvm,
      { rules: [{ action: 'allow', os: { name: 'osx' } }], value: '-XstartOnFirstThread' }] } };
  const plan = libraryPlan(mac, 'darwin', 'arm64');
  assert.equal(plan.natives.length, 1);
  assert.match(plan.natives[0].path, /macos-arm64/);
  const args = launchArguments(mac, { root: '/fixture/game', profile: createOfflineProfile('LMCL_Test'), platform: 'darwin', arch: 'arm64' });
  assert.ok(args.includes('-XstartOnFirstThread'));
  assert.match(args[args.indexOf('-cp') + 1], /\.jar:/);
  assert.equal(allowed([{ action: 'allow', os: { arch: '^aarch64$' } }], 'darwin', 'arm64'), true);
  assert.throws(() => libraryPlan({ libraries: libraries.slice(0, 1) }, 'darwin', 'arm64'), /M 系列原生库/);
});

test('Apple Silicon never falls back to legacy Intel-only classifiers', () => {
  const legacy = { name: 'org.example:native:1', natives: { osx: 'natives-osx' },
    downloads: { classifiers: { 'natives-osx': native } } };
  assert.throws(() => libraryPlan({ libraries: [legacy] }, 'darwin', 'arm64'), /M 系列原生库/);
  const arm = { ...native, path: 'org/example/native/1/native-macos-arm64.jar' };
  legacy.downloads.classifiers['natives-macos-arm64'] = arm;
  assert.deepEqual(libraryPlan({ libraries: [legacy] }, 'darwin', 'arm64').natives, [arm]);
});

test('only official HTTPS domains are accepted for game file downloads', () => {
  assert.equal(officialURL('https://libraries.minecraft.net/a.jar'), 'https://libraries.minecraft.net/a.jar');
  for (const url of ['http://libraries.minecraft.net/a', 'https://libraries.minecraft.net.evil.org/a',
    'https://user:pass@libraries.minecraft.net/a', 'https://example.org/a', 'file:///tmp/a']) assert.throws(() => officialURL(url));
});

test('downloader verifies bytes and cached hashes, with no partial file on integrity failure', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lmcl-download-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('synthetic game file');
  const file = { url: 'https://libraries.minecraft.net/fixture.jar', size: bytes.length,
    sha1: createHash('sha1').update(bytes).digest('hex') };
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response(bytes); });
  const destination = path.join(root, 'good.jar');
  await download(file, destination, new AbortController().signal);
  assert.deepEqual(await readFile(destination), bytes);
  await download(file, destination, new AbortController().signal);
  assert.equal(requests, 1);
  await assert.rejects(download({ ...file, sha1: 'b'.repeat(40) }, path.join(root, 'bad.jar'), new AbortController().signal));
  assert.deepEqual(await readdir(root), ['good.jar']);
});

test('metadata verifies expected hash and provider JSON never follows a redirect', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"ok":true}'));
  await assert.rejects(getJSON('https://piston-meta.mojang.com/file.json', { official: true, sha1: '0'.repeat(40) }));
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 302, headers: { location: 'https://other.example.org/' } }));
  await assert.rejects(getJSON('https://community.example.org/lmcl/v1/servers'), /重定向/);
});

test('cancelled queue rejects and leaves no installed files', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(downloadQueue([], controller.signal));
});

test('import scans existing vanilla metadata and skips unsupported loader versions', async t => {
  const { importDirectory } = await import('../lib/minecraft.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'lmcl-import-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [id, data] of [['1.20.1', metadata], ['fabric', { id: 'fabric', inheritsFrom: '1.20.1' }]]) {
    const version = path.join(root, 'versions', id); await mkdir(version, { recursive: true });
    await writeFile(path.join(version, `${id}.json`), JSON.stringify(data));
  }
  const entries = await importDirectory(root);
  assert.equal(entries.length, 1); assert.equal(entries[0].version, '1.20.1'); assert.equal(entries[0].managed, false);
  assert.ok(await readFile(path.join(root, 'versions/fabric/fabric.json')));
});
