import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveHdriRadianceLimit } from '../pack-input-v2.mjs';

test('the environment image is not capped unless the caller asks, as in Cycles', () => {
  assert.equal(resolveHdriRadianceLimit(undefined, 'buildNativeInputV2'), Infinity);
  assert.equal(Math.min(resolveHdriRadianceLimit(undefined, 'buildNativeInputV2'), 60000), 60000, 'a sun texel keeps its radiance');
});

test('an explicit limit caps, and Infinity names no limit', () => {
  assert.equal(resolveHdriRadianceLimit(16, 'buildNativeInputV2'), 16);
  assert.equal(resolveHdriRadianceLimit(Infinity, 'buildNativeInputV2'), Infinity);
});

test('a limit that is not a number above 0 is refused with what to pass instead', () => {
  for (const value of [0, -1, Number.NaN, '16', null]) {
    assert.throws(
      () => resolveHdriRadianceLimit(value, 'buildNativeInputV2'),
      (error) => error instanceof RangeError && /buildNativeInputV2: `hdriRadianceLimit` must be a number above 0, or Infinity for no limit/.test(error.message),
    );
  }
});
