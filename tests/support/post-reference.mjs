// A JavaScript twin of src/post.wgsl for the GPU tests. The view-transform functions are copied from Crucible's
// src/view-transform.js (acesChannel, agxColor, neutralColor); the order of the steps and the bloom and grain definitions are
// the ones docs/post-stage.md lists. Not imported by the package.

const AGX_INSET = [[0.57215, 0.33216, 0.09569], [0.12368, 0.74091, 0.13541], [0.09814, 0.19729, 0.70457]];
const AGX_OUTSET = [[1.84762, -0.70741, -0.14021], [-0.2341, 1.3225, -0.0884], [-0.19713, -0.30062, 1.49775]];
const AGX = {
  minimumEv: -12.47393,
  maximumEv: 4.026069,
  pivot: [0.60608, 0.48834],
  slope: 2.39013,
  toe: { scale: 0.56474, power: 1.50159 },
  shoulder: { scale: 0.70613, power: 1.53357 },
  encodingPower: 2.4,
};
const NEUTRAL = { startCompression: 0.8 - 0.04, desaturation: 0.15 };
const BLOOM_CELL = 8;
const MAXIMUM_BLUR_TAPS = 32;

const clampUnit = (value) => Math.min(1, Math.max(0, value));

function multiply(rows, vector) {
  return rows.map((row) => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]);
}

function acesChannel(value) {
  const color = Math.max(value, 0);
  return clampUnit((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14));
}

function agxSigmoidSide(distance, side) {
  const scaled = distance / side.scale;
  return (side.scale * scaled) / (1 + scaled ** side.power) ** (1 / side.power);
}

function agxCurve(value) {
  const distance = AGX.slope * (value - AGX.pivot[0]);
  return AGX.pivot[1] + (distance >= 0 ? agxSigmoidSide(distance, AGX.shoulder) : -agxSigmoidSide(-distance, AGX.toe));
}

function agxColor(rgb) {
  const linear = multiply(AGX_INSET, rgb).map((channel) => {
    const logged = (Math.log2(Math.max(channel, 1e-10)) - AGX.minimumEv) / (AGX.maximumEv - AGX.minimumEv);
    return Math.max(0, agxCurve(clampUnit(logged))) ** AGX.encodingPower;
  });
  return multiply(AGX_OUTSET, linear).map(clampUnit);
}

function neutralColor(rgb) {
  const lowest = Math.min(...rgb);
  const offset = lowest < 0.08 ? lowest - 6.25 * lowest * lowest : 0.04;
  const shifted = rgb.map((channel) => channel - offset);
  const peak = Math.max(...shifted);
  if (peak < NEUTRAL.startCompression) return shifted.map(clampUnit);
  const distance = 1 - NEUTRAL.startCompression;
  const newPeak = 1 - (distance * distance) / (peak + distance - NEUTRAL.startCompression);
  const mix = 1 - 1 / (NEUTRAL.desaturation * (peak - newPeak) + 1);
  return shifted.map((channel) => clampUnit(((channel * newPeak) / peak) * (1 - mix) + newPeak * mix));
}

export function applyViewTransform(name, rgb) {
  if (name === 'agx') return agxColor(rgb);
  if (name === 'neutral') return neutralColor(rgb);
  if (name === 'aces') return rgb.map(acesChannel);
  return rgb.map(clampUnit);
}

