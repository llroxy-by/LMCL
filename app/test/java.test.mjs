import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { discoverJava, inspectJava } from '../lib/java.mjs';

const output = (home, version = 17, arch = 'aarch64') => ({ stdout: '',
  stderr: `Property settings:\n    java.home = ${home}\n    os.arch = ${arch}\nopenjdk version "${version}.0.1"\nOpenJDK Runtime Environment\n` });

test('Mac Java inspection resolves the real runtime and rejects Intel Java', async () => {
  const java = await inspectJava('/usr/bin/java', {
    platform: 'darwin', arch: 'arm64', execute: async () => output('/fixture/Java 17/Contents/Home'),
  });
  assert.equal(java.path, path.join('/fixture/Java 17/Contents/Home', 'bin/java'));
  assert.equal(java.arch, 'arm64');
  assert.equal(java.major, 17);
  await assert.rejects(inspectJava('/fixture/intel/bin/java', {
    platform: 'darwin', arch: 'arm64', execute: async () => output('/fixture/intel', 17, 'x86_64'),
  }), /ARM64/);
});

test('Mac discovery finds system, user and Homebrew JDKs without relying on shell PATH', { skip: process.platform === 'win32' }, async () => {
  const entry = name => ({ name, isDirectory: () => true, isSymbolicLink: () => false });
  const installs = new Map([
    ['/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin/java', output('/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home')],
    ['/Users/fixture/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home/bin/java', output('/Users/fixture/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home', 21)],
    ['/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home/bin/java', output('/fixture/homebrew25', 25)],
    ['/opt/homebrew/Cellar/openjdk@17/17.0.1/libexec/openjdk.jdk/Contents/Home/bin/java', output('/fixture/homebrew17')],
    ['/usr/bin/java', output('/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home')],
    ['/fixture/intel/bin/java', output('/fixture/intel', 17, 'x86_64')],
  ]);
  const dirs = new Map([
    ['/Library/Java/JavaVirtualMachines', ['temurin-17.jdk']],
    ['/Users/fixture/Library/Java/JavaVirtualMachines', ['jdk-21.jdk']],
    ['/opt/homebrew/opt', ['openjdk@25', 'unrelated-package']],
    ['/opt/homebrew/Cellar', ['openjdk@17']],
    ['/opt/homebrew/Cellar/openjdk@17', ['17.0.1']],
  ]);
  const found = await discoverJava('/fixture/intel/bin/java', {
    platform: 'darwin', arch: 'arm64', env: {}, home: '/Users/fixture',
    listDirectory: async root => (dirs.get(root) ?? []).map(entry),
    execute: async executable => {
      if (executable === '/usr/libexec/java_home') return { stdout: '/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home\n', stderr: '' };
      if (installs.has(executable)) return installs.get(executable);
      throw new Error('Not installed');
    },
  });
  assert.deepEqual(found.map(java => java.major), [17, 21, 25, 17]);
  assert.ok(found.every(java => java.arch === 'arm64'));
  assert.equal(new Set(found.map(java => java.path)).size, found.length);
});
