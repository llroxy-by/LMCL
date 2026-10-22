import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLoaderInstallPlan, LoaderInstallPlanError, mavenArtifactPath, planLoaderInstall,
} from '../src/loader-install-plan.mjs';

const SHA1_A = 'a'.repeat(40);
const SHA1_B = 'b'.repeat(40);
const SHA256_A = 'a'.repeat(64);

const vanilla = {
  id: '1.20.1',
  mainClass: 'net.minecraft.client.main.Main',
  downloads: { client: { url: 'https://example.com/client.jar', sha1: SHA1_A } },
};

function fabricProfile() {
  return {
    id: 'fabric-loader-0.15.11-1.20.1',
    inheritsFrom: '1.20.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    arguments: { game: [], jvm: ['-Dfabric=true'] },
    libraries: [
      {
        name: 'net.fabricmc:fabric-loader:0.15.11',
        url: 'https://maven.fabricmc.net/',
        sha1: SHA1_A,
      },
      {
        name: 'org.example:native:2.0:linux@zip',
        downloads: {
          artifact: {
            path: 'org/example/native/2.0/native-2.0-linux.zip',
            url: 'https://repo.example.org/org/example/native/2.0/native-2.0-linux.zip',
            sha256: SHA256_A,
            size: 123,
          },
        },
      },
    ],
  };
}

test('builds a pure Fabric installation plan with canonical targets and hash constraints', () => {
  const profile = fabricProfile();
  const beforeVanilla = structuredClone(vanilla);
  const beforeProfile = structuredClone(profile);
  const result = createLoaderInstallPlan(vanilla, profile);

  assert.equal(result.loader, 'fabric');
  assert.equal(result.minecraftVersion, '1.20.1');
  assert.equal(result.versionId, profile.id);
  assert.equal(result.versionJsonPath, `versions/${profile.id}/${profile.id}.json`);
  assert.deepEqual(result.target, {
    versionId: profile.id,
    versionJsonPath: result.versionJsonPath,
    versionJson: result.versionJson,
  });
  assert.equal(result.versionJson.inheritsFrom, vanilla.id);
  assert.notEqual(result.versionJson, profile);
  assert.deepEqual(result.libraryDownloads[0], {
    name: 'net.fabricmc:fabric-loader:0.15.11',
    artifactPath: 'net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar',
    path: 'libraries/net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar',
    url: 'https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar',
    hashes: { sha1: SHA1_A },
    constraints: [{ algorithm: 'sha1', digest: SHA1_A }],
  });
  assert.equal(result.libraryDownloads[1].path, 'libraries/org/example/native/2.0/native-2.0-linux.zip');
  assert.equal(result.libraryDownloads[1].hashes.sha256, SHA256_A);
  assert.equal(result.libraryDownloads[1].size, 123);
  assert.deepEqual(vanilla, beforeVanilla);
  assert.deepEqual(profile, beforeProfile);
});

test('builds a Quilt plan and permits an explicit safe target version id', () => {
  const profile = {
    id: 'quilt-loader-0.26.3-1.20.1', inheritsFrom: '1.20.1',
    mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotClient',
    libraries: [{
      name: 'org.quiltmc:quilt-loader:0.26.3',
      url: 'https://maven.quiltmc.org/repository/release', checksums: [SHA1_A],
    }],
  };
  const result = planLoaderInstall(vanilla, profile, { versionId: 'my-quilt-1.20.1' });
  assert.equal(result.loader, 'quilt');
  assert.equal(result.versionJson.id, 'my-quilt-1.20.1');
  assert.equal(result.versionJson.inheritsFrom, '1.20.1');
  assert.equal(result.libraryDownloads[0].url,
    'https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-loader/0.26.3/quilt-loader-0.26.3.jar');
});

test('canonical Maven paths support classifiers and extensions', () => {
  assert.equal(mavenArtifactPath('com.example:demo:1.2.3'), 'com/example/demo/1.2.3/demo-1.2.3.jar');
  assert.equal(mavenArtifactPath('com.example:demo:1.2.3:all@zip'), 'com/example/demo/1.2.3/demo-1.2.3-all.zip');
});

test('rejects traversal and non-canonical Maven artifact paths', () => {
  for (const coordinate of [
    '../evil:demo:1', 'com..evil:demo:1', 'com.example:../demo:1',
    'com.example:demo:../1', 'com/example:demo:1', 'com.example:demo:1@../jar',
  ]) assert.throws(() => mavenArtifactPath(coordinate), LoaderInstallPlanError, coordinate);

  const profile = fabricProfile();
  profile.libraries[1].downloads.artifact.path = '../native.zip';
  assert.throws(() => createLoaderInstallPlan(vanilla, profile),
    error => error.code === 'UNSAFE_TARGET_PATH');

  const mismatch = fabricProfile();
  mismatch.libraries[1].downloads.artifact.path = 'org/example/native/2.0/wrong.zip';
  assert.throws(() => createLoaderInstallPlan(vanilla, mismatch),
    error => error.code === 'MAVEN_PATH_MISMATCH');
});

test('requires credential-free HTTPS artifact and repository URLs', () => {
  for (const url of ['http://maven.fabricmc.net/', 'https://user:secret@example.com/repo/']) {
    const profile = fabricProfile();
    profile.libraries[0].url = url;
    assert.throws(() => createLoaderInstallPlan(vanilla, profile),
      error => error.code === 'INSECURE_URL');
  }
  const direct = fabricProfile();
  direct.libraries[1].downloads.artifact.url = 'ftp://example.com/native.zip';
  assert.throws(() => createLoaderInstallPlan(vanilla, direct), error => error.code === 'INSECURE_URL');
});

test('detects duplicate destination, hash, and Minecraft version conflicts', () => {
  const duplicate = fabricProfile();
  duplicate.libraries.push({
    name: 'net.fabricmc:fabric-loader:0.15.11',
    url: 'https://mirror.example.com/', sha1: SHA1_B,
  });
  assert.throws(() => createLoaderInstallPlan(vanilla, duplicate),
    error => error.code === 'DUPLICATE_TARGET_CONFLICT' && error.path.startsWith('libraries/'));

  const hashes = fabricProfile();
  hashes.libraries[0].downloads = { artifact: {
    url: 'https://maven.fabricmc.net/a.jar', sha1: SHA1_B,
  } };
  assert.throws(() => createLoaderInstallPlan(vanilla, hashes), error => error.code === 'HASH_CONFLICT');

  const wrongVersion = fabricProfile();
  wrongVersion.inheritsFrom = '1.21';
  assert.throws(() => createLoaderInstallPlan(vanilla, wrongVersion),
    error => error.code === 'MINECRAFT_VERSION_MISMATCH');
});

test('deduplicates identical entries and rejects missing or malformed integrity data', () => {
  const duplicate = fabricProfile();
  duplicate.libraries.push(structuredClone(duplicate.libraries[0]));
  assert.equal(createLoaderInstallPlan(vanilla, duplicate).libraryDownloads.length, 2);

  const missing = fabricProfile();
  delete missing.libraries[0].sha1;
  assert.throws(() => createLoaderInstallPlan(vanilla, missing), error => error.code === 'MISSING_HASH');

  const malformed = fabricProfile();
  malformed.libraries[0].sha1 = 'not-a-sha1';
  assert.throws(() => createLoaderInstallPlan(vanilla, malformed), error => error.code === 'INVALID_HASH');
});
