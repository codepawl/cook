// Where did caustic light tracing add light? Subtracts the render without it from the render with it (linear), writes the difference
// as a tone-mapped picture and prints the added energy, the box around the pixels that gained a lot and their centroid.
//   node tools/caustic-diff.mjs <off.npy> <on.npy> <difference-prefix> [<threshold-fraction-of-peak>]
import { readFileSync, writeFileSync } from 'node:fs';

import { encodePng } from '../output/png.mjs';
import { toneMapToRgba8 } from '../output/tone-map.mjs';
import { decodeNpy } from '../tests/support/images.mjs';

const [offPath, onPath, prefix, thresholdArgument = '0.1'] = process.argv.slice(2);
if (!offPath || !onPath || !prefix) {
  throw new TypeError('Usage: node tools/caustic-diff.mjs <off.npy> <on.npy> <difference-prefix> [<threshold-fraction-of-peak>]');
}

function readRender(path) {
  const { shape, data } = decodeNpy(readFileSync(path));
  return { width: shape[1], height: shape[0], values: new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4) };
}

const off = readRender(offPath);
const on = readRender(onPath);
const { width, height } = off;
const difference = new Float32Array(width * height * 4);
const luminanceGain = new Float32Array(width * height);
let totalEnergy = [0, 0, 0];
let peak = 0;
for (let pixel = 0; pixel < width * height; pixel++) {
  for (let channel = 0; channel < 3; channel++) {
    const gain = on.values[pixel * 4 + channel] - off.values[pixel * 4 + channel];
    totalEnergy[channel] += gain;
    difference[pixel * 4 + channel] = Math.max(gain, 0);
  }
  difference[pixel * 4 + 3] = 1;
  luminanceGain[pixel] = 0.2126 * difference[pixel * 4] + 0.7152 * difference[pixel * 4 + 1] + 0.0722 * difference[pixel * 4 + 2];
  peak = Math.max(peak, luminanceGain[pixel]);
}
const threshold = peak * Number(thresholdArgument);
let [x0, y0, x1, y1] = [width, height, -1, -1];
let weight = 0;
let [sumX, sumY] = [0, 0];
let bigPixels = 0;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const gain = luminanceGain[y * width + x];
    if (gain < threshold) continue;
    bigPixels += 1;
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    weight += gain;
    sumX += gain * x;
    sumY += gain * y;
  }
}
// Scale the picture so its peak is mid grey, whatever the absolute level.
const exposure = peak > 0 ? 0.5 / peak : 1;
const scaled = difference.map((value, index) => (index % 4 === 3 ? 1 : value * exposure));
writeFileSync(`${prefix}.png`, encodePng(toneMapToRgba8(scaled, width, height), width, height));
const report = {
  addedEnergyRgb: totalEnergy,
  peakGainLuminance: peak,
  bigPixels,
  threshold,
  box: bigPixels > 0 ? [x0, y0, x1, y1] : null,
  centroid: weight > 0 ? [sumX / weight, sumY / weight] : null,
};
writeFileSync(`${prefix}.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report));
