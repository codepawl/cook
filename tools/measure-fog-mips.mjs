// Times a fogged, textured room with texture mips on and off: `node tools/measure-fog-mips.mjs [width] [height] [samples] [runs] [outputPrefix]`.
// The room has a checker textured floor and boxes, fog, a glass box, a coated box and 8 bounces (the scene of codepawl/crucible#1171).
// Prints the median `tracedSeconds` of each of the four cases (fog on or off, mips on or off) and writes each picture as raw
// float RGBA (`<outputPrefix>-<case>.f32`) when an output prefix is given. `FOG_DENSITY` (default 0.12) sets the fog and
// `EXTRA_TEXTURES=1` adds a metallic-roughness, a normal and an emission map to every material. Run it through gpu-lock on a shared machine.
import { writeFileSync } from 'node:fs';

import { traceNative } from '../index.mjs';
import { buildNativeInputV2 } from '../pack-input-v2.mjs';
import { pinholeCamera } from './make-fixture-pack.mjs';

const width = Number(process.argv[2] ?? 960);
const height = Number(process.argv[3] ?? 540);
const samples = Number(process.argv[4] ?? 128);
const runs = Number(process.argv[5] ?? 3);
const outputPrefix = process.argv[6];
const fogDensity = Number(process.env.FOG_DENSITY ?? 0.12);
const extraTextures = process.env.EXTRA_TEXTURES === '1';

const TEXTURE_SIZE = 512;
const CHECKER_CELLS = 16;

function checkerTexture() {
  const data = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  const cellSize = TEXTURE_SIZE / CHECKER_CELLS;
  for (let row = 0; row < TEXTURE_SIZE; row++) {
    for (let column = 0; column < TEXTURE_SIZE; column++) {
      const isLight = (Math.floor(row / cellSize) + Math.floor(column / cellSize)) % 2 === 0;
      const value = isLight ? 230 : 60;
      const offset = (row * TEXTURE_SIZE + column) * 4;
      data[offset] = value;
      data[offset + 1] = isLight ? 200 : 70;
      data[offset + 2] = isLight ? 170 : 90;
      data[offset + 3] = 255;
    }
  }
  return { width: TEXTURE_SIZE, height: TEXTURE_SIZE, data };
}

function floorGeometry(halfSize, uvRepeat) {
  return {
    positions: new Float32Array([-halfSize, 0, -halfSize, halfSize, 0, -halfSize, halfSize, 0, halfSize, -halfSize, 0, halfSize]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, uvRepeat, 0, uvRepeat, uvRepeat, 0, uvRepeat]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
  };
}

function boxGeometry() {
  const faces = [
    { normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
    { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { normal: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
    { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { normal: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (const { normal, u, v } of faces) {
    const firstVertex = positions.length / 3;
    for (const [uSign, vSign] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let axis = 0; axis < 3; axis++) {
        positions.push(0.5 * (normal[axis] + uSign * u[axis] + vSign * v[axis]));
        normals.push(normal[axis]);
      }
      uvs.push(uSign * 0.5 + 0.5, vSign * 0.5 + 0.5);
    }
    indices.push(firstVertex, firstVertex + 1, firstVertex + 2, firstVertex, firstVertex + 2, firstVertex + 3);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}

function panelGeometry(halfSize, panelHeight) {
  return {
    positions: new Float32Array([-halfSize, panelHeight, -halfSize, halfSize, panelHeight, -halfSize, halfSize, panelHeight, halfSize, -halfSize, panelHeight, halfSize]),
    normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function placement(scale, translation) {
  return [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, translation[0], translation[1], translation[2], 1];
}

function buildInput({ withFog, textureMips }) {
  const texture = checkerTexture();
  const extra = extraTextures ? { surfaceTexture: texture, normalTexture: texture, emissiveTexture: texture } : {};
  const box = boxGeometry();
  const scene = {
    materials: [
      { color: [1, 1, 1], roughness: 0.7, texture, ...extra },
      { color: [1, 1, 1], roughness: 0.5, texture, ...extra },
      { color: [1, 1, 1], roughness: 0.05, transmission: 1, ior: 1.45, ...extra },
      { color: [0.8, 0.2, 0.15], roughness: 0.4, coatWeight: 1, coatRoughness: 0.05, texture, ...extra },
      { color: [1, 0.95, 0.85], emission: 14 },
    ],
    instances: [
      { geometry: floorGeometry(5, 6), matrix: placement(1, [0, 0, 0]), materialIndex: 0 },
      { geometry: box, matrix: placement(1.5, [-1.4, 0.75, -0.4]), materialIndex: 1 },
      { geometry: box, matrix: placement(1.3, [0.3, 0.65, 1.2]), materialIndex: 2 },
      { geometry: box, matrix: placement(1.2, [1.8, 0.6, -0.6]), materialIndex: 3 },
      { geometry: panelGeometry(1.2, 3.6), matrix: placement(1, [0, 0, 0]), materialIndex: 4 },
    ],
    lights: {},
    ...(withFog ? { volume: { density: fogDensity, albedo: [0.9, 0.92, 0.95] } } : {}),
  };
  const camera = pinholeCamera({ eye: [0, 2.4, 7.5], target: [0, 1, 0], fieldOfViewDegrees: 40, width, height });
  return buildNativeInputV2(scene, camera, {
    width,
    height,
    samples,
    maxBounces: 8,
    backgroundColor: [0.35, 0.5, 0.75],
    ...(textureMips ? { textureMips: true } : {}),
  });
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

const cases = [];
for (const withFog of [true, false]) {
  for (const textureMips of [false, true]) {
    cases.push({ name: `${withFog ? 'fog' : 'nofog'}-${textureMips ? 'mips' : 'nomips'}`, withFog, textureMips });
  }
}
for (const { name, withFog, textureMips } of cases) {
  const input = buildInput({ withFog, textureMips });
  const options = { width, height, samples, kernel: 'cycles', denoise: 'none' };
  traceNative(input, { ...options, samples: 1 }); // warms the pipeline
  const seconds = [];
  let result;
  for (let run = 0; run < runs; run++) {
    result = traceNative(input, options);
    
    seconds.push(result.tracedSeconds);
  }
  console.log(`${name}: median tracedSeconds ${median(seconds).toFixed(3)} (runs ${seconds.map((value) => value.toFixed(3)).join(', ')}) at ${width}x${height}, ${samples} spp`);
  if (outputPrefix) {
    writeFileSync(`${outputPrefix}-${name}.f32`, Buffer.from(result.rgba.buffer, result.rgba.byteOffset, result.rgba.byteLength));
  }
}
