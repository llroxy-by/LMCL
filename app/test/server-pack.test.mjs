import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { exportServerPackArchive, validateServerConnection } from '../lib/instance-pack-exporter.mjs';
import { installServerPack, resolveInstanceServer } from '../lib/server-pack-installer.mjs';
import { launchArguments } from '../lib/minecraft-rules.mjs';

test('validateServerConnection strictly verifies host and port bounds', () => {
  assert.deepEqual(validateServerConnection({ host: 'play.mangomc.top', port: 25565 }), {
    host: 'play.mangomc.top',
    port: 25565
  });
  assert.deepEqual(validateServerConnection({ host: '127.0.0.1', port: '25565' }), {
    host: '127.0.0.1',
    port: 25565
  });
  assert.throws(() => validateServerConnection({ host: '', port: 25565 }));
  assert.throws(() => validateServerConnection({ host: 'bad host with space', port: 25565 }));
  assert.throws(() => validateServerConnection({ host: 'play.mangomc.top', port: 0 }));
  assert.throws(() => validateServerConnection({ host: 'play.mangomc.top', port: 70000 }));
});

test('launchArguments appends --server and --port when server option provided', () => {
  const metadata = {
    id: '1.20.1',
    mainClass: 'net.minecraft.client.main.Main',
    arguments: {
      game: ['--username', '${auth_player_name}'],
      jvm: ['-Djava.library.path=${natives_directory}']
    }
  };
  const profile = { name: 'Player', uuid: '00000000-0000-0000-0000-000000000000' };

  // 无直连参数
  const normalArgs = launchArguments(metadata, { root: '/game', profile });
  assert.equal(normalArgs.includes('--server'), false);

  // 附带有效直连参数
  const directArgs = launchArguments(metadata, {
    root: '/game',
    profile,
    server: { host: 'mc.mangomc.top', port: 25577 }
  });
  assert.equal(directArgs.includes('--server'), true);
  const serverIndex = directArgs.indexOf('--server');
  assert.equal(directArgs[serverIndex + 1], 'mc.mangomc.top');
  assert.equal(directArgs[serverIndex + 2], '--port');
  assert.equal(directArgs[serverIndex + 3], '25577');
});

test('exports instance pack, excludes private files, and restores with direct-connect metadata', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lmcl-server-pack-'));
  const instDir = path.join(tmp, 'src-instance');
  const targetDir = path.join(tmp, 'dst-instance');
  const zipFile = path.join(tmp, 'pack.zip');

  try {
    // 构造测试实例
    await mkdir(path.join(instDir, 'mods'), { recursive: true });
    await mkdir(path.join(instDir, 'config'), { recursive: true });
    await mkdir(path.join(instDir, 'saves/World1'), { recursive: true });
    await mkdir(path.join(instDir, 'logs'), { recursive: true });

    await writeFile(path.join(instDir, 'mods/testmod.jar'), 'mod-bytes');
    await writeFile(path.join(instDir, 'config/common.toml'), 'config-data');
    await writeFile(path.join(instDir, 'saves/World1/level.dat'), 'private-save'); // 必须排除
    await writeFile(path.join(instDir, 'logs/latest.log'), 'private-log'); // 必须排除
    await writeFile(path.join(instDir, 'options.txt'), 'key_binds'); // 必须排除

    // 执行服主导出
    const manifest = await exportServerPackArchive({
      instanceDir: instDir,
      archivePath: zipFile,
      packId: 'mango-survival-pack',
      name: '芒果生存服整合包',
      version: '1.2.0',
      serverConnection: { host: 'play.mangomc.top', port: 25565 }
    });

    assert.equal(manifest.packId, 'mango-survival-pack');
    assert.deepEqual(manifest.overrides.map(f => f.path), ['config/common.toml', 'mods/testmod.jar']);

    // 执行玩家安装
    const res = await installServerPack({
      archivePath: zipFile,
      targetInstanceDir: targetDir,
      baseVersionId: '1.20.1'
    });

    assert.equal(res.ok, true);
    assert.deepEqual(res.serverConnection, { host: 'play.mangomc.top', port: 25565 });

    // 验证文件存在且排除项未被解压
    assert.equal(await readFile(path.join(targetDir, 'mods/testmod.jar'), 'utf8'), 'mod-bytes');
    assert.equal(await readFile(path.join(targetDir, 'config/common.toml'), 'utf8'), 'config-data');
    await assert.rejects(readFile(path.join(targetDir, 'saves/World1/level.dat')));
    await assert.rejects(readFile(path.join(targetDir, 'logs/latest.log')));

    // 验证 instance.json 注入
    const instMeta = JSON.parse(await readFile(path.join(targetDir, 'instance.json'), 'utf8'));
    assert.deepEqual(resolveInstanceServer(instMeta), { host: 'play.mangomc.top', port: 25565 });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
