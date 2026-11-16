// Measures how rough a pixel box of a linear .npy render is: the mean absolute difference of horizontally neighbouring pixels (in
// luminance) divided by the mean luminance of the box. A smooth caustic gives a small number, speckle a large one.
//   node tools/caustic-noise.mjs <x0,y0,x1,y1> <render.npy> [<render.npy> ...]
import { readFileSync } from 'node:fs';

import { decodeNpy } from '../tests/support/images.mjs';

const [boxArgument, ...paths] = process.argv.slice(2);
if (!boxArgument || paths.length === 0) {
  throw new TypeError('Usage: node tools/caustic-noise.mjs <x0,y0,x1,y1> <render.npy> [<render.npy> ...]');
}
const [x0, y0, x1, y1] = boxArgument.split(',').map(Number);

for (const path of paths) {
  const { shape, data } = decodeNpy(readFileSync(path));
  const width = shape[1];
  const values = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  const luminanceAt = (x, y) => {
    const base = (y * width + x) * 4;
    return 0.2126 * values[base] + 0.7152 * values[base + 1] + 0.0722 * values[base + 2];
  };
  let sum = 0;
  let differenceSum = 0;
  let pixels = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1 - 1; x++) {
      sum += luminanceAt(x, y);
      differenceSum += Math.abs(luminanceAt(x, y) - luminanceAt(x + 1, y));
      pixels += 1;
    }
  }
  const mean = sum / pixels;
  console.log(`${path}: mean ${mean.toFixed(5)} roughness ${(differenceSum / pixels / mean).toFixed(3)}`);
}
