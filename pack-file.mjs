// The Cook pack file: one little-endian container for a FORMAT-v2 input (FORMAT-v2.md section 10). Pure JavaScript on typed
// arrays with no Node imports, so a browser page can write or read it. Every read is bounds checked.
import { FORMAT_V2_MAGIC, FORMAT_V2_VERSION, PACK_REVISION, STRUCT_STRIDES_V2 } from './pack-input-v2.mjs';

export const PACK_FILE_MAGIC = 'COOKPACK';
export const PACK_FILE_CONTAINER_VERSION = 1;
export const PACK_FILE_ERROR_CODE = 'COOK_PACK_FILE';

const HEADER_BYTES = 16;
const DIRECTORY_NAME_BYTES = 32;
const DIRECTORY_ENTRY_BYTES = 56;
const METADATA_PREFIX_BYTES = 8;
const TABLE_ALIGNMENT = 8;
const MAXIMUM_TABLE_COUNT = 64;
const KERNEL_PARAMS_COUNT_WORDS = {
  instanceCount: 21,
  triangleCount: 22,
  materialCount: 23,
  emissiveTriangleCount: 24,
  lightCount: 25,
  lightTreeNodeCount: 26,
  textureCount: 27,
};

const ELEMENT_TYPES = {
  u8: { code: 1, bytes: 1, ArrayType: Uint8Array },
  u32: { code: 2, bytes: 4, ArrayType: Uint32Array },
  f32: { code: 3, bytes: 4, ArrayType: Float32Array },
};
const ELEMENT_TYPE_BY_CODE = new Map(Object.entries(ELEMENT_TYPES).map(([name, type]) => [type.code, { name, ...type }]));

// Directory order. `optional` tables are the light tree emitter tables, which come together or not at all.
const TABLE_SPECS = [
  { name: 'kernelParams', type: 'u8' },
  { name: 'instances', type: 'u8', countName: 'instanceCount', stride: STRUCT_STRIDES_V2.instance },
  { name: 'triangles', type: 'u8', countName: 'triangleCount', stride: STRUCT_STRIDES_V2.triangle },
  { name: 'materials', type: 'u8', countName: 'materialCount', stride: STRUCT_STRIDES_V2.material },
  { name: 'emissiveTriangles', type: 'u8', countName: 'emissiveTriangleCount', stride: STRUCT_STRIDES_V2.emissiveTriangle },
  { name: 'lights', type: 'u8', countName: 'lightCount', stride: STRUCT_STRIDES_V2.light },
  { name: 'lightTreeNodes', type: 'u8', countName: 'lightTreeNodeCount', stride: STRUCT_STRIDES_V2.lightTreeNode },
  { name: 'lightTreeEmitters', type: 'u8', countName: 'lightTreeEmitterCount', stride: 32, optional: true },
  { name: 'lightToTree', type: 'u32', optional: true },
  { name: 'textureDescriptors', type: 'u8', countName: 'textureCount', stride: STRUCT_STRIDES_V2.textureDescriptor },
  { name: 'textureTexels', type: 'u32' },
  { name: 'environmentTexels', type: 'f32' },
];
const TABLE_SPEC_BY_NAME = new Map(TABLE_SPECS.map((spec) => [spec.name, spec]));
const OPTIONAL_TABLE_NAMES = TABLE_SPECS.filter((spec) => spec.optional).map((spec) => spec.name);
const COUNT_NAMES = [
  'instanceCount',
  'triangleCount',
  'materialCount',
  'emissiveTriangleCount',
  'lightCount',
  'lightTreeNodeCount',
  'lightTreeEmitterCount',
  'textureCount',
];

/** The error of a pack file that cannot be written or read; the message says what is wrong. */
export class PackFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackFileError';
    this.code = PACK_FILE_ERROR_CODE;
  }
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function assertLittleEndianHost() {
  if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) {
    throw new PackFileError('Pack files are little-endian and this machine is not; Cook does not read or write them here.');
  }
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

