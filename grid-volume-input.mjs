// Packs dense grid volumes (FORMAT-v2.md, "Grid volumes") into the words the Cycles-parity kernel reads from the texture texel pool.
// Pure typed arrays with zero Node-only imports, so a browser page can run it.
//
// A grid volume is a 3D grid of density, with optional temperature and flame, placed by a box (centre, size and an optional rotation) and
// shaded with the terms of Principled Volume. The `.67vg` channel layout of Crucible's `src/volume-grid.js` is read by `decodeGridFile`.

export const GRID_VOLUME_DESCRIPTOR_WORDS = 32;
export const GRID_VOLUME_MAX_COUNT = 8;
export const GRID_VOLUME_MAX_AXIS = 256;
/** Each voxel stores two words (density and temperature, then flame), whatever channels the grid has. */
export const GRID_VOLUME_BYTES_PER_VOXEL = 8;
export const GRID_VOLUME_MAX_VOXELS = GRID_VOLUME_MAX_AXIS * GRID_VOLUME_MAX_AXIS * GRID_VOLUME_MAX_AXIS;
export const GRID_VOLUME_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const GRID_VOLUME_FLAG_HAS_TEMPERATURE = 1;
export const KERNEL_FLAG_HAS_GRID_VOLUME = 8192;
export const KERNEL_PARAMS_V2_GRID_VOLUME_COUNT_BYTE_OFFSET = 324;
export const KERNEL_PARAMS_V2_GRID_TABLE_OFFSET_BYTE_OFFSET = 328;

export const BLACKBODY_TABLE_FIRST_KELVIN = 800;
export const BLACKBODY_TABLE_STEP_KELVIN = 200;
export const BLACKBODY_TABLE_COUNT = 57;
/**
 * The linear RGB colour of luminance 1 of a blackbody at each table temperature (800 K to 12000 K every 200 K): the Planckian locus in Rec.709,
 * the table Crucible's grid volumes use, so a Cook fire and a Glaze fire have the same hue.
 */
export const BLACKBODY_HUE_TABLE = new Float32Array([
  4.7036691, 0, 0,
  4.2895632, 0.12309691, 0,
  3.774529, 0.27619568, 0,
  3.3438206, 0.40422782, 0,
  2.9943442, 0.50811297, 0,
  2.711458, 0.59220368, 0,
  2.4774327, 0.65984708, 0.019046674,
  2.2803152, 0.71389806, 0.064059518,
  2.1153762, 0.75799358, 0.11293626,
  1.9759554, 0.79424274, 0.16439694,
  1.8569862, 0.8242569, 0.21739899,
  1.7545869, 0.84927326, 0.27111569,
  1.6657554, 0.87024933, 0.32490444,
  1.5881441, 0.8879323, 0.37827402,
  1.5198981, 0.90291101, 0.43085507,
  1.4595358, 0.91565323, 0.48237494,
  1.4058627, 0.92653412, 0.53263718,
  1.3579053, 0.93585664, 0.58150482,
  1.3148645, 0.94386762, 0.6288873,
  1.2760783, 0.95076936, 0.67472994,
  1.240994, 0.95672882, 0.71900606,
  1.209147, 0.96188462, 0.76171023,
  1.1801447, 0.9663524, 0.80285329,
  1.1536523, 0.97022933, 0.84245843,
  1.1293839, 0.97359717, 0.88055801,
  1.1070931, 0.97652519, 0.91719121,
  1.086567, 0.97907215, 0.95240182,
  1.0676211, 0.98128837, 0.98623693,
  1.050094, 0.9832167, 1.0187455,
  1.0338448, 0.98489398, 1.0499778,
  1.0187497, 0.98635203, 1.0799841,
  1.0046995, 0.98761809, 1.1088147,
  0.99159759, 0.98871601, 1.1365191,
  0.97935855, 0.98966622, 1.1631455,
  0.96790612, 0.99048662, 1.1887416,
  0.95717251, 0.99119276, 1.2133527,
  0.947097, 0.99179822, 1.2370231,
  0.93762523, 0.99231493, 1.2597954,
  0.92870831, 0.99275327, 1.2817104,
  0.92030221, 0.99312228, 1.3028072,
  0.91236728, 0.99343014, 1.3231232,
  0.90486759, 0.99368376, 1.3426943,
  0.8977707, 0.99388945, 1.3615543,
  0.89104706, 0.99405271, 1.3797358,
  0.88466978, 0.9941783, 1.3972697,
  0.87861449, 0.99427062, 1.4141855,
  0.87285882, 0.99433351, 1.4305111,
  0.86738247, 0.99437022, 1.4462731,
  0.8621667, 0.99438381, 1.4614967,
  0.85719442, 0.99437696, 1.4762058,
  0.85244995, 0.99435204, 1.4904234,
  0.84791887, 0.99431109, 1.5041709,
  0.84358782, 0.99425614, 1.5174689,
  0.83944458, 0.99418867, 1.5303371,
  0.83547777, 0.99411035, 1.5427936,
  0.83167696, 0.99402243, 1.5548564,
  0.82803243, 0.99392611, 1.5665419,
]);

