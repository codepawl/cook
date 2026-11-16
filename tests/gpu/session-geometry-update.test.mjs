// session.update with a new triangle table: the frame after it equals the traceNative render of the same input, and only the
// meshes whose triangles changed get a new BLAS. Needs the built addon and a ray-query adapter; skips with the reason otherwise.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createNativeSession, findNativeAddon, planNativeSessionUpdate, traceNative } from '../../index.mjs';
import { decodePackFile } from '../../pack-file.mjs';

const FIXTURE_PATH = fileURLToPath(new URL('../../fixtures/room.cookpack', import.meta.url));
const FRAME_OPTIONS = { kernel: 'cycles', width: 64, height: 48, samples: 4, denoise: 'none' };
const TRIANGLE_RECORD_BYTES = 224;
const INSTANCE_RECORD_BYTES = 160;
const EMISSIVE_RECORD_BYTES = 96;
const EMISSIVE_TRIANGLE_INDEX_BYTE = 44;
const TRIANGLE_COUNT_KERNEL_PARAM_BYTE = 88;
const BLAS_INDEX_BYTE = 96;
const TRIANGLE_OFFSET_BYTE = 100;
const OPAQUE_COUNT_BYTE = 104;
const TOTAL_COUNT_BYTE = 108;

function skipReason() {
  try {
    return findNativeAddon() === null ? 'the native addon is not built (run `node build.mjs`)' : false;
  } catch (environmentError) {
    return environmentError.message;
  }
}
const skip = skipReason();

const sessions = [];
after(() => sessions.forEach((session) => session.close()));