// Checks the counts against the table sizes and against the counts inside kernelParams. Shared by encode and decode.
function checkCountsAgainstTables(counts, tableByteLengths, kernelParams, callerName) {
  const hasEmitterTables = OPTIONAL_TABLE_NAMES.every((name) => tableByteLengths.has(name));
  const hasAnyEmitterTable = OPTIONAL_TABLE_NAMES.some((name) => tableByteLengths.has(name));
  if (hasAnyEmitterTable && !hasEmitterTables) {
    throw new PackFileError(
      `${callerName}: the light tree emitter tables (${OPTIONAL_TABLE_NAMES.join(', ')}) must all be present or all absent; found ${OPTIONAL_TABLE_NAMES.filter((name) => tableByteLengths.has(name)).join(', ')}.`
    );
  }
  if (hasEmitterTables !== (counts.lightTreeEmitterCount !== null)) {
    throw new PackFileError(
      `${callerName}: lightTreeEmitterCount is ${counts.lightTreeEmitterCount} but the emitter tables are ${hasEmitterTables ? 'present' : 'absent'}; it must be a count when they are present and null when they are absent.`
    );
  }
  for (const spec of TABLE_SPECS) {
    if (spec.countName === undefined || !tableByteLengths.has(spec.name)) continue;
    const requiredBytes = counts[spec.countName] * spec.stride;
    const actualBytes = tableByteLengths.get(spec.name);
    if (actualBytes < requiredBytes) {
      throw new PackFileError(
        `${callerName}: ${spec.countName} is ${counts[spec.countName]} but table "${spec.name}" holds ${actualBytes} bytes; ${counts[spec.countName]} records of ${spec.stride} bytes need at least ${requiredBytes}.`
      );
    }
  }
  if (hasEmitterTables) {
    const unifiedEmitterCount = counts.lightCount + counts.emissiveTriangleCount;
    const lightToTreeBytes = tableByteLengths.get('lightToTree');
    if (lightToTreeBytes < unifiedEmitterCount * 4) {
      throw new PackFileError(
        `${callerName}: table "lightToTree" holds ${lightToTreeBytes} bytes but lightCount + emissiveTriangleCount is ${unifiedEmitterCount}, which needs ${unifiedEmitterCount * 4}.`
      );
    }
  }
  checkKernelParams(counts, kernelParams, tableByteLengths.get('kernelParams'), callerName);
}

function checkKernelParams(counts, kernelParams, kernelParamsByteLength, callerName) {
  if (kernelParamsByteLength !== STRUCT_STRIDES_V2.kernelParams) {
    throw new PackFileError(
      `${callerName}: table "kernelParams" must hold exactly ${STRUCT_STRIDES_V2.kernelParams} bytes; it holds ${kernelParamsByteLength}.`
    );
  }
  const words = new Uint32Array(kernelParams.buffer.slice(kernelParams.byteOffset, kernelParams.byteOffset + STRUCT_STRIDES_V2.kernelParams));
  if (words[0] !== FORMAT_V2_MAGIC || words[1] !== FORMAT_V2_VERSION) {
    throw new PackFileError(
      `${callerName}: table "kernelParams" does not start with the FORMAT-v2 magic and version (found 0x${words[0].toString(16)} and ${words[1]}).`
    );
  }
  for (const [countName, wordIndex] of Object.entries(KERNEL_PARAMS_COUNT_WORDS)) {
    if (words[wordIndex] !== counts[countName]) {
      throw new PackFileError(
        `${callerName}: ${countName} is ${counts[countName]} in the metadata but ${words[wordIndex]} in kernelParams. Repack the scene.`
      );
    }
  }
  if (words[2] < 1 || words[3] < 1) {
    throw new PackFileError(`${callerName}: kernelParams holds an image size of ${words[2]} x ${words[3]}; both sides must be at least 1.`);
  }
}

