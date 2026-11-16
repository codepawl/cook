// Regression check for #42: traces a room with a point light and two emissive quads through the light tree and the flat
// (uniform) light pick, and fails when the flat pick mean is not finite or strays from the tree mean. llvmpipe once compiled
// the flat pick wrongly on AVX-512 CPUs, so on lavapipe runners this check depends on the CPU GitHub assigns.
import { buildNativeInputV2, traceNative } from '../index.mjs';

const UNIT_QUAD = {
  positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  colors: new Float32Array(12).fill(1),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};

function horizontalQuadMatrix(scale, height, facesUp) {
  const upOrDown = facesUp ? 1 : -1;
  return [scale, 0, 0, 0, 0, 0, -upOrDown * scale, 0, 0, upOrDown * scale, 0, 0, 0, height, 0, 1];
}

function buildScene({ withEmitters, withPoint }) {
  const instances = [{ geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(8, 0, true), materialIndex: 0 }];
  if (withEmitters) {
    instances.push({ geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(2, 3, false), materialOverride: 1 });
    instances.push({ geometry: UNIT_QUAD, matrix: horizontalQuadMatrix(1, 2, false), materialOverride: 1 });
  }
  return {
    materials: [{ color: [0.6, 0.6, 0.6], roughness: 0.8 }, { color: [1, 0.95, 0.9], emission: 5, roughness: 1 }],
    instances,
    lights: withPoint ? { points: [{ position: [2, 1.5, 1], intensity: 10, radius: 0.1 }] } : undefined,
  };
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

function cross(left, right) {
  return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
}

function createCamera(width, height) {
  const eye = [0, 2.2, 6];
  const forward = normalize([0 - eye[0], 0.5 - eye[1], 0 - eye[2]]);
  const right = normalize(cross(forward, [0, 1, 0]));
  const above = cross(right, forward);
  const halfHeight = Math.tan((45 * Math.PI) / 360);
  return { eye, forward, right, above, halfHeight, halfWidth: (halfHeight * width) / height };
}

function summarize(rgba) {
  let sum = 0;
  let largest = 0;
  let largestPixel = -1;
  let notFinite = 0;
  const pixelCount = rgba.length / 4;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const red = rgba[pixel * 4];
    if (!Number.isFinite(red)) {
      notFinite += 1;
      continue;
    }
    sum += red;
    if (red > largest) {
      largest = red;
      largestPixel = pixel;
    }
  }
  return { mean: sum / pixelCount, largest, largestPixel, notFinite, rgba };
}


const width = 48;
const height = 32;
const samples = 256;
const tolerance = 0.05;
const means = {};
for (const lightSampling of ['tree', 'uniform']) {
  const options = { width, height, samples, samplesPerDispatch: 32, seed: 5, kernel: 'cycles', lightSampling };
  const input = buildNativeInputV2(buildScene({ withEmitters: true, withPoint: true }), createCamera(width, height), options);
  const stats = summarize(traceNative(input, options).rgba);
  means[lightSampling] = stats.mean;
  console.log(`${lightSampling}: mean ${stats.mean.toPrecision(6)} max ${stats.largest.toPrecision(6)} nonfinite ${stats.notFinite}`);
  if (stats.notFinite > 0) {
    throw new Error(`The ${lightSampling} light pick gave ${stats.notFinite} pixels that are not finite.`);
  }
}
const relativeGap = Math.abs(means.uniform - means.tree) / means.tree;
if (!(relativeGap <= tolerance)) {
  throw new Error(`The flat light pick mean ${means.uniform} differs from the light tree mean ${means.tree} by ${(relativeGap * 100).toFixed(1)} percent (allowed ${tolerance * 100}).`);
}
console.log(`flat and tree light picks agree within ${(relativeGap * 100).toFixed(2)} percent`);