const MAGIC = [0x36, 0x37, 0x56, 0x47];
const GRID_FILE_VERSION = 1;
const CHANNEL_NAMES = ['density', 'temperature', 'flame', 'velocityX', 'velocityY', 'velocityZ'];
const HALF_MAXIMUM = 65504;

const floatScratch = new Float32Array(1);
const floatScratchBits = new Uint32Array(floatScratch.buffer);

/** Converts a number to half float bits, rounding to nearest even. The caller has checked that it is finite and at most 65504. */
export function floatToHalfBits(value) {
  floatScratch[0] = value;
  const bits = floatScratchBits[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const fraction = bits & 0x7fffff;
  if (exponent >= 31) return sign | 0x7bff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const shift = 14 - exponent;
    const mantissa = fraction | 0x800000;
    const kept = mantissa >> shift;
    const remainder = mantissa - (kept << shift);
    const halfway = 1 << (shift - 1);
    return sign | (kept + (remainder > halfway || (remainder === halfway && (kept & 1)) ? 1 : 0));
  }
  const rounded = (fraction + 0xfff + ((fraction >> 13) & 1)) >> 13;
  return sign + (exponent << 10) + rounded;
}

/** Converts half float bits to a number. */
export function halfBitsToFloat(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/**
 * Reads a `.67vg` grid file (the layout of Crucible's `encodeVolumeGrid`: "67VG", version 1, a JSON header, then half float channels, x fastest)
 * into `{ resolution, size, channels }` for `gridVolumes`. The velocity channels are skipped; Cook has no motion blur from a grid.
 */
export function decodeGridFile(source, label = 'grid file') {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (bytes.length < 12 || MAGIC.some((value, index) => bytes[index] !== value)) {
    throw new TypeError(`${label} is not a grid file: it must start with "67VG". Pass the bytes of a file written by Crucible's encodeVolumeGrid or scripts/vdb-to-grid.py.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version !== GRID_FILE_VERSION) throw new RangeError(`${label} is grid file version ${version}; Cook reads version ${GRID_FILE_VERSION}.`);
  const headerBytes = view.getUint32(8, true);
  if (12 + headerBytes > bytes.length) throw new RangeError(`${label} ends inside its header.`);
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerBytes)));
  } catch {
    throw new TypeError(`${label} has a header that is not JSON.`);
  }
  const names = header?.channels;
  if (!Array.isArray(names) || names.length === 0 || names.some(name => !CHANNEL_NAMES.includes(name)) || new Set(names).size !== names.length) {
    throw new TypeError(`${label} header channels must be a list of distinct names from ${CHANNEL_NAMES.join(', ')}.`);
  }
  const resolution = checkResolution(header.resolution, label);
  const voxels = resolution[0] * resolution[1] * resolution[2];
  const dataStart = 12 + headerBytes;
  if (bytes.length !== dataStart + voxels * 2 * names.length) {
    throw new RangeError(`${label} holds ${bytes.length - dataStart} bytes of data, expected ${voxels * 2 * names.length} for ${resolution.join('x')} and ${names.length} channels.`);
  }
  const channels = {};
  names.forEach((name, index) => {
    if (name !== 'density' && name !== 'temperature' && name !== 'flame') return;
    const values = new Uint16Array(voxels);
    for (let voxel = 0; voxel < voxels; voxel += 1) values[voxel] = view.getUint16(dataStart + (index * voxels + voxel) * 2, true);
    channels[name] = values;
  });
  if (!channels.density) throw new TypeError(`${label} has no density channel.`);
  return { resolution, size: header.size ?? null, channels };
}

function checkResolution(resolution, label) {
  if (!Array.isArray(resolution) || resolution.length !== 3) throw new TypeError(`${label}: resolution must be [x, y, z], got ${JSON.stringify(resolution)}.`);
  for (const axis of resolution) {
    if (!Number.isInteger(axis) || axis < 1 || axis > GRID_VOLUME_MAX_AXIS) {
      throw new RangeError(`${label}: resolution ${resolution.join('x')} is out of range: each axis is an integer from 1 to ${GRID_VOLUME_MAX_AXIS}. Resample the grid to at most ${GRID_VOLUME_MAX_AXIS} voxels per axis.`);
    }
  }
  return resolution.slice();
}

function checkVector(value, length, name, label, { positive = false, minimum = 0, maximum = Infinity } = {}) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw new TypeError(`${label}: \`${name}\` must be ${length} numbers.`);
  if (value.length !== length) throw new TypeError(`${label}: \`${name}\` must be ${length} numbers, got ${value.length}.`);
  for (let index = 0; index < length; index += 1) {
    const component = value[index];
    if (typeof component !== 'number' || !Number.isFinite(component)) throw new RangeError(`${label}: \`${name}\`[${index}] must be a finite number, got ${component}.`);
    if (positive && component <= 0) throw new RangeError(`${label}: \`${name}\`[${index}] must be above 0, got ${component}.`);
    if (!positive && (component < minimum || component > maximum)) throw new RangeError(`${label}: \`${name}\`[${index}] must be from ${minimum} to ${maximum}, got ${component}.`);
  }
  return Array.from(value);
}

function checkScalar(value, name, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label}: \`${name}\` must be a finite number from ${minimum} to ${maximum}, got ${value}.`);
  }
  return value;
}

