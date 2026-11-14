import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildNativeInputV2 } from '../pack-input-v2.mjs';
import { pinholeCamera } from '../tools/make-fixture-pack.mjs';

function packEnvironment(width, height, texelAt) {
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = texelAt(x, y);
      data.fill(value, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
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
    environment: { width, height, channels: 3, data },
  };
  const camera = pinholeCamera({ eye: [0, 0, 3], target: [0, 0, 0], fieldOfViewDegrees: 40, width: 8, height: 8 });
  return buildNativeInputV2(scene, camera, { width: 8, height: 8, samples: 1, backgroundColor: [0, 0, 0] });
}

function wholeTableSearch(texels, firstEntry, count, pick) {
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (texels[(firstEntry + middle) * 4] <= pick) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

// The search the kernel runs (lgt_search_env_cdf in lights.wgsl), in float32 where the kernel compares float32.
function guidedSearch(texels, firstEntry, count, pick) {
  const bucketCount = 2 ** Math.floor(Math.log2(count));
  const bucket = Math.min(Math.floor(Math.min(Math.max(pick, 0), 1) * bucketCount), bucketCount - 1);
  let low = texels[(firstEntry + bucket) * 4 + 2];
  let high = bucket + 1 < bucketCount ? texels[(firstEntry + bucket + 1) * 4 + 2] : count - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (texels[(firstEntry + middle) * 4] <= pick) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function pickValues() {
  const values = [0, 1, 0.5, 0.25, 0.75, 0.999999940395, 1e-9];
  let state = 12345;
  for (let index = 0; index < 4000; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    values.push(Math.fround(state / 4294967296));
  }
  return values;
}

const environments = [
  { name: 'a sun in a dim sky, sizes that are not powers of two', width: 37, height: 19, texelAt: (x, y) => (x === 20 && y === 5 ? 50000 : 0.2) },
  { name: 'a flat sky of power of two sizes', width: 64, height: 32, texelAt: () => 1 },
  { name: 'rows and columns with no light', width: 16, height: 9, texelAt: (x, y) => (y === 4 && x > 9 ? 3 : 0) },
  { name: 'one texel', width: 1, height: 1, texelAt: () => 2 },
];

for (const { name, width, height, texelAt } of environments) {
  test(`the guided search finds the index of a search of the whole table: ${name}`, () => {
    const input = packEnvironment(width, height, texelAt);
    const texels = input.environmentTexels;
    const cdfOffset = width * height;
    const picks = pickValues();
    for (const pick of picks) {
      assert.equal(guidedSearch(texels, cdfOffset, height, pick), wholeTableSearch(texels, cdfOffset, height, pick), `marginal, pick ${pick}`);
    }
    for (let row = 0; row < height; row++) {
      const rowStart = cdfOffset + height + row * width;
      for (const pick of picks) {
        assert.equal(guidedSearch(texels, rowStart, width, pick), wholeTableSearch(texels, rowStart, width, pick), `row ${row}, pick ${pick}`);
      }
    }
  });
}

test('every guide entry is a whole table index and the guide does not decrease', () => {
  const input = packEnvironment(37, 19, (x, y) => (x === 20 && y === 5 ? 50000 : 0.2));
  const texels = input.environmentTexels;
  const rowStart = 37 * 19 + 19;
  let previousGuide = 0;
  for (let bucket = 0; bucket < 32; bucket++) {
    const guide = texels[(rowStart + bucket) * 4 + 2];
    assert.ok(Number.isInteger(guide) && guide >= previousGuide && guide <= 36, `bucket ${bucket} holds ${guide}`);
    previousGuide = guide;
  }
});
