// Times the native post stage on a resolved film: `node tools/measure-post-timing.mjs [width] [height] [runs]`.
// Prints the median of `postSeconds` (upload, dispatches and the 8-bit readback, excluding the pipeline compile) and of the
// whole `resolve` call, which also reads the film back and resolves it on the CPU. Run it through gpu-lock on a shared machine.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createNativeSession } from '../index.mjs';
import { decodePackFile } from '../pack-file.mjs';

const width = Number(process.argv[2] ?? 1920);
const height = Number(process.argv[3] ?? 1080);
const runs = Number(process.argv[4] ?? 10);
const FULL_LOOK = {
  viewTransform: 'agx',
  exposure: 1.5,
  whiteBalance: 0.1,
  bloom: { strength: 0.3, radius: 2, threshold: 0.5 },
  grain: { amount: 0.02, seed: 3 },
  vignette: { strength: 0.2 },
};

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

const fixturePath = fileURLToPath(new URL('../fixtures/room.cookpack', import.meta.url));
const session = createNativeSession(decodePackFile(readFileSync(fixturePath)), { kernel: 'cycles', width, height, samples: 1, denoise: 'none' });
try {
  session.render({});
  const postMilliseconds = [];
  const resolveMilliseconds = [];
  const plainMilliseconds = [];
  for (let run = 0; run < runs + 1; run++) {
    const plainStarted = performance.now();
    session.resolve({});
    const plainElapsed = performance.now() - plainStarted;
    const started = performance.now();
    const result = session.resolve({ post: FULL_LOOK });
    const elapsed = performance.now() - started;
    if (run === 0) continue; // the first call warms the device
    postMilliseconds.push(result.postSeconds * 1000);
    resolveMilliseconds.push(elapsed);
    plainMilliseconds.push(plainElapsed);
  }
  console.log(`${width}x${height}, ${runs} runs`);
  console.log(`median post + readback (postSeconds): ${median(postMilliseconds).toFixed(1)} ms`);
  console.log(`median resolve with post: ${median(resolveMilliseconds).toFixed(1)} ms, without post: ${median(plainMilliseconds).toFixed(1)} ms`);
} finally {
  session.close();
}
