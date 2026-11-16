import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BLACKBODY_HUE_TABLE,
  GRID_VOLUME_DESCRIPTOR_WORDS,
  GRID_VOLUME_MAX_COUNT,
  KERNEL_FLAG_HAS_GRID_VOLUME,
  decodeGridFile,
  floatToHalfBits,
  halfBitsToFloat,
  packGridVolumes,
  writeGridVolumeKernelParams,
} from '../grid-volume-input.mjs';
import { buildNativeInputV2 } from '../pack-input-v2.mjs';
import { pinholeCamera } from '../tools/make-fixture-pack.mjs';

const CAMERA = pinholeCamera({ eye: [0, 0, 5], target: [0, 0, 0], fieldOfViewDegrees: 40, width: 8, height: 8 });
const PACK_OPTIONS = { width: 8, height: 8, samples: 1, seed: 1 };
const FLOOR_SCENE = { materials: [{}], instances: [], lights: {} };

function uniformGrid(overrides = {}) {
  return {
    resolution: [2, 2, 2],
    channels: { density: new Float32Array(8).fill(1) },
    center: [0, 0, 0],
    size: [2, 2, 2],
    ...overrides,
  };
}

function gridFileBytes(resolution, channelNames, valuesByChannel) {
  const header = JSON.stringify({ resolution, channels: channelNames, size: [8, 8, 8] });
  const headerBytes = Math.ceil(header.length / 4) * 4;
  const voxels = resolution[0] * resolution[1] * resolution[2];
  const bytes = new Uint8Array(12 + headerBytes + voxels * 2 * channelNames.length);
  bytes.set([0x36, 0x37, 0x56, 0x47], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 1, true);
  view.setUint32(8, headerBytes, true);
  bytes.set(new TextEncoder().encode(header.padEnd(headerBytes, ' ')), 12);
  channelNames.forEach((name, index) => {
    for (let voxel = 0; voxel < voxels; voxel += 1) {
      view.setUint16(12 + headerBytes + (index * voxels + voxel) * 2, floatToHalfBits(valuesByChannel[name](voxel)), true);
    }
  });
  return bytes;
}

test('half floats round trip the values a gas sim writes', () => {
  for (const value of [0, 1, 0.5, 3.25, 1000, 65504, 2 ** -14, 0.000123]) {
    const bits = floatToHalfBits(value);
    assert.ok(Math.abs(halfBitsToFloat(bits) - value) <= value * 2 ** -10, `${value} came back as ${halfBitsToFloat(bits)}`);
  }
});

test('a .67vg file decodes to its density, temperature and flame and skips velocity', () => {
  const bytes = gridFileBytes([2, 1, 1], ['density', 'velocityX', 'velocityY', 'velocityZ', 'temperature'], {
    density: voxel => 1 + voxel,
    velocityX: () => 7,
    velocityY: () => 7,
    velocityZ: () => 7,
    temperature: voxel => 300 * (voxel + 1),
  });
  const grid = decodeGridFile(bytes);
  assert.deepEqual(grid.resolution, [2, 1, 1]);
  assert.deepEqual(grid.size, [8, 8, 8]);
  assert.deepEqual(Object.keys(grid.channels).sort(), ['density', 'temperature']);
  assert.deepEqual(Array.from(grid.channels.density, halfBitsToFloat), [1, 2]);
  assert.deepEqual(Array.from(grid.channels.temperature, halfBitsToFloat), [300, 600]);
});

test('a file that is not a grid, or is cut short, is refused with what to pass', () => {
  assert.throws(() => decodeGridFile(new Uint8Array(40)), /must start with "67VG"/);
  const bytes = gridFileBytes([2, 2, 2], ['density'], { density: () => 1 });
  assert.throws(() => decodeGridFile(bytes.subarray(0, bytes.length - 2)), /holds .* bytes of data, expected/);
  const noDensity = gridFileBytes([1, 1, 1], ['temperature'], { temperature: () => 1 });
  assert.throws(() => decodeGridFile(noDensity), /no density channel/);
});

test('the descriptor holds the box transform, the coefficients and a majorant that covers the densest voxel', () => {
  const density = new Float32Array(8).fill(0.5);
  density[3] = 4;
  const packed = packGridVolumes([uniformGrid({
    channels: { density },
    center: [1, 2, 3],
    size: [4, 2, 8],
    density: 3,
    absorption: [1, 0.5, 0],
    scatter: [0, 0.25, 1],
    anisotropy: 0.4,
    emission: [1, 0.5, 0.25],
    emissionStrength: 2,
    temperatureScale: 1000,
    blackbodyIntensity: 0.3,
  })], 100);
  assert.equal(packed.count, 1);
  assert.equal(packed.tableOffset, 100);
  const floats = new Float32Array(packed.words.buffer);
  assert.deepEqual(Array.from(packed.words.subarray(0, 3)), [2, 2, 2]);
  assert.equal(packed.words[3], 100 + GRID_VOLUME_DESCRIPTOR_WORDS + BLACKBODY_HUE_TABLE.length, 'the voxels follow the descriptor table and the blackbody table');
  // The box centre maps to the middle of the unit cube and a point half a size along x to its face.
  const mapX = point => floats[4] * point[0] + floats[5] * point[1] + floats[6] * point[2] + floats[7];
  assert.ok(Math.abs(mapX([1, 2, 3]) - 0.5) < 1e-6);
  assert.ok(Math.abs(mapX([3, 2, 3]) - 1) < 1e-6);
  assert.deepEqual(Array.from(floats.subarray(16, 19)), [3, 1.5, 0]);
  assert.deepEqual(Array.from(floats.subarray(20, 23)), [0, 0.75, 3]);
  assert.ok(Math.abs(floats[19] - 0.4) < 1e-6);
  assert.deepEqual(Array.from(floats.subarray(24, 27)), [2, 1, 0.5]);
  // The largest extinction per unit density is the blue channel, 0 + 3, and the densest voxel is 4.
  assert.ok(floats[23] >= 12 && floats[23] < 12.01, `majorant ${floats[23]}`);
  assert.equal(floats[27], 1000);
  assert.ok(Math.abs(floats[28] - 0.3) < 1e-6);
  assert.equal(packed.words[29], 0, 'no temperature channel');
});

