import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildNativeV1Tables } from '../pack-input.mjs';
import { STRUCT_STRIDES_V2, upgradeNativeInputV1ToV2 } from '../pack-input-v2.mjs';

const LIGHT_FLOATS = 24;
const LIGHT_FLAGS_WORD_INDEX = 7;
const LIGHT_BOUNCE_LIMIT_SHIFT = 8;
const SUN_LIMIT_CODE_FLOAT_INDEX = 19;
const CAMERA = { eye: [0, 0, 0], forward: [0, 0, -1], right: [1, 0, 0], above: [0, 1, 0], halfWidth: 1, halfHeight: 1 };

// A v1 light table of a point, a spot and an area light, each with the given limit code in its last float.
function lightTable(limitCodes) {
  const data = new Float32Array(limitCodes.length * LIGHT_FLOATS);
  limitCodes.forEach((code, index) => {
    const base = index * LIGHT_FLOATS;
    data.set([index, 2, 0, index], base);
    data.set([1, 1, 1, index], base + 4);
    data.set([0, -1, 0, 0.1], base + 8);
    data.set([0, 0, 0, 1], base + 12);
    data.set([0, 0, 0, 0.1], base + 16);
    data.set([5, 0, 0, code], base + 20);
  });
  return { count: limitCodes.length, table: { data } };
}

function packInput(sun, limitCodes) {
  const pack = {
    packLights: () => lightTable(limitCodes),
    packEnvironment: () => null,
    packTriangles: () => ({ data: new Float32Array(36) }),
    packAtlas: () => ({ data: new Uint8Array(4), width: 1, height: 1 }),
    packMaterials: () => ({ data: new Float32Array(16) }),
    sceneUsesSubsurface: () => false,
    packSubsurface: () => ({ data: new Float32Array(0) }),
  };
  const scene = { materials: [{}], lights: { sun }, environment: null, surfaceOffset: 1e-4, farDistance: 100, bvh: { triangleOrder: [0] } };
  return buildNativeV1Tables(scene, CAMERA, { width: 4, height: 4, bounces: 3, seed: 7 }, pack);
}

function upgradedFlagWords(v1Input) {
  const upgraded = upgradeNativeInputV1ToV2(v1Input, { width: 4, height: 4, samples: 1 });
  const words = new Uint32Array(upgraded.lights.buffer, upgraded.lights.byteOffset, upgraded.lights.byteLength / 4);
  return Array.from({ length: 4 }, (unused, index) => words[(index * STRUCT_STRIDES_V2.light) / 4 + LIGHT_FLAGS_WORD_INDEX]);
}

test('the sun maxBounces rides in the fourth float of the sun direction as limit plus one', () => {
  const parameters = (sun) => new Float32Array(packInput(sun, []).parameters.buffer, 0, 64);
  assert.equal(parameters({ direction: [0, 1, 0], color: [1, 1, 1], maxBounces: 2 })[SUN_LIMIT_CODE_FLOAT_INDEX], 3);
  assert.equal(parameters({ direction: [0, 1, 0], color: [1, 1, 1] })[SUN_LIMIT_CODE_FLOAT_INDEX], 0);
  assert.throws(() => parameters({ direction: [0, 1, 0], color: [1, 1, 1], maxBounces: -1 }), /lights\.sun\.maxBounces must be a whole number from 0 to 254/);
});

test('a v1 input upgraded to v2 keeps the limit of the sun and of each point, spot and area light', () => {
  const words = upgradedFlagWords(packInput({ direction: [0, 1, 0], color: [1, 1, 1], maxBounces: 2 }, [1, 0, 255]));
  const limitCodes = words.map(word => (word >>> LIGHT_BOUNCE_LIMIT_SHIFT) & 0xff);
  assert.deepEqual(limitCodes, [3, 1, 0, 255]);
});
