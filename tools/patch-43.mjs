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
const PDF_TARGET = 'let target_emitter = light_tree_emitters[target_slot];\n';
const PROFILE_HEAD = 'fn ltr_emitter_profile(emitter_slot: u32, position: vec3<f32>, normal: vec3<f32>, has_transmission: bool) -> LtrProfile {\n';
const NODE_PROFILE_HEAD = 'fn ltr_node_profile(node_index: u32, position: vec3<f32>, normal: vec3<f32>, has_transmission: bool) -> LtrProfile {\n';
const PROFILE_IMPORTANCE_HEAD = 'fn ltr_profile_importance(profile: LtrProfile, normal: vec3<f32>, has_transmission: bool) -> vec2<f32> {\n';
const MAX_LEVEL = 'let max_level = min(kernel_params.light_tree_node_count, LTR_MAX_TREE_DEPTH + 2u);';

const sampleOff = [TREE, SAMPLE_HEAD, `${SAMPLE_HEAD}  *pick_probability_out = 1.0;\n  return -1;\n`];
const pdfOff = [TREE, PDF_HEAD, `${PDF_HEAD}  return 0.0;\n`];

const PDF_LEAF = '    if (node.left_child < 0) {\n      let emitter_count = min(node.emitter_count_and_kind & LTR_NODE_EMITTER_COUNT_MASK, LTR_MAX_LEAF_EMITTERS);\n';
const PDF_TRAIL = '    let trail_word = select(target_emitter.bit_trail_low, target_emitter.bit_trail_high, level >= 32u);\n';
const PDF_GOES_RIGHT = '    let goes_right = ((trail_word >> (level & 31u)) & 1u) != 0u;';
const PDF_DIVIDE = '      var minimum_term = 1.0 / f32(emitters_with_importance);';
const ALL_CONST = [
  sampleOff,
  [TREE, CHILD_HEAD, `${CHILD_HEAD}  return vec2<f32>(1.0);\n`],
  [TREE, EMITTER_HEAD, `${EMITTER_HEAD}  return vec2<f32>(1.0);\n`],
  [TREE, LEFT_BODY, ') -> bool {\n  *left_probability_out = 0.5;\n  return true;\n  let left = ltr_child_importance'],
];

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
  // Round 2: sample-off kept the pdf alive and still lost the device, so cut inside ltr_pdf.
  'so-pdf-after-emitter-read': [sampleOff, [TREE, PDF_TARGET, `${PDF_TARGET}  return f32(target_emitter.bit_trail_low & 1u);\n`]],
  'so-pdf-after-light-to-tree': [sampleOff, [TREE, PDF_TARGET, `${PDF_TARGET}  return f32(target_slot & 1u);\n`]],
  'so-pdf-node-read': [sampleOff, [TREE, PDF_TARGET, `${PDF_TARGET}  return f32(light_tree_nodes[target_slot].left_child);\n`]],
  'so-all-importance-const': [
    sampleOff,
    [TREE, CHILD_HEAD, `${CHILD_HEAD}  return vec2<f32>(1.0);\n`],
    [TREE, EMITTER_HEAD, `${EMITTER_HEAD}  return vec2<f32>(1.0);\n`],
    [TREE, LEFT_BODY, ') -> bool {\n  *left_probability_out = 0.5;\n  return true;\n  let left = ltr_child_importance'],
  ],
  'so-profiles-invisible': [
    sampleOff,
    [TREE, PROFILE_HEAD, `${PROFILE_HEAD}  return ltr_invisible_profile();\n`],
    [TREE, NODE_PROFILE_HEAD, `${NODE_PROFILE_HEAD}  return ltr_invisible_profile();\n`],
  ],
  'so-profile-importance-const': [sampleOff, [TREE, PROFILE_IMPORTANCE_HEAD, `${PROFILE_IMPORTANCE_HEAD}  return vec2<f32>(1.0);\n`]],
  // Round 3: only the pdf walk runs and it must go deep. Cut inside it, with and without constant importance.
  'pdf-return-at-leaf': [sampleOff, [TREE, PDF_LEAF, `${PDF_LEAF}      return pdf;\n`]],
  'pdf-return-before-trail': [sampleOff, [TREE, PDF_TRAIL, `    return left_probability;\n${PDF_TRAIL}`]],
  'pdf-no-trail': [sampleOff, [TREE, PDF_GOES_RIGHT, '    let goes_right = false;']],
  'pdf-no-divide': [sampleOff, [TREE, PDF_DIVIDE, '      var minimum_term = 1.0;']],
  'cp-pdf-return-at-leaf': [...ALL_CONST, [TREE, PDF_LEAF, `${PDF_LEAF}      return pdf;\n`]],
  'cp-pdf-no-trail': [...ALL_CONST, [TREE, PDF_GOES_RIGHT, '    let goes_right = false;']],
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
