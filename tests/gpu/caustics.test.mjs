// Needs the built addon and a Vulkan adapter with ray queries; skips, with the reason, when the addon is not built.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findNativeAddon, traceNative } from '../../index.mjs';
import { INSTANCE_FLAG_CAUSTIC_CASTER } from '../../pack-input-v2.mjs';
import { buildCausticInput } from '../../tools/make-caustic-scene.mjs';

function skipReason() {
  try {
    return findNativeAddon() === null ? 'the native addon is not built (run `node build.mjs`, needs Rust and a Vulkan adapter with ray queries)' : false;
  } catch (environmentError) {
    return environmentError.message;
  }
}
const skip = skipReason();

const WIDTH = 80;
const HEIGHT = 45;
const SAMPLES = 48;
const BLOCK = 4;
const VISIBILITY_WORD = 29;

function render(input) {
  return traceNative(input, { kernel: 'cycles', width: WIDTH, height: HEIGHT, samples: SAMPLES, denoise: 'none' });
}

// The brightest BLOCK x BLOCK block of the picture: the caustic spot is a few times brighter than the lit floor around it.
function brightestBlock(result) {
  let brightest = 0;
  for (let top = 0; top + BLOCK <= HEIGHT; top += BLOCK) {
    for (let left = 0; left + BLOCK <= WIDTH; left += BLOCK) {
      let sum = 0;
      for (let row = top; row < top + BLOCK; row++) {
        for (let column = left; column < left + BLOCK; column++) {
          const offset = (row * WIDTH + column) * 4;
          sum += result.rgba[offset] + result.rgba[offset + 1] + result.rgba[offset + 2];
        }
      }
      brightest = Math.max(brightest, sum / (BLOCK * BLOCK * 3));
    }
  }
  return brightest;
}

test('a caster without a receiver renders the same bytes as a scene without the bits', { skip }, () => {
  const plain = buildCausticInput('ball', { width: WIDTH, height: HEIGHT, samples: SAMPLES });
  const onlyCaster = buildCausticInput('ball', { width: WIDTH, height: HEIGHT, samples: SAMPLES });
  const words = new Uint32Array(onlyCaster.instances.buffer, onlyCaster.instances.byteOffset, onlyCaster.instances.byteLength / 4);
  words[(1 * onlyCaster.instances.byteLength) / onlyCaster.instanceCount / 4 + VISIBILITY_WORD] |= INSTANCE_FLAG_CAUSTIC_CASTER;
  const first = render(plain);
  const second = render(onlyCaster);
  assert.ok(Buffer.from(first.rgba.buffer, first.rgba.byteOffset, first.rgba.byteLength).equals(Buffer.from(second.rgba.buffer, second.rgba.byteOffset, second.rgba.byteLength)));
});

test('a raised glass ball throws a caustic spot on the floor once it is a caster and the floor a receiver', { skip }, () => {
  const scene = { width: WIDTH, height: HEIGHT, samples: SAMPLES, ballHeight: 1.0, lowView: true };
  const without = brightestBlock(render(buildCausticInput('ball', scene)));
  const withCaustics = brightestBlock(render(buildCausticInput('ball', { ...scene, caustics: true })));
  assert.ok(Number.isFinite(withCaustics));
  assert.ok(withCaustics > without * 1.5, );
});
