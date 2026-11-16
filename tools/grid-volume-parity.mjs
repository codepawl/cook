// Renders one frame of a Crucible grid volume scene in Cook, the counterpart of Crucible's `scripts/cycles-volume-reference.py` (codepawl/cook#44).
//   node tools/grid-volume-parity.mjs <spec.json> <grid.67vg> <output-prefix> [--samples N] [--seed S]
// The spec is the one that script reads (center, size, density, absorption, scatter, anisotropy, emission, emissionStrength, temperatureScale,
// blackbodyIntensity; camera, sun, floor, background, image). Writes <prefix>.cook.npy (linear RGBA float32), <prefix>.cook.png (tone mapped)
// and <prefix>.cook.json (sampling seconds, adapter, options). Compare with tools/grid-volume-compare.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { traceNative } from '../index.mjs';
import { decodeGridFile } from '../grid-volume-input.mjs';
import { encodeNpy } from '../output/npy.mjs';
import { encodePng } from '../output/png.mjs';
import { toneMapToRgba8 } from '../output/tone-map.mjs';
import { buildNativeInputV2 } from '../pack-input-v2.mjs';
import { floorGeometry, placement } from './dispersion-scenes.mjs';
import { pinholeCamera } from './make-fixture-pack.mjs';

const SUN_HALF_ANGLE_RADIANS = (0.53 * Math.PI) / 360;

/** The FORMAT-v2 input Cook traces for a Crucible grid volume spec and the grid file it names. */
export function packGridVolumeSpec(spec, gridFileBytes, { samples, seed = 1 }) {
  const image = { width: 960, height: 540, ...spec.image };
  const grid = decodeGridFile(gridFileBytes, 'grid file');
  const volume = spec.volume;
  const strength = volume.emissionStrength ?? 1;
  const gridVolume = {
    resolution: grid.resolution,
    channels: grid.channels,
    center: volume.center,
    size: volume.size ?? grid.size,
    density: volume.density ?? 1,
    absorption: volume.absorption ?? [1, 1, 1],
    scatter: Array(3).fill(volume.scatter ?? 0),
    anisotropy: volume.anisotropy ?? 0,
    emission: volume.emission ?? [0, 0, 0],
    emissionStrength: strength,
    temperatureScale: volume.temperatureScale ?? 1,
    blackbodyIntensity: (volume.blackbodyIntensity ?? 0) * strength,
  };
  const instances = [];
  const materials = [];
  if (spec.floor) {
    materials.push({ color: spec.floor.color ?? [0.5, 0.5, 0.5], roughness: 1 });
    const geometry = floorGeometry(1000);
    instances.push({
      geometry: { positions: Float32Array.from(geometry.positions), normals: Float32Array.from(geometry.normals), indices: Uint32Array.from(geometry.indices) },
      matrix: placement({ translation: [0, spec.floor.y ?? 0, 0] }),
      materialIndex: 0,
    });
  }
  const sunColor = (spec.sun?.color ?? [1, 1, 1]).map(channel => channel * (spec.sun?.strength ?? 1));
  const lights = spec.sun ? { sun: { direction: spec.sun.direction, color: sunColor, angularRadius: SUN_HALF_ANGLE_RADIANS } } : {};
  const camera = pinholeCamera({ eye: spec.camera.eye, target: spec.camera.target, fieldOfViewDegrees: spec.camera.fov, width: image.width, height: image.height });
  return {
    width: image.width,
    height: image.height,
    input: buildNativeInputV2({ materials: materials.length > 0 ? materials : [{}], instances, lights, gridVolumes: [gridVolume] }, camera, {
      width: image.width,
      height: image.height,
      samples,
      seed,
      // Blender's defaults: 12 bounces, 4 diffuse, no volume scattering bounce.
      bounces: 12,
      diffuseBounces: 4,
      glossyBounces: 4,
      volumeBounces: 0,
      backgroundColor: spec.background ?? [0, 0, 0],
    }),
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { samples: { type: 'string', default: '64' }, seed: { type: 'string', default: '1' } },
  });
  const [specPath, gridPath, prefix] = positionals;
  if (!specPath || !gridPath || !prefix) {
    throw new TypeError('Usage: node tools/grid-volume-parity.mjs <spec.json> <grid.67vg> <output-prefix> [--samples N] [--seed S]');
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const samples = Number(values.samples);
  const { width, height, input } = packGridVolumeSpec(spec, readFileSync(gridPath), { samples, seed: Number(values.seed) });
  const started = performance.now();
  const traced = traceNative(input, { width, height, samples, kernel: 'cycles' });
  const wallSeconds = (performance.now() - started) / 1000;
  writeFileSync(`${prefix}.cook.npy`, encodeNpy(traced.rgba, width, height));
  writeFileSync(`${prefix}.cook.png`, encodePng(toneMapToRgba8(traced.rgba, width, height), width, height));
  const { rgba, albedo, normal, depth, variance, ...timing } = traced;
  writeFileSync(`${prefix}.cook.json`, JSON.stringify({ samples, width, height, wallSeconds, ...timing }, null, 1));
  console.log(JSON.stringify({ samples, width, height, wallSeconds }));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  await main();
}
