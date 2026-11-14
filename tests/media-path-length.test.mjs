import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildNativeInputV2, resolveVolumeAlbedo } from '../pack-input-v2.mjs';
import { pinholeCamera } from '../tools/make-fixture-pack.mjs';

const integratorSource = readFileSync(new URL('../src/cycles/integrator.wgsl', import.meta.url), 'utf8');
const formatSource = readFileSync(new URL('../FORMAT-v2.md', import.meta.url), 'utf8');

function packFoggyTriangle(volumeFields, options = {}) {
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
    volume: { minimum: [-1, -1, -1], maximum: [1, 1, 1], density: 0.5, ...volumeFields },
  };
  const camera = pinholeCamera({ eye: [0, 0, 3], target: [0, 0, 0], fieldOfViewDegrees: 40, width: 8, height: 8 });
  return buildNativeInputV2(scene, camera, { width: 8, height: 8, samples: 1, backgroundColor: [0, 0, 0], ...options });
}

test('volume albedo is clamped to [0, 1] and defaults to white', () => {
  assert.deepEqual(resolveVolumeAlbedo([1.5, -0.25, 0.5], 'test'), [1, 0, 0.5]);
  assert.deepEqual(resolveVolumeAlbedo(undefined, 'test'), [1, 1, 1]);
});

test('volume albedo rejects a missing or non-finite component before clamping', () => {
  for (const bad of [[1, 1], [1, 1, Number.NaN], [Infinity, 1, 1], [1, '0.5', 1], [1, null, 1]]) {
    assert.throws(() => resolveVolumeAlbedo(bad, 'test'), /volume\.albedo.*three finite numbers/, JSON.stringify(bad));
  }
});

test('the v2 packer refuses a NaN albedo and accepts a clamped one', () => {
  assert.throws(() => packFoggyTriangle({ albedo: [1, Number.NaN, 1] }), /volume\.albedo/);
  packFoggyTriangle({ albedo: [1.5, 1, 1] });
});

test('bounces up to 1024 still pack, and the kernel derives its step limit from them', () => {
  packFoggyTriangle({}, { bounces: 1024 });
  assert.doesNotMatch(integratorSource, /INT_MAX_PATH_STEPS/);
  assert.match(integratorSource, /max\(INT_MIN_PATH_STEPS, configured_steps\)/);
  assert.match(formatSource, /max\(128, max_bounces \+ max_transparent_bounces \+ 16\)/);
});

test('the kernel keeps a keyed medium stack and attenuates volume light samples by the medium', () => {
  assert.match(integratorSource, /fn int_medium_stack_push\(/);
  assert.match(integratorSource, /fn int_medium_stack_remove\(/);
  assert.match(integratorSource, /int_medium_stack_remove\(&medium_stack_instances, &medium_stack_sigmas, &medium_stack_depth, point\.instance_index\)/);
  const volumeEstimator = integratorSource.slice(integratorSource.indexOf('fn int_accumulate_volume_direct_sample('));
  assert.match(volumeEstimator.slice(0, 1200), /exp\(-medium_sigma \* sample\.distance\)/);
});
