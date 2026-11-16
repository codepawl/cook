// [DEBUG-mnee] temporary: shows why the caustic solver rejects samples. Run through the Caustics workflow.
import { traceNative } from '../index.mjs';
import { buildCausticInput } from './make-caustic-scene.mjs';

const WIDTH = 80;
const HEIGHT = 45;
const SAMPLES = 16;
const NAMES = {
  1: 'a-invalid', 2: 'b-invalid', 3: 'jacobian-failed-in-loop', 4: 'solve-singular', 5: 'no-accepted-step', 6: 'not-converged',
  7: 'final-orientation', 8: 'final-jacobian', 9: 'final-solve', 10: 'bad-surface-per-light-area', 11: 'segment-receiver-a', 12: 'segment-a-b',
  13: 'leg-to-light', 14: 'bsdf-zero', 100: 'SOLVED',
};
const codes = Object.keys(NAMES).map(Number);
const scenes = {
  'ball-raised-low': { name: 'ball', ballHeight: 1.0, lowView: true },
  'ball-raised-high': { name: 'ball', ballHeight: 1.0 },
  prism: { name: 'prism' },
};

function meanOfChannels(input, triple) {
  process.env.COOK_MNEE_DEBUG = triple.join(',');
  const result = traceNative(input, { kernel: 'cycles', width: WIDTH, height: HEIGHT, samples: SAMPLES, denoise: 'none' });
  delete process.env.COOK_MNEE_DEBUG;
  const sums = [0, 0, 0];
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    for (let channel = 0; channel < 3; channel++) sums[channel] += result.rgba[pixel * 4 + channel];
  }
  return sums.map((sum) => sum / (WIDTH * HEIGHT));
}

const requested = (process.argv[2] ?? '999,100,6;3,5,7').split(';').map((text) => text.split(',').map(Number));
const labelsToRun = (process.argv[3] ?? 'ball-raised-low').split(',');
for (const label of labelsToRun) {
  const { name, ...options } = scenes[label];
  const input = buildCausticInput(name, { width: WIDTH, height: HEIGHT, samples: SAMPLES, caustics: true, ...options });
  const rows = [];
  for (const triple of requested) {
    const means = meanOfChannels(input, triple);
    triple.forEach((code, channel) => {
      if (code) rows.push(`${NAMES[code] ?? 'calls'}=${means[channel].toFixed(4)}`);
    });
    console.log(`DEBUG-mnee ${label} ${rows.join(' ')}`);
  }
}

// Byte identity: the same plain scene twice, and with the caster bit.
if (process.argv[4] === 'identity') {
  const flagWord = 29;
  const plain = buildCausticInput('ball', { width: 80, height: 45, samples: 48 });
  const withBit = buildCausticInput('ball', { width: 80, height: 45, samples: 48 });
  const words = new Uint32Array(withBit.instances.buffer, withBit.instances.byteOffset, withBit.instances.byteLength / 4);
  words[(1 * withBit.instances.byteLength) / withBit.instanceCount / 4 + flagWord] |= 128;
  const run = (input) => traceNative(input, { kernel: 'cycles', width: 80, height: 45, samples: 48, denoise: 'none' }).rgba;
  const differences = (first, second) => {
    let count = 0;
    let largest = 0;
    for (let index = 0; index < first.length; index++) {
      if (first[index] !== second[index]) {
        count++;
        largest = Math.max(largest, Math.abs(first[index] - second[index]));
      }
    }
    return `${count} of ${first.length} floats differ, largest ${largest}`;
  };
  const first = run(plain);
  const second = run(plain);
  const third = run(withBit);
  console.log(`DEBUG-identity plain vs plain: ${differences(first, second)}`);
  console.log(`DEBUG-identity plain vs caster bit: ${differences(first, third)}`);
}
