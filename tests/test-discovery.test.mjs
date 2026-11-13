import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Node's default `node --test` discovery runs every file named *.test.*, *-test.*, *_test.* or test-*.* (also `test.*`).
// A tool matching it would run as a test file; tools/run-cargo-tests.mjs once did and ran cargo inside the JavaScript job.
const DEFAULT_TEST_FILE_PATTERN = /(^test-.*|^test|[._-]test)\.[cm]?js$/;

test('no script in tools/ is picked up by the default `node --test` discovery', () => {
  const toolsDirectory = fileURLToPath(new URL('../tools/', import.meta.url));
  const matched = readdirSync(toolsDirectory).filter((name) => DEFAULT_TEST_FILE_PATTERN.test(name));
  assert.deepEqual(matched, []);
});
