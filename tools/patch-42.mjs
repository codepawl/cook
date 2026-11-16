// Probe for #42: applies one named WGSL change to src/cycles so CI can rebuild and see which code path lavapipe's AVX-512
// code generation gets wrong. Fails loudly when the text it replaces is not found, so a stale patch never passes silently.
import { readFileSync, writeFileSync } from 'node:fs';

const LIGHTS = 'src/cycles/lights.wgsl';

const BRANCH_FREE_SEARCH = (buffer) => `{
  var low = 0u;
  var high = count - 1u;
  for (var step = 0u; step < 24u; step += 1u) {
    let mid = (low + high) >> 1u;
    let upper = ${buffer}[min(mid, count - 1u)].cdf_upper;
    let searching = low < high;
    let go_right = searching && upper <= pick_u;
    let go_left = searching && !(upper <= pick_u);
    low = select(low, mid + 1u, go_right);
    high = select(high, mid, go_left);
  }
  return low;
}`;

function searchBody(buffer) {
  return `{
  var low = 0u;
  var high = count - 1u;
  for (var step = 0u; step < 24u; step += 1u) {
    if (low >= high) {
      break;
    }
    let mid = (low + high) >> 1u;
    if (${buffer}[mid].cdf_upper <= pick_u) {
      low = mid + 1u;
    } else {
      high = mid;
    }
  }
  return low;
}`;
}

const VARIANTS = {
  base: [],
  'skip-emissive-weight': [
    [LIGHTS, ') -> f32 {\n  if (emissive_index == INVALID_INDEX', ') -> f32 {\n  return 1.0;\n  if (emissive_index == INVALID_INDEX'],
  ],
  'skip-analytic-segment': [
    [LIGHTS, ') -> vec3<f32> {\n  let count = kernel_params.light_count;\n  if (count == 0u) {\n    return vec3<f32>(0.0);\n  }\n  var total = vec3<f32>(0.0);', ') -> vec3<f32> {\n  return vec3<f32>(0.0);\n  let count = kernel_params.light_count;\n  if (count == 0u) {\n    return vec3<f32>(0.0);\n  }\n  var total = vec3<f32>(0.0);'],
  ],
  'clamp-emissive-weight': [
    [LIGHTS, '  if (emissive_index == INVALID_INDEX || emissive_index >= kernel_params.emissive_triangle_count) {\n    return 1.0;\n  }\n  let emitter = emissive_triangles[emissive_index];', '  let emitter = emissive_triangles[min(emissive_index, max(kernel_params.emissive_triangle_count, 1u) - 1u)];\n  if (emissive_index == INVALID_INDEX || emissive_index >= kernel_params.emissive_triangle_count) {\n    return 1.0;\n  }'],
  ],
  'branch-free-search': [
    [LIGHTS, searchBody('lights'), BRANCH_FREE_SEARCH('lights')],
    [LIGHTS, searchBody('emissive_triangles'), BRANCH_FREE_SEARCH('emissive_triangles')],
  ],
};

const name = process.argv[2];
const edits = VARIANTS[name];
if (edits === undefined) {
  throw new Error(`Unknown variant "${name}". Pass one of: ${Object.keys(VARIANTS).join(', ')}.`);
}
for (const [path, before, after] of edits) {
  const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  if (!source.includes(before)) {
    throw new Error(`Variant ${name}: text to replace not found in ${path}: ${before.slice(0, 80)}`);
  }
  writeFileSync(path, source.replace(before, after));
}
console.log(`patched ${name}: ${edits.length} edit(s)`);