// One channel as half float bits. A Uint16Array is taken as half float bits already; a Float32Array or an array is converted.
function channelHalfBits(values, name, label, voxels) {
  if (values === undefined || values === null) return null;
  if (!ArrayBuffer.isView(values) && !Array.isArray(values)) throw new TypeError(`${label}: channel \`${name}\` must be a Uint16Array of half floats or a Float32Array.`);
  if (values.length !== voxels) throw new RangeError(`${label}: channel \`${name}\` holds ${values.length} values, expected ${voxels} for the resolution.`);
  const bits = new Uint16Array(voxels);
  const isHalfBits = values instanceof Uint16Array;
  for (let voxel = 0; voxel < voxels; voxel += 1) {
    const value = isHalfBits ? halfBitsToFloat(values[voxel]) : values[voxel];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new RangeError(`${label}: channel \`${name}\` has ${value} at voxel ${voxel}; every value must be finite and at least 0.`);
    }
    if (value > HALF_MAXIMUM) throw new RangeError(`${label}: channel \`${name}\` has ${value} at voxel ${voxel}, past the half float maximum ${HALF_MAXIMUM}. Scale the channel down and raise \`density\`, \`temperatureScale\` or \`emissionStrength\` to match.`);
    bits[voxel] = isHalfBits ? values[voxel] : floatToHalfBits(value);
  }
  return bits;
}