function collectTablesForEncoding(input) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('encodePackFile: `input` must be a FORMAT-v2 input object from buildNativeInputV2.');
  }
  if (input.schemaVersion !== FORMAT_V2_VERSION) {
    throw new PackFileError(`encodePackFile: input.schemaVersion must be ${FORMAT_V2_VERSION}; got ${JSON.stringify(input.schemaVersion)}. Convert a v1 input with upgradeNativeInputV1ToV2.`);
  }
  const tables = [];
  for (const spec of TABLE_SPECS) {
    const table = input[spec.name];
    if (table === undefined || table === null) {
      if (!spec.optional) {
        throw new PackFileError(`encodePackFile: input.${spec.name} is missing; a FORMAT-v2 input needs it (pass an empty ${ELEMENT_TYPES[spec.type].ArrayType.name} for an empty table).`);
      }
      continue;
    }
    if (!(table instanceof ELEMENT_TYPES[spec.type].ArrayType)) {
      throw new PackFileError(`encodePackFile: input.${spec.name} must be a ${ELEMENT_TYPES[spec.type].ArrayType.name}; got ${Object.prototype.toString.call(table)}.`);
    }
    tables.push({ spec, table });
  }
  return tables;
}

function collectCountsForEncoding(input) {
  const counts = {};
  for (const countName of COUNT_NAMES) {
    const value = input[countName];
    if (countName === 'lightTreeEmitterCount' && value === undefined) {
      counts[countName] = null;
    } else if (!isCount(value)) {
      throw new PackFileError(`encodePackFile: input.${countName} must be a whole number from 0 to 4294967295; got ${JSON.stringify(value)}.`);
    } else {
      counts[countName] = value;
    }
  }
  return counts;
}

/**
 * Writes a FORMAT-v2 input (`buildNativeInputV2` or `upgradeNativeInputV1ToV2`) as a pack file and returns its bytes.
 * `metadata` is an optional JSON-safe object (for example `{ generator: "my exporter 1.2" }`) kept under `extra`. The same
 * input always gives the same bytes.
 */
export function encodePackFile(input, metadata = undefined) {
  assertLittleEndianHost();
  const tables = collectTablesForEncoding(input);
  const counts = collectCountsForEncoding(input);
  const tableByteLengths = new Map(tables.map(({ spec, table }) => [spec.name, table.byteLength]));
  checkCountsAgainstTables(counts, tableByteLengths, input.kernelParams, 'encodePackFile');

  const metadataObject = { schemaVersion: FORMAT_V2_VERSION, packRevision: PACK_REVISION, counts };
  if (metadata !== undefined) {
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new TypeError('encodePackFile: `metadata` must be a plain object that JSON can hold, or left out.');
    }
    metadataObject.extra = metadata;
  }
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadataObject));

  const directoryEnd = HEADER_BYTES + tables.length * DIRECTORY_ENTRY_BYTES;
  const metadataEnd = directoryEnd + METADATA_PREFIX_BYTES + metadataBytes.length;
  let nextOffset = alignUp(metadataEnd, TABLE_ALIGNMENT);
  const placements = tables.map(({ spec, table }) => {
    const placement = { spec, table, offset: nextOffset };
    nextOffset = alignUp(nextOffset + table.byteLength, TABLE_ALIGNMENT);
    return placement;
  });

  const bytes = new Uint8Array(nextOffset);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(PACK_FILE_MAGIC), 0);
  view.setUint32(8, PACK_FILE_CONTAINER_VERSION, true);
  view.setUint32(12, tables.length, true);
  placements.forEach(({ spec, table, offset }, index) => {
    const entryStart = HEADER_BYTES + index * DIRECTORY_ENTRY_BYTES;
    bytes.set(new TextEncoder().encode(spec.name), entryStart);
    view.setUint32(entryStart + DIRECTORY_NAME_BYTES, ELEMENT_TYPES[spec.type].code, true);
    view.setBigUint64(entryStart + DIRECTORY_NAME_BYTES + 8, BigInt(offset), true);
    view.setBigUint64(entryStart + DIRECTORY_NAME_BYTES + 16, BigInt(table.byteLength), true);
    bytes.set(new Uint8Array(table.buffer, table.byteOffset, table.byteLength), offset);
  });
  view.setUint32(directoryEnd, metadataBytes.length, true);
  bytes.set(metadataBytes, directoryEnd + METADATA_PREFIX_BYTES);
  return bytes;
}

