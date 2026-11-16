// The native post stage against the JavaScript reference in tests/support/post-reference.mjs. Skips, with the reason, when the
// addon is not built.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createNativeSession, findNativeAddon } from '../../index.mjs';
import { decodePackFile } from '../../pack-file.mjs';
import { resolvePostOption } from '../../post-options.mjs';
import { referenceDisplay } from '../support/post-reference.mjs';

const FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/room.cookpack', import.meta.url));
/** Largest accepted difference per 8-bit channel between the GPU and the reference, grain excluded. */
const TOLERANCE_PER_CHANNEL = 2;

function skipReason() {
  try {
    return findNativeAddon() === null ? 'the native addon is not built (run `node build.mjs`)' : false;
  } catch (environmentError) {
    return environmentError.message;
  }
}
const skip = skipReason();

const sessions = [];
after(() => sessions.forEach((session) => session.close()));

function sessionOfSize(width, height) {
  const session = createNativeSession(decodePackFile(readFileSync(FIXTURE_PATH)), { kernel: 'cycles', width, height, samples: 4, denoise: 'none' });
  sessions.push(session);
  return session;
}

function largestDifference(first, second) {
  let largest = 0;
  for (let index = 0; index < first.length; index++) largest = Math.max(largest, Math.abs(first[index] - second[index]));
  return largest;
}

const FULL_LOOK = {
  exposure: 2,
  whiteBalance: 0.3,
  lift: [0.02, 0, -0.01],
  gamma: 1.1,
  gain: [1.05, 1, 0.95],
  bloom: { strength: 0.4, radius: 2, threshold: 0.3 },
  vignette: { strength: 0.35 },
};

for (const viewTransform of ['agx', 'aces', 'neutral', 'standard']) {
  test(`display matches the JavaScript reference within ${TOLERANCE_PER_CHANNEL}/255 for ${viewTransform}`, { skip }, () => {
    const width = 100;
    const height = 75;
    const session = sessionOfSize(width, height);
    const frame = session.render({ post: { ...FULL_LOOK, viewTransform } });
    assert.equal(frame.display.length, width * height * 4);
    const look = resolvePostOption({ ...FULL_LOOK, viewTransform }, 'test');
    const expected = referenceDisplay(frame.rgba, width, height, look);
    assert.ok(largestDifference(frame.display, expected) <= TOLERANCE_PER_CHANNEL, `largest difference ${largestDifference(frame.display, expected)}`);
    const resolved = session.resolve({ post: { ...FULL_LOOK, viewTransform } });
    assert.deepEqual(resolved.display, frame.display, 'resolve of the same film gives the same display');
    assert.ok(resolved.postSeconds > 0);
  });
}

test('a result without post has no display and the film is unchanged', { skip }, () => {
  const session = sessionOfSize(64, 48);
  const plain = session.render({});
  assert.equal(plain.display, undefined);
  const withPost = session.render({ post: {} });
  assert.deepEqual(withPost.rgba, plain.rgba);
});

test('the post stage reads the denoised film when a denoise is asked for', { skip }, () => {
  const session = sessionOfSize(64, 48);
  const frame = session.render({ denoise: 'atrous', post: { viewTransform: 'aces' } });
  const look = resolvePostOption({ viewTransform: 'aces' }, 'test');
  const expected = referenceDisplay(frame.denoisedRgba, 64, 48, look);
  assert.ok(largestDifference(frame.display, expected) <= TOLERANCE_PER_CHANNEL);
});

test('grain is deterministic for a seed, differs between seeds and stays inside its amount', { skip }, () => {
  const session = sessionOfSize(64, 48);
  const plain = session.render({ post: { viewTransform: 'standard', exposure: 0.5 } }).display;
  const grainy = session.resolve({ post: { viewTransform: 'standard', exposure: 0.5, grain: { amount: 0.05, seed: 7 } } }).display;
  const again = session.resolve({ post: { viewTransform: 'standard', exposure: 0.5, grain: { amount: 0.05, seed: 7 } } }).display;
  const otherSeed = session.resolve({ post: { viewTransform: 'standard', exposure: 0.5, grain: { amount: 0.05, seed: 8 } } }).display;
  assert.deepEqual(grainy, again);
  assert.notDeepEqual(grainy, otherSeed);
  let signedSum = 0;
  let count = 0;
  for (let index = 0; index < grainy.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const difference = grainy[index + channel] - plain[index + channel];
      assert.ok(Math.abs(difference) <= 0.05 * 0.5 * 255 + 1.5, `pixel ${index / 4} differs by ${difference}`);
      signedSum += difference;
      count++;
    }
  }
  assert.ok(Math.abs(signedSum / count) < 1, `mean grain offset ${signedSum / count}`);
});
