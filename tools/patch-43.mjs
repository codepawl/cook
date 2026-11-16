// Probe for #43: applies one named WGSL change to src/cycles/light_tree.wgsl so CI can rebuild and see which construct of the
// light tree makes WARP lose the device. Fails loudly when the text it replaces is not found.
import { readFileSync, writeFileSync } from 'node:fs';

const TREE = 'src/cycles/light_tree.wgsl';
const SAMPLE_HEAD = 'pick_probability_out: ptr<function, f32>) -> i32 {\n';
const PDF_HEAD = 'unified_index: u32) -> f32 {\n';
const LEFT_BODY = ') -> bool {\n  let left = ltr_child_importance';
const LEAF_BODY = 'pdf_factor: ptr<function, f32>,\n) -> i32 {\n';
const CHILD_HEAD = 'fn ltr_child_importance(child_index: u32, position: vec3<f32>, normal: vec3<f32>, has_transmission: bool) -> vec2<f32> {\n';
const EMITTER_HEAD = 'fn ltr_emitter_importance(emitter_slot: u32, position: vec3<f32>, normal: vec3<f32>, has_transmission: bool) -> vec2<f32> {\n';
const MAX_LEVEL = 'let max_level = min(kernel_params.light_tree_node_count, LTR_MAX_TREE_DEPTH + 2u);';

const sampleOff = [TREE, SAMPLE_HEAD, `${SAMPLE_HEAD}  *pick_probability_out = 1.0;\n  return -1;\n`];
const pdfOff = [TREE, PDF_HEAD, `${PDF_HEAD}  return 0.0;\n`];

const VARIANTS = {
  base: [],
  // Control: the tree is dead code, so this must behave like a tree with no emitters.
  'sample-off-pdf-off': [sampleOff, pdfOff],
  'sample-off': [sampleOff],
  'pdf-off': [pdfOff],
  // Loops: one level only, in both traversals.
  'one-level': [[TREE, MAX_LEVEL, 'let max_level = 1u;'], [TREE, MAX_LEVEL, 'let max_level = 1u;']],
  // Importance math: replace one layer at a time with a constant.
  'child-importance-const': [[TREE, CHILD_HEAD, `${CHILD_HEAD}  return vec2<f32>(1.0);\n`]],
  'emitter-importance-const': [[TREE, EMITTER_HEAD, `${EMITTER_HEAD}  return vec2<f32>(1.0);\n`]],
  'left-probability-const': [[TREE, LEFT_BODY, ') -> bool {\n  *left_probability_out = 0.5;\n  return true;\n  let left = ltr_child_importance']],
  // The leaf reservoir with its pointer arguments and bit mask.
  'leaf-first-slot': [[TREE, LEAF_BODY, `${LEAF_BODY}  return i32(light_tree_nodes[leaf_index].right_or_first_emitter);\n`]],
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
