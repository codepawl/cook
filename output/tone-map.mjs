// The display transform the 67js path tracer applies by default (view transform "aces", then gamma 2.2), so a Cook PNG and a
// 67js render of the same scene use the same curve. Copied from `acesChannel` in src/view-transform.js and
// `toneMapToRgba8` in src/path-tracer.js of codepawl/67.js; a test pins the values.

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

/** The rasterizer's ACES fit for one linear channel (src/view-transform.js `acesChannel` of codepawl/67.js). */
export function acesChannel(value) {
  const color = Math.max(value, 0);
  return clampUnit((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14));
}

/** One linear channel as an 8-bit display value: the ACES curve, then gamma 2.2, rounded. */
export function displayByte(linearValue) {
  return Math.round(acesChannel(linearValue) ** (1 / 2.2) * 255);
}

/**
 * Linear RGBA floats (four per pixel, rows from the top) as 8-bit RGBA with the same rows. Alpha is written as 255:
 * a trace does not return a usable alpha.
 */
export function toneMapToRgba8(linearRgba, width, height) {
  const pixelCount = width * height;
  if (!(linearRgba instanceof Float32Array) || linearRgba.length !== pixelCount * 4) {
    throw new TypeError(`toneMapToRgba8: pass a Float32Array of ${pixelCount * 4} floats for a ${width}x${height} image.`);
  }
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      rgba[pixel * 4 + channel] = displayByte(linearRgba[pixel * 4 + channel]);
    }
    rgba[pixel * 4 + 3] = 255;
  }
  return rgba;
}
