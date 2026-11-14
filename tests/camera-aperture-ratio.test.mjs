import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_APERTURE_RATIO,
  MIN_APERTURE_RATIO,
  STRUCT_STRIDES_V2,
  packCameraParams,
  resolveThinLensParameters,
} from '../pack-input-v2.mjs';
import { buildRoomInput } from '../tools/make-fixture-pack.mjs';

const APERTURE_RATIO_BYTE_OFFSET = 320;
const IMAGE_ASPECT = 160 / 120;

function viewCamera(extraFields = {}) {
  return { eye: [0, 1, 5], forward: [0, 0, -1], right: [1, 0, 0], above: [0, 1, 0], halfWidth: IMAGE_ASPECT, halfHeight: 1, ...extraFields };
}

function wordAt(kernelParams, byteOffset) {
  return new DataView(kernelParams.buffer, kernelParams.byteOffset, kernelParams.byteLength).getFloat32(byteOffset, true);
}

test('the params block holds the aperture ratio in a word after the tile origin, and the packer writes 1 by default', () => {
  const { kernelParams } = buildRoomInput();
  assert.equal(kernelParams.byteLength, STRUCT_STRIDES_V2.kernelParams);
  assert.equal(STRUCT_STRIDES_V2.kernelParams, 336);
  assert.equal(wordAt(kernelParams, APERTURE_RATIO_BYTE_OFFSET), 1);
  assert.ok(kernelParams.subarray(APERTURE_RATIO_BYTE_OFFSET + 4).every(byte => byte === 0));
});

test('a camera without an apertureRatio resolves to 1 and leaves the other thin lens fields as they were', () => {
  const thinLens = resolveThinLensParameters(null, {}, 'test');
  assert.deepEqual(thinLens, { apertureRadius: 0, focalDistance: 10, apertureBlades: 0, apertureRotation: 0, apertureRatio: 1 });
});

test('apertureRatio comes from the camera before the options', () => {
  assert.equal(resolveThinLensParameters({ apertureRatio: 2 }, { apertureRatio: 3 }, 'test').apertureRatio, 2);
  assert.equal(resolveThinLensParameters(null, { apertureRatio: 3 }, 'test').apertureRatio, 3);
});

test('an apertureRatio outside the bounds or not a number throws an error that says what to pass', () => {
  for (const bad of [0, -1, MIN_APERTURE_RATIO / 2, MAX_APERTURE_RATIO * 2, Number.NaN, Infinity, '2']) {
    assert.throws(
      () => resolveThinLensParameters(null, { apertureRatio: bad }, 'test'),
      /test: camera `apertureRatio` must be the width over height of the aperture, from 0\.01 to 100/,
      String(bad)
    );
  }
  assert.doesNotThrow(() => resolveThinLensParameters(null, { apertureRatio: MIN_APERTURE_RATIO }, 'test'));
  assert.doesNotThrow(() => resolveThinLensParameters(null, { apertureRatio: MAX_APERTURE_RATIO }, 'test'));
});

test('a camera update without the field keeps the default block byte for byte', () => {
  const { kernelParams } = buildRoomInput();
  const patched = packCameraParams(kernelParams, viewCamera());
  assert.equal(wordAt(patched, APERTURE_RATIO_BYTE_OFFSET), 1);
  const changedBytes = patched.reduce((count, byte, index) => count + (byte === kernelParams[index] ? 0 : 1), 0);
  assert.ok(changedBytes <= 80, `a view camera may only rewrite camera words, changed ${changedBytes} bytes`);
  assert.deepEqual(patched.subarray(192), kernelParams.subarray(192));
});

test('a camera update with apertureRatio writes the word and nothing outside the camera words', () => {
  const { kernelParams } = buildRoomInput();
  const patched = packCameraParams(kernelParams, viewCamera({ apertureRatio: 2 }));
  assert.equal(wordAt(patched, APERTURE_RATIO_BYTE_OFFSET), 2);
  assert.deepEqual(patched.subarray(192, APERTURE_RATIO_BYTE_OFFSET), kernelParams.subarray(192, APERTURE_RATIO_BYTE_OFFSET));
  assert.deepEqual(patched.subarray(0, 112), kernelParams.subarray(0, 112));
});

test('a later camera update that leaves the ratio out keeps the ratio the block holds', () => {
  const { kernelParams } = buildRoomInput();
  const anamorphic = packCameraParams(kernelParams, viewCamera(), { apertureRatio: 1.5 });
  const moved = packCameraParams(anamorphic, viewCamera({ eye: [1, 1, 4] }));
  assert.equal(wordAt(moved, APERTURE_RATIO_BYTE_OFFSET), 1.5);
});
