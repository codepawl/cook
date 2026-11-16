// Scores linear renders stored as .npy files (float32, height x width x 4), codepawl/cook#44.
//   node tools/grid-volume-compare.mjs rmse <candidate.npy> <reference.npy>   RMSE and relative RMSE of the RGB channels, and the mean of both
//   node tools/grid-volume-compare.mjs noise <first.npy> <second.npy>         per pixel noise of two renders of the same scene with different seeds
// Noise is the standard deviation of one render: the RMS of the difference of the two over the square root of two. Both report the mean
// of the reference (or of the first render) so the number reads against the image's own brightness.
import { readFileSync } from 'node:fs';

function readNpy(path) {
  const bytes = readFileSync(path);
  if (bytes[0] !== 0x93 || bytes.toString('latin1', 1, 6) !== 'NUMPY') throw new Error(`${path} is not an .npy file`);
  const headerLength = bytes.readUInt16LE(8);
  const header = bytes.toString('latin1', 10, 10 + headerLength);
  if (!header.includes("'<f4'")) throw new Error(`${path} must hold little-endian float32, its header is ${header.trim()}`);
  const shape = /'shape': \(([^)]*)\)/.exec(header)[1].split(',').map(part => Number(part.trim())).filter(Number.isFinite);
  const offset = 10 + headerLength;
  const values = new Float32Array(bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + bytes.length));
  return { shape, values };
}

export function compareImages(first, second) {
  if (first.values.length !== second.values.length) {
    throw new RangeError(`the images differ in size: ${first.shape.join('x')} and ${second.shape.join('x')}`);
  }
  const pixelCount = first.values.length / 4;
  let squaredError = 0;
  let firstSum = 0;
  let secondSum = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const a = first.values[pixel * 4 + channel];
      const b = second.values[pixel * 4 + channel];
      squaredError += (a - b) * (a - b);
      firstSum += a;
      secondSum += b;
    }
  }
  const sampleCount = pixelCount * 3;
  return { rmse: Math.sqrt(squaredError / sampleCount), firstMean: firstSum / sampleCount, secondMean: secondSum / sampleCount };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  const [command, firstPath, secondPath] = process.argv.slice(2);
  if (!['rmse', 'noise'].includes(command) || !firstPath || !secondPath) {
    throw new TypeError('Usage: node tools/grid-volume-compare.mjs rmse|noise <first.npy> <second.npy>');
  }
  const { rmse, firstMean, secondMean } = compareImages(readNpy(firstPath), readNpy(secondPath));
  const value = command === 'noise' ? rmse / Math.SQRT2 : rmse;
  console.log(JSON.stringify({ [command]: value, relative: value / secondMean, firstMean, secondMean }));
}