// The box has its centre at `center` and its axes along the columns of `rotation` (row-major 3x3, identity by default), each `size` long:
// the unit coordinate is rotation^T (p - center) / size + 0.5.
function boxWorldToUnitRows(center, size, rotation) {
  const rows = new Float32Array(12);
  for (let axis = 0; axis < 3; axis += 1) {
    const column = [rotation[axis], rotation[3 + axis], rotation[6 + axis]];
    for (let component = 0; component < 3; component += 1) rows[axis * 4 + component] = column[component] / size[axis];
    rows[axis * 4 + 3] = 0.5 - (column[0] * center[0] + column[1] * center[1] + column[2] * center[2]) / size[axis];
  }
  return rows;
}

function packOneGrid(volume, index, dataOffsetWords) {
  const label = `gridVolumes[${index}]`;
  if (!volume || typeof volume !== 'object') throw new TypeError(`${label} must be an object with resolution, channels, center and size.`);
  const resolution = checkResolution(volume.resolution, label);
  const voxels = resolution[0] * resolution[1] * resolution[2];
  const channels = volume.channels;
  if (!channels || typeof channels !== 'object') throw new TypeError(`${label}: \`channels\` must be an object with a \`density\` channel (and optionally \`temperature\` and \`flame\`). Decode a .67vg file with decodeGridFile.`);
  const density = channelHalfBits(channels.density, 'density', label, voxels);
  if (!density) throw new TypeError(`${label}: \`channels.density\` is required.`);
  const temperature = channelHalfBits(channels.temperature, 'temperature', label, voxels);
  const flame = channelHalfBits(channels.flame, 'flame', label, voxels);

  const center = checkVector(volume.center, 3, 'center', label, { minimum: -1e9, maximum: 1e9 });
  const size = checkVector(volume.size, 3, 'size', label, { positive: true });
  const rotation = volume.rotation === undefined ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : checkVector(volume.rotation, 9, 'rotation', label, { minimum: -1, maximum: 1 });
  const densityScale = checkScalar(volume.density ?? 1, 'density', label, 0, 1e6);
  const absorption = checkVector(volume.absorption ?? [1, 1, 1], 3, 'absorption', label, { minimum: 0, maximum: 1e6 });
  const scatter = checkVector(volume.scatter ?? [0, 0, 0], 3, 'scatter', label, { minimum: 0, maximum: 1e6 });
  const anisotropy = checkScalar(volume.anisotropy ?? 0, 'anisotropy', label, -0.99, 0.99);
  const emission = checkVector(volume.emission ?? [0, 0, 0], 3, 'emission', label, { minimum: 0, maximum: 1e6 });
  const emissionStrength = checkScalar(volume.emissionStrength ?? 1, 'emissionStrength', label, 0, 1e6);
  const temperatureScale = checkScalar(volume.temperatureScale ?? 1, 'temperatureScale', label, 0, 1e6);
  const blackbodyIntensity = checkScalar(volume.blackbodyIntensity ?? 0, 'blackbodyIntensity', label, 0, 1e6);

  const voxelWords = new Uint32Array(voxels * 2);
  let maximumDensity = 0;
  for (let voxel = 0; voxel < voxels; voxel += 1) {
    voxelWords[voxel * 2] = (density[voxel] | ((temperature ? temperature[voxel] : 0) << 16)) >>> 0;
    // A grid with no flame channel emits by its density, as Crucible's grid volumes do.
    voxelWords[voxel * 2 + 1] = flame ? flame[voxel] : density[voxel];
    maximumDensity = Math.max(maximumDensity, halfBitsToFloat(density[voxel]));
  }

  const descriptor = new Uint32Array(GRID_VOLUME_DESCRIPTOR_WORDS);
  const descriptorFloats = new Float32Array(descriptor.buffer);
  descriptor.set(resolution, 0);
  descriptor[3] = dataOffsetWords;
  descriptorFloats.set(boxWorldToUnitRows(center, size, rotation), 4);
  for (let channel = 0; channel < 3; channel += 1) {
    descriptorFloats[16 + channel] = densityScale * absorption[channel];
    descriptorFloats[20 + channel] = densityScale * scatter[channel];
    descriptorFloats[24 + channel] = emission[channel] * emissionStrength;
  }
  descriptorFloats[19] = anisotropy;
  let largestExtinction = 0;
  for (let channel = 0; channel < 3; channel += 1) largestExtinction = Math.max(largestExtinction, descriptorFloats[16 + channel] + descriptorFloats[20 + channel]);
  // Trilinear interpolation never passes the largest voxel; the margin covers float rounding.
  descriptorFloats[23] = maximumDensity * largestExtinction * 1.0001;
  descriptorFloats[27] = temperatureScale;
  descriptorFloats[28] = blackbodyIntensity;
  descriptor[29] = temperature ? GRID_VOLUME_FLAG_HAS_TEMPERATURE : 0;
  return { descriptor, voxelWords };
}