function fixtureInput() {
  return decodePackFile(readFileSync(FIXTURE_PATH));
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The first instance that places the mesh, as { offset, opaque, total }. */
function meshSlice(input, blasIndex) {
  const instances = viewOf(input.instances);
  for (let instance = 0; instance < input.instanceCount; instance++) {
    const base = instance * INSTANCE_RECORD_BYTES;
    if (instances.getUint32(base + BLAS_INDEX_BYTE, true) === blasIndex) {
      return {
        offset: instances.getUint32(base + TRIANGLE_OFFSET_BYTE, true),
        opaque: instances.getUint32(base + OPAQUE_COUNT_BYTE, true),
        total: instances.getUint32(base + TOTAL_COUNT_BYTE, true),
      };
    }
  }
  throw new Error(`the fixture has no mesh ${blasIndex}`);
}

/** `count` opaque triangle records for a mesh: the old ones, cut or repeated to `count`, each moved by `shift` along x. */
function movedTriangles(input, slice, count, shift) {
  const records = new Uint8Array(count * TRIANGLE_RECORD_BYTES);
  for (let index = 0; index < count; index++) {
    const source = slice.offset + (index % slice.total);
    const record = records.subarray(index * TRIANGLE_RECORD_BYTES, (index + 1) * TRIANGLE_RECORD_BYTES);
    record.set(input.triangles.subarray(source * TRIANGLE_RECORD_BYTES, (source + 1) * TRIANGLE_RECORD_BYTES));
    const corner = viewOf(record);
    corner.setFloat32(0, corner.getFloat32(0, true) + shift, true);
  }
  return records;
}

/**
 * The input with the triangles of one mesh replaced by `count` others. Meshes after it in the table move, so their
 * instances' offsets, the emissive triangles' owner indices and the triangle count of the kernel parameters follow.
 */
function withMeshReplaced(input, blasIndex, count, shift) {
  const slice = meshSlice(input, blasIndex);
  const delta = count - slice.total;
  const sliceEnd = slice.offset + slice.total;
  const before = input.triangles.subarray(0, slice.offset * TRIANGLE_RECORD_BYTES);
  const after = input.triangles.subarray(sliceEnd * TRIANGLE_RECORD_BYTES);
  const triangles = Uint8Array.from([...before, ...movedTriangles(input, slice, count, shift), ...after]);

  const instances = Uint8Array.from(input.instances);
  const instanceView = viewOf(instances);
  for (let instance = 0; instance < input.instanceCount; instance++) {
    const base = instance * INSTANCE_RECORD_BYTES;
    if (instanceView.getUint32(base + BLAS_INDEX_BYTE, true) === blasIndex) {
      instanceView.setUint32(base + OPAQUE_COUNT_BYTE, count, true);
      instanceView.setUint32(base + TOTAL_COUNT_BYTE, count, true);
    } else if (instanceView.getUint32(base + TRIANGLE_OFFSET_BYTE, true) >= sliceEnd) {
      instanceView.setUint32(base + TRIANGLE_OFFSET_BYTE, instanceView.getUint32(base + TRIANGLE_OFFSET_BYTE, true) + delta, true);
    }
  }
  const emissiveTriangles = Uint8Array.from(input.emissiveTriangles);
  const emissiveView = viewOf(emissiveTriangles);
  for (let entry = 0; entry < input.emissiveTriangleCount; entry++) {
    const field = entry * EMISSIVE_RECORD_BYTES + EMISSIVE_TRIANGLE_INDEX_BYTE;
    if (emissiveView.getUint32(field, true) >= sliceEnd) emissiveView.setUint32(field, emissiveView.getUint32(field, true) + delta, true);
  }
  const kernelParams = Uint8Array.from(input.kernelParams);
  viewOf(kernelParams).setUint32(TRIANGLE_COUNT_KERNEL_PARAM_BYTE, input.triangleCount + delta, true);
  return { ...input, triangles, instances, emissiveTriangles, kernelParams, triangleCount: input.triangleCount + delta };
}

function newSession(input) {
  const session = createNativeSession(input, FRAME_OPTIONS);
  sessions.push(session);
  return session;
}

function sameBytes(first, second) {
  return Buffer.from(first.buffer, first.byteOffset, first.byteLength).equals(Buffer.from(second.buffer, second.byteOffset, second.byteLength));
}

function assertFrameEqualsTraceNative(session, input, label) {
  const frame = session.render({});
  const reference = traceNative(input, FRAME_OPTIONS);
  assert.ok(sameBytes(frame.rgba, reference.rgba), `${label}: the session frame differs from the traceNative render`);
  assert.ok(sameBytes(frame.depth, reference.depth), `${label}: the depth differs`);
  return frame;
}

test('a session updated to moved and resized meshes renders what traceNative renders for the same input', { skip }, () => {
  const frameOne = fixtureInput();
  const session = newSession(frameOne);
  const firstFrame = assertFrameEqualsTraceNative(session, frameOne, 'first frame');
  assert.ok(!sameBytes(frameOne.triangles, withMeshReplaced(fixtureInput(), 0, 72, 0.05).triangles), 'the moved mesh really differs');

  // Mesh 0 comes first in the table, so shrinking it moves every other mesh: offsets, emissive owners and the count follow.
  const frameTwo = withMeshReplaced(frameOne, 0, 70, 0.05);
  const shrunk = session.update(frameTwo);
  assert.equal(shrunk.changedMeshes, 1);
  assert.equal(shrunk.accelerationRebuilt, true);
  assert.ok(shrunk.uploadedTables.includes('triangles'));
  assert.equal(typeof shrunk.updateSeconds, 'number');
  const afterShrink = assertFrameEqualsTraceNative(session, frameTwo, 'mesh with fewer triangles');
  assert.ok(!sameBytes(afterShrink.rgba, firstFrame.rgba), 'the new geometry shows in the picture');
  assert.equal(afterShrink.accelerationReused, true);
  assert.equal(afterShrink.pipelineReused, true);

  const frameThree = withMeshReplaced(frameTwo, 0, 90, -0.04);
  assert.equal(session.update(frameThree).changedMeshes, 1);
  assertFrameEqualsTraceNative(session, frameThree, 'mesh with more triangles');

  const frameFour = withMeshReplaced(frameThree, 0, 90, 0.03);
  assert.equal(session.update(frameFour).changedMeshes, 1, 'same count, other positions');
  assertFrameEqualsTraceNative(session, frameFour, 'same triangle count, moved');

  const frameFive = withMeshReplaced(frameFour, 1, 12, 0.02);
  assert.equal(session.update(frameFive).changedMeshes, 1, 'a mesh two instances share is rebuilt once');
  assertFrameEqualsTraceNative(session, frameFive, 'shared mesh moved');
});

test('a geometry update that moves only the other meshes keeps the BLAS of the unchanged ones', { skip }, () => {
  const frameOne = fixtureInput();
  const session = newSession(frameOne);
  session.render({});
  // Mesh 2 (the emissive quad) is the last in the table; changing mesh 0's count shifts it without changing its triangles.
  const shifted = withMeshReplaced(frameOne, 0, 66, 0);
  const sameFirstMeshPositions = withMeshReplaced(frameOne, 0, 72, 0);
  assert.ok(sameBytes(sameFirstMeshPositions.triangles, frameOne.triangles), 'an unmoved mesh of the same count is the same table');
  const report = session.update(shifted);
  assert.equal(report.changedMeshes, 1, 'only mesh 0 changed; meshes 1 and 2 only moved in the table');
  assertFrameEqualsTraceNative(session, shifted, 'meshes after the changed one');
});

test('a geometry update with no geometry change builds no BLAS and a changed instance table with the same triangles is still refused', { skip }, () => {
  const frameOne = fixtureInput();
  const session = newSession(frameOne);
  const idle = session.update(fixtureInput());
  assert.equal(idle.changedMeshes, 0);
  assert.equal(idle.accelerationRebuilt, false);

  const otherMesh = fixtureInput();
  viewOf(otherMesh.instances).setUint32(BLAS_INDEX_BYTE, 5, true);
  assert.throws(() => session.update(otherMesh), /changes `blasIndex`/);
  assertFrameEqualsTraceNative(session, frameOne, 'after a refused update');
});

test('a geometry update that adds a mesh or points past the table is refused and the session still renders the old scene', { skip }, () => {
  const frameOne = fixtureInput();
  const session = newSession(frameOne);
  const grown = withMeshReplaced(frameOne, 0, 80, 0.01);

  const newMesh = withMeshReplaced(frameOne, 0, 80, 0.01);
  viewOf(newMesh.instances).setUint32(BLAS_INDEX_BYTE, 7, true);
  assert.throws(() => session.update(newMesh), /keeps the set of meshes/);

  const pastTheEnd = withMeshReplaced(frameOne, 0, 80, 0.01);
  viewOf(pastTheEnd.instances).setUint32(INSTANCE_RECORD_BYTES * 3 + TOTAL_COUNT_BYTE, 500, true);
  assert.throws(() => session.update(pastTheEnd), /exceeds triangle_count/);

  const wrongCount = { ...grown, kernelParams: frameOne.kernelParams };
  assert.throws(() => session.update(wrongCount), /triangleCount/);

  assertFrameEqualsTraceNative(session, frameOne, 'after refused updates');
});

test('planNativeSessionUpdate sends the triangle table when it changed and refuses a mesh change without one', () => {
  const frameOne = fixtureInput();
  const resized = withMeshReplaced(frameOne, 0, 70, 0.05);
  const plan = planNativeSessionUpdate(frameOne, resized);
  assert.ok(plan.triangles !== undefined, 'a changed triangle table goes to the addon');
  assert.ok(plan.instances !== undefined, 'the instances that moved in the table go too');

  const otherMesh = fixtureInput();
  viewOf(otherMesh.instances).setUint32(BLAS_INDEX_BYTE, 5, true);
  assert.throws(() => planNativeSessionUpdate(frameOne, otherMesh), /changes `blasIndex`/);

  assert.deepEqual(Object.keys(planNativeSessionUpdate(frameOne, fixtureInput())), []);
});
