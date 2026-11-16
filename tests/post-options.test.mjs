import assert from 'node:assert/strict';
import { test } from 'node:test';

import { POST_VIEW_TRANSFORMS, resolvePostOption } from '../post-options.mjs';

test('a left-out post option stays undefined so a result has no display', () => {
  assert.equal(resolvePostOption(undefined, 'NativeSession.render'), undefined);
});

test('an empty post object resolves to the full default look', () => {
  assert.deepEqual(resolvePostOption({}, 'NativeSession.render'), {
    exposure: 1,
    viewTransform: 'agx',
    whiteBalance: 0,
    lift: [0, 0, 0],
    gamma: [1, 1, 1],
    gain: [1, 1, 1],
    bloomStrength: 0,
    bloomRadius: 1,
    bloomThreshold: 1,
    grainAmount: 0,
    grainSeed: 0,
    vignetteStrength: 0,
  });
});

test('a single number for lift, gamma or gain applies to all three channels', () => {
  const look = resolvePostOption({ lift: 0.1, gamma: [1, 2, 3], gain: 2 }, 'NativeSession.render');
  assert.deepEqual(look.lift, [0.1, 0.1, 0.1]);
  assert.deepEqual(look.gamma, [1, 2, 3]);
  assert.deepEqual(look.gain, [2, 2, 2]);
});

const REFUSED = [
  [{ exposure: 0 }, /post\.exposure must be a number from 0\.01 to 16, got 0/],
  [{ exposure: Number.NaN }, /post\.exposure must be a number/],
  [{ viewTransform: 'filmic' }, /post\.viewTransform must be one of agx, aces, neutral, standard, got "filmic"/],
  [{ whiteBalance: 2 }, /post\.whiteBalance must be a number from -1 to 1, got 2/],
  [{ lift: [0, 0] }, /post\.lift must be a number or three numbers/],
  [{ gamma: 0 }, /post\.gamma must be a number from 0\.2 to 5/],
  [{ gain: [1, 1, 9] }, /post\.gain\[2\] must be a number from 0 to 4, got 9/],
  [{ bloom: 0.2 }, /post\.bloom must be an object such as/],
  [{ bloom: { strength: -1 } }, /post\.bloom\.strength must be a number from 0 to 4, got -1/],
  [{ bloom: { radius: 9 } }, /post\.bloom\.radius must be a number from 0 to 8/],
  [{ bloom: { size: 1 } }, /post\.bloom\.size is not a post option; use one of strength, radius, threshold/],
  [{ grain: { amount: 0.5 } }, /post\.grain\.amount must be a number from 0 to 0\.1/],
  [{ grain: { seed: 1.5 } }, /post\.grain\.seed must be a whole number from 0 to 4294967295, got 1\.5/],
  [{ vignette: { strength: 2 } }, /post\.vignette\.strength must be a number from 0 to 1, got 2/],
  [{ tonemap: 'agx' }, /post\.tonemap is not a post option; use one of exposure, viewTransform/],
  [null, /post must be an object/],
  ['agx', /post must be an object/],
];

for (const [post, message] of REFUSED) {
  test(`post ${JSON.stringify(post)} is refused naming the field and a valid value`, () => {
    assert.throws(() => resolvePostOption(post, 'NativeSession.render'), message);
  });
}

test('every listed view transform is accepted', () => {
  for (const viewTransform of POST_VIEW_TRANSFORMS) {
    assert.equal(resolvePostOption({ viewTransform }, 'NativeSession.resolve').viewTransform, viewTransform);
  }
});