/**
 * Packs `gridVolumes` into one word array to append to the texture texel pool: the descriptor table, the blackbody hue table, then each grid's
 * voxels. `poolWordCount` is the length of the pool before it, so descriptor offsets are absolute. Returns `{ words, count, tableOffset }`, or
 * `null` for no grids.
 */
export function packGridVolumes(gridVolumes, poolWordCount) {
  if (gridVolumes === undefined || gridVolumes === null) return null;
  if (!Array.isArray(gridVolumes)) throw new TypeError('`gridVolumes` must be an array of grid volumes.');
  if (gridVolumes.length === 0) return null;
  if (gridVolumes.length > GRID_VOLUME_MAX_COUNT) {
    throw new RangeError(`\`gridVolumes\` holds ${gridVolumes.length} grids; Cook takes at most ${GRID_VOLUME_MAX_COUNT}. Merge grids that share a box.`);
  }
  const tableWords = gridVolumes.length * GRID_VOLUME_DESCRIPTOR_WORDS + BLACKBODY_HUE_TABLE.length;
  let totalBytes = 0;
  gridVolumes.forEach((volume, index) => {
    if (!volume || typeof volume !== 'object') throw new TypeError(`gridVolumes[${index}] must be an object with resolution, channels, center and size.`);
    const resolution = checkResolution(volume.resolution, `gridVolumes[${index}]`);
    totalBytes += resolution[0] * resolution[1] * resolution[2] * GRID_VOLUME_BYTES_PER_VOXEL;
  });
  if (totalBytes > GRID_VOLUME_MAX_TOTAL_BYTES) {
    throw new RangeError(`\`gridVolumes\` need ${totalBytes} bytes of voxels, over the ${GRID_VOLUME_MAX_TOTAL_BYTES} byte limit. Resample the grids to fewer voxels.`);
  }
  const packed = [];
  let dataOffset = poolWordCount + tableWords;
  gridVolumes.forEach((volume, index) => {
    const one = packOneGrid(volume, index, dataOffset);
    dataOffset += one.voxelWords.length;
    packed.push(one);
  });
  const words = new Uint32Array(dataOffset - poolWordCount);
  packed.forEach((one, index) => words.set(one.descriptor, index * GRID_VOLUME_DESCRIPTOR_WORDS));
  words.set(new Uint32Array(BLACKBODY_HUE_TABLE.buffer.slice(0)), gridVolumes.length * GRID_VOLUME_DESCRIPTOR_WORDS);
  let cursor = tableWords;
  for (const one of packed) {
    words.set(one.voxelWords, cursor);
    cursor += one.voxelWords.length;
  }
  return { words, count: gridVolumes.length, tableOffset: poolWordCount };
}

/** Writes the grid volume count, the descriptor table offset and the kernel flag into a `KernelParamsV2` buffer. */
export function writeGridVolumeKernelParams(kernelParams, packedGrids) {
  const view = new DataView(kernelParams.buffer, kernelParams.byteOffset, kernelParams.byteLength);
  const flags = view.getUint32(32, true);
  view.setUint32(32, (flags | KERNEL_FLAG_HAS_GRID_VOLUME) >>> 0, true);
  view.setUint32(KERNEL_PARAMS_V2_GRID_VOLUME_COUNT_BYTE_OFFSET, packedGrids.count, true);
  view.setUint32(KERNEL_PARAMS_V2_GRID_TABLE_OFFSET_BYTE_OFFSET, packedGrids.tableOffset, true);
}
