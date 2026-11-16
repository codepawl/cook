import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// naga resets a ray_query declared inside a loop or block with OpConstantNull, which SPIR-V forbids for that type. NVIDIA
// accepts the module; Mesa lavapipe loses the device on the first dispatch (#37). Every ray_query must sit at function scope.
const SOURCE_DIRECTORY = fileURLToPath(new URL('../src', import.meta.url));
const RAY_QUERY_DECLARATION = /^\s*var\s+\w+\s*:\s*ray_query\s*;/;

function wgslFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return wgslFiles(path);
    return entry.name.endsWith('.wgsl') ? [path] : [];
  });
}

function withoutComment(line) {
  const commentStart = line.indexOf('//');
  return commentStart === -1 ? line : line.slice(0, commentStart);
}

/** Line numbers of ray_query declarations deeper than the function body's own braces. */
function nestedRayQueryLines(source) {
  const lines = [];
  let depth = 0;
  source.split('\n').forEach((line, index) => {
    const code = withoutComment(line);
    if (RAY_QUERY_DECLARATION.test(code) && depth > 1) lines.push(index + 1);
    for (const character of code) {
      if (character === '{') depth++;
      if (character === '}') depth--;
    }
  });
  return lines;
}

test('every ray_query is declared at function scope, not inside a loop or block', () => {
  const files = wgslFiles(SOURCE_DIRECTORY);
  assert.ok(files.length > 0, 'no WGSL files found under src');
  const nested = files.flatMap(path => nestedRayQueryLines(readFileSync(path, 'utf8')).map(line => `${path}:${line}`));
  assert.deepEqual(nested, [], `move these ray_query declarations to the top of their function: ${nested.join(', ')}`);
});

test('the scope check finds a ray_query inside a loop and passes one at function scope', () => {
  const insideLoop = 'fn trace() {\n  for (var step = 0u; step < 4u; step += 1u) {\n    var query: ray_query;\n  }\n}\n';
  const atFunctionScope = 'fn trace() {\n  var query: ray_query;\n  for (var step = 0u; step < 4u; step += 1u) {\n  }\n}\n';
  assert.deepEqual(nestedRayQueryLines(insideLoop), [3]);
  assert.deepEqual(nestedRayQueryLines(atFunctionScope), []);
});
