// A NumPy .npy writer (format version 1.0) for a float32 RGBA image: shape (height, width, 4), C order, little-endian.

const NPY_MAGIC = Uint8Array.of(0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59);
const HEADER_ALIGNMENT = 64;

/** Encodes linear float RGBA (width * height * 4 floats, rows from the top) as the bytes of a .npy file. */
export function encodeNpy(linearRgba, width, height) {
  if (!(linearRgba instanceof Float32Array) || linearRgba.length !== width * height * 4) {
    throw new TypeError(`encodeNpy: pass a Float32Array of ${width * height * 4} floats for a ${width}x${height} image.`);
  }
  const dictionary = `{'descr': '<f4', 'fortran_order': False, 'shape': (${height}, ${width}, 4), }`;
  // magic (6) + version (2) + header length field (2) + dictionary + padding + newline is a multiple of 64.
  const unpaddedLength = NPY_MAGIC.length + 2 + 2 + dictionary.length + 1;
  const paddingLength = (HEADER_ALIGNMENT - (unpaddedLength % HEADER_ALIGNMENT)) % HEADER_ALIGNMENT;
  const headerText = `${dictionary}${' '.repeat(paddingLength)}\n`;
  const headerLength = headerText.length;
  const dataBytes = new Uint8Array(linearRgba.buffer, linearRgba.byteOffset, linearRgba.byteLength);
  const bytes = new Uint8Array(NPY_MAGIC.length + 4 + headerLength + dataBytes.length);
  bytes.set(NPY_MAGIC, 0);
  bytes[6] = 1;
  bytes[7] = 0;
  new DataView(bytes.buffer).setUint16(8, headerLength, true);
  bytes.set(new TextEncoder().encode(headerText), 10);
  bytes.set(dataBytes, 10 + headerLength);
  return bytes;
}
