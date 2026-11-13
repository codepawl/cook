import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PACK_REVISION, prepareCyclesInput } from '../index.mjs';
import {
  PACK_FILE_ERROR_CODE,
  PackFileError,
  decodePackFile,
  describePackFile,
  encodePackFile,
} from '../pack-file.mjs';
import { buildRoomInput, buildRoomPackBytes, ROOM_HEIGHT, ROOM_SAMPLES, ROOM_WIDTH } from '../tools/make-fixture-pack.mjs';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/room.cookpack', import.meta.url));
const ENTRY_START = 16;
const ENTRY_BYTES = 56;
const TABLE_NAMES = [
  'kernelParams', 'instances', 'triangles', 'materials', 'emissiveTriangles', 'lights', 'lightTreeNodes',
  'lightTreeEmitters', 'lightToTree', 'textureDescriptors', 'textureTexels', 'environmentTexels',
];
const COUNT_NAMES = [
  'instanceCount', 'triangleCount', 'materialCount', 'emissiveTriangleCount', 'lightCount', 'lightTreeNodeCount',
  'lightTreeEmitterCount', 'textureCount',
];

function bytesOf(table) {
  return Buffer.from(table.buffer, table.byteOffset, table.byteLength);
}

function expectPackFileError(callback, messagePattern) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof PackFileError, `expected a PackFileError, got ${error}`);
    assert.equal(error.code, PACK_FILE_ERROR_CODE);
    assert.match(error.message, messagePattern);
    return true;
  });
}

// Overwrites one field of a directory entry (offset 40, length 48 or element type 32) of a copy of the file.
function withEntryField(bytes, tableName, fieldOffset, value, width = 8) {
  const copy = Uint8Array.from(bytes);
  const view = new DataView(copy.buffer);
  const entryIndex = TABLE_NAMES.filter((name) => describePackFile(bytes).directory.some((entry) => entry.name === name)).indexOf(tableName);
  const position = ENTRY_START + entryIndex * ENTRY_BYTES + fieldOffset;
  if (width === 8) view.setBigUint64(position, BigInt(value), true);
  else view.setUint32(position, value, true);
  return copy;
}

// Removes one directory entry and moves the metadata block up over its place; the tables keep their offsets.
function withoutDirectoryEntry(bytes, tableName) {
  const names = describePackFile(bytes).directory.map((entry) => entry.name);
  const removedIndex = names.indexOf(tableName);
  const directoryEnd = ENTRY_START + names.length * ENTRY_BYTES;
  const metadataLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(directoryEnd, true);
  const result = Uint8Array.from(bytes);
  const entriesAfter = bytes.subarray(ENTRY_START + (removedIndex + 1) * ENTRY_BYTES, directoryEnd);
  result.set(entriesAfter, ENTRY_START + removedIndex * ENTRY_BYTES);
  result.set(bytes.subarray(directoryEnd, directoryEnd + 8 + metadataLength), directoryEnd - ENTRY_BYTES);
  new DataView(result.buffer).setUint32(12, names.length - 1, true);
  return result;
}

test('the room input survives a round trip: every table byte for byte, every count, no extra keys', () => {
  const input = buildRoomInput();
  const decoded = decodePackFile(encodePackFile(input));
  assert.deepEqual(Object.keys(decoded).sort(), Object.keys(input).sort());
  assert.equal(decoded.schemaVersion, 2);
  for (const name of TABLE_NAMES) {
    assert.equal(decoded[name].constructor, input[name].constructor, `${name} keeps its array type`);
    assert.ok(bytesOf(decoded[name]).equals(bytesOf(input[name])), `${name} is byte-identical`);
  }
  for (const name of COUNT_NAMES) {
    assert.equal(decoded[name], input[name], name);
  }
});

test('the same input always encodes to the same bytes', () => {
  assert.ok(Buffer.from(encodePackFile(buildRoomInput())).equals(Buffer.from(encodePackFile(buildRoomInput()))));
});

test('tables that were absent stay absent and tables that were empty stay empty', () => {
  const withoutEmitters = buildRoomInput();
  delete withoutEmitters.lightTreeEmitters;
  delete withoutEmitters.lightToTree;
  delete withoutEmitters.lightTreeEmitterCount;
  const bytes = encodePackFile(withoutEmitters);
  const decoded = decodePackFile(bytes);
  assert.equal('lightTreeEmitters' in decoded, false);
  assert.equal('lightToTree' in decoded, false);
  assert.equal('lightTreeEmitterCount' in decoded, false);
  assert.equal(describePackFile(bytes).counts.lightTreeEmitterCount, null);

  const withEmptyEnvironment = buildRoomInput();
  withEmptyEnvironment.environmentTexels = new Float32Array(0);
  const decodedEmpty = decodePackFile(encodePackFile(withEmptyEnvironment));
  assert.equal(decodedEmpty.environmentTexels.length, 0);
  assert.ok(decodedEmpty.environmentTexels instanceof Float32Array);
});

