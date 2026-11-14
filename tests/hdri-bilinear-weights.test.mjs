import assert from 'node:assert/strict';
import { test } from 'node:test';

import { packEnvironmentTexelsV2 } from '../pack-input-v2.mjs';

function buildEnvironment(width, height, radianceAt) {
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const radiance = radianceAt(x, y);
      data.set([radiance, radiance, radiance], (y * width + x) * 3);
    }
  }
  return { width, height, channels: 3, data, intensity: 1 };
}

function readTexelProbability(packed, x, y) {
  const conditionalBase = packed.envCdfOffset + packed.envHeight;
  const marginalProbability = packed.environmentTexels[(packed.envCdfOffset + y) * 4 + 1];
  const conditionalProbability = packed.environmentTexels[(conditionalBase + y * packed.envWidth + x) * 4 + 1];
  return marginalProbability * conditionalProbability;
}

const NO_COMPENSATION = { envCompensation: false };

test('a lone bright texel gives its neighbours weight, since the kernel reads the map bilinearly', () => {
  const environment = buildEnvironment(16, 8, (x, y) => (x === 5 && y === 4 ? 1000 : 0));
  const packed = packEnvironmentTexelsV2(environment, NO_COMPENSATION);
  assert.ok(readTexelProbability(packed, 5, 4) > 0);
  assert.ok(readTexelProbability(packed, 4, 4) > 0, 'left neighbour');
  assert.ok(readTexelProbability(packed, 6, 4) > 0, 'right neighbour');
  assert.ok(readTexelProbability(packed, 5, 3) > 0, 'upper neighbour');
  assert.ok(readTexelProbability(packed, 6, 5) > 0, 'diagonal neighbour');
  assert.equal(readTexelProbability(packed, 8, 4), 0, 'a texel the bilinear lookup never reaches');
});

test('the filter keeps the total weight of the map', () => {
  const environment = buildEnvironment(16, 8, (x, y) => 1 + ((x * 7 + y * 3) % 5));
  const packed = packEnvironmentTexelsV2(environment, NO_COMPENSATION);
  let expectedTotal = 0;
  const deltaCell = ((2 * Math.PI) / 16) * (Math.PI / 8);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 16; x++) {
      expectedTotal += (1 + ((x * 7 + y * 3) % 5)) * Math.sin(Math.PI * (y + 0.5) / 8) * deltaCell;
    }
  }
  // Rows clamp at the poles, so the sum moves only by the pole rows' tiny sine weights.
  assert.ok(Math.abs(packed.envTotalWeight - expectedTotal) / expectedTotal < 0.02);
});

test('columns wrap around the seam like the kernel lookup', () => {
  const environment = buildEnvironment(16, 8, (x, y) => (x === 0 && y === 4 ? 1000 : 0));
  const packed = packEnvironmentTexelsV2(environment, NO_COMPENSATION);
  assert.ok(readTexelProbability(packed, 15, 4) > 0, 'the last column sees the first');
});

test('a constant map keeps a weight in proportion to the solid angle of each texel', () => {
  const environment = buildEnvironment(16, 8, () => 2);
  const packed = packEnvironmentTexelsV2(environment, NO_COMPENSATION);
  const equatorProbability = readTexelProbability(packed, 3, 4);
  const equatorSine = Math.sin(Math.PI * 4.5 / 8);
  const secondEquatorProbability = readTexelProbability(packed, 9, 3);
  const secondEquatorSine = Math.sin(Math.PI * 3.5 / 8);
  assert.ok(Math.abs(equatorProbability / secondEquatorProbability - equatorSine / secondEquatorSine) < 1e-3);
});
