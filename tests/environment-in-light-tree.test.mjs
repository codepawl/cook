import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LIGHT_TREE_EMITTER_BACKGROUND, LIGHT_TREE_EMITTER_BYTES, LIGHT_TREE_EMITTER_DISTANT, LIGHT_TREE_NODE_BYTES, LIGHT_TREE_NODE_DISTANT } from '../light-tree-v2.mjs';
import { buildNativeInputV2, KERNEL_FLAG_ENVIRONMENT_IN_LIGHT_TREE, KERNEL_FLAG_USE_LIGHT_TREE } from '../pack-input-v2.mjs';
import { pinholeCamera } from '../tools/make-fixture-pack.mjs';

const WIDTH = 16;
const HEIGHT = 16;
const SKY_RADIANCE = 2;
const SKY_COLUMNS = 128;
const SKY_ROWS = 64;
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function square(halfSize, height, facingUp) {
  const normalY = facingUp ? 1 : -1;
  return {
    positions: new Float32Array([-halfSize, height, -halfSize, halfSize, height, -halfSize, halfSize, height, halfSize, -halfSize, height, halfSize]),
    normals: new Float32Array([0, normalY, 0, 0, normalY, 0, 0, normalY, 0, 0, normalY, 0]),
    indices: new Uint32Array(facingUp ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]),
  };
}

function uniformSky(radiance) {
  return { width: SKY_COLUMNS, height: SKY_ROWS, channels: 3, data: new Float32Array(SKY_COLUMNS * SKY_ROWS * 3).fill(radiance), intensity: 1 };
}

function packRoom({ withPanel, environment, options = {} }) {
  const instances = [{ geometry: square(4, 0, true), matrix: IDENTITY_MATRIX, materialIndex: 0 }];
  if (withPanel) {
    instances.push({ geometry: square(1, 3, false), matrix: IDENTITY_MATRIX, materialIndex: 1 });
  }
  const scene = {
    materials: [{ color: [0.7, 0.7, 0.7], roughness: 0.8 }, { color: [1, 1, 1], emission: 12 }],
    instances,
    lights: {},
    environment,
  };
  const camera = pinholeCamera({ eye: [0, 2, 8], target: [0, 1, 0], fieldOfViewDegrees: 40, width: WIDTH, height: HEIGHT });
  return buildNativeInputV2(scene, camera, { width: WIDTH, height: HEIGHT, samples: 1, ...options });
}

function kernelFlags(input) {
  return new Uint32Array(input.kernelParams.buffer, input.kernelParams.byteOffset, 16)[8];
}

function emitterRecord(input, slot) {
  const offset = input.lightTreeEmitters.byteOffset + slot * LIGHT_TREE_EMITTER_BYTES;
  return {
    energy: new Float32Array(input.lightTreeEmitters.buffer, offset, 3)[0],
    thetaO: new Float32Array(input.lightTreeEmitters.buffer, offset, 3)[1],
    thetaE: new Float32Array(input.lightTreeEmitters.buffer, offset, 3)[2],
    kind: new Uint32Array(input.lightTreeEmitters.buffer, offset, 8)[3] & 0xff,
    leafIndex: new Uint32Array(input.lightTreeEmitters.buffer, offset, 8)[5],
  };
}

function nodeKindWord(input, nodeIndex) {
  return new Uint32Array(input.lightTreeNodes.buffer, input.lightTreeNodes.byteOffset + nodeIndex * LIGHT_TREE_NODE_BYTES, 16)[14];
}

test('by default the environment stays out of the light tree', () => {
  const input = packRoom({ withPanel: true, environment: uniformSky(SKY_RADIANCE) });
  assert.equal(input.lightTreeEmitterCount, 2, 'the two triangles of the panel');
  assert.equal(input.lightToTree.length, 2);
  assert.equal(kernelFlags(input) & KERNEL_FLAG_ENVIRONMENT_IN_LIGHT_TREE, 0);
});

test('environmentSampling "tree" adds the environment as the last emitter, in a distant leaf, with its irradiance as energy', () => {
  const input = packRoom({ withPanel: true, environment: uniformSky(SKY_RADIANCE), options: { environmentSampling: 'tree' } });
  assert.equal(input.lightTreeEmitterCount, 3);
  assert.equal(input.lightToTree.length, 3, 'one entry past the lights and the emissive triangles');
  const backgroundSlot = input.lightToTree[2];
  assert.equal(backgroundSlot, 2, 'the distant leaf comes after the local emitters');
  const background = emitterRecord(input, backgroundSlot);
  assert.equal(background.kind, LIGHT_TREE_EMITTER_DISTANT | LIGHT_TREE_EMITTER_BACKGROUND);
  assert.ok(Math.abs(background.thetaO - Math.PI) < 1e-6, 'it emits toward every direction');
  assert.equal(background.thetaE, 0);
  // A sky of radiance 2 everywhere gives a surface 2 * pi; the mean over 64 rows of sin(theta) is within 0.1 % of 2 / pi.
  assert.ok(Math.abs(background.energy / (SKY_RADIANCE * Math.PI) - 1) < 2e-3, `energy ${background.energy}`);
  assert.notEqual(nodeKindWord(input, background.leafIndex) & LIGHT_TREE_NODE_DISTANT, 0, 'its leaf is the distant leaf');
  const flags = kernelFlags(input);
  assert.notEqual(flags & KERNEL_FLAG_ENVIRONMENT_IN_LIGHT_TREE, 0);
  assert.notEqual(flags & KERNEL_FLAG_USE_LIGHT_TREE, 0, 'the tree is walked, since it now picks between the panel and the sky');
});

test('the energy follows the intensity of the environment', () => {
  const dim = packRoom({ withPanel: true, environment: { ...uniformSky(SKY_RADIANCE), intensity: 0.25 }, options: { environmentSampling: 'tree' } });
  const energy = emitterRecord(dim, dim.lightToTree[2]).energy;
  assert.ok(Math.abs(energy / (0.25 * SKY_RADIANCE * Math.PI) - 1) < 2e-3, `energy ${energy}`);
});

test('a scene with no other emitter, or with no environment map, keeps its tables', () => {
  const skyOnly = packRoom({ withPanel: false, environment: uniformSky(SKY_RADIANCE), options: { environmentSampling: 'tree' } });
  assert.equal(skyOnly.lightTreeEmitterCount, 0);
  assert.equal(kernelFlags(skyOnly) & KERNEL_FLAG_ENVIRONMENT_IN_LIGHT_TREE, 0);
  const panelOnly = packRoom({ withPanel: true, environment: undefined, options: { environmentSampling: 'tree' } });
  assert.equal(panelOnly.lightTreeEmitterCount, 2);
  assert.equal(kernelFlags(panelOnly) & KERNEL_FLAG_ENVIRONMENT_IN_LIGHT_TREE, 0);
});

test('an unknown value, or "tree" next to lightSampling "uniform", is refused with what to pass instead', () => {
  assert.throws(
    () => packRoom({ withPanel: true, environment: uniformSky(SKY_RADIANCE), options: { environmentSampling: 'both' } }),
    (error) => error instanceof RangeError && /`environmentSampling` must be "separate" \(default\) or "tree", got "both"/.test(error.message),
  );
  assert.throws(
    () => packRoom({ withPanel: true, environment: uniformSky(SKY_RADIANCE), options: { environmentSampling: 'tree', lightSampling: 'uniform' } }),
    (error) => error instanceof RangeError && /Pass `lightSampling: "tree"` or "auto", or `environmentSampling: "separate"`/.test(error.message),
  );
});