test('a file read at an odd byte offset decodes to aligned copies with the same bytes', () => {
  const input = buildRoomInput();
  const bytes = encodePackFile(input);
  const shifted = new Uint8Array(bytes.length + 3);
  shifted.set(bytes, 3);
  const decoded = decodePackFile(shifted.subarray(3));
  for (const name of TABLE_NAMES) {
    assert.ok(bytesOf(decoded[name]).equals(bytesOf(input[name])), `${name} is byte-identical`);
  }
});

test('describePackFile reads the directory, the counts, the revision and the size from kernelParams', () => {
  const description = describePackFile(encodePackFile(buildRoomInput(), { generator: 'test' }));
  assert.equal(description.containerVersion, 1);
  assert.equal(description.packRevision, PACK_REVISION);
  assert.deepEqual(description.image, { width: ROOM_WIDTH, height: ROOM_HEIGHT, samples: ROOM_SAMPLES });
  assert.deepEqual(description.extra, { generator: 'test' });
  assert.deepEqual(description.directory.map((entry) => entry.name), TABLE_NAMES);
  for (const entry of description.directory) {
    assert.equal(entry.byteOffset % 8, 0, `${entry.name} is 8-byte aligned`);
  }
});

test('the committed fixture has the current pack revision and equals a fresh build byte for byte', () => {
  const committed = readFileSync(FIXTURE_PATH);
  assert.equal(describePackFile(committed).packRevision, PACK_REVISION);
  assert.ok(committed.length < 200 * 1024, `the fixture is ${committed.length} bytes`);
  assert.ok(committed.equals(Buffer.from(buildRoomPackBytes())), 'run node tools/make-fixture-pack.mjs and commit the result');
});

test('the decoded fixture is a valid input for the cycles kernel', () => {
  const decoded = decodePackFile(readFileSync(FIXTURE_PATH));
  const prepared = prepareCyclesInput(decoded, { width: ROOM_WIDTH, height: ROOM_HEIGHT, samples: 1 });
  assert.equal(prepared.kernelParams.byteLength, 320);
  assert.equal(prepared.triangleCount, 86);
});

test('decoding refuses a file that is not a pack file, with a message that says why', () => {
  const bytes = encodePackFile(buildRoomInput());
  assert.throws(() => decodePackFile('text'), /Uint8Array/);
  expectPackFileError(() => decodePackFile(bytes.subarray(0, 10)), /truncated.*16-byte header/);
  expectPackFileError(() => decodePackFile(bytes.subarray(0, 100)), /truncated/);
  const wrongMagic = Uint8Array.from(bytes);
  wrongMagic.set(new TextEncoder().encode('NOTAPACK'), 0);
  expectPackFileError(() => decodePackFile(wrongMagic), /not a Cook pack file.*COOKPACK/);
  const futureVersion = Uint8Array.from(bytes);
  new DataView(futureVersion.buffer).setUint32(8, 99, true);
  expectPackFileError(() => decodePackFile(futureVersion), /container version 99.*reads container version 1/);
  const manyTables = Uint8Array.from(bytes);
  new DataView(manyTables.buffer).setUint32(12, 5000, true);
  expectPackFileError(() => decodePackFile(manyTables), /5000 tables/);
});

test('decoding refuses a cut file and a table that lies outside it', () => {
  const bytes = encodePackFile(buildRoomInput());
  expectPackFileError(() => decodePackFile(bytes.subarray(0, bytes.length - 40)), /table "[A-Za-z]+" lies outside the file/);
  expectPackFileError(
    () => decodePackFile(withEntryField(bytes, 'triangles', 40, bytes.length + 8)),
    /table "triangles" lies outside the file/,
  );
  expectPackFileError(() => decodePackFile(withEntryField(bytes, 'triangles', 40, 2 ** 62)), /far larger than any file/);
});

test('decoding refuses an unknown element type, a wrong one, an unaligned or overlapping table and a bad length', () => {
  const bytes = encodePackFile(buildRoomInput());
  expectPackFileError(() => decodePackFile(withEntryField(bytes, 'triangles', 32, 9, 4)), /unknown element type code 9/);
  expectPackFileError(() => decodePackFile(withEntryField(bytes, 'triangles', 32, 3, 4)), /stored as f32 but a u8 table is required/);
  expectPackFileError(() => decodePackFile(withEntryField(bytes, 'instances', 40, 1285)), /not 8-byte aligned/);
  expectPackFileError(() => decodePackFile(withEntryField(bytes, 'instances', 40, 8)), /inside the header, directory or metadata/);
  expectPackFileError(() => decodePackFile(withEntryField(bytes, 'lightToTree', 48, 6)), /not a multiple of its 4-byte u32 elements/);
});

