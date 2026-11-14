import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareAddonBuildInfo, verifyAddonBuildInfo, PACK_REVISION } from '../index.mjs';

const expected = { version: '1.2.3', packRevision: 4 };

test('an addon built from the same version and pack revision matches', () => {
  const addonBuildInfo = () => ({ version: '1.2.3', packRevision: 4 });
  assert.deepEqual(compareAddonBuildInfo(addonBuildInfo, expected), { status: 'match' });
});

test('an addon without the export is unknown, not a failure', () => {
  assert.deepEqual(compareAddonBuildInfo(undefined, expected), { status: 'unknown' });
  assert.doesNotThrow(() => verifyAddonBuildInfo({}, 'old-unknown-addon.node', expected));
});

test('an addon without the export warns once per file', () => {
  const warnings = [];
  const listener = (warning) => warnings.push(warning);
  process.on('warning', listener);
  verifyAddonBuildInfo({}, 'warned-once.node', expected);
  verifyAddonBuildInfo({}, 'warned-once.node', expected);
  return new Promise((resolveDone) => {
    setImmediate(() => {
      process.off('warning', listener);
      const ours = warnings.filter((warning) => warning.name === 'CookAddonWarning' && warning.message.includes('warned-once.node'));
      assert.equal(ours.length, 1);
      assert.match(ours[0].message, /predates the version check/);
      resolveDone();
    });
  });
});

test('a version mismatch names both versions and what to run', () => {
  const addon = { addonBuildInfo: () => ({ version: '1.2.0', packRevision: 4 }) };
  assert.throws(
    () => verifyAddonBuildInfo(addon, 'a.node', expected),
    /built from version 1\.2\.0 and the package is version 1\.2\.3.*npx cook fetch-addon.*npm run build/s
  );
});

test('a pack revision mismatch names both revisions', () => {
  const addon = { addonBuildInfo: () => ({ version: '1.2.3', packRevision: 3 }) };
  assert.throws(() => verifyAddonBuildInfo(addon, 'a.node', expected), /pack revision 3 and the package writes pack revision 4/);
});

test('both differences are reported together', () => {
  const result = compareAddonBuildInfo(() => ({ version: '0.0.1', packRevision: 9 }), expected);
  assert.equal(result.status, 'mismatch');
  assert.equal(result.differences.length, 2);
});

test('the default expectation is this package: its own version and PACK_REVISION match', () => {
  const result = compareAddonBuildInfo(() => ({ version: JSON.parse(readPackage()).version, packRevision: PACK_REVISION }));
  assert.equal(result.status, 'match');
});

function readPackage() {
  return globalThis.process.getBuiltinModule('node:fs').readFileSync(new URL('../package.json', import.meta.url), 'utf8');
}