function requireBytes(bytes, callerName) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`${callerName}: pass the file contents as a Uint8Array (a Node Buffer works).`);
  }
}

function readName(bytes, entryStart, entryIndex) {
  const nameBytes = bytes.subarray(entryStart, entryStart + DIRECTORY_NAME_BYTES);
  const terminator = nameBytes.indexOf(0);
  const used = terminator === -1 ? nameBytes : nameBytes.subarray(0, terminator);
  if (used.length === 0 || used.some((byte) => byte < 0x21 || byte > 0x7e) || (terminator !== -1 && nameBytes.subarray(terminator).some((byte) => byte !== 0))) {
    throw new PackFileError(`decodePackFile: directory entry ${entryIndex} has a table name that is empty or not printable ASCII padded with zero bytes.`);
  }
  return String.fromCharCode(...used);
}

function readSafeInteger(view, position, what) {
  const value = view.getBigUint64(position, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PackFileError(`decodePackFile: ${what} is ${value}, which is far larger than any file; the file is damaged.`);
  }
  return Number(value);
}

function readDirectory(bytes, view) {
  if (bytes.length < HEADER_BYTES) {
    throw new PackFileError(`decodePackFile: the file is truncated: ${bytes.length} bytes, but a pack file starts with a ${HEADER_BYTES}-byte header.`);
  }
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== PACK_FILE_MAGIC) {
    throw new PackFileError(`decodePackFile: not a Cook pack file: expected the magic ${PACK_FILE_MAGIC} but the file starts with ${JSON.stringify(magic)}.`);
  }
  const containerVersion = view.getUint32(8, true);
  if (containerVersion !== PACK_FILE_CONTAINER_VERSION) {
    throw new PackFileError(
      `decodePackFile: the file has container version ${containerVersion}; this Cook reads container version ${PACK_FILE_CONTAINER_VERSION}. Use a Cook that reads it, or write the file again.`
    );
  }
  const tableCount = view.getUint32(12, true);
  if (tableCount > MAXIMUM_TABLE_COUNT) {
    throw new PackFileError(`decodePackFile: the directory lists ${tableCount} tables; a pack file has at most ${TABLE_SPECS.length}. The file is damaged.`);
  }
  const directoryEnd = HEADER_BYTES + tableCount * DIRECTORY_ENTRY_BYTES;
  if (bytes.length < directoryEnd + METADATA_PREFIX_BYTES) {
    throw new PackFileError(`decodePackFile: the file is truncated: ${bytes.length} bytes, but the directory of ${tableCount} tables and the metadata header end at byte ${directoryEnd + METADATA_PREFIX_BYTES}.`);
  }
  const entries = [];
  const seenNames = new Set();
  for (let entryIndex = 0; entryIndex < tableCount; entryIndex++) {
    const entryStart = HEADER_BYTES + entryIndex * DIRECTORY_ENTRY_BYTES;
    const name = readName(bytes, entryStart, entryIndex);
    const spec = TABLE_SPEC_BY_NAME.get(name);
    if (spec === undefined) {
      throw new PackFileError(`decodePackFile: the directory lists a table "${name}", which this Cook does not know. Known tables: ${TABLE_SPECS.map((known) => known.name).join(', ')}.`);
    }
    if (seenNames.has(name)) {
      throw new PackFileError(`decodePackFile: the directory lists table "${name}" twice.`);
    }
    seenNames.add(name);
    const elementCode = view.getUint32(entryStart + DIRECTORY_NAME_BYTES, true);
    const elementType = ELEMENT_TYPE_BY_CODE.get(elementCode);
    if (elementType === undefined) {
      throw new PackFileError(`decodePackFile: table "${name}" has the unknown element type code ${elementCode}; known codes are 1 (u8), 2 (u32) and 3 (f32).`);
    }
    if (elementType.name !== spec.type) {
      throw new PackFileError(`decodePackFile: table "${name}" is stored as ${elementType.name} but a ${spec.type} table is required.`);
    }
    if (view.getUint32(entryStart + DIRECTORY_NAME_BYTES + 4, true) !== 0) {
      throw new PackFileError(`decodePackFile: the reserved field of the directory entry for "${name}" is not 0.`);
    }
    const byteOffset = readSafeInteger(view, entryStart + DIRECTORY_NAME_BYTES + 8, `the byte offset of table "${name}"`);
    const byteLength = readSafeInteger(view, entryStart + DIRECTORY_NAME_BYTES + 16, `the byte length of table "${name}"`);
    entries.push({ name, spec, elementType, byteOffset, byteLength });
  }
  return { containerVersion, entries, directoryEnd };
}

