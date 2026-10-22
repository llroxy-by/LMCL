import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSavePath, normalizeSaveManifest, digestSaveManifest, planSaveSync,
  createSaveSyncState, transitionSaveSync,
} from '../src/save-sync.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const file = (path, sha256 = A, size = 10) => ({ path, sha256, size });
const manifest = (...files) => ({ files });

test('save paths normalize Unicode but reject traversal and Windows ambiguity', () => {
  assert.equal(normalizeSavePath('世界/Cafe\u0301/level.dat'), '世界/Café/level.dat');
  for (const path of ['', '/world/a', 'C:/world/a', '../a', 'world/../a', 'world/./a',
    'world//a', 'world\\a', 'world/a:', 'world/a?', 'world/NUL.txt', 'world/com1',
    'world/a.', 'world/a ', `world/a\u0000`]) {
    assert.throws(() => normalizeSavePath(path), path);
  }
});

test('manifest is canonical, metadata-free, case-safe, and digest is stable', () => {
  const first = manifest({ ...file('world/z.dat', A, 3), mtime: 123 }, file('world/a.dat', B, 2));
  const second = manifest(file('world/a.dat', B.toUpperCase(), 2), file('world/z.dat', A, 3));
  assert.deepEqual(normalizeSaveManifest(first), {
    version: 1,
    files: [file('world/a.dat', B, 2), file('world/z.dat', A, 3)],
    totalSize: 5,
  });
  assert.equal(digestSaveManifest(first), digestSaveManifest(second));
  assert.match(digestSaveManifest(first), /^[a-f0-9]{64}$/);
  assert.throws(() => normalizeSaveManifest(manifest(file('World/a'), file('world/A', B))));
  assert.throws(() => normalizeSaveManifest(manifest(file('world/a'), file('world/a/child', B))));
});

test('manifest rejects untrusted hash, size, entry, and overflow', () => {
  assert.throws(() => normalizeSaveManifest(manifest({ path: 'a', sha256: 'weak', size: 1 })));
  assert.throws(() => normalizeSaveManifest(manifest(file('a', A, -1))));
  assert.throws(() => normalizeSaveManifest({ files: [null] }));
  assert.throws(() => normalizeSaveManifest(manifest(file('a', A, Number.MAX_SAFE_INTEGER), file('b', B, 1))));
});

test('three-way planning propagates one-sided create, update, and delete', () => {
  const base = manifest(file('same'), file('remote-change'), file('remote-delete'), file('local-change'), file('local-delete'));
  const local = manifest(file('same'), file('remote-change'), file('remote-delete'), file('local-change', B), file('local-new', C));
  const remote = manifest(file('same'), file('remote-change', B), file('local-change'), file('local-delete'), file('remote-new', C));
  const plan = planSaveSync({ base, local, remote });
  assert.deepEqual(plan.downloads.map(x => x.path), ['remote-change', 'remote-new']);
  assert.deepEqual(plan.uploads.map(x => x.path), ['local-change', 'local-new']);
  assert.deepEqual(plan.deleteLocal.map(x => x.path), ['remote-delete']);
  assert.deepEqual(plan.deleteRemote.map(x => x.path), ['local-delete']);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.canSync, true);
});

test('three-way planning reports both-changed and delete-vs-change conflicts', () => {
  const base = manifest(file('changed'), file('deleted-local'), file('deleted-remote'));
  const local = manifest(file('changed', B), file('deleted-remote', B));
  const remote = manifest(file('changed', C), file('deleted-local', C));
  const plan = planSaveSync({ base, local, remote });
  assert.deepEqual(plan.conflicts.map(x => [x.path, x.reason]), [
    ['changed', 'both-changed'],
    ['deleted-local', 'delete-vs-change'],
    ['deleted-remote', 'delete-vs-change'],
  ]);
  assert.equal(plan.status, 'conflict');
  assert.equal(plan.canSync, false);
});

