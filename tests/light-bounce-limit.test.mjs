import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STRUCT_STRIDES_V2, buildNativeInputV2 } from '../pack-input-v2.mjs';
import { pinholeCamera } from '../tools/make-fixture-pack.mjs';

const LIGHT_FLAGS_WORD_INDEX = 7;
const LIGHT_BOUNCE_LIMIT_SHIFT = 8;
const LIGHT_BOUNCE_LIMIT_MASK = 0xff;
const LOW_FLAG_MASK = 0xff;

function packLights(lights) {
  const geometry = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = {
    materials: [{ color: [0.5, 0.5, 0.5] }],
    instances: [{ geometry, matrix: identity, materialIndex: 0 }],
    lights,
  };
  const camera = pinholeCamera({ eye: [0, 0, 3], target: [0, 0, 0], fieldOfViewDegrees: 40, width: 8, height: 8 });
  return buildNativeInputV2(scene, camera, { width: 8, height: 8, samples: 1, backgroundColor: [0, 0, 0] });
}

function lightsOf(limits) {
  return {
    sun: { direction: [0, 1, 0], color: [1, 1, 1], ...limits.sun },
    points: [{ position: [0, 2, 0], color: [1, 1, 1], intensity: 5, radius: 0.1, ...limits.point }],
    spots: [{ position: [1, 2, 0], direction: [0, -1, 0], angle: 0.6, color: [1, 1, 1], intensity: 5, radius: 0.1, ...limits.spot }],
    areas: [{ position: [2, 2, 0], direction: [0, -1, 0], width: 1, height: 1, color: [1, 1, 1], intensity: 5, ...limits.area }],
  };
}

function lightFlagWords(input) {
  const stride = STRUCT_STRIDES_V2.light;
  const words = new Uint32Array(input.lights.buffer, input.lights.byteOffset, input.lights.byteLength / 4);
  return [0, 1, 2, 3].map(index => words[(index * stride) / 4 + LIGHT_FLAGS_WORD_INDEX]);
}

const limitOf = flagWord => ((flagWord >>> LIGHT_BOUNCE_LIMIT_SHIFT) & LIGHT_BOUNCE_LIMIT_MASK) - 1;

test('a light maxBounces is stored in bits 8 to 15 of its record flags as the limit plus one', () => {
  const words = lightFlagWords(packLights(lightsOf({ sun: { maxBounces: 2 }, point: { maxBounces: 0 }, spot: { maxBounces: 254 }, area: { maxBounces: 1 } })));
  assert.deepEqual(words.map(limitOf), [2, 0, 254, 1]);
});

test('a light without maxBounces has no limit bits, and its other flags match a light that has one', () => {
  const plain = lightFlagWords(packLights(lightsOf({})));
  const limited = lightFlagWords(packLights(lightsOf({ sun: { maxBounces: 3 }, point: { maxBounces: 3 }, spot: { maxBounces: 3 }, area: { maxBounces: 3 } })));
  for (const word of plain) {
    assert.equal(word >>> LIGHT_BOUNCE_LIMIT_SHIFT, 0, 'no limit bits without maxBounces');
  }
  assert.deepEqual(limited.map(word => word & LOW_FLAG_MASK), plain.map(word => word & LOW_FLAG_MASK));
});

test('a maxBounces that is not a whole number from 0 to 254 is refused with the accepted range', () => {
  for (const badLimit of [-1, 255, 1.5, Number.NaN, '2', null]) {
    for (const field of ['sun', 'point', 'spot', 'area']) {
      assert.throws(
        () => packLights(lightsOf({ [field]: { maxBounces: badLimit } })),
        (error) => error instanceof RangeError && /maxBounces must be a whole number from 0 to 254/.test(error.message),
        `${field} maxBounces ${String(badLimit)} is refused`,
      );
    }
  }
});