function pcg(value) {
  const state = (Math.imul(value, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/** Grain in -0.5 to 0.5 for one pixel and seed. */
export function grainNoise(x, y, seed) {
  return (pcg((x ^ pcg((y ^ pcg(seed)) >>> 0)) >>> 0) >>> 8) / 16777216 - 0.5;
}

function bloomBlurShape(radius, height) {
  const sigma = Math.max((radius * 0.01 * height) / BLOOM_CELL, 0.5);
  return { sigma, taps: Math.min(Math.ceil(sigma * 3), MAXIMUM_BLUR_TAPS) };
}

/** The blurred, eighth-size bloom as { width, height, data } with three floats per bloom pixel. */
function bloomImage(film, width, height, look) {
  const bloomWidth = Math.ceil(width / BLOOM_CELL);
  const bloomHeight = Math.ceil(height / BLOOM_CELL);
  let current = new Float64Array(bloomWidth * bloomHeight * 3);
  for (let row = 0; row < bloomHeight; row++) {
    for (let column = 0; column < bloomWidth; column++) {
      let count = 0;
      for (let y = row * BLOOM_CELL; y < Math.min(height, (row + 1) * BLOOM_CELL); y++) {
        for (let x = column * BLOOM_CELL; x < Math.min(width, (column + 1) * BLOOM_CELL); x++) {
          for (let channel = 0; channel < 3; channel++) {
            current[(row * bloomWidth + column) * 3 + channel] += Math.max(film[(y * width + x) * 4 + channel] * look.exposure - look.bloomThreshold, 0);
          }
          count++;
        }
      }
      for (let channel = 0; channel < 3; channel++) current[(row * bloomWidth + column) * 3 + channel] /= count;
    }
  }
  const { sigma, taps } = bloomBlurShape(look.bloomRadius, height);
  for (const horizontal of [true, false]) {
    const blurred = new Float64Array(current.length);
    for (let row = 0; row < bloomHeight; row++) {
      for (let column = 0; column < bloomWidth; column++) {
        let weightSum = 0;
        for (let tap = -taps; tap <= taps; tap++) {
          const weight = Math.exp((-0.5 * tap * tap) / (sigma * sigma));
          const sourceColumn = horizontal ? Math.min(bloomWidth - 1, Math.max(0, column + tap)) : column;
          const sourceRow = horizontal ? row : Math.min(bloomHeight - 1, Math.max(0, row + tap));
          for (let channel = 0; channel < 3; channel++) {
            blurred[(row * bloomWidth + column) * 3 + channel] += weight * current[(sourceRow * bloomWidth + sourceColumn) * 3 + channel];
          }
          weightSum += weight;
        }
        for (let channel = 0; channel < 3; channel++) blurred[(row * bloomWidth + column) * 3 + channel] /= weightSum;
      }
    }
    current = blurred;
  }
  return { width: bloomWidth, height: bloomHeight, data: current };
}

function sampleBloom(bloom, x, y) {
  const positionX = (x + 0.5) / BLOOM_CELL - 0.5;
  const positionY = (y + 0.5) / BLOOM_CELL - 0.5;
  const baseX = Math.floor(positionX);
  const baseY = Math.floor(positionY);
  const fractionX = positionX - baseX;
  const fractionY = positionY - baseY;
  const clampColumn = (column) => Math.min(bloom.width - 1, Math.max(0, column));
  const clampRow = (row) => Math.min(bloom.height - 1, Math.max(0, row));
  const at = (column, row, channel) => bloom.data[(clampRow(row) * bloom.width + clampColumn(column)) * 3 + channel];
  return [0, 1, 2].map((channel) => {
    const top = at(baseX, baseY, channel) * (1 - fractionX) + at(baseX + 1, baseY, channel) * fractionX;
    const bottom = at(baseX, baseY + 1, channel) * (1 - fractionX) + at(baseX + 1, baseY + 1, channel) * fractionX;
    return top * (1 - fractionY) + bottom * fractionY;
  });
}

/**
 * The display image a post look makes of a linear RGBA film: `look` is the complete object `resolvePostOption` returns.
 * Returns a Uint8Array of RGBA bytes, and with `withoutGrain` leaves the grain out so the comparison can use a tight tolerance.
 */
export function referenceDisplay(film, width, height, look, { withoutGrain = false } = {}) {
  const bloom = look.bloomStrength > 0 ? bloomImage(film, width, height, look) : null;
  const display = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      let color = [0, 1, 2].map((channel) => film[pixel * 4 + channel] * look.exposure);
      if (bloom) {
        const glow = sampleBloom(bloom, x, y);
        color = color.map((channel, index) => channel + glow[index] * look.bloomStrength);
      }
      color = applyViewTransform(look.viewTransform, color).map((channel) => channel ** (1 / 2.2));
      color = [color[0] * (1 + look.whiteBalance * 0.1), color[1], color[2] * (1 - look.whiteBalance * 0.1)];
      color = color.map((channel, index) => Math.max(channel * look.gain[index] + look.lift[index], 0) ** (1 / look.gamma[index]));
      const centeredX = ((x + 0.5) / width) * 2 - 1;
      const centeredY = ((y + 0.5) / height) * 2 - 1;
      const vignette = Math.max(0, 1 - look.vignetteStrength * (centeredX * centeredX + centeredY * centeredY));
      const grain = withoutGrain ? 0 : grainNoise(x, y, look.grainSeed) * look.grainAmount;
      color = color.map((channel) => channel * vignette + grain);
      for (let channel = 0; channel < 3; channel++) display[pixel * 4 + channel] = Math.round(clampUnit(color[channel]) * 255);
      display[pixel * 4 + 3] = Math.round(clampUnit(film[pixel * 4 + 3]) * 255);
    }
  }
  return display;
}