function readMetadata(bytes, view, directoryEnd) {
  const metadataLength = view.getUint32(directoryEnd, true);
  if (view.getUint32(directoryEnd + 4, true) !== 0) {
    throw new PackFileError('decodePackFile: the reserved field after the metadata length is not 0.');
  }
  const metadataStart = directoryEnd + METADATA_PREFIX_BYTES;
  if (metadataStart + metadataLength > bytes.length) {
    throw new PackFileError(`decodePackFile: the file is truncated: the metadata block needs bytes ${metadataStart} to ${metadataStart + metadataLength} but the file has ${bytes.length}.`);
  }
  let metadata;
  try {
    metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(metadataStart, metadataStart + metadataLength)));
  } catch (parseError) {
    throw new PackFileError(`decodePackFile: the metadata block is not valid UTF-8 JSON (${parseError.message}).`);
  }
  if (metadata === null || typeof metadata !== 'object' || metadata.counts === null || typeof metadata.counts !== 'object') {
    throw new PackFileError('decodePackFile: the metadata must be a JSON object with a "counts" object.');
  }
  if (metadata.schemaVersion !== FORMAT_V2_VERSION) {
    throw new PackFileError(`decodePackFile: the metadata schemaVersion is ${JSON.stringify(metadata.schemaVersion)}; this Cook reads ${FORMAT_V2_VERSION}.`);
  }
  if (!Number.isInteger(metadata.packRevision) || metadata.packRevision < 1) {
    throw new PackFileError(`decodePackFile: the metadata packRevision must be a whole number of at least 1; got ${JSON.stringify(metadata.packRevision)}.`);
  }
  const counts = {};
  for (const countName of COUNT_NAMES) {
    const value = metadata.counts[countName];
    const mayBeNull = countName === 'lightTreeEmitterCount';
    if (!(isCount(value) || (mayBeNull && value === null))) {
      throw new PackFileError(`decodePackFile: the metadata count ${countName} must be a whole number from 0 to 4294967295${mayBeNull ? ' or null' : ''}; got ${JSON.stringify(value)}.`);
    }
    counts[countName] = value;
  }
  return { metadata, counts, metadataEnd: metadataStart + metadataLength };
}

function checkTablePlacement(entry, fileLength, dataStart) {
  const { name, elementType, byteOffset, byteLength } = entry;
  if (byteOffset % TABLE_ALIGNMENT !== 0) {
    throw new PackFileError(`decodePackFile: table "${name}" starts at byte ${byteOffset}, which is not ${TABLE_ALIGNMENT}-byte aligned.`);
  }
  if (byteOffset < dataStart) {
    throw new PackFileError(`decodePackFile: table "${name}" starts at byte ${byteOffset}, inside the header, directory or metadata (data starts at ${dataStart}).`);
  }
  if (byteOffset + byteLength > fileLength) {
    throw new PackFileError(
      `decodePackFile: table "${name}" lies outside the file: it needs bytes ${byteOffset} to ${byteOffset + byteLength} but the file has ${fileLength} bytes (truncated?).`
    );
  }
  if (byteLength % elementType.bytes !== 0) {
    throw new PackFileError(`decodePackFile: table "${name}" is ${byteLength} bytes, which is not a multiple of its ${elementType.bytes}-byte ${elementType.name} elements.`);
  }
}

function checkTablesDoNotOverlap(entries) {
  const placed = entries.filter((entry) => entry.byteLength > 0).sort((first, second) => first.byteOffset - second.byteOffset);
  for (let index = 1; index < placed.length; index++) {
    const previous = placed[index - 1];
    const current = placed[index];
    if (current.byteOffset < previous.byteOffset + previous.byteLength) {
      throw new PackFileError(
        `decodePackFile: tables "${previous.name}" (bytes ${previous.byteOffset} to ${previous.byteOffset + previous.byteLength}) and "${current.name}" (starting at byte ${current.byteOffset}) overlap; tables must not share bytes.`
      );
    }
  }
}

