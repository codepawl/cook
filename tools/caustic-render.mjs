// Renders the prism-floor caustic scene (codepawl/crucible#1715) with or without caustic light tracing and measures a pixel box.
//   node tools/caustic-render.mjs <output-prefix> [--light-tracing] [--photons N] [--samples N] [--dispersion D] [--seed S]
//        [--width W] [--height H] [--sun-radius R] [--box x0,y0,x1,y1] [--storyboard]
// `--storyboard` is the dispersion short's scene: the hero camera, a warm sun and the blue fill panel.
// Writes <prefix>.npy (linear RGBA float32), <prefix>.png (tone mapped) and <prefix>.json (wall seconds and the box means), and
// prints the json. `--sun-radius` makes the sun bigger and dimmer in step (the same power), so a camera-path-only render of it
// converges and can serve as the reference for the light traced one.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { traceNative } from '../index.mjs';
import { encodeNpy } from '../output/npy.mjs';
import { encodePng } from '../output/png.mjs';
import { toneMapToRgba8 } from '../output/tone-map.mjs';
import { dispersionScene, packDispersionScene, panelGeometry, placement } from './dispersion-scenes.mjs';

const SUN_RADIUS = 0.09;
const SUN_EMISSION = 900;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'light-tracing': { type: 'boolean', default: false },
    photons: { type: 'string', default: '1' },
    samples: { type: 'string', default: '64' },
    dispersion: { type: 'string', default: '1' },
    seed: { type: 'string', default: '1' },
    width: { type: 'string', default: '540' },
    height: { type: 'string', default: '960' },
    'sun-radius': { type: 'string', default: String(SUN_RADIUS) },
    box: { type: 'string' },
    storyboard: { type: 'boolean', default: false },
  },
});
const [prefix] = positionals;
if (!prefix) {
  throw new TypeError('Usage: node tools/caustic-render.mjs <output-prefix> [--light-tracing] [--photons N] [--samples N] [--dispersion D] [--seed S] [--width W] [--height H] [--sun-radius R] [--box x0,y0,x1,y1]');
}

const width = Number(values.width);
const height = Number(values.height);
const samples = Number(values.samples);
const sunRadius = Number(values['sun-radius']);
const description = dispersionScene('prism-floor', { dispersion: Number(values.dispersion), width, height });
const sun = description.objects.find(object => object.name === 'sun');
const scale = sunRadius / SUN_RADIUS;
sun.matrix = sun.matrix.map((value, index) => (index < 12 && index % 4 !== 3 ? value * scale : value));
sun.material = { ...sun.material, emission: SUN_EMISSION / (scale * scale) };

if (values.storyboard) {
  description.camera = { eye: [1.6, 1.1, 1.5], target: [0.35, 0.05, 0], fieldOfViewDegrees: 40 };
  sun.material = { ...sun.material, color: [1, 0.949, 0.863] };
  description.objects.push({
    name: 'fill',
    geometry: panelGeometry(1.2, 0.8),
    matrix: placement({ turnY: -0.7, translation: [2.0, 2.4, 2.6] }),
    material: { color: [0.624, 0.706, 0.847], roughness: 1, emission: 0.35 },
  });
}

const options = values['light-tracing']
  ? { caustics: 'light-tracing', causticPhotons: Number(values.photons) }
  : {};
const input = packDispersionScene(description, { samples, seed: Number(values.seed), options });
const started = performance.now();
const traced = traceNative(input, { width, height, samples, kernel: 'cycles' });
const wallSeconds = (performance.now() - started) / 1000;

function boxMean(box) {
  const [x0, y0, x1, y1] = box;
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      for (let channel = 0; channel < 3; channel++) {
        sum[channel] += traced.rgba[(y * width + x) * 4 + channel];
      }
      count += 1;
    }
  }
  return sum.map(value => value / count);
}

const report = { samples, photons: values['light-tracing'] ? Number(values.photons) : 0, dispersion: Number(values.dispersion), sunRadius, width, height, wallSeconds };
if (values.box) {
  report.box = values.box.split(',').map(Number);
  report.boxMean = boxMean(report.box);
}
writeFileSync(`${prefix}.npy`, encodeNpy(traced.rgba, width, height));
writeFileSync(`${prefix}.png`, encodePng(toneMapToRgba8(traced.rgba, width, height), width, height));
writeFileSync(`${prefix}.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report));
