import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildNativeV1Tables } from '../pack-input.mjs';

const SUN_PARAMETER_FLOAT_INDEX = 23;
const FIREFLY_CLAMP_FLOAT_INDEX = 34;
const NO_CLAMP_FLOOR = 1e29;

const EMPTY_PACK = {
  packLights: () => ({ count: 0, table: { data: new Float32Array(0) } }),
  packEnvironment: () => null,
  packTriangles: () => ({ data: new Float32Array(0) }),
  packAtlas: () => ({ data: new Uint8Array(4), width: 1, height: 1 }),
  packMaterials: () => ({ data: new Float32Array(0) }),
  sceneUsesSubsurface: () => false,
  packSubsurface: () => ({ data: new Float32Array(0) }),
};

const CAMERA = { eye: [0, 0, 0], forward: [0, 0, -1], right: [1, 0, 0], above: [0, 1, 0], halfWidth: 1, halfHeight: 1 };

function packParameters(sun, options = {}) {
  const scene = {
    materials: [],
    lights: { sun },
    environment: null,
    surfaceOffset: 1e-4,
    farDistance: 100,
    bvh: { triangleOrder: [] },
  };
  const input = buildNativeV1Tables(scene, CAMERA, { width: 4, height: 4, bounces: 3, seed: 7, ...options }, EMPTY_PACK);
  return new Float32Array(input.parameters.buffer, input.parameters.byteOffset, input.parameters.byteLength / 4);
}

function readKernelSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('the sun cone follows sun.angularRadius and defaults to half a degree', () => {
  const sun = { direction: [0, 1, 0], color: [1, 1, 1] };
  const wide = packParameters({ ...sun, angularRadius: 0.2 });
  assert.ok(Math.abs(wide[SUN_PARAMETER_FLOAT_INDEX] - Math.cos(0.2)) < 1e-6);
  const omitted = packParameters(sun);
  assert.ok(Math.abs(omitted[SUN_PARAMETER_FLOAT_INDEX] - Math.cos(Math.PI / 360)) < 1e-7);
  const negative = packParameters({ ...sun, angularRadius: -1 });
  assert.equal(negative[SUN_PARAMETER_FLOAT_INDEX], 1);
});

test('a firefly clamp of 0, a negative value or NaN means no clamp instead of zeroing indirect light', () => {
  const sun = { direction: [0, 1, 0], color: [1, 1, 1] };
  assert.equal(packParameters(sun)[FIREFLY_CLAMP_FLOAT_INDEX], 20);
  assert.equal(packParameters(sun, { fireflyClamp: 5 })[FIREFLY_CLAMP_FLOAT_INDEX], 5);
  for (const unclamped of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, 1e29]) {
    assert.ok(packParameters(sun, { fireflyClamp: unclamped })[FIREFLY_CLAMP_FLOAT_INDEX] >= NO_CLAMP_FLOOR, `fireflyClamp ${unclamped}`);
  }
  assert.throws(() => packParameters(sun, { fireflyClamp: '5' }), /fireflyClamp/);
});

test('the legacy kernel guards a non-positive clamp itself', () => {
  assert.match(readKernelSource('../src/kernel.wgsl'), /params\.cameraAndClamp\.z > 0\.0 && peak > params\.cameraAndClamp\.z/);
});

test('the adaptive floors are the documented ones and each kernel says it differs from the other', () => {
  const legacy = readKernelSource('../src/kernel.wgsl');
  const cycles = readKernelSource('../src/cycles/integrator.wgsl');
  assert.match(legacy, /CONVERGENCE_LUMINANCE_FLOOR: f32 = 0\.05;/);
  assert.match(cycles, /INT_ADAPTIVE_LUMINANCE_FLOOR: f32 = 1\.0e-3;/);
  assert.match(legacy, /"cycles" kernel uses a floor of 1e-3/);
  assert.match(cycles, /legacy kernel and the CPU tracer use a floor of 0\.05/);
});

test('the legacy RNG keeps a second state word seeded from the whole tuple', () => {
  const legacy = readKernelSource('../src/kernel.wgsl');
  assert.match(legacy, /var<private> rngStateSecond: u32/);
  assert.match(legacy, /rngStateSecond = chained;/);
  assert.match(legacy, /permuteRandomState\(rngState\) \^ permuteRandomState\(rngStateSecond\)/);
});

test('the legacy kernel offsets a bounce origin along the geometric normal', () => {
  const legacy = readKernelSource('../src/kernel.wgsl');
  assert.match(legacy, /position = hitPoint \+ hitGeometricNormal \* select\(-surfaceOffset, surfaceOffset, leavesFront\);/);
  assert.doesNotMatch(legacy, /position = hitPoint \+ direction \* surfaceOffset/);
});
