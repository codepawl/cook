// Renders a dispersion scene with Cook and writes what the Cycles side needs (codepawl/crucible#1714).
//   node tools/dispersion-parity.mjs <scene> <output-prefix> [--samples N] [--dispersion D] [--seed S] [--width W] [--height H] [--scene-only]
// Writes <prefix>.scene.json (the meshes, materials and camera for tools/dispersion-parity-cycles.py) and, unless --scene-only,
// <prefix>.cook.npy (linear RGBA float32), <prefix>.cook.png (tone mapped) and <prefix>.cook.json (sampling seconds, adapter, options).
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { traceNative } from '../index.mjs';
import { encodeNpy } from '../output/npy.mjs';
import { encodePng } from '../output/png.mjs';
import { toneMapToRgba8 } from '../output/tone-map.mjs';
import { dispersionScene, packDispersionScene } from './dispersion-scenes.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    samples: { type: 'string', default: '64' },
    dispersion: { type: 'string', default: '1' },
    seed: { type: 'string', default: '1' },
    width: { type: 'string' },
    height: { type: 'string' },
    'scene-only': { type: 'boolean', default: false },
  },
});
const [sceneName, prefix] = positionals;
if (!sceneName || !prefix) {
  throw new TypeError('Usage: node tools/dispersion-parity.mjs <scene> <output-prefix> [--samples N] [--dispersion D] [--seed S] [--width W] [--height H] [--scene-only]');
}

const description = dispersionScene(sceneName, {
  dispersion: Number(values.dispersion),
  width: values.width ? Number(values.width) : undefined,
  height: values.height ? Number(values.height) : undefined,
});
writeFileSync(`${prefix}.scene.json`, JSON.stringify({ ...description, seed: Number(values.seed) }));
if (values['scene-only']) {
  process.exit(0);
}

const samples = Number(values.samples);
const input = packDispersionScene(description, { samples, seed: Number(values.seed) });
const started = performance.now();
const traced = traceNative(input, { width: description.width, height: description.height, samples, kernel: 'cycles' });
const wallSeconds = (performance.now() - started) / 1000;
writeFileSync(`${prefix}.cook.npy`, encodeNpy(traced.rgba, description.width, description.height));
writeFileSync(`${prefix}.cook.png`, encodePng(toneMapToRgba8(traced.rgba, description.width, description.height), description.width, description.height));
const { rgba, albedo, normal, depth, ...timing } = traced;
writeFileSync(`${prefix}.cook.json`, JSON.stringify({
  scene: sceneName, samples, dispersion: Number(values.dispersion), width: description.width, height: description.height, wallSeconds, ...timing,
}, null, 1));
console.log(JSON.stringify({ scene: sceneName, samples, dispersion: Number(values.dispersion), wallSeconds }));
