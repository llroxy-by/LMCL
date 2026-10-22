import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { installLoader } from '../lib/loader-installer.mjs';

const hashes = bytes => ({
  sha1: createHash('sha1').update(bytes).digest('hex'),
  sha256: createHash('sha256').update(bytes).digest('hex'),
});

function fixture(bytes = Buffer.from('loader library'), overrides = {}) {
  return {
    versionId: 'fabric-loader-1.0-1.20.1',
    versionJson: { id: 'fabric-loader-1.0-1.20.1', inheritsFrom: '1.20.1', mainClass: 'example.Loader' },
    libraries: [{ url: 'fixture://loader', path: 'example/loader/1.0/loader-1.0.jar', size: bytes.length,
      ...hashes(bytes), ...overrides }],
  };
}

async function sandbox(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lmcl-loader-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const writer = bytes => async (_file, destination) => { await writeFile(destination, bytes); };

test('stages, verifies and atomically commits loader JSON and libraries with progress', async t => {
  const root = await sandbox(t);
  const bytes = Buffer.from('verified loader library');
  const progress = [];
  const result = await installLoader({ plan: fixture(bytes), gamesRoot: root, downloader: writer(bytes),
    signal: new AbortController().signal, onProgress: event => progress.push(event) });
  assert.equal(result.versionId, 'fabric-loader-1.0-1.20.1');
  assert.deepEqual(await readFile(path.join(root, 'libraries/example/loader/1.0/loader-1.0.jar')), bytes);
  const json = JSON.parse(await readFile(path.join(root, 'versions/fabric-loader-1.0-1.20.1/fabric-loader-1.0-1.20.1.json')));
  assert.equal(json.inheritsFrom, '1.20.1');
  assert.ok(progress.some(value => value.phase === 'download' && value.done === 1));
  assert.ok(progress.some(value => value.phase === 'commit' && value.done === 2));
  assert.equal((await readdir(root)).some(name => name.startsWith('.loader-installing-')), false);
});

test('SHA-1, SHA-256 and size failures roll back without touching an existing vanilla install', async t => {
  for (const override of [{ sha1: '0'.repeat(40) }, { sha256: '0'.repeat(64) }, { size: 999 }]) {
    const root = await sandbox(t);
    const vanilla = path.join(root, 'versions/1.20.1');
    await mkdir(vanilla, { recursive: true });
    await writeFile(path.join(vanilla, '1.20.1.json'), 'original vanilla');
    const bytes = Buffer.from('corruptible');
    await assert.rejects(installLoader({ plan: fixture(bytes, override), gamesRoot: root,
      downloader: writer(bytes), signal: new AbortController().signal }), /校验/);
    assert.equal(await readFile(path.join(vanilla, '1.20.1.json'), 'utf8'), 'original vanilla');
    await assert.rejects(readFile(path.join(root, 'versions/fabric-loader-1.0-1.20.1/fabric-loader-1.0-1.20.1.json')));
    assert.equal((await readdir(root)).some(name => name.startsWith('.loader-installing-')), false);
  }
});

test('commit failure restores overwritten libraries and leaves no loader version JSON', async t => {
  const root = await sandbox(t);
  const bytes = Buffer.from('new library');
  const library = path.join(root, 'libraries/example/loader/1.0');
  await mkdir(library, { recursive: true });
  await writeFile(path.join(library, 'loader-1.0.jar'), 'old library');
  const versionDirectory = path.join(root, 'versions/fabric-loader-1.0-1.20.1');
  await mkdir(versionDirectory, { recursive: true });
  await mkdir(path.join(versionDirectory, 'fabric-loader-1.0-1.20.1.json'));
  await assert.rejects(installLoader({ plan: fixture(bytes), gamesRoot: root, downloader: writer(bytes),
    signal: new AbortController().signal }), /拒绝覆盖/);
  assert.equal(await readFile(path.join(library, 'loader-1.0.jar'), 'utf8'), 'old library');
});

test('AbortSignal cancels staging and removes all transaction files', async t => {
  const root = await sandbox(t);
  const bytes = Buffer.from('cancelled library');
  const controller = new AbortController();
  await assert.rejects(installLoader({ plan: fixture(bytes), gamesRoot: root, signal: controller.signal,
    downloader: async (_file, destination) => { await writeFile(destination, bytes); controller.abort(); } }),
  error => error.name === 'AbortError');
  assert.deepEqual(await readdir(root), []);
});

test('rejects traversal paths and symlinked installation parents', async t => {
  const root = await sandbox(t);
  const bytes = Buffer.from('safe');
  await assert.rejects(installLoader({ plan: fixture(bytes, { path: '../escape.jar' }), gamesRoot: root,
    downloader: writer(bytes), signal: new AbortController().signal }));
  const outside = await sandbox(t);
  await symlink(outside, path.join(root, 'libraries'));
  await assert.rejects(installLoader({ plan: fixture(bytes), gamesRoot: root,
    downloader: writer(bytes), signal: new AbortController().signal }), /符号链接/);
  assert.deepEqual(await readdir(outside), []);
});

test('rejects a symlink emitted by an untrusted downloader', async t => {
  const root = await sandbox(t);
  const outside = path.join(root, 'outside');
  await writeFile(outside, 'outside');
  const bytes = Buffer.from('safe');
  await assert.rejects(installLoader({ plan: fixture(bytes), gamesRoot: root, signal: new AbortController().signal,
    downloader: async (_file, destination) => symlink(outside, destination) }), /普通文件/);
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});
