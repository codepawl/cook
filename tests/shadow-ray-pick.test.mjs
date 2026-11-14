import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KERNEL_FLAG_SHADOW_RAY_PICK, buildNativeInputV2 } from '../pack-input-v2.mjs';
import { pinholeCamera } from '../tools/make-fixture-pack.mjs';

const KERNEL_FLAGS_BYTE_OFFSET = 32;

function packTriangle(options) {
  const geometry = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = {
    materials: [{ color: [0.5, 0.5, 0.5] }],
    instances: [{ geometry, matrix: identity, materialIndex: 0 }],
    lights: {},
  };
  const camera = pinholeCamera({ eye: [0, 0, 3], target: [0, 0, 0], fieldOfViewDegrees: 40, width: 8, height: 8 });
  return buildNativeInputV2(scene, camera, { width: 8, height: 8, samples: 1, backgroundColor: [0, 0, 0], ...options });
}

function kernelFlagsOf(input) {
  const params = input.kernelParams;
  return new DataView(params.buffer, params.byteOffset, params.byteLength).getUint32(KERNEL_FLAGS_BYTE_OFFSET, true);
}

test('shadowRayPick "contribution" sets the shadow ray pick flag and nothing else changes it', () => {
  const baselineFlags = kernelFlagsOf(packTriangle({}));
  assert.equal(baselineFlags & KERNEL_FLAG_SHADOW_RAY_PICK, 0);
  assert.equal(kernelFlagsOf(packTriangle({ shadowRayPick: 'all' })), baselineFlags);
  const pickedFlags = kernelFlagsOf(packTriangle({ shadowRayPick: 'contribution' }));
  assert.equal(pickedFlags, baselineFlags | KERNEL_FLAG_SHADOW_RAY_PICK);
});

test('a shadowRayPick value other than "all" or "contribution" is refused with the accepted values', () => {
  assert.throws(
    () => packTriangle({ shadowRayPick: 'one' }),
    /`shadowRayPick` must be "all".*or "contribution".*got "one"/,
  );
});
