import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { STRUCT_STRIDES_V2, buildNativeInputV2 } from '../pack-input-v2.mjs';
import { pinholeCamera } from '../tools/make-fixture-pack.mjs';

const MATERIAL_STRIDE = STRUCT_STRIDES_V2.material;
const EXTENSION_DISPERSION_BYTE = 16;

function packGlassTriangle(glassFields) {
  const geometry = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = {
    materials: [{ color: [1, 1, 1], roughness: 0, ior: 1.5, transmission: 1, ...glassFields }],
    instances: [{ geometry, matrix: identity, materialIndex: 0 }],
    lights: {},
  };
  const camera = pinholeCamera({ eye: [0, 0, 3], target: [0, 0, 0], fieldOfViewDegrees: 40, width: 8, height: 8 });
  return buildNativeInputV2(scene, camera, { width: 8, height: 8, samples: 1, backgroundColor: [0, 0, 0] });
}

function extensionDispersion(input) {
  const view = new DataView(input.materials.buffer, input.materials.byteOffset, input.materials.byteLength);
  return view.getFloat32(input.materialCount * MATERIAL_STRIDE + EXTENSION_DISPERSION_BYTE, true);
}

test('a material without dispersion packs the table it always did, and dispersion 0 packs the same bytes', () => {
  const plain = packGlassTriangle({});
  const zero = packGlassTriangle({ dispersion: 0 });
  assert.equal(plain.materials.byteLength, plain.materialCount * MATERIAL_STRIDE, 'no extension run');
  assert.deepEqual(Buffer.from(zero.materials), Buffer.from(plain.materials));
  assert.deepEqual(Buffer.from(zero.kernelParams), Buffer.from(plain.kernelParams));
});

test('a dispersive material adds an extension run that holds its dispersion and leaves the record alone', () => {
  const plain = packGlassTriangle({});
  const prism = packGlassTriangle({ dispersion: 1.5 });
  assert.equal(prism.materials.byteLength, 2 * prism.materialCount * MATERIAL_STRIDE);
  assert.equal(extensionDispersion(prism), 1.5);
  assert.deepEqual(
    Buffer.from(prism.materials.subarray(0, prism.materialCount * MATERIAL_STRIDE)),
    Buffer.from(plain.materials),
    'the first run is the record without dispersion, byte for byte',
  );
});

test('a dispersion outside 0 to 10 or not a number is refused with the accepted range', () => {
  for (const bad of [-0.1, 11, Number.NaN, '1']) {
    assert.throws(() => packGlassTriangle({ dispersion: bad }), /dispersion must be a number from 0 to 10/);
  }
});

// The kernel's Cauchy fit and hero wavelength weight, mirrored here so that the constants written in bsdf_glass.wgsl are checked.
const glassSource = readFileSync(new URL('../src/cycles/bsdf_glass.wgsl', import.meta.url), 'utf8');

function wyman(nm, center, sigmaBelow, sigmaAbove) {
  const sigma = nm < center ? sigmaBelow : sigmaAbove;
  return Math.exp(-0.5 * ((nm - center) / sigma) ** 2);
}

function clampedRgb(nm) {
  const x = 1.056 * wyman(nm, 599.8, 37.9, 31.0) + 0.362 * wyman(nm, 442.0, 16.0, 26.7) - 0.065 * wyman(nm, 501.1, 20.4, 26.2);
  const y = 0.821 * wyman(nm, 568.8, 46.9, 40.5) + 0.286 * wyman(nm, 530.9, 16.3, 31.1);
  const z = 1.217 * wyman(nm, 437.0, 11.8, 36.0) + 0.681 * wyman(nm, 459.0, 26.0, 13.8);
  return [
    Math.max(3.2406 * x - 1.5372 * y - 0.4986 * z, 0),
    Math.max(-0.9689 * x + 1.8758 * y + 0.0415 * z, 0),
    Math.max(0.0557 * x - 0.2040 * y + 1.0570 * z, 0),
  ];
}

test('the spectral weight of the kernel averages to one per channel over the sampled wavelengths', () => {
  const declared = /const SPECTRAL_RGB_MEAN: vec3<f32> = vec3<f32>\(([^)]*)\);/.exec(glassSource);
  assert.ok(declared, 'the kernel declares SPECTRAL_RGB_MEAN');
  const declaredMean = declared[1].split(',').map(Number);
  const steps = 6000;
  const mean = [0, 0, 0];
  for (let step = 0; step < steps; step++) {
    const rgb = clampedRgb(400 + (300 * (step + 0.5)) / steps);
    for (let channel = 0; channel < 3; channel++) mean[channel] += rgb[channel] / steps;
  }
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(Math.abs(mean[channel] - declaredMean[channel]) < 1e-6, `channel ${channel}: ${mean[channel]} against ${declaredMean[channel]}`);
  }
});

test('the kernel reads dispersion as 20 divided by the Abbe number around the d line', () => {
  assert.match(glassSource, /const SPECTRAL_ABBE_AT_UNIT_DISPERSION: f32 = 20\.0;/);
  assert.match(glassSource, /const SPECTRAL_D_LINE_UM: f32 = 0\.5876;/);
  assert.match(glassSource, /const SPECTRAL_F_LINE_UM: f32 = 0\.4861;/);
  assert.match(glassSource, /const SPECTRAL_C_LINE_UM: f32 = 0\.6563;/);
  const ior = 1.5;
  const dispersion = 1.5;
  const indexAt = micrometres => {
    const spread = ((ior - 1) * dispersion) / 20;
    const b = spread / (1 / 0.4861 ** 2 - 1 / 0.6563 ** 2);
    const a = ior - b / 0.5876 ** 2;
    return a + b / micrometres ** 2;
  };
  assert.ok(Math.abs(indexAt(0.5876) - ior) < 1e-12);
  const abbe = (indexAt(0.5876) - 1) / (indexAt(0.4861) - indexAt(0.6563));
  assert.ok(Math.abs(abbe - 20 / dispersion) < 1e-9, `Abbe number ${abbe}`);
});
