import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COOK_PACK_REVISION_CODE, describeEngine, requireReadablePackRevision } from '../engine.mjs';
import { PACK_REVISION, createNativeSession, traceNative, traceNativeTexels } from '../index.mjs';
import { decodePackFile, encodePackFile } from '../pack-file.mjs';
import { buildRoomInput } from '../tools/make-fixture-pack.mjs';

const TRACE_OPTIONS = { kernel: 'cycles', width: 16, height: 12, samples: 1 };

function expectRevisionError(callback, pattern) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, COOK_PACK_REVISION_CODE);
    assert.match(error.message, pattern);
    return true;
  });
}

test('the v2 packer stamps the pack revision and a pack file carries it back', () => {
  const input = buildRoomInput();
  assert.equal(input.packRevision, PACK_REVISION);
  assert.equal(decodePackFile(encodePackFile(input)).packRevision, PACK_REVISION);
});

test('an input of a newer or older revision is refused, with both revisions in the message', () => {
  const [oldest, newest] = describeEngine().packFormat.readsRevisions;
  const newer = { ...buildRoomInput(), packRevision: newest + 1 };
  expectRevisionError(
    () => requireReadablePackRevision(newer, 'traceNative'),
    new RegExp(`pack revision ${newest + 1}, but this Cook .* reads revisions ${oldest} to ${newest}\. Update Cook`),
  );
  const older = { ...buildRoomInput(), packRevision: oldest - 1 };
  if (oldest - 1 >= 1) {
    expectRevisionError(() => requireReadablePackRevision(older, 'traceNative'), /Pack the scene again/);
  }
});

test('traceNative, traceNativeTexels and createNativeSession check the revision before they look for the addon', () => {
  const newer = { ...buildRoomInput(), packRevision: PACK_REVISION + 1 };
  expectRevisionError(() => traceNative(newer, TRACE_OPTIONS), /^traceNative: the input has pack revision/);
  expectRevisionError(() => traceNativeTexels(newer, {}, { samples: 1 }), /^traceNativeTexels: the input has pack revision/);
  expectRevisionError(() => createNativeSession(newer, { width: 16, height: 12, samples: 1 }), /^createNativeSession: the input has pack revision/);
});

test('an input without a stamp counts as revision 1, so callers that never stamped keep working', () => {
  const { packRevision, ...unstamped } = buildRoomInput();
  assert.equal(packRevision, PACK_REVISION);
  assert.doesNotThrow(() => requireReadablePackRevision(unstamped, 'traceNative'));
  assert.doesNotThrow(() => requireReadablePackRevision(null, 'traceNative'));
});

test('a stamp that is not a whole number of at least 1 is a TypeError', () => {
  for (const stamp of [0, -1, 1.5, '1', null]) {
    assert.throws(() => requireReadablePackRevision({ packRevision: stamp }, 'traceNative'), /packRevision must be a whole number of at least 1/, String(stamp));
  }
});
