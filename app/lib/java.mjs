import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const run = promisify(execFile);

export async function inspectJava(executable, { execute = run, platform = process.platform, arch = process.arch } = {}) {
  const { stdout, stderr } = await execute(executable, ['-XshowSettings:properties', '-version'], { timeout: 7000, windowsHide: true });
  const text = `${stdout}\n${stderr}`;
  const match = text.match(/(?:openjdk|java) version "(?:1\.)?(\d+)/i);
  if (!match) throw new Error('无法识别该 Java 版本');
  const architecture = text.match(/^\s*os\.arch\s*=\s*(\S+)/m)?.[1];
  const javaArch = ({ aarch64: 'arm64', arm64: 'arm64', amd64: 'x64', x86_64: 'x64', x86: 'ia32' })[architecture] ?? architecture;
  if (platform === 'darwin' && arch === 'arm64' && javaArch !== 'arm64') {
    throw new Error('M 系列 Mac 需要 ARM64 / AArch64 版 Java，请选择对应架构的运行环境');
  }
  const home = text.match(/^\s*java\.home\s*=\s*(.+)/m)?.[1].trim();
  const resolved = home ? path.join(home, 'bin', platform === 'win32' ? 'java.exe' : 'java') : executable;
  return { path: await realpath(resolved).catch(() => resolved), major: Number(match[1]), arch: javaArch,
    description: text.match(/(?:openjdk|java) version[^\r\n]*/i)?.[0] ?? `Java ${match[1]}` };
}

export async function discoverJava(selected = '', {
  platform = process.platform, arch = process.arch, env = process.env, home = os.homedir(),
  execute = run, listDirectory = readdir,
} = {}) {
  const candidates = new Set(selected ? [selected] : []);
  if (env.JAVA_HOME) candidates.add(path.join(env.JAVA_HOME, 'bin', platform === 'win32' ? 'java.exe' : 'java'));
  if (platform === 'darwin') {
    const roots = ['/Library/Java/JavaVirtualMachines', path.join(home, 'Library/Java/JavaVirtualMachines'),
      '/opt/homebrew/opt', '/opt/homebrew/Cellar'];
    try {
      const { stdout } = await execute('/usr/libexec/java_home', ['-a', 'arm64'], { timeout: 7000 });
      if (stdout.trim()) candidates.add(path.join(stdout.trim(), 'bin/java'));
    } catch { /* Scan installation folders even when java_home finds nothing. */ }
    for (const root of roots) {
      for (const entry of await listDirectory(root, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (root.startsWith('/opt/homebrew') && !/^openjdk(?:@\d+)?$/.test(entry.name)) continue;
        const base = path.join(root, entry.name);
        candidates.add(path.join(base, 'Contents/Home/bin/java'));
        if (root === '/opt/homebrew/opt') candidates.add(path.join(base, 'libexec/openjdk.jdk/Contents/Home/bin/java'));
        if (root === '/opt/homebrew/Cellar') {
          for (const version of await listDirectory(base, { withFileTypes: true }).catch(() => [])) {
            if (version.isDirectory()) candidates.add(path.join(base, version.name, 'libexec/openjdk.jdk/Contents/Home/bin/java'));
          }
        }
      }
    }
  }
  candidates.add('java');
  if (platform === 'win32') {
    for (const vendor of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Amazon Corretto']) {
      const root = path.join(env.ProgramFiles || 'C:\\Program Files', vendor);
      for (const entry of await listDirectory(root, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) candidates.add(path.join(root, entry.name, 'bin', 'java.exe'));
      }
    }
  }
  const found = [];
  for (const candidate of candidates) {
    try {
      const java = await inspectJava(candidate, { execute, platform, arch });
      if (!found.some(item => item.path === java.path)) found.push(java);
    } catch { /* Other installed Javas may still work. */ }
  }
  return found;
}
