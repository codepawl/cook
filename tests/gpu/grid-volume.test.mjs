// Grid volumes against closed forms. They need the built addon and a Vulkan adapter with ray queries, and skip, with the reason, without them.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findNativeAddon, traceNative } from '../../index.mjs';
import { buildNativeInputV2 } from '../../pack-input-v2.mjs';
import { floorGeometry, placement } from '../../tools/dispersion-scenes.mjs';
import { pinholeCamera } from '../../tools/make-fixture-pack.mjs';

function skipReason() {
  try {
    return findNativeAddon() === null ? 'the native addon is not built (run `node build.mjs`, needs Rust and a Vulkan adapter with ray queries)' : false;
  } catch (environmentError) {
    return environmentError.message;
  }
}
const skip = skipReason();

const SIZE = 16;

// A box of `resolution` voxels of density 1. Voxel centres sit at (i + 0.5) / n and a voxel beyond the grid reads 0, so at a face the field is
// halfway between the empty border voxel and the first voxel (0.5) and it rises to 1 over the outer half voxel. Along a ray through the middle of
// the box the optical depth is sigma * length * (1 - 1 / (4 n)), the closed form the tests compare with.
function uniformBox({ center, size, resolution, ...shading }) {
  const voxelCount = resolution * resolution * resolution;
  return { resolution: [resolution, resolution, resolution], channels: { density: new Float32Array(voxelCount).fill(1) }, center, size, ...shading };
}

function centreAverage(rgba, width, height, halfExtent) {
  const sum = [0, 0, 0];
  let count = 0;
  for (let row = height / 2 - halfExtent; row < height / 2 + halfExtent; row += 1) {
    for (let column = width / 2 - halfExtent; column < width / 2 + halfExtent; column += 1) {
      for (let channel = 0; channel < 3; channel += 1) sum[channel] += rgba[(row * width + column) * 4 + channel];
      count += 1;
    }
  }
  return sum.map(value => value / count);
}

test('a camera ray through a grid of absorbing gas keeps exp(-sigma * length) of the background', { skip }, () => {
  const camera = pinholeCamera({ eye: [0, 0, 6], target: [0, 0, 0], fieldOfViewDegrees: 2, width: SIZE, height: SIZE });
  const sigma = [1.5, 0.75, 0];
  const resolution = 16;
  const input = buildNativeInputV2({
    materials: [{}],
    instances: [],
    lights: {},
    gridVolumes: [uniformBox({ center: [0, 0, 0], size: [4, 4, 2], resolution, density: 1.5, absorption: [1, 0.5, 0] })],
  }, camera, { width: SIZE, height: SIZE, samples: 2048, seed: 5, backgroundColor: [1, 1, 1] });
  const traced = traceNative(input, { width: SIZE, height: SIZE, samples: 2048, kernel: 'cycles' });
  const measured = centreAverage(traced.rgba, SIZE, SIZE, 6);
  const length = 2 * (1 - 1 / (4 * resolution));
  sigma.forEach((coefficient, channel) => {
    const expected = Math.exp(-coefficient * length);
    assert.ok(Math.abs(measured[channel] - expected) < 0.03 * Math.max(expected, 0.1), `channel ${channel}: measured ${measured[channel]}, expected ${expected}`);
  });
});

test('a shadow ray through a grid is attenuated by ratio tracking to the same transmittance', { skip }, () => {
  const resolution = 16;
  const geometry = floorGeometry(30);
  const floor = {
    geometry: { positions: Float32Array.from(geometry.positions), normals: Float32Array.from(geometry.normals), indices: Uint32Array.from(geometry.indices) },
    matrix: placement({}),
    materialIndex: 0,
  };
  // The camera sees the floor point under the slab through the open side: the ray from (0, 0.5, 6) to the origin stays below the slab at y = 1 to 2.
  const camera = pinholeCamera({ eye: [0, 0.5, 6], target: [0, 0, 0], fieldOfViewDegrees: 2, width: SIZE, height: SIZE });
  const scene = gridVolumes => ({
    materials: [{ color: [0.6, 0.6, 0.6], roughness: 1 }],
    instances: [floor],
    lights: { sun: { direction: [0, 1, 0], color: [3, 3, 3] } },
    gridVolumes,
  });
  const options = { width: SIZE, height: SIZE, samples: 512, seed: 9, backgroundColor: [0, 0, 0] };
  const render = gridVolumes => traceNative(buildNativeInputV2(scene(gridVolumes), camera, options), { width: SIZE, height: SIZE, samples: 512, kernel: 'cycles' });
  const open = centreAverage(render(undefined).rgba, SIZE, SIZE, 3);
  const shaded = centreAverage(
    render([uniformBox({ center: [0, 1.5, 0], size: [6, 1, 6], resolution, density: 2, absorption: [1, 1, 1] })]).rgba,
    SIZE,
    SIZE,
    3,
  );
  assert.ok(open[0] > 0.05, `the open floor point is lit: ${open[0]}`);
  const expected = Math.exp(-2 * 1 * (1 - 1 / (4 * resolution)));
  const ratio = shaded[0] / open[0];
  assert.ok(Math.abs(ratio - expected) < 0.05 * expected, `shadowed over open floor: ${ratio}, expected ${expected}`);
});

test('a grid that emits adds its emission per unit length along the ray', { skip }, () => {
  const camera = pinholeCamera({ eye: [0, 0, 6], target: [0, 0, 0], fieldOfViewDegrees: 2, width: SIZE, height: SIZE });
  const resolution = 16;
  const sigma = 0.8;
  const emission = 0.5;
  const input = buildNativeInputV2({
    materials: [{}],
    instances: [],
    lights: {},
    gridVolumes: [uniformBox({ center: [0, 0, 0], size: [4, 4, 2], resolution, density: sigma, absorption: [1, 1, 1], emission: [emission, emission, emission], emissionStrength: 1 })],
  }, camera, { width: SIZE, height: SIZE, samples: 512, seed: 2, backgroundColor: [0, 0, 0] });
  const measured = centreAverage(traceNative(input, { width: SIZE, height: SIZE, samples: 512, kernel: 'cycles' }).rgba, SIZE, SIZE, 6)[0];
  // The grid emits emission * flame (here the density) per unit length and absorbs sigma * density per unit length, so the radiance is the integral
  // of emission * density(s) * exp(-sigma * optical depth(s)) over the 2 long path, with density(s) the ramp (0.5 to 1), plateau and ramp of the box.
  const ramp = 2 / (2 * resolution);
  const densityAt = distance => Math.min(1, 0.5 + (0.5 * distance) / ramp, 0.5 + (0.5 * (2 - distance)) / ramp);
  const steps = 200000;
  let depth = 0;
  let expected = 0;
  for (let step = 0; step < steps; step += 1) {
    const midpoint = ((step + 0.5) * 2) / steps;
    const density = Math.max(0, densityAt(midpoint));
    expected += emission * density * Math.exp(-sigma * depth) * (2 / steps);
    depth += density * (2 / steps);
  }
  assert.ok(Math.abs(measured - expected) < 0.04 * expected, `measured ${measured}, expected ${expected}`);
});
