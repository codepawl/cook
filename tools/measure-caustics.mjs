// Renders the caustic scenes at a ladder of sample counts and writes one JSON report with the time, the mean and the speckle of a
// floor patch for each, plus a PNG per render. It needs the built addon and a Vulkan adapter with ray queries.
//
// Usage: node tools/measure-caustics.mjs <output-folder> [config.json]
// Config keys (all optional): `ball` and `prism` hold { width, height, rungs: [{ caustics, samples }], reference: { width, height, samples } }.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { traceNative } from '../index.mjs';
import { encodePng } from '../output/png.mjs';
import { buildCausticInput } from './make-caustic-scene.mjs';
import { pinholeCamera } from './make-fixture-pack.mjs';

// A floor rectangle (world x and z, at y = 0) where the glass shadow of each scene lies in view of its camera.
const PATCHES = {
  ball: { xRange: [-0.08, 0.08], zRange: [0.04, 0.14] },
  prism: { xRange: [0.45, 0.75], zRange: [-0.12, 0.12] },
};

function projectToPixel(camera, point, width, height) {
  const offset = point.map((value, axis) => value - camera.eye[axis]);
  const along = (axis) => offset[0] * axis[0] + offset[1] * axis[1] + offset[2] * axis[2];
  const depth = along(camera.forward);
  const ndcX = along(camera.right) / depth / camera.halfWidth;
  const ndcY = along(camera.above) / depth / camera.halfHeight;
  return [((ndcX + 1) / 2) * width, ((1 - ndcY) / 2) * height];
}

function patchPixels(scene, camera, width, height) {
  const { xRange, zRange } = PATCHES[scene];
  const corners = [[xRange[0], zRange[0]], [xRange[1], zRange[0]], [xRange[0], zRange[1]], [xRange[1], zRange[1]]];
  const pixels = corners.map(([x, z]) => projectToPixel(camera, [x, 0, z], width, height));
  const xs = pixels.map((pixel) => pixel[0]);
  const ys = pixels.map((pixel) => pixel[1]);
  return {
    left: Math.max(0, Math.floor(Math.min(...xs))),
    right: Math.min(width, Math.ceil(Math.max(...xs))),
    top: Math.max(0, Math.floor(Math.min(...ys))),
    bottom: Math.min(height, Math.ceil(Math.max(...ys))),
  };
}

function patchStatistics(rgba, width, box) {
  const values = [];
  for (let row = box.top; row < box.bottom; row++) {
    for (let column = box.left; column < box.right; column++) {
      const offset = (row * width + column) * 4;
      values.push((rgba[offset] + rgba[offset + 1] + rgba[offset + 2]) / 3);
    }
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(values.length, 1);
  return { pixels: values.length, mean, relativeStandardDeviation: mean > 0 ? Math.sqrt(variance) / mean : null };
}

function toSrgbPng(rgba, width, height, exposure) {
  const bytes = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    for (let channel = 0; channel < 3; channel++) {
      const linear = Math.max(0, rgba[index * 4 + channel] * exposure);
      const encoded = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
      bytes[index * 4 + channel] = Math.round(255 * Math.min(1, encoded));
    }
    bytes[index * 4 + 3] = 255;
  }
  return encodePng(bytes, width, height);
}

const DEFAULT_CONFIG = {
  ball: {
    width: 480,
    height: 270,
    rungs: [
      { caustics: false, samples: 64 }, { caustics: false, samples: 512 },
      { caustics: true, samples: 16 }, { caustics: true, samples: 64 }, { caustics: true, samples: 256 },
    ],
    reference: { width: 96, height: 54, samples: 65536 },
  },
  prism: {
    width: 1920,
    height: 1080,
    rungs: [
      { caustics: false, samples: 256 },
      { caustics: true, samples: 16 }, { caustics: true, samples: 64 }, { caustics: true, samples: 256 }, { caustics: true, samples: 1024 },
    ],
    reference: null,
  },
};

function render(scene, { width, height, samples, caustics, opaqueCaster = false }) {
  const input = buildCausticInput(scene, { width, height, samples, caustics, opaqueCaster });
  const started = process.hrtime.bigint();
  const result = traceNative(input, { kernel: 'cycles', width, height, samples, denoise: 'none' });
  const wallSeconds = Number(process.hrtime.bigint() - started) / 1e9;
  return { result, wallSeconds };
}

const [outputFolder, configPath] = process.argv.slice(2);
if (!outputFolder) {
  console.error('usage: node tools/measure-caustics.mjs <output-folder> [config.json]');
  process.exit(2);
}
mkdirSync(outputFolder, { recursive: true });
const config = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : DEFAULT_CONFIG;
const rows = [];

for (const scene of Object.keys(config)) {
  const { width, height, rungs, reference } = config[scene];
  const cameraFields = { ball: { eye: [0, 2.2, 3.2], target: [0, 0.2, 0], fieldOfViewDegrees: 40 }, prism: { eye: [1.6, 1.1, 1.5], target: [0.35, 0.05, 0], fieldOfViewDegrees: 40 } }[scene];
  const camera = pinholeCamera({ ...cameraFields, width, height });
  const box = patchPixels(scene, camera, width, height);
  const jobs = rungs.map((rung) => ({ ...rung, width, height, kind: 'rung' }));
  if (reference) {
    jobs.push({ ...reference, caustics: false, kind: 'reference' });
    jobs.push({ ...reference, samples: Math.min(reference.samples, 512), caustics: false, opaqueCaster: true, kind: 'opaque' });
  }
  for (const job of jobs) {
    const { result, wallSeconds } = render(scene, job);
    const jobBox = job.kind === 'rung' ? box : patchPixels(scene, pinholeCamera({ ...cameraFields, width: job.width, height: job.height }), job.width, job.height);
    const statistics = patchStatistics(result.rgba, job.width, jobBox);
    const name = `${scene}-${job.kind}-${job.caustics ? 'mnee' : 'plain'}-${job.samples}spp`;
    writeFileSync(join(outputFolder, `${name}.png`), toSrgbPng(result.rgba, job.width, job.height, 1));
    const row = {
      name, scene, kind: job.kind, caustics: job.caustics, samples: job.samples, width: job.width, height: job.height,
      wallSeconds, timings: Object.fromEntries(Object.entries(result).filter(([key, value]) => key !== 'rgba' && (typeof value === 'number' || typeof value === 'string'))),
      patch: jobBox, imageMean: patchStatistics(result.rgba, job.width, { left: 0, right: job.width, top: 0, bottom: job.height }).mean, ...statistics,
    };
    rows.push(row);
    console.log('ROW', JSON.stringify(row));
    writeFileSync(join(outputFolder, 'rows.json'), JSON.stringify(rows, null, 1));
  }
}
