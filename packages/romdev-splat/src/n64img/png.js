// The pypng (png.py 0.20220715.0, MIT, David Jones et al.) Writer code
// paths n64img uses: Writer(width, height, greyscale, alpha, palette,
// bitdepth=8).write_array(). Same chunk layout, same IDAT chunking
// (1 MiB chunk_limit), same zlib calls.
import { compressobj, crc32 } from '../zlib.js';

class ProtocolError extends Error {}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function checkPalette(palette) {
  if (palette === null || palette === undefined) return null;
  const p = [...palette];
  if (!(p.length > 0 && p.length <= 256)) {
    throw new ProtocolError('a palette must have between 1 and 256 entries, see https://www.w3.org/TR/PNG/#11PLTE');
  }
  let seenTriple = false;
  p.forEach((t, i) => {
    if (t.length !== 3 && t.length !== 4) throw new ProtocolError(`palette entry ${i}: entries must be 3- or 4-tuples.`);
    if (t.length === 3) seenTriple = true;
    if (seenTriple && t.length === 4) throw new ProtocolError(`palette entry ${i}: all 4-tuples must precede all 3-tuples`);
    for (const x of t) {
      if (!Number.isInteger(x) || x < 0 || x > 255) throw new ProtocolError(`palette entry ${i}: values must be integer: 0 <= x <= 255`);
    }
  });
  return p;
}

function writeChunk(out, tag, data = new Uint8Array(0)) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  out.push(len);
  const tagB = Buffer.from(tag, 'latin1');
  out.push(tagB);
  out.push(Buffer.from(data));
  let c = crc32(tagB);
  c = crc32(data, c);
  const cb = Buffer.alloc(4); cb.writeUInt32BE(c >>> 0);
  out.push(cb);
}

export class Writer {
  constructor(width, height, { greyscale = null, alpha = false, bitdepth = 8, palette = null, compression = null, chunkLimit = 2 ** 20 } = {}) {
    if (!Number.isInteger(width) || !Number.isInteger(height)) throw new ProtocolError('width and height must be integers');
    if (width <= 0 || height <= 0) throw new ProtocolError('width and height must be greater than zero');
    palette = checkPalette(palette);
    alpha = !!alpha;
    const colormap = !!(palette && palette.length);
    if (greyscale === null && colormap) greyscale = false;
    greyscale = !!greyscale;
    const planes = colormap ? 1 : (greyscale ? 1 : 3) + (alpha ? 1 : 0);
    if (colormap) {
      if (![1, 2, 4, 8].includes(bitdepth)) throw new ProtocolError('with palette, bitdepth must be 1, 2, 4, or 8');
      if (alpha) throw new ProtocolError('alpha and palette not compatible');
      if (greyscale) throw new ProtocolError('greyscale and palette not compatible');
    }
    if (bitdepth !== 8) throw new Error('romdev-splat: only bitdepth 8 is implemented (the depth n64img writes)');
    this.width = width;
    this.height = height;
    this.greyscale = greyscale;
    this.alpha = alpha;
    this.colormap = colormap;
    this.bitdepth = bitdepth;
    this.compression = compression;
    this.chunk_limit = chunkLimit;
    this.palette = palette;
    this.planes = planes;
    this.color_type = 4 * (alpha ? 1 : 0) + 2 * (greyscale ? 0 : 1) + (colormap ? 1 : 0);
  }

  /** write_array(outfile, pixels) with a flat pixel array; returns the PNG bytes. */
  writeArray(pixels) {
    const out = [SIGNATURE];
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = this.bitdepth; ihdr[9] = this.color_type; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    writeChunk(out, 'IHDR', ihdr);
    if (this.palette) {
      const p = []; const t = [];
      for (const x of this.palette) {
        p.push(...x.slice(0, 3));
        if (x.length > 3) t.push(x[3]);
      }
      writeChunk(out, 'PLTE', Uint8Array.from(p));
      if (t.length) writeChunk(out, 'tRNS', Uint8Array.from(t));
    }

    const compressor = this.compression !== null ? compressobj(this.compression) : compressobj();
    const vpr = this.width * this.planes;
    let data = [];
    let dataLen = 0;
    const flushData = () => {
      const buf = Buffer.concat(data, dataLen);
      data = []; dataLen = 0;
      return buf;
    };
    let stop = 0;
    for (let y = 0; y < this.height; y++) {
      const start = stop;
      stop = start + vpr;
      // pixels[start:stop] (Python slicing clamps; bytearray.extend of values)
      const row = pixels.subarray(Math.min(start, pixels.length), Math.min(stop, pixels.length));
      data.push(Buffer.from([0]), Buffer.from(row));
      dataLen += 1 + row.length;
      if (dataLen > this.chunk_limit) {
        const compressed = compressor.compress(flushData());
        if (compressed.length) writeChunk(out, 'IDAT', compressed);
      }
    }
    const compressed = compressor.compress(flushData());
    const flushed = compressor.flush();
    if (compressed.length || flushed.length) writeChunk(out, 'IDAT', Buffer.concat([compressed, flushed]));
    writeChunk(out, 'IEND');
    return Buffer.concat(out);
  }
}
