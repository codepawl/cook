// Probe for #42: traces the room with one point light through the tree and the flat pick and prints the mean, the largest
// pixel and how many pixels are far brighter than the tree mean. Prints one line per variant so CI logs can be compared.
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

function brightCount(rgba, limit) {
  let count = 0;
  for (let index = 0; index < rgba.length; index += 4) {
    if (rgba[index] > limit) {
      count += 1;
    }
  }
  return count;
}

const width = 48;
const height = 32;
const label = process.argv[2] ?? 'default';
const variants = [
  { name: 'tree', scene: { withEmitters: true, withPoint: true }, options: { lightSampling: 'tree' } },
  { name: 'uniform', scene: { withEmitters: true, withPoint: true }, options: { lightSampling: 'uniform' } },
  { name: 'uniform-nee', scene: { withEmitters: true, withPoint: true }, options: { lightSampling: 'uniform', directLighting: 'nee-only' } },
  { name: 'uniform-bsdf', scene: { withEmitters: true, withPoint: true }, options: { lightSampling: 'uniform', directLighting: 'bsdf-only' } },
  { name: 'uniform-point-only', scene: { withEmitters: false, withPoint: true }, options: { lightSampling: 'uniform' } },
  { name: 'uniform-quads-only', scene: { withEmitters: true, withPoint: false }, options: { lightSampling: 'uniform' } },
  { name: 'uniform-spd1', scene: { withEmitters: true, withPoint: true }, options: { lightSampling: 'uniform', samples: 32, samplesPerDispatch: 1 } },
];
let treeMean = null;
for (const variant of variants) {
  const camera = createCamera(width, height);
  const options = { width, height, samples: 256, samplesPerDispatch: 32, seed: 5, kernel: 'cycles', ...variant.options };
  const input = buildNativeInputV2(buildScene(variant.scene), camera, options);
  try {
    const result = traceNative(input, options);
    const stats = summarize(result.rgba);
    if (variant.name === 'tree') {
      treeMean = stats.mean;
    }
    const bright = treeMean === null ? -1 : brightCount(result.rgba, treeMean * 50);
    console.log(`PROBE ${label} ${variant.name}: mean ${stats.mean.toPrecision(6)} max ${stats.largest.toPrecision(6)} at pixel ${stats.largestPixel} (x ${stats.largestPixel % width}, y ${Math.floor(stats.largestPixel / width)}) bright ${bright} nonfinite ${stats.notFinite} gpu ${result.gpu ?? result.adapter ?? '?'}`);
  } catch (error) {
    console.log(`PROBE ${label} ${variant.name}: threw ${error.message}`);
  }
}
