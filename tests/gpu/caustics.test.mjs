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

const WIDTH = 64;
const HEIGHT = 36;
const SAMPLES = 32;
const VISIBILITY_WORD = 29;

function render(input) {
  return traceNative(input, { kernel: 'cycles', width: WIDTH, height: HEIGHT, samples: SAMPLES, denoise: 'none' });
}

function meanOfRgb(result) {
  let sum = 0;
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    sum += result.rgba[pixel * 4] + result.rgba[pixel * 4 + 1] + result.rgba[pixel * 4 + 2];
  }
  return sum / (WIDTH * HEIGHT * 3);
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

test('light reaches the floor through a glass ball once the ball is a caster and the floor a receiver', { skip }, () => {
  const without = meanOfRgb(render(buildCausticInput('ball', { width: WIDTH, height: HEIGHT, samples: SAMPLES })));
  const withCaustics = meanOfRgb(render(buildCausticInput('ball', { width: WIDTH, height: HEIGHT, samples: SAMPLES, caustics: true })));
  assert.ok(Number.isFinite(withCaustics));
  assert.ok(withCaustics > without * 1.01, `mean ${withCaustics} with the estimator, ${without} without`);
});
