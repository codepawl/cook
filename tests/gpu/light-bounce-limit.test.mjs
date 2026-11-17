// A light's own bounce limit against a scene whose wall gets light only after the floor has bounced it. They need the built addon and a
// Vulkan adapter with ray queries, and skip, with the reason, without them.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findNativeAddon, traceNative } from '../../index.mjs';
import { buildNativeInputV2 } from '../../pack-input-v2.mjs';
import { floorGeometry, panelGeometry, placement } from '../../tools/dispersion-scenes.mjs';
import { pinholeCamera } from '../../tools/make-fixture-pack.mjs';

function skipReason() {
  try {
    return findNativeAddon() === null ? 'the native addon is not built (run `node build.mjs`, needs Rust and a Vulkan adapter with ray queries)' : false;
  } catch (environmentError) {
    return environmentError.message;
  }
}
const skip = skipReason();

const SIZE = 16;
const SAMPLES = 256;

function asInstance(geometry, matrix) {
  return {
    geometry: { positions: Float32Array.from(geometry.positions), normals: Float32Array.from(geometry.normals), indices: Uint32Array.from(geometry.indices) },
    matrix,
    materialIndex: 0,
  };
}

function centreAverage(rgba, halfExtent) {
  let sum = 0;
  let count = 0;
  for (let row = SIZE / 2 - halfExtent; row < SIZE / 2 + halfExtent; row += 1) {
    for (let column = SIZE / 2 - halfExtent; column < SIZE / 2 + halfExtent; column += 1) {
      for (let channel = 0; channel < 3; channel += 1) sum += rgba[(row * SIZE + column) * 4 + channel];
      count += 3;
    }
  }
  return sum / count;
}

// The sun is straight overhead, so a vertical wall takes no direct sun: what it shows is the floor's light, reaching the sun at path vertex 1.
function wallBrightness(sun) {
  const camera = pinholeCamera({ eye: [0, 1.5, 3], target: [0, 1.5, -1], fieldOfViewDegrees: 4, width: SIZE, height: SIZE });
  const scene = {
    materials: [{ color: [0.8, 0.8, 0.8], roughness: 1 }],
    instances: [asInstance(floorGeometry(30), placement({})), asInstance(panelGeometry(30, 30), placement({ translation: [0, 0, -1] }))],
    lights: { sun: { direction: [0, 1, 0], color: [3, 3, 3], ...sun } },
  };
  const options = { width: SIZE, height: SIZE, samples: SAMPLES, seed: 3, bounces: 8, backgroundColor: [0, 0, 0] };
  const traced = traceNative(buildNativeInputV2(scene, camera, options), { width: SIZE, height: SIZE, samples: SAMPLES, kernel: 'cycles' });
  return centreAverage(traced.rgba, 4);
}

test('a sun limited to 0 bounces leaves the wall the floor lights dark, and one limited to 1 still lights it', { skip }, () => {
  const unlimited = wallBrightness({});
  assert.ok(unlimited > 0.05, `the wall is lit by the floor without a limit: ${unlimited}`);
  assert.ok(wallBrightness({ maxBounces: 0 }) < 0.01 * unlimited, 'with a limit of 0 the sun reaches no vertex past the first');
  assert.ok(wallBrightness({ maxBounces: 1 }) > 0.5 * unlimited, 'with a limit of 1 the sun still lights the floor the wall sees');
});

test('a limit above the scene bounces renders the same picture as no limit', { skip }, () => {
  assert.equal(wallBrightness({ maxBounces: 254 }), wallBrightness({}));
});
