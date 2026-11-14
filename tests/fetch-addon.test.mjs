import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { PREBUILT_SYSTEMS, fetchPrebuiltAddon, parseSha256File, prebuiltAssetName, prebuiltAssetUrl, verifySha256 } from '../fetch-addon.mjs';

test('each prebuilt system has one asset name, and other systems have none', () => {
  assert.deepEqual(PREBUILT_SYSTEMS, ['win32-x64', 'linux-x64']);
  assert.equal(prebuiltAssetName('win32', 'x64'), 'render-native-win32-x64.node');
  assert.equal(prebuiltAssetName('linux', 'x64'), 'render-native-linux-x64.node');
  assert.equal(prebuiltAssetName('darwin', 'arm64'), null);
  assert.equal(prebuiltAssetName('linux', 'arm64'), null);
});

test('the asset URL names the release tag of the package version', () => {
  assert.equal(
    prebuiltAssetUrl('0.1.0', 'render-native-linux-x64.node'),
    'https://github.com/codepawl/cook/releases/download/v0.1.0/render-native-linux-x64.node'
  );
});

test('the hash is read from a sha256sum line, and a file without one is refused', () => {
  const hash = 'a'.repeat(64);
  assert.equal(parseSha256File(`${hash}  render-native-linux-x64.node\n`), hash);
  assert.equal(parseSha256File(hash.toUpperCase()), hash);
  assert.throws(() => parseSha256File('not a hash'), /does not start with a SHA-256 hash/);
});

test('bytes with another hash are refused with what to do instead', () => {
  const bytes = Buffer.from('addon bytes');
  const goodHash = createHash('sha256').update(bytes).digest('hex');
  verifySha256(bytes, goodHash, 'render-native-linux-x64.node');
  assert.throws(
    () => verifySha256(bytes, 'b'.repeat(64), 'render-native-linux-x64.node'),
    /has SHA-256 [0-9a-f]{64}, but the release lists b{64}\. Nothing was written\..*npm run build/
  );
});

test('a system without a prebuilt addon is told to build from source, before any download', async () => {
  await assert.rejects(
    fetchPrebuiltAddon({ platform: 'darwin', arch: 'arm64', version: '0.1.0' }),
    /No prebuilt addon exists for darwin-arm64; prebuilt addons cover win32-x64 and linux-x64\. Build from source with npm run build/
  );
});
