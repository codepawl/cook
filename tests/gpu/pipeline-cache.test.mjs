// The on-disk pipeline cache across processes: a scene without emitters traces, the first process stores its kernel, a second
// process loads it, a damaged file is replaced, and COOK_PIPELINE_CACHE=off writes nothing. Needs the built addon and a
// ray-query adapter; skips with the reason otherwise.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findNativeAddon } from '../../index.mjs';

const CHILD_SCRIPT = fileURLToPath(new URL('../support/trace-dark-scene.mjs', import.meta.url));
const FILE_MAGIC = 'COOKPLC1';

function skipReason() {
  try {
    return findNativeAddon() === null ? 'the native addon is not built (run `node build.mjs`)' : false;
  } catch (environmentError) {
    return environmentError.message;
  }
}
const skip = skipReason();

const directories = [];
after(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function freshCacheDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'cook-pipeline-cache-'));
  directories.push(directory);
  return directory;
}

function traceInNewProcess(environment) {
  const child = spawnSync(process.execPath, [CHILD_SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    timeout: 120_000,
  });
  assert.equal(child.status, 0, `the trace process failed: ${child.stderr}`);
  return JSON.parse(child.stdout.trim().split('\n').pop());
}

function cacheFiles(directory) {
  return readdirSync(directory).filter((name) => name.endsWith('.bin'));
}

test('a scene without emitters traces, the first process stores its kernel and a second process loads it', { skip }, () => {
  const directory = freshCacheDirectory();
  const first = traceInNewProcess({ COOK_PIPELINE_CACHE_DIR: directory });
  assert.ok(first.pixelCount === 16 * 9 && first.pixelSum > 0, 'a scene with no emitter keeps tracing');
  assert.ok(first.compileSeconds >= 0 && first.tracedSeconds >= 0, 'compile time is reported apart from trace time');
  if (first.pipelineCache === 'unsupported') return;
  assert.equal(first.pipelineCache, 'cold');
  const files = cacheFiles(directory);
  assert.equal(files.length, 1, 'one cache file per adapter and Cook version');
  assert.equal(readFileSync(join(directory, files[0])).subarray(0, 8).toString('latin1'), FILE_MAGIC);
  assert.match(files[0], /_cook\d+\.\d+\.\d+/, 'the file name carries the Cook package version');

  const second = traceInNewProcess({ COOK_PIPELINE_CACHE_DIR: directory });
  assert.equal(second.pipelineCache, 'warm');
  assert.equal(second.pixelSum, first.pixelSum, 'a cached kernel draws the same pixels');
});

test('a damaged cache file is replaced and the trace still runs', { skip }, () => {
  const directory = freshCacheDirectory();
  const stored = traceInNewProcess({ COOK_PIPELINE_CACHE_DIR: directory });
  if (stored.pipelineCache === 'unsupported') return;
  const [file] = cacheFiles(directory);
  const path = join(directory, file);
  const bytes = readFileSync(path);
  bytes[bytes.length - 1] ^= 0xff;
  writeFileSync(path, bytes);
  const recovered = traceInNewProcess({ COOK_PIPELINE_CACHE_DIR: directory });
  assert.equal(recovered.pipelineCache, 'cold', 'a file that fails its checksum is not handed to the driver');
  assert.equal(recovered.pixelSum, stored.pixelSum);
  assert.equal(traceInNewProcess({ COOK_PIPELINE_CACHE_DIR: directory }).pipelineCache, 'warm', 'the replaced file loads');
});

test('COOK_PIPELINE_CACHE=off reports off and writes no file', { skip }, () => {
  const directory = freshCacheDirectory();
  const traced = traceInNewProcess({ COOK_PIPELINE_CACHE_DIR: directory, COOK_PIPELINE_CACHE: 'off' });
  assert.ok(traced.pixelSum > 0);
  assert.ok(traced.pipelineCache === 'off' || traced.pipelineCache === 'unsupported');
  assert.deepEqual(cacheFiles(directory), []);
});