test('decoding refuses tables that overlap or alias each other', () => {
  const bytes = encodePackFile(buildRoomInput());
  const directory = describePackFile(bytes).directory;
  const instances = directory.find((entry) => entry.name === 'instances');
  const triangles = directory.find((entry) => entry.name === 'triangles');
  const aliased = withEntryField(bytes, 'triangles', 40, instances.byteOffset);
  expectPackFileError(() => decodePackFile(aliased), /tables "instances".*and "triangles".*overlap/);
  expectPackFileError(() => describePackFile(aliased), /overlap/);
  const startsInside = withEntryField(bytes, 'triangles', 40, instances.byteOffset + 8);
  expectPackFileError(() => decodePackFile(startsInside), /overlap/);
  assert.ok(triangles.byteLength > 0);
});

test('an empty table may share an offset with its neighbour', () => {
  const input = buildRoomInput();
  input.environmentTexels = new Float32Array(0);
  const bytes = encodePackFile(input);
  const environment = describePackFile(bytes).directory.find((entry) => entry.name === 'environmentTexels');
  const sharing = withEntryField(bytes, 'environmentTexels', 40, environment.byteOffset - 8);
  assert.equal(decodePackFile(sharing).environmentTexels.length, 0);
});

test('decoding refuses a non-zero reserved field after the metadata length', () => {
  const bytes = encodePackFile(buildRoomInput());
  const directoryEnd = ENTRY_START + describePackFile(bytes).directory.length * ENTRY_BYTES;
  const flagged = Uint8Array.from(bytes);
  new DataView(flagged.buffer).setUint32(directoryEnd + 4, 1, true);
  expectPackFileError(() => decodePackFile(flagged), /reserved field after the metadata length is not 0/);
  expectPackFileError(() => describePackFile(flagged), /reserved field after the metadata length/);
});

test('decoding refuses counts that disagree with the table sizes or with kernelParams', () => {
  const bytes = encodePackFile(buildRoomInput());
  expectPackFileError(
    () => decodePackFile(withEntryField(bytes, 'triangles', 48, 224)),
    /triangleCount is 86 but table "triangles" holds 224 bytes/,
  );
  expectPackFileError(() => decodePackFile(withEntryField(bytes, 'kernelParams', 48, 64)), /"kernelParams" must hold exactly 320 bytes/);
  expectPackFileError(
    () => decodePackFile(withEntryField(bytes, 'lightToTree', 48, 4)),
    /"lightToTree" holds 4 bytes but lightCount \+ emissiveTriangleCount is 2/,
  );
  const mismatched = buildRoomInput();
  mismatched.materialCount = 3;
  expectPackFileError(() => encodePackFile(mismatched), /materialCount is 3 in the metadata but 4 in kernelParams/);
});

test('decoding refuses an unknown or repeated table name and a missing required table', () => {
  const bytes = encodePackFile(buildRoomInput());
  const renamed = Uint8Array.from(bytes);
  renamed.set(new TextEncoder().encode('mystery'), ENTRY_START + ENTRY_BYTES);
  renamed.fill(0, ENTRY_START + ENTRY_BYTES + 7, ENTRY_START + ENTRY_BYTES + 32);
  expectPackFileError(() => decodePackFile(renamed), /table "mystery", which this Cook does not know/);
  const repeated = Uint8Array.from(bytes);
  repeated.copyWithin(ENTRY_START + ENTRY_BYTES, ENTRY_START, ENTRY_START + 32);
  expectPackFileError(() => decodePackFile(repeated), /table "kernelParams" twice/);
  expectPackFileError(() => decodePackFile(withoutDirectoryEntry(bytes, 'materials')), /required table "materials" is missing/);
});

test('encoding refuses an input that is not a complete FORMAT-v2 input', () => {
  const missingTable = buildRoomInput();
  delete missingTable.materials;
  expectPackFileError(() => encodePackFile(missingTable), /input\.materials is missing/);

  const wrongType = buildRoomInput();
  wrongType.textureTexels = new Float32Array(4);
  expectPackFileError(() => encodePackFile(wrongType), /input\.textureTexels must be a Uint32Array/);

  const partialEmitters = buildRoomInput();
  delete partialEmitters.lightToTree;
  expectPackFileError(() => encodePackFile(partialEmitters), /must all be present or all absent/);

  const countWithoutTables = buildRoomInput();
  delete countWithoutTables.lightTreeEmitters;
  delete countWithoutTables.lightToTree;
  expectPackFileError(() => encodePackFile(countWithoutTables), /lightTreeEmitterCount is 2 but the emitter tables are absent/);

  const badCount = buildRoomInput();
  badCount.lightCount = -1;
  expectPackFileError(() => encodePackFile(badCount), /input\.lightCount must be a whole number/);

  expectPackFileError(() => encodePackFile({ ...buildRoomInput(), schemaVersion: 1 }), /schemaVersion must be 2/);
  assert.throws(() => encodePackFile(null), /FORMAT-v2 input object/);
  assert.throws(() => encodePackFile(buildRoomInput(), []), /plain object/);
});
