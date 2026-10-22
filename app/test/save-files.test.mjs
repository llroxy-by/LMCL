import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import {
  MANIFEST_ENTRY, createSaveArchive, restoreSaveArchive, scanWorld,
} from '../lib/save-files.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lmcl-saves-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function adapterWith(entries) {
  return { async createArchive(args) { entries.push(args); await writeFile(args.archivePath, 'adapter'); } };
}

test('scan builds deterministic manifest and excludes volatile trees and symlinks', async t => {
  const root = await fixture(t), world = path.join(root, 'World');
  await mkdir(path.join(world, 'region'), { recursive: true });
  await mkdir(path.join(world, 'logs'), { recursive: true });
  await mkdir(path.join(world, 'crash-reports'), { recursive: true });
  await writeFile(path.join(world, 'level.dat'), 'level');
  await writeFile(path.join(world, 'session.lock'), 'lock');
  await writeFile(path.join(world, 'region', 'r.0.0.mca'), 'region');
  await writeFile(path.join(world, 'logs', 'latest.log'), 'secret');
  await writeFile(path.join(world, 'crash-reports', 'crash.txt'), 'secret');
  await symlink(path.join(world, 'level.dat'), path.join(world, 'linked.dat'));
  const manifest = await scanWorld(world);
  assert.deepEqual(manifest.files.map(file => file.path), ['level.dat', 'region/r.0.0.mca']);
  assert.equal(manifest.totalSize, 11);
  assert.match(manifest.files[0].sha256, /^[a-f0-9]{64}$/);
});

test('archive adapter is injectable and game lock rejects before reading files', async t => {
  const root = await fixture(t), world = path.join(root, 'world'), archive = path.join(root, 'save.zip');
  await mkdir(world); await writeFile(path.join(world, 'level.dat'), 'ok');
  const calls = [];
  const manifest = await createSaveArchive({ worldDir: world, archivePath: archive, archiveAdapter: adapterWith(calls) });
  assert.equal(calls.length, 1); assert.equal(manifest.files[0].path, 'level.dat');
  await assert.rejects(createSaveArchive({ worldDir: path.join(root, 'missing'), archivePath: archive, gameLocked: true }), /游戏正在运行/);
});

test('pure Node ZIP roundtrip restores through staging and keeps previous save backup', async t => {
  const root = await fixture(t), source = path.join(root, 'source'), target = path.join(root, 'target'), archive = path.join(root, 'save.zip');
  await mkdir(path.join(source, 'region'), { recursive: true });
  await writeFile(path.join(source, 'level.dat'), 'new-level');
  await writeFile(path.join(source, 'region', 'r.mca'), 'chunks');
  await mkdir(target); await writeFile(path.join(target, 'old.dat'), 'old-world');
  await createSaveArchive({ worldDir: source, archivePath: archive });
  const result = await restoreSaveArchive({ archivePath: archive, worldDir: target });
  assert.equal(await readFile(path.join(target, 'level.dat'), 'utf8'), 'new-level');
  assert.equal(await readFile(path.join(target, 'region', 'r.mca'), 'utf8'), 'chunks');
  assert.equal(await readFile(path.join(result.backupPath, 'old.dat'), 'utf8'), 'old-world');
  assert.deepEqual((await readdir(root)).filter(name => name.includes('.restore-')), []);
});

test('manifest tampering is rejected without touching current world', async t => {
  const root = await fixture(t), world = path.join(root, 'world'), archive = path.join(root, 'bad.zip');
  await mkdir(world); await writeFile(path.join(world, 'old.dat'), 'safe');
  const fake = {
    version: 1, algorithm: 'sha256', totalSize: 1,
    files: [{ path: 'level.dat', size: 1, sha256: '0'.repeat(64) }],
  };
  // Adapter fixture uses the module's own safe ZIP writer indirectly, then corrupts manifest bytes in place.
  const source = path.join(root, 'source'); await mkdir(source); await writeFile(path.join(source, 'level.dat'), 'x');
  await createSaveArchive({ worldDir: source, archivePath: archive });
  const bytes = await readFile(archive);
  const marker = Buffer.from('"sha256":"');
  const at = bytes.indexOf(marker);
  bytes.fill('0'.charCodeAt(0), at + marker.length, at + marker.length + 64);
  await writeFile(archive, bytes);
  await assert.rejects(restoreSaveArchive({ archivePath: archive, worldDir: world }), /校验失败|CRC/);
  assert.equal(await readFile(path.join(world, 'old.dat'), 'utf8'), 'safe');
  void fake; void MANIFEST_ENTRY;
});

test('limits reject file count, size and suspicious compression ratio', async t => {
  const root = await fixture(t), world = path.join(root, 'world'), archive = path.join(root, 'save.zip');
  await mkdir(world); await writeFile(path.join(world, 'a'), '1234'); await writeFile(path.join(world, 'b'), '5');
  await assert.rejects(scanWorld(world, { limits: { maxFiles: 1 } }), /文件数/);
  await assert.rejects(scanWorld(world, { limits: { maxFileSize: 3 } }), /单文件/);
  await createSaveArchive({ worldDir: world, archivePath: archive });
  await assert.rejects(restoreSaveArchive({ archivePath: archive, worldDir: path.join(root, 'out'), limits: { maxCompressionRatio: 0.5 } }), /压缩比/);
});

test('failed final rename rolls old save back into place', async t => {
  const root = await fixture(t), source = path.join(root, 'source'), target = path.join(root, 'target'), archive = path.join(root, 'save.zip');
  await mkdir(source); await writeFile(path.join(source, 'new.dat'), 'new');
  await mkdir(target); await writeFile(path.join(target, 'old.dat'), 'old');
  await createSaveArchive({ worldDir: source, archivePath: archive });
  const { rename } = await import('node:fs/promises'); let calls = 0;
  await assert.rejects(restoreSaveArchive({ archivePath: archive, worldDir: target, fileOps: {
    rename: async (from, to) => { calls++; if (calls === 2) throw new Error('injected rename failure'); return rename(from, to); },
  } }), /injected/);
  assert.equal(await readFile(path.join(target, 'old.dat'), 'utf8'), 'old');
  await assert.rejects(readFile(path.join(target, 'new.dat')));
});
