// Tests that need the built addon and a Vulkan adapter with ray queries. They skip, with the reason, when the addon is not built.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findNativeAddon, isTimeLimitError, traceNative } from '../../index.mjs';
import { decodePackFile } from '../../pack-file.mjs';
import { crc32 } from '../../output/png.mjs';
import { decodeNpy, decodePng } from '../support/images.mjs';

const PACKAGE_DIRECTORY = fileURLToPath(new URL('../..', import.meta.url));
const CLI_PATH = join(PACKAGE_DIRECTORY, 'bin', 'cook.mjs');
const FIXTURE_PATH = join(PACKAGE_DIRECTORY, 'fixtures', 'room.cookpack');
const WIDTH = 160;
const HEIGHT = 120;
const SAMPLES = 64;

function skipReason() {
  try {
    return findNativeAddon() === null ? 'the native addon is not built (run `node build.mjs`, needs Rust and a Vulkan adapter with ray queries)' : false;
  } catch (environmentError) {
    return environmentError.message;
  }
}
const skip = skipReason();

const workDirectory = mkdtempSync(join(tmpdir(), 'cook-gpu-test-'));
after(() => rmSync(workDirectory, { recursive: true, force: true }));

function cook(args) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('cook render writes a PNG of the fixture that is not black', { skip }, () => {
  const picturePath = join(workDirectory, 'room.png');
  const result = cook(['render', FIXTURE_PATH, '--output', picturePath]);
  assert.equal(result.status, 0, result.stderr);
  const picture = decodePng(readFileSync(picturePath), crc32);
  assert.equal(picture.width, WIDTH);
  assert.equal(picture.height, HEIGHT);
  let brightestChannel = 0;
  let channelSum = 0;
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const value = picture.rgba[pixel * 4 + channel];
      brightestChannel = Math.max(brightestChannel, value);
      channelSum += value;
    }
  }
  assert.ok(brightestChannel > 100, `the brightest channel is ${brightestChannel}`);
  assert.ok(channelSum / (WIDTH * HEIGHT * 3) > 10, 'the picture is almost black');
});

test('cook render --output .npy equals traceNative on the decoded pack byte for byte', { skip }, () => {
  const arrayPath = join(workDirectory, 'room.npy');
  const result = cook(['render', FIXTURE_PATH, '--output', arrayPath]);
  assert.equal(result.status, 0, result.stderr);
  const written = decodeNpy(readFileSync(arrayPath));
  assert.deepEqual(written.shape, [HEIGHT, WIDTH, 4]);
  const traced = traceNative(decodePackFile(readFileSync(FIXTURE_PATH)), {
    kernel: 'cycles',
    width: WIDTH,
    height: HEIGHT,
    samples: SAMPLES,
    denoise: 'none',
  });
  assert.ok(written.data.equals(Buffer.from(traced.rgba.buffer, traced.rgba.byteOffset, traced.rgba.byteLength)));
});

test('a smaller size at the packed ratio renders at that size', { skip }, () => {
  const picturePath = join(workDirectory, 'small.png');
  const result = cook(['render', FIXTURE_PATH, '--output', picturePath, '--width', '80', '--samples', '8', '--denoise', 'atrous']);
  assert.equal(result.status, 0, result.stderr);
  const picture = decodePng(readFileSync(picturePath), crc32);
  assert.equal(picture.width, 80);
  assert.equal(picture.height, 60);
});

test('a trace that passes its time limit throws an error with the code COOK_TIME_LIMIT', { skip }, () => {
  assert.throws(
    () => traceNative(decodePackFile(readFileSync(FIXTURE_PATH)), {
      kernel: 'cycles',
      width: WIDTH,
      height: HEIGHT,
      samples: 1000000,
      maxSeconds: 0.05,
    }),
    (error) => isTimeLimitError(error) && error.code === 'COOK_TIME_LIMIT' && /time limit/.test(error.message),
  );
});

test('cook render exits 4 and writes nothing when the time limit passes', { skip }, () => {
  const picturePath = join(workDirectory, 'late.png');
  const result = cook(['render', FIXTURE_PATH, '--output', picturePath, '--samples', '1000000', '--max-seconds', '0.05']);
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stderr, /time limit of 0\.05 s; nothing was written/);
  assert.equal(existsSync(picturePath), false);
});
