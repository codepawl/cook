// Compares the WARP and lavapipe probe runs of #43: RMSE per image and pass or fail per test name.
// Usage: node tools/compare-probe-43.mjs <warp-folder> <lavapipe-folder>; each folder holds the *.f32 images and test.xml (junit).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [warpFolder, lavapipeFolder] = process.argv.slice(2);

function readImage(path) {
  const bytes = readFileSync(path);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

console.log('image | pixels | byte-equal | rmse | max abs diff | mean warp | mean lavapipe');
const lavapipeImages = existsSync(lavapipeFolder) ? readdirSync(lavapipeFolder).filter((name) => name.endsWith('.f32')).sort() : [];
for (const fileName of lavapipeImages) {
  if (!existsSync(join(warpFolder, fileName))) {
    console.log(`${fileName} | missing from the WARP run`);
    continue;
  }
  const warp = readImage(join(warpFolder, fileName));
  const lavapipe = readImage(join(lavapipeFolder, fileName));
  let squared = 0;
  let largest = 0;
  let warpSum = 0;
  let lavapipeSum = 0;
  for (let index = 0; index < lavapipe.length; index++) {
    const difference = Math.abs(warp[index] - lavapipe[index]);
    squared += difference * difference;
    largest = Math.max(largest, difference);
    warpSum += warp[index];
    lavapipeSum += lavapipe[index];
  }
  const equal = Buffer.from(warp.buffer, warp.byteOffset, warp.byteLength).equals(Buffer.from(lavapipe.buffer, lavapipe.byteOffset, lavapipe.byteLength));
  const channelCount = lavapipe.length;
  console.log(`${fileName} | ${channelCount / 4} | ${equal} | ${Math.sqrt(squared / channelCount).toExponential(3)} | ${largest.toExponential(3)} | ${(warpSum / channelCount).toPrecision(5)} | ${(lavapipeSum / channelCount).toPrecision(5)}`);
}

function readTestResults(path) {
  const results = new Map();
  if (!existsSync(path)) return results;
  const xml = readFileSync(path, 'utf8');
  for (const match of xml.matchAll(/<testcase\s+([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = /name="([^"]*)"/.exec(match[1])?.[1] ?? '?';
    const body = match[3] ?? '';
    results.set(name, body.includes('<failure') ? 'FAIL' : body.includes('<skipped') ? 'skip' : 'pass');
  }
  return results;
}

const warpTests = readTestResults(join(warpFolder, 'test.xml'));
const lavapipeTests = readTestResults(join(lavapipeFolder, 'test.xml'));
console.log('\ntest | warp | lavapipe');
for (const name of [...new Set([...warpTests.keys(), ...lavapipeTests.keys()])].sort()) {
  console.log(`${name} | ${warpTests.get(name) ?? 'absent'} | ${lavapipeTests.get(name) ?? 'absent'}`);
}
function tally(map) {
  const counts = {};
  for (const value of map.values()) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
console.log(`\ntotals warp ${JSON.stringify(tally(warpTests))} lavapipe ${JSON.stringify(tally(lavapipeTests))}`);
