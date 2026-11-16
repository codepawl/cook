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

for (const [label, { name, ...options }] of Object.entries(scenes)) {
  const input = buildCausticInput(name, { width: WIDTH, height: HEIGHT, samples: SAMPLES, caustics: true, ...options });
  const rows = [`calls/pixel=${meanOfChannels(input, [999, 0, 0])[0].toFixed(4)}`];
  for (let first = 0; first < codes.length; first += 3) {
    const triple = [codes[first], codes[first + 1] ?? 0, codes[first + 2] ?? 0];
    const means = meanOfChannels(input, triple);
    triple.forEach((code, channel) => {
      if (code) rows.push(`${NAMES[code]}=${means[channel].toFixed(4)}`);
    });
  }
  console.log(`DEBUG-mnee ${label} ${rows.join(' ')}`);
}
