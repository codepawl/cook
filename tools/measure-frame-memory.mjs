// Measures how much RSS a render loop and an OIDN denoise loop gain per call, after gc(), for three ways of waiting between calls.
//   node --expose-gc tools/measure-frame-memory.mjs <oidn-library> <sync|micro|macro> [calls]
// Needs the built addon (COOK_ADDON_PATH or build/render-native.node), a Vulkan adapter with ray queries and the OIDN shared library.
// `sync` never yields, `micro` awaits a resolved promise, `macro` awaits setImmediate. Issue #34: only `macro` stays flat.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const [oidnLibrary, yieldMode, callCountText = '60'] = process.argv.slice(2);

const callCount = Number(callCountText);
const index = await import(pathToFileURL(join(packageDirectory, 'index.mjs')).href);
const { decodePackFile } = await import(pathToFileURL(join(packageDirectory, 'pack-file.mjs')).href);

const width = 640;
const height = 480;
const megabytes = (bytes) => bytes / 1048576;

async function yieldNow() {
  if (yieldMode === 'micro') await Promise.resolve();
  if (yieldMode === 'macro') await new Promise((resolve) => setImmediate(resolve));
}

async function measure(label, callOnce) {
  for (let warmup = 0; warmup < 3; warmup += 1) {
    callOnce();
    await yieldNow();
  }
  globalThis.gc();
  await new Promise((resolve) => setTimeout(resolve, 50));
  globalThis.gc();
  const startRss = megabytes(process.memoryUsage().rss);
  const samples = [];
  for (let call = 1; call <= callCount; call += 1) {
    callOnce();
    await yieldNow();
    if (call % 10 === 0) {
      globalThis.gc();
      samples.push(megabytes(process.memoryUsage().rss).toFixed(0));
    }
  }
  globalThis.gc();
  const endRss = megabytes(process.memoryUsage().rss);
  const perCall = (endRss - startRss) / callCount;
  console.log(`RESULT mode=${yieldMode} ${label} startMB=${startRss.toFixed(0)} endMB=${endRss.toFixed(0)} perCallMB=${perCall.toFixed(2)} every10=[${samples.join(',')}]`);
}

const input = decodePackFile(readFileSync(join(packageDirectory, 'fixtures', 'room.cookpack')));
const session = index.createNativeSession(input, { width, height, samples: 32 });
await measure('render', () => session.render({}));
const color = new Float32Array(width * height * 3).fill(0.5);
const denoiser = index.createNativeOidnDenoiser({ libraryPath: oidnLibrary, device: 'cpu' });
await measure('denoise', () => denoiser.denoise({ width, height, color }));
denoiser.close();
session.close();
