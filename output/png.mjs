// A small PNG writer: 8-bit RGBA, no interlace, filter type 0 on every row, compressed with node:zlib.
import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** The CRC-32 of the PNG specification (also used by zip): over the chunk type and data. */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const bytes = new Uint8Array(12 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index++) {
    bytes[4 + index] = type.charCodeAt(index);
  }
  bytes.set(data, 8);
  view.setUint32(8 + data.length, crc32(bytes.subarray(4, 8 + data.length)));
  return bytes;
}

/** Encodes `rgba` (width * height * 4 bytes, rows from the top) as a PNG and returns its bytes. */
export function encodePng(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`encodePng: width and height must be whole numbers of at least 1; got ${width} x ${height}.`);
  }
  if (rgba.length !== width * height * 4) {
    throw new TypeError(`encodePng: a ${width}x${height} image needs ${width * height * 4} bytes of RGBA; got ${rgba.length}.`);
  }
  const rowBytes = width * 4;
  const scanlines = new Uint8Array(height * (rowBytes + 1));
  for (let row = 0; row < height; row++) {
    scanlines.set(rgba.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1);
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const parts = [PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