function readPackFileStructure(bytes) {
  assertLittleEndianHost();
  requireBytes(bytes, 'decodePackFile');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { containerVersion, entries, directoryEnd } = readDirectory(bytes, view);
  const { metadata, counts, metadataEnd } = readMetadata(bytes, view, directoryEnd);
  const dataStart = alignUp(metadataEnd, TABLE_ALIGNMENT);
  for (const entry of entries) {
    checkTablePlacement(entry, bytes.length, dataStart);
  }
  checkTablesDoNotOverlap(entries);
  const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
  for (const spec of TABLE_SPECS) {
    if (!spec.optional && !entryByName.has(spec.name)) {
      throw new PackFileError(`decodePackFile: the required table "${spec.name}" is missing from the directory.`);
    }
  }
  const tableByteLengths = new Map(entries.map((entry) => [entry.name, entry.byteLength]));
  const kernelParamsEntry = entryByName.get('kernelParams');
  const kernelParams = new Uint8Array(bytes.buffer, bytes.byteOffset + kernelParamsEntry.byteOffset, Math.min(kernelParamsEntry.byteLength, STRUCT_STRIDES_V2.kernelParams));
  checkCountsAgainstTables(counts, tableByteLengths, kernelParams, 'decodePackFile');
  return { containerVersion, entries, metadata, counts, kernelParams };
}

/**
 * Reads the directory and metadata of a pack file without building the input, after the same checks as `decodePackFile`.
 * Returns `{ containerVersion, schemaVersion, packRevision, counts, image: { width, height, samples }, directory, extra }`;
 * the image size and sample count are those stored in kernelParams.
 */
export function describePackFile(bytes) {
  const { containerVersion, entries, metadata, counts, kernelParams } = readPackFileStructure(bytes);
  const words = new Uint32Array(kernelParams.slice().buffer);
  return {
    containerVersion,
    schemaVersion: metadata.schemaVersion,
    packRevision: metadata.packRevision,
    counts,
    image: { width: words[2], height: words[3], samples: words[6] },
    directory: entries.map(({ name, elementType, byteOffset, byteLength }) => ({ name, elementType: elementType.name, byteOffset, byteLength })),
    extra: metadata.extra,
    byteLength: bytes.length,
  };
}

/**
 * Reads a pack file and returns the FORMAT-v2 input object that `traceNative(input, { kernel: "cycles" })` takes. Tables
 * that are 4-byte aligned in `bytes` are views into it; the others are copies. Throws a `PackFileError` (code
 * `COOK_PACK_FILE`) that says what is wrong with a damaged or unknown file. The pack revision is not checked here: compare
 * `describePackFile(bytes).packRevision` with `describeEngine().packFormat.readsRevisions`.
 */
export function decodePackFile(bytes) {
  const { entries, counts } = readPackFileStructure(bytes);
  const input = { schemaVersion: FORMAT_V2_VERSION };
  for (const { name, elementType, byteOffset, byteLength } of entries) {
    const absoluteOffset = bytes.byteOffset + byteOffset;
    const isAligned = absoluteOffset % elementType.bytes === 0;
    // Uint8Array.prototype.slice copies even when `bytes` is a Node Buffer, whose own slice would share memory.
    const source = isAligned
      ? new Uint8Array(bytes.buffer, absoluteOffset, byteLength)
      : Uint8Array.prototype.slice.call(bytes, byteOffset, byteOffset + byteLength);
    input[name] = isAligned
      ? new elementType.ArrayType(source.buffer, source.byteOffset, byteLength / elementType.bytes)
      : new elementType.ArrayType(source.buffer, 0, byteLength / elementType.bytes);
  }
  for (const [countName, value] of Object.entries(counts)) {
    if (value !== null) input[countName] = value;
  }
  return input;
}
