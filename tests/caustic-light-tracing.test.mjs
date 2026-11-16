import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { findNativeAddon, traceNative } from '../index.mjs';
import {
  KERNEL_FLAG_CAUSTIC_LIGHT_TRACING,
  KERNEL_PARAMS_V2_CAUSTIC_PHOTONS_BYTE_OFFSET,
  buildNativeInputV2,
} from '../pack-input-v2.mjs';
import { dispersionScene, packDispersionScene } from '../tools/dispersion-scenes.mjs';
import { pinholeCamera } from '../tools/make-fixture-pack.mjs';

const KERNEL_FLAGS_BYTE_OFFSET = 32;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function packLitFloor(options) {
  const floor = {
    positions: [-2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2],
    normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    indices: [0, 2, 1, 0, 3, 2],
  };
  const lamp = {
    positions: [-0.2, 1, -0.2, 0.2, 1, -0.2, 0.2, 1, 0.2, -0.2, 1, 0.2],
    normals: [0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0],
    indices: [0, 1, 2, 0, 2, 3],
  };
  const scene = {
    materials: [{ color: [0.5, 0.5, 0.5], roughness: 1 }, { color: [1, 1, 1], roughness: 1, emission: 20 }],
    instances: [
      { geometry: floor, matrix: IDENTITY, materialIndex: 0 },
      { geometry: lamp, matrix: IDENTITY, materialIndex: 1 },
    ],
    lights: {},
  };
  const camera = pinholeCamera({ eye: [0, 1.5, 3], target: [0, 0, 0], fieldOfViewDegrees: 40, width: 32, height: 32 });
  return buildNativeInputV2(scene, camera, { width: 32, height: 32, samples: 4, seed: 5, backgroundColor: [0, 0, 0], ...options });
}

function wordsOf(input) {
  const params = input.kernelParams;
  const view = new DataView(params.buffer, params.byteOffset, params.byteLength);
  return {
    flags: view.getUint32(KERNEL_FLAGS_BYTE_OFFSET, true),
    photons: view.getUint32(KERNEL_PARAMS_V2_CAUSTIC_PHOTONS_BYTE_OFFSET, true),
  };
}

test('caustics off, "off" and no option pack the same kernel parameters, with the flag and the photon word clear', () => {
  const plain = packLitFloor({});
  const off = packLitFloor({ caustics: 'off' });
  assert.deepEqual(Buffer.from(off.kernelParams), Buffer.from(plain.kernelParams));
  assert.deepEqual(wordsOf(plain), { flags: wordsOf(plain).flags & ~KERNEL_FLAG_CAUSTIC_LIGHT_TRACING, photons: 0 });
});

test('caustics "light-tracing" sets the flag and the photon word (1 by default) and changes no other byte', () => {
  const plain = packLitFloor({});
  const traced = packLitFloor({ caustics: 'light-tracing' });
  assert.deepEqual(wordsOf(traced), { flags: wordsOf(plain).flags | KERNEL_FLAG_CAUSTIC_LIGHT_TRACING, photons: 1 });
  const differing = [];
  for (let byte = 0; byte < plain.kernelParams.byteLength; byte++) {
    if (plain.kernelParams[byte] !== traced.kernelParams[byte]) differing.push(byte);
  }
  assert.ok(differing.every(byte => (byte >= 32 && byte < 36) || (byte >= 324 && byte < 328)), `bytes ${differing}`);
  assert.equal(wordsOf(packLitFloor({ caustics: 'light-tracing', causticPhotons: 7 })).photons, 7);
});

test('a caustics option the kernel cannot use is refused with what to pass', () => {
  assert.throws(() => packLitFloor({ caustics: 'photon-map' }), /`caustics` must be "off".*"light-tracing".*got "photon-map"/);
  assert.throws(() => packLitFloor({ caustics: 'light-tracing', causticPhotons: 0 }), /`causticPhotons` must be a whole number from 1 to 64.*got 0/);
  assert.throws(() => packLitFloor({ caustics: 'light-tracing', causticPhotons: 65 }), /from 1 to 64.*got 65/);
  assert.throws(() => packLitFloor({ caustics: 'light-tracing', causticPhotons: 1.5 }), /whole number/);
  assert.throws(() => packLitFloor({ causticPhotons: 2 }), /only applies with `caustics: "light-tracing"`/);
  assert.throws(() => packLitFloor({ caustics: 'light-tracing', noiseThreshold: 0.01 }), /a pixel cannot stop early/);
  assert.throws(() => packLitFloor({ caustics: 'light-tracing', orthographic: true }), /does not support `orthographic: true`/);
});

test('the kernel text keeps the light tracing behind the frame flag and the splat at binding 15', () => {
  const integrator = readFileSync(new URL('../src/cycles/integrator.wgsl', import.meta.url), 'utf8');
  const abi = readFileSync(new URL('../src/cycles/abi.wgsl', import.meta.url), 'utf8');
  assert.match(abi, /const KERNEL_FLAG_CAUSTIC_LIGHT_TRACING: u32 = 8192u;/);
  assert.match(abi, /const FRAME_HAS_CAUSTIC_LIGHT_TRACING: bool = true;/);
  assert.match(abi, /@group\(0\) @binding\(15\) var<storage, read_write> caustic_splat: array<atomic<u32>>;/);
  assert.match(integrator, /if \(FRAME_HAS_CAUSTIC_LIGHT_TRACING && kernel_params\.caustic_photons > 0u\)/);
  assert.match(integrator, /if \(FRAME_HAS_CAUSTIC_LIGHT_TRACING && lt_left_surface_vertex && lt_caster_chain > 0u\)/);
});

const addonMissing = (() => {
  try {
    return findNativeAddon() === null ? 'the native addon is not built (run `node build.mjs`)' : false;
  } catch (environmentError) {
    return environmentError.message;
  }
})();

// No glass, so no photon crosses a caster: nothing is splatted and no camera path drops its emitter hit. The image must not move.
test('light tracing changes no pixel of a scene without a caster', { skip: addonMissing }, () => {
  const options = { width: 32, height: 32, samples: 4, kernel: 'cycles' };
  const without = traceNative(packLitFloor({}), options);
  const withLightTracing = traceNative(packLitFloor({ caustics: 'light-tracing', causticPhotons: 2 }), options);
  assert.deepEqual(Buffer.from(withLightTracing.rgba.buffer), Buffer.from(without.rgba.buffer));
});

// `filterGlossy` blurs a glass lobe a camera path meets after a diffuse bounce. With light tracing that blur would turn the smooth
// glass into a non-singular lobe: the camera path would then keep a blurred copy of the caustic the light paths already carry.
// So the blur skips smooth glass, and the setting must not move a light traced image of a scene with only smooth glass.
test('light tracing keeps smooth glass sharp under filterGlossy, and the blur does change the image without it', { skip: addonMissing }, () => {
  const render = options => {
    const description = dispersionScene('prism-floor', { dispersion: 0, width: 48, height: 27 });
    const input = packDispersionScene(description, { samples: 16, seed: 3, options });
    return Buffer.from(traceNative(input, { width: 48, height: 27, samples: 16, kernel: 'cycles' }).rgba.buffer);
  };
  const traced = { caustics: 'light-tracing', causticPhotons: 2 };
  assert.deepEqual(render({ ...traced, filterGlossy: 0 }), render({ ...traced, filterGlossy: 1 }));
  assert.notDeepEqual(render({ filterGlossy: 0 }), render({ filterGlossy: 1 }));
});
