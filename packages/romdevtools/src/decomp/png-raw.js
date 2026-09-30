// png-raw.js - a small PNG codec with pypng's raw view of an image, for ports
// of project scripts that read indexed/RGBA PNGs through pypng
// (png.Reader(f).read(): width, height, rows of samples, info with bitdepth,
// planes and palette) and write them through png.Writer (bitdepth 8, no
// filtering, one IDAT). Non-interlaced images only; sub-byte depths are
// unpacked to one sample per pixel, 16-bit samples to numbers, as pypng does.
import zlib from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * pypng png.Writer(width, height, greyscale, alpha, palette).write_array:
 * bitdepth 8; colour type 3 with a palette (tRNS when the entries have alpha),
 * else 6 / 2 / 4 / 0 by alpha and greyscale. `pixels` is the flat sample array.
 */
export function writePng({ width, height, pixels, palette = null, greyscale = false, alpha = false }) {
  let colorType, planes;
  if (palette) { colorType = 3; planes = 1; }
  else if (greyscale) { colorType = alpha ? 4 : 0; planes = alpha ? 2 : 1; }
  else { colorType = alpha ? 6 : 2; planes = alpha ? 4 : 3; }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * planes;
  if (pixels.length !== stride * height) throw new Error(`writePng: ${pixels.length} samples for ${width}x${height}x${planes}`);
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1); }
  const parts = [SIG, chunk("IHDR", ihdr)];
  if (palette) {
    parts.push(chunk("PLTE", Buffer.from(palette.flatMap((p) => p.slice(0, 3)))));
    const t = palette.filter((p) => p.length > 3).map((p) => p[3]);
    if (t.length) parts.push(chunk("tRNS", Buffer.from(t)));
  }
  parts.push(chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/**
 * pypng png.Reader(bytes).read(): { width, height, rows: Uint8Array|number[][] (samples), info: { bitdepth, planes, greyscale, alpha, palette? } }.
 * info.palette follows pypng's Reader.palette(): 3-tuples, or 4-tuples padded with 255 when tRNS exists.
 */
export function readPng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("PNG file has invalid signature");
  let off = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("latin1", off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== buf.readUInt32BE(off + 8 + len)) throw new Error(`Checksum error in ${type} chunk`);
    off += 12 + len;
    if (type === "IHDR") ihdr = data; else if (type === "PLTE") plte = data; else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data); else if (type === "IEND") break;
  }
  if (!ihdr) throw new Error("IHDR missing");
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4), bitdepth = ihdr[8], colorType = ihdr[9], interlace = ihdr[12];
  if (interlace) throw new Error("interlaced PNGs are not supported");
  const planes = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!planes) throw new Error(`bad colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPerPixel = bitdepth * planes, bpp = Math.max(1, bitsPerPixel >> 3), rowBytes = Math.ceil(width * bitsPerPixel / 8);
  let prev = Buffer.alloc(rowBytes);
  const rows = [];
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (rowBytes + 1)];
    const line = Buffer.from(raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1)));
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (ft !== 0) throw new Error(`bad filter type ${ft}`);
      line[i] = v & 0xff;
    }
    prev = line;
    const n = width * planes, row = new Array(n);
    if (bitdepth === 8) for (let i = 0; i < n; i++) row[i] = line[i];
    else if (bitdepth === 16) for (let i = 0; i < n; i++) row[i] = line.readUInt16BE(i * 2);
    else { const per = 8 / bitdepth, mask = (1 << bitdepth) - 1; for (let i = 0; i < n; i++) row[i] = (line[(i / per) | 0] >> (8 - bitdepth * ((i % per) + 1))) & mask; }
    rows.push(row);
  }
  const info = { bitdepth, planes, greyscale: colorType === 0 || colorType === 4, alpha: colorType === 4 || colorType === 6 };
  if (colorType === 3) {
    if (!plte) throw new Error("Required PLTE chunk is missing in colour type 3 image.");
    const pal = [];
    for (let i = 0; i < plte.length; i += 3) pal.push([plte[i], plte[i + 1], plte[i + 2]]);
    if (trns) pal.forEach((p, i) => p.push(i < trns.length ? trns[i] : 255));
    info.palette = pal;
  }
  return { width, height, rows, info };
}
