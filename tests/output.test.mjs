import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 as nodeCrc32 } from 'node:zlib';

import { encodeNpy } from '../output/npy.mjs';
import { crc32, encodePng } from '../output/png.mjs';
import { acesChannel, displayByte, toneMapToRgba8 } from '../output/tone-map.mjs';
import { decodeNpy, decodePng } from './support/images.mjs';

test('the tone curve gives the hand-computed ACES values and the gamma 2.2 bytes of the 67js default', () => {
  assert.equal(acesChannel(0), 0);
  assert.equal(acesChannel(-3), 0);
  // (1 * (2.51 + 0.03)) / (1 * (2.43 + 0.59) + 0.14) = 2.54 / 3.16
  assert.ok(Math.abs(acesChannel(1) - 2.54 / 3.16) < 1e-12);
  assert.ok(Math.abs(acesChannel(0.18) - 0.2668989) < 1e-7);
  assert.equal(acesChannel(1000), 1);
  assert.equal(displayByte(0), 0);
  assert.equal(displayByte(0.18), 140);
  assert.equal(displayByte(0.5), 205);
  assert.equal(displayByte(1), 231);
  assert.equal(displayByte(1000), 255);
});

test('toneMapToRgba8 maps three channels per pixel, writes alpha 255 and refuses a wrong size', () => {
  const linear = new Float32Array([1, 0.5, 0.18, 0.25, 0, 0, 1000, 0]);
  const mapped = toneMapToRgba8(linear, 2, 1);
  assert.deepEqual(Array.from(mapped), [231, 205, 140, 255, 0, 0, 255, 255]);
  assert.throws(() => toneMapToRgba8(linear, 3, 1), /Float32Array of 12 floats/);
  assert.throws(() => toneMapToRgba8(new Float64Array(8), 2, 1), /Float32Array/);
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  if (typeof nodeCrc32 === 'function') {
    const sample = Uint8Array.from({ length: 1000 }, (_, index) => (index * 37) % 251);
    assert.equal(crc32(sample), nodeCrc32(sample));
  }
});

test('a PNG decodes back to the pixels that went in, with valid chunk CRCs', () => {
  const width = 5;
  const height = 3;
  const rgba = Uint8Array.from({ length: width * height * 4 }, (_, index) => (index * 53 + 7) % 256);
  const png = encodePng(rgba, width, height);
  const decoded = decodePng(png, crc32);
  assert.deepEqual(decoded.chunks.map((chunk) => chunk.type), ['IHDR', 'IDAT', 'IEND']);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.equal(decoded.bitDepth, 8);
  assert.equal(decoded.colourType, 6);
  assert.equal(decoded.interlace, 0);
  assert.deepEqual(Array.from(decoded.rgba), Array.from(rgba));
});

test('encodePng refuses a wrong pixel count and a bad size', () => {
  assert.throws(() => encodePng(new Uint8Array(10), 2, 2), /needs 16 bytes/);
  assert.throws(() => encodePng(new Uint8Array(0), 0, 0), /at least 1/);
});

test('an .npy file has a 64-byte aligned version 1.0 header, shape (height, width, 4) and the floats in C order', () => {
  const width = 3;
  const height = 2;
  const pixels = Float32Array.from({ length: width * height * 4 }, (_, index) => index * 0.25 - 1);
  const npy = encodeNpy(pixels, width, height);
  const decoded = decodeNpy(npy);
  assert.deepEqual(decoded.version, [1, 0]);
  assert.equal((10 + decoded.headerLength) % 64, 0);
  assert.ok(decoded.header.endsWith('\n'));
  assert.equal(decoded.descr, '<f4');
  assert.match(decoded.header, /'fortran_order': False/);
  assert.deepEqual(decoded.shape, [height, width, 4]);
  assert.ok(decoded.data.equals(Buffer.from(pixels.buffer)));
  assert.throws(() => encodeNpy(pixels, 4, 2), /Float32Array of 32 floats/);
});
