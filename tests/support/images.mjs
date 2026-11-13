// Readers for the files the Cook command line writes, used by the tests only.
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Splits a PNG into its chunks and returns the size, the pixels and the chunks, checking the signature and every CRC. */
export function decodePng(png, crc32) {
  const bytes = Buffer.from(png);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG: bad signature');
  }
  const chunks = [];
  let position = PNG_SIGNATURE.length;
  while (position < bytes.length) {
    const length = bytes.readUInt32BE(position);
    const type = bytes.toString('latin1', position + 4, position + 8);
    const data = bytes.subarray(position + 8, position + 8 + length);
    const storedCrc = bytes.readUInt32BE(position + 8 + length);
    const actualCrc = crc32(bytes.subarray(position + 4, position + 8 + length));
    if (storedCrc !== actualCrc) throw new Error(`bad CRC in the ${type} chunk`);
    chunks.push({ type, data });
    position += 12 + length;
  }
  const header = chunks.find((chunk) => chunk.type === 'IHDR').data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const compressed = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
  const scanlines = inflateSync(compressed);
  const rowBytes = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    if (scanlines[row * (rowBytes + 1)] !== 0) throw new Error(`row ${row} uses a filter this reader does not know`);
    rgba.set(scanlines.subarray(row * (rowBytes + 1) + 1, (row + 1) * (rowBytes + 1)), row * rowBytes);
  }
  return { width, height, rgba, chunks, bitDepth: header[8], colourType: header[9], interlace: header[12] };
}

/** Reads a version 1.0 .npy file: the header fields and the data as a Buffer. */
export function decodeNpy(npy) {
  const bytes = Buffer.from(npy);
  if (bytes.toString('latin1', 1, 6) !== 'NUMPY' || bytes[0] !== 0x93) throw new Error('not an .npy file: bad magic');
  const headerLength = bytes.readUInt16LE(8);
  const header = bytes.toString('latin1', 10, 10 + headerLength);
  const descr = /'descr': '([^']+)'/.exec(header)[1];
  const shape = /'shape': \(([^)]*)\)/.exec(header)[1].split(',').map((part) => part.trim()).filter(Boolean).map(Number);
  return { version: [bytes[6], bytes[7]], headerLength, header, descr, shape, data: bytes.subarray(10 + headerLength) };
}