test('a grid with no flame channel emits by its density', () => {
  const packed = packGridVolumes([uniformGrid({ channels: { density: new Float32Array(8).fill(2) } })], 0);
  const voxelStart = GRID_VOLUME_DESCRIPTOR_WORDS + BLACKBODY_HUE_TABLE.length;
  assert.equal(packed.words[voxelStart + 1], floatToHalfBits(2));
});

test('no grids, or an empty list, pack to nothing', () => {
  assert.equal(packGridVolumes(undefined, 0), null);
  assert.equal(packGridVolumes([], 0), null);
});

test('inputs the kernel cannot read are refused with the field and what to pass', () => {
  const refuses = (volume, pattern) => assert.throws(() => packGridVolumes([volume], 0), pattern);
  refuses(uniformGrid({ resolution: [257, 1, 1] }), /resolution 257x1x1 is out of range: each axis is an integer from 1 to 256/);
  refuses(uniformGrid({ resolution: [2, 2] }), /resolution must be \[x, y, z\]/);
  refuses(uniformGrid({ channels: { density: new Float32Array(7) } }), /channel `density` holds 7 values, expected 8/);
  refuses(uniformGrid({ channels: { density: new Float32Array(8).fill(NaN) } }), /every value must be finite and at least 0/);
  refuses(uniformGrid({ channels: { density: new Float32Array(8).fill(-1) } }), /every value must be finite and at least 0/);
  refuses(uniformGrid({ channels: { density: new Float32Array(8).fill(70000) } }), /past the half float maximum 65504/);
  refuses(uniformGrid({ channels: {} }), /`channels.density` is required/);
  refuses(uniformGrid({ size: [1, 0, 1] }), /`size`\[1\] must be above 0/);
  refuses(uniformGrid({ center: [0, 0] }), /`center` must be 3 numbers/);
  refuses(uniformGrid({ anisotropy: 1 }), /`anisotropy` must be a finite number from -0.99 to 0.99/);
  refuses(uniformGrid({ absorption: [1, 1, -1] }), /`absorption`\[2\] must be from 0/);
  refuses(uniformGrid({ density: Infinity }), /`density` must be a finite number/);
  refuses(uniformGrid({ blackbodyIntensity: -1 }), /`blackbodyIntensity` must be a finite number/);
  refuses(null, /gridVolumes\[0\] must be an object/);
  assert.throws(() => packGridVolumes('grid', 0), /must be an array/);
});

test('too many grids, and grids that need too many bytes, are refused', () => {
  assert.throws(() => packGridVolumes(Array.from({ length: GRID_VOLUME_MAX_COUNT + 1 }, () => uniformGrid()), 0), /takes at most 8/);
  const big = { resolution: [256, 256, 256], channels: {}, center: [0, 0, 0], size: [1, 1, 1] };
  assert.throws(() => packGridVolumes([big, big, big], 0), /byte limit\. Resample the grids to fewer voxels/);
});

test('a scene with no grid volumes packs the words it packed before they existed', () => {
  const input = buildNativeInputV2(FLOOR_SCENE, CAMERA, PACK_OPTIONS);
  const view = new DataView(input.kernelParams.buffer, input.kernelParams.byteOffset, input.kernelParams.byteLength);
  assert.equal(view.getUint32(32, true) & KERNEL_FLAG_HAS_GRID_VOLUME, 0);
  for (const byteOffset of [324, 328, 332]) assert.equal(view.getUint32(byteOffset, true), 0);
  const withEmptyList = buildNativeInputV2({ ...FLOOR_SCENE, gridVolumes: [] }, CAMERA, PACK_OPTIONS);
  assert.deepEqual(withEmptyList.kernelParams, input.kernelParams);
  assert.deepEqual(withEmptyList.textureTexels, input.textureTexels);
});

test('a scene with a grid volume sets the flag, the count and an offset behind the textures', () => {
  const plain = buildNativeInputV2(FLOOR_SCENE, CAMERA, PACK_OPTIONS);
  const input = buildNativeInputV2({ ...FLOOR_SCENE, gridVolumes: [uniformGrid()] }, CAMERA, PACK_OPTIONS);
  const view = new DataView(input.kernelParams.buffer, input.kernelParams.byteOffset, input.kernelParams.byteLength);
  assert.equal(view.getUint32(32, true) & KERNEL_FLAG_HAS_GRID_VOLUME, KERNEL_FLAG_HAS_GRID_VOLUME);
  assert.equal(view.getUint32(324, true), 1);
  assert.equal(view.getUint32(328, true), plain.textureTexels.length);
  assert.deepEqual(input.textureTexels.subarray(0, plain.textureTexels.length), plain.textureTexels);
  assert.ok(input.textureTexels.length > plain.textureTexels.length);
  const written = new Uint8Array(336);
  writeGridVolumeKernelParams(written, { count: 3, tableOffset: 7 });
  assert.equal(new DataView(written.buffer).getUint32(324, true), 3);
  assert.equal(new DataView(written.buffer).getUint32(328, true), 7);
});
