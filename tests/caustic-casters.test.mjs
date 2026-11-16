// The caustic estimator's bits on the instance table, the packed scene that does not use it, and its place in the kernel source.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { INSTANCE_FLAG_CAUSTIC_CASTER, INSTANCE_FLAG_CAUSTIC_RECEIVER, STRUCT_STRIDES_V2 } from '../pack-input-v2.mjs';
import { buildCausticInput } from '../tools/make-caustic-scene.mjs';

const VISIBILITY_WORD = 29;
const OPTIONS = { width: 32, height: 18, samples: 1 };
const ALL_RAY_KINDS = 63;

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function visibilityWords(input) {
  const stride = STRUCT_STRIDES_V2.instance;
  const words = new Uint32Array(input.instances.buffer, input.instances.byteOffset, input.instances.byteLength / 4);
  return Array.from({ length: input.instanceCount }, (_, instance) => words[(instance * stride) / 4 + VISIBILITY_WORD]);
}

test('the caster and receiver bits reach the instance table and no other instance carries them', () => {
  const marked = visibilityWords(buildCausticInput('ball', { ...OPTIONS, caustics: true }));
  assert.deepEqual(marked, [ALL_RAY_KINDS | INSTANCE_FLAG_CAUSTIC_RECEIVER, ALL_RAY_KINDS | INSTANCE_FLAG_CAUSTIC_CASTER, ALL_RAY_KINDS]);
  assert.equal(INSTANCE_FLAG_CAUSTIC_CASTER, 128);
  assert.equal(INSTANCE_FLAG_CAUSTIC_RECEIVER, 256);
});

test('a scene without the bits packs to the bytes it packed to before, and the bits change nothing else', () => {
  const plain = buildCausticInput('ball', { ...OPTIONS, caustics: false });
  assert.deepEqual(visibilityWords(plain), [ALL_RAY_KINDS, ALL_RAY_KINDS, ALL_RAY_KINDS]);
  const marked = buildCausticInput('ball', { ...OPTIONS, caustics: true });
  for (const table of ['kernelParams', 'triangles', 'materials', 'emissiveTriangles', 'lights', 'lightTreeNodes', 'textureTexels']) {
    const plainBytes = Buffer.from(plain[table].buffer, plain[table].byteOffset, plain[table].byteLength);
    const markedBytes = Buffer.from(marked[table].buffer, marked[table].byteOffset, marked[table].byteLength);
    assert.ok(plainBytes.equals(markedBytes), `${table} differs between the scene with the bits and the one without`);
  }
  const stride = STRUCT_STRIDES_V2.instance;
  const withoutVisibility = (input) => {
    const copy = Buffer.from(input.instances.buffer, input.instances.byteOffset, input.instances.byteLength).subarray();
    const bytes = Buffer.from(copy);
    for (let instance = 0; instance < input.instanceCount; instance++) {
      bytes.writeUInt32LE(0, instance * stride + VISIBILITY_WORD * 4);
    }
    return bytes;
  };
  assert.ok(withoutVisibility(plain).equals(withoutVisibility(marked)));
});

test('the specialization turns the estimator off for a scene without a caster and a receiver', () => {
  const abi = readSource('../src/cycles/abi.wgsl');
  assert.match(abi, /const SCENE_HAS_CASTERS: bool = true;/);
  const modulePath = readSource('../src/cycles/mod.rs');
  assert.match(modulePath, /specialize!\(CASTERS, has_casters\);/);
  assert.match(modulePath, /has_casters: has_caster && has_receiver/);
});

test('every use of the estimator in the integrator sits behind SCENE_HAS_CASTERS', () => {
  const integrator = readSource('../src/cycles/integrator.wgsl');
  const manifest = readSource('../src/cycles/kernel-manifest.txt');
  assert.match(manifest, /^mnee\.wgsl$/m);
  const lines = integrator.split('\n');
  const mneeLines = lines
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => /mnee_|SCENE_HAS_CASTERS/.test(text) && !/^\s*\/\//.test(text));
  assert.ok(mneeLines.length >= 8, 'the integrator carries the estimator hooks');
  for (const { text, index } of mneeLines) {
    const guarded = text.includes('SCENE_HAS_CASTERS') || lines.slice(Math.max(0, index - 3), index).some((line) => line.includes('SCENE_HAS_CASTERS'));
    const isDeclaration = /^\s*var mnee_/.test(text) || /^\s*mnee_(from_receiver|light_through_caster) = false;/.test(text);
    assert.ok(guarded || isDeclaration, `line ${index + 1} uses the estimator outside SCENE_HAS_CASTERS: ${text.trim()}`);
  }
});

test('a light through a caster is dropped by the BSDF path only after a diffuse or glossy bounce from a receiver', () => {
  const integrator = readSource('../src/cycles/integrator.wgsl');
  assert.match(integrator, /if \(SCENE_HAS_CASTERS && !is_singular\) \{\s*mnee_from_receiver = mnee_instance_is_receiver\(point\.instance_index\);\s*mnee_light_through_caster = false;/);
  assert.match(integrator, /if \(SCENE_HAS_CASTERS && mnee_from_receiver && mnee_hit_is_smooth_caster\(/);
  assert.match(integrator, /!\(SCENE_HAS_CASTERS && mnee_light_through_caster\) && \(analytic_emission/);
  assert.match(integrator, /emission_weight > 0\.0 && !\(SCENE_HAS_CASTERS && mnee_light_through_caster\)/);
});
