// Traces a glass prism on a dark floor with no emitter, in this process, and prints one JSON line:
// the pipeline cache state, the compile time and a checksum of the pixels. Run by tests/gpu/pipeline-cache.test.mjs.
import { buildNativeInputV2 } from '../../pack-input-v2.mjs';
import { pinholeCamera } from '../../tools/make-fixture-pack.mjs';
import { traceNative } from '../../index.mjs';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const floor = {
  positions: [-3, 0, -3, -3, 0, 3, 3, 0, 3, 3, 0, -3],
  normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  indices: [0, 1, 2, 0, 2, 3],
};
const prism = {
  positions: [-0.15, 0, -0.25, 0.15, 0, -0.25, 0, 0.26, -0.25, -0.15, 0, 0.25, 0.15, 0, 0.25, 0, 0.26, 0.25],
  normals: [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 2, 1, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 2, 0, 3, 2, 3, 5],
};
const scene = {
  materials: [
    { color: [0, 0, 0], roughness: 1 },
    { color: [1, 1, 1], roughness: 0, ior: 1.5, transmission: 1, dispersion: 1 },
  ],
  instances: [
    { geometry: floor, matrix: identity, materialIndex: 0 },
    { geometry: prism, matrix: identity, materialIndex: 1 },
  ],
  lights: {},
};
const camera = pinholeCamera({ eye: [0, 0.5, 2], target: [0, 0.1, 0], fieldOfViewDegrees: 40, width: 16, height: 9 });
const input = buildNativeInputV2(scene, camera, { width: 16, height: 9, samples: 2, backgroundColor: [0.1, 0.1, 0.1] });
const result = await traceNative(input, { kernel: 'cycles', width: 16, height: 9, samples: 2 });
let pixelSum = 0;
for (const value of result.rgba) pixelSum += value;
console.log(JSON.stringify({
  pipelineCache: result.pipelineCache,
  compileSeconds: result.compileSeconds,
  tracedSeconds: result.tracedSeconds,
  pixelCount: result.rgba.length / 4,
  pixelSum,
}));
