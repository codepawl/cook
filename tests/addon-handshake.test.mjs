import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareAddonBuildInfo, verifyAddonBuildInfo, PACK_REVISION } from '../index.mjs';
import { STRUCT_STRIDES_V2 } from '../pack-input-v2.mjs';

const expected = { version: '1.2.3', packRevision: 4, kernelParamsBytes: 336 };

test('an addon built from the same version and pack revision matches', () => {
  const addonBuildInfo = () => ({ version: '1.2.3', packRevision: 4, kernelParamsBytes: 336 });
  assert.deepEqual(compareAddonBuildInfo(addonBuildInfo, expected), { status: 'match' });
});

test('an addon without the export is rejected as older than the package', () => {
  const result = compareAddonBuildInfo(undefined, expected);
  assert.equal(result.status, 'mismatch');
  assert.throws(
    () => verifyAddonBuildInfo({}, 'old-addon.node', expected),
    /Cook addon at "old-addon\.node" does not match.*does not export addonBuildInfo.*npx cook fetch-addon.*npm run build/s
  );
});

test('a KernelParamsV2 size mismatch names both sizes', () => {
  const addon = { addonBuildInfo: () => ({ version: '1.2.3', packRevision: 4, kernelParamsBytes: 320 }) };
  assert.throws(() => verifyAddonBuildInfo(addon, 'a.node', expected), /KernelParamsV2 blocks of 320 bytes and the package writes 336 bytes/);
});

test('an addon that does not report the KernelParamsV2 size is rejected', () => {
  const addon = { addonBuildInfo: () => ({ version: '1.2.3', packRevision: 4 }) };
  assert.throws(() => verifyAddonBuildInfo(addon, 'a.node', expected), /an unreported number of bytes/);
});

test('a version mismatch names both versions and what to run', () => {
  const addon = { addonBuildInfo: () => ({ version: '1.2.0', packRevision: 4, kernelParamsBytes: 336 }) };
  assert.throws(
    () => verifyAddonBuildInfo(addon, 'a.node', expected),
    /built from version 1\.2\.0 and the package is version 1\.2\.3.*npx cook fetch-addon.*npm run build/s
  );
});

test('a pack revision mismatch names both revisions', () => {
  const addon = { addonBuildInfo: () => ({ version: '1.2.3', packRevision: 3, kernelParamsBytes: 336 }) };
  assert.throws(() => verifyAddonBuildInfo(addon, 'a.node', expected), /pack revision 3 and the package writes pack revision 4/);
});

test('both differences are reported together', () => {
  const result = compareAddonBuildInfo(() => ({ version: '0.0.1', packRevision: 9, kernelParamsBytes: 336 }), expected);
  assert.equal(result.status, 'mismatch');
  assert.equal(result.differences.length, 2);
});

test('the default expectation is this package: its own version and PACK_REVISION match', () => {
  const result = compareAddonBuildInfo(() => ({ version: JSON.parse(readPackage()).version, packRevision: PACK_REVISION, kernelParamsBytes: STRUCT_STRIDES_V2.kernelParams }));
  assert.equal(result.status, 'match');
});

function readPackage() {
  return globalThis.process.getBuiltinModule('node:fs').readFileSync(new URL('../package.json', import.meta.url), 'utf8');
}