test('same concurrent result and same concurrent deletion need no operation', () => {
  const plan = planSaveSync({
    base: manifest(file('updated'), file('removed')),
    local: manifest(file('updated', B)),
    remote: manifest(file('updated', B)),
  });
  assert.deepEqual(plan.unchanged, [
    { path: 'removed', state: 'deleted' },
    { path: 'updated', state: 'present' },
  ]);
  assert.equal(plan.operationCount, 0);
  assert.equal(plan.status, 'up-to-date');
});

test('offline and game lock defer otherwise safe work without losing intents', () => {
  const offline = planSaveSync({ local: manifest(file('new')), online: false });
  assert.equal(offline.status, 'pending-offline');
  assert.deepEqual(offline.deferredReasons, ['offline']);
  assert.equal(offline.uploads.length, 1);
  assert.equal(offline.canSync, false);

  const locked = planSaveSync({ remote: manifest(file('new')), online: false, gameRunning: true });
  assert.equal(locked.status, 'blocked-game');
  assert.deepEqual(locked.deferredReasons, ['game-running', 'offline']);
  assert.equal(locked.downloads.length, 1);
});

test('strict state machine supports offline retry and game exit unlock', () => {
  const plan = planSaveSync({ local: manifest(file('new')), online: false, gameRunning: true });
  let state = createSaveSyncState();
  state = transitionSaveSync(state, { type: 'START' });
  state = transitionSaveSync(state, { type: 'PLANNED', plan });
  assert.equal(state.status, 'blocked-game');
  state = transitionSaveSync(state, { type: 'GAME_EXITED' });
  assert.equal(state.status, 'pending-offline');
  state = transitionSaveSync(state, { type: 'NETWORK_ONLINE' });
  assert.equal(state.status, 'ready');
  state = transitionSaveSync(state, { type: 'APPLY' });
  assert.equal(state.status, 'syncing');
  state = transitionSaveSync(state, { type: 'SUCCEEDED' });
  assert.equal(state.status, 'synced');
});

test('strict state machine rejects skipped, duplicate, and unsafe transitions', () => {
  const idle = createSaveSyncState();
  assert.throws(() => transitionSaveSync(idle, { type: 'APPLY' }));
  const evaluating = transitionSaveSync(idle, { type: 'START' });
  assert.throws(() => transitionSaveSync(evaluating, { type: 'START' }));

  const conflictPlan = planSaveSync({
    base: manifest(file('a')), local: manifest(file('a', B)), remote: manifest(file('a', C)),
  });
  const conflict = transitionSaveSync(evaluating, { type: 'PLANNED', plan: conflictPlan });
  assert.equal(conflict.status, 'conflict');
  assert.throws(() => transitionSaveSync(conflict, { type: 'APPLY' }));

  const readyPlan = planSaveSync({ local: manifest(file('a')) });
  let ready = transitionSaveSync(evaluating, { type: 'PLANNED', plan: readyPlan });
  ready = transitionSaveSync(ready, { type: 'GAME_STARTED' });
  assert.equal(ready.status, 'blocked-game');
  assert.throws(() => transitionSaveSync(ready, { type: 'APPLY' }));
});

test('failure is explicit and retry requires a fresh evaluation', () => {
  const plan = planSaveSync({ local: manifest(file('a')) });
  let state = transitionSaveSync(createSaveSyncState(), { type: 'START' });
  state = transitionSaveSync(state, { type: 'PLANNED', plan });
  state = transitionSaveSync(state, { type: 'APPLY' });
  state = transitionSaveSync(state, { type: 'FAILED', error: 'network timeout' });
  assert.equal(state.status, 'failed');
  assert.equal(state.error, 'network timeout');
  assert.throws(() => transitionSaveSync(state, { type: 'APPLY' }));
  assert.equal(transitionSaveSync(state, { type: 'START' }).status, 'evaluating');
});
