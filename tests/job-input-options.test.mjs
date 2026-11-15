import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const jobInputSource = readFileSync(new URL('../job-input.mjs', import.meta.url), 'utf8');

// buildFlattenedJobNativeInput hands only a few options to the kernel parameters. `directLighting` and `filterGlossy` were
// dropped there, so a furnace run could not split light sampling from BSDF sampling or switch off the glossy filter, and the
// glossy filter's loss in glass mixes (codepawl/cook#29) looked like a kernel energy bug.
test('buildFlattenedJobNativeInput forwards directLighting and filterGlossy to the kernel parameters', () => {
  const functionStart = jobInputSource.indexOf('export function buildFlattenedJobNativeInput(');
  assert.ok(functionStart > 0, 'buildFlattenedJobNativeInput exists');
  const functionBody = jobInputSource.slice(functionStart);
  assert.match(functionBody, /directLighting: options\.directLighting/);
  assert.match(functionBody, /filterGlossy: options\.filterGlossy/);
});
