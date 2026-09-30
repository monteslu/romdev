// setup-ports.js - JS ports of the Python scripts decomp projects run while
// SETTING UP a checkout (turning the base ROM into what splat and the build
// expect), so `make setup` / `make extract` run without Python:
//
//   romDecompress              tools/compressor/rom_decompressor.py
//   extractCompressedSegments  tools/compressor/extract_compressed_segments.py
//                              (both over compression_common.py's segments csv)
//   mio0Extract                tools/mio0_extract.py
//
// Each port reproduces the script's observable behaviour: the same output
// files (bytes and paths), the same stdout lines, the same refusals. Values a
// script hard-codes about one game (expected ROM hashes, block offsets) are
// read from the script's own source, whose exact bytes recipe.js pins by
// sha256, so no ROM-derived data lives in romdev.
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { readSegmentsCsv } from "./host-ports.js";

const hex = (v, w) => v.toString(16).toUpperCase().padStart(w, "0");

/**
 * compression_common.decompressZlib: a raw deflate stream (wbits -15). Like
 * zlib.decompressobj, anything after the end of the stream is ignored.
 */
export function inflateRaw(data) {
  return inflateRawSync(data, { finishFlush: 2 /* Z_SYNC_FLUSH */ });
}

/**
 * The expected base ROM md5 per version, as rom_decompressor.py's
 * BASEROM_HASHES dict spells it.
 * @param {string} source the script's text
 */
export function parseBaseromHashes(source) {
  const m = /^BASEROM_HASHES\s*=\s*\{([^}]*)\}/m.exec(source);
  if (!m) throw new Error("BASEROM_HASHES not found in rom_decompressor.py");
  const out = {};
  for (const e of m[1].matchAll(/"([^"]+)"\s*:\s*"([0-9a-fA-F]+)"/g)) out[e[1]] = e[2];
  return out;
}

/**
 * rom_decompressor.py: rebuild the uncompressed ROM. Every csv segment is
 * inflated; the gaps between segments (and before the first / after the
 * last) are copied as-is; each piece is zero-padded to 0x10.
 * @param {{inRom:Buffer, segmentsCsv:string, version:string, baseromHashes:Record<string,string>}} o
 * @returns {{rom:Buffer, log:string}}
 */
export function romDecompress({ inRom, segmentsCsv, version, baseromHashes }) {
  const segs = [...readSegmentsCsv(segmentsCsv, version).values()];
  if (!inRom.length) throw new Error("the input ROM could not be opened");
  const got = createHash("md5").update(inRom).digest("hex");
  if (!(version in baseromHashes)) throw new Error(`KeyError: '${version}'`);
  if (got !== baseromHashes[version]) throw new Error(`Baserom's hash differs\n Expected '${baseromHashes[version]}', got '${got}'`);
  const byStart = (a, b) => a.compressedRomOffset - b.compressedRomOffset;
  const sorted = [...segs].sort(byStart);
  const gap = (start, end) => ({ compressedRomOffset: start, compressedRomOffsetEnd: end, compressed: false });
  const gaps = [];
  if (sorted[0].compressedRomOffset !== 0) gaps.push(gap(0, sorted[0].compressedRomOffset));
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].compressedRomOffsetEnd !== sorted[i + 1].compressedRomOffset) gaps.push(gap(sorted[i].compressedRomOffsetEnd, sorted[i + 1].compressedRomOffset));
  }
  const last = sorted[sorted.length - 1];
  if (last.compressedRomOffsetEnd !== inRom.length) gaps.push(gap(last.compressedRomOffsetEnd, inRom.length));
  const all = [...sorted.map((s) => ({ ...s, compressed: true })), ...gaps].sort(byStart);
  const out = [];
  let offset = 0, log = "";
  for (const e of all) {
    const bytes = inRom.subarray(e.compressedRomOffset, Math.max(e.compressedRomOffset, e.compressedRomOffsetEnd));
    const range = `Range [0x${hex(e.compressedRomOffset, 6)}:0x${hex(e.compressedRomOffsetEnd, 6)}]`;
    let piece;
    if (e.compressed) {
      log += `${range}: Decompressing at offset 0x${hex(offset, 6)}\n`;
      piece = inflateRaw(bytes);
    } else {
      log += `${range}: Writing as-is at offset 0x${hex(offset, 6)}\n`;
      piece = bytes;
    }
    const padded = Buffer.alloc((piece.length + 0xf) & ~0xf);
    padded.set(piece);
    out.push(padded);
    offset += padded.length;
  }
  return { rom: Buffer.concat(out), log };
}

/**
 * extract_compressed_segments.py: each csv segment's compressed bytes, to
 * bin/<version>/compressed_segments/<name>_compressed.bin (relative paths,
 * in csv order; a repeated name keeps its last row's range at its first
 * position, as the script's dict does).
 * @returns {{files:Array<{path:string, bytes:Buffer}>, log:string}}
 */
export function extractCompressedSegments({ inRom, segmentsCsv, version }) {
  if (!inRom.length) throw new Error("the input ROM could not be opened");
  const files = [];
  let log = "";
  for (const e of readSegmentsCsv(segmentsCsv, version).values()) {
    log += `Extracting ${e.compressedPath}\n`;
    files.push({ path: e.compressedPath, bytes: Buffer.from(inRom.subarray(e.compressedRomOffset, Math.max(e.compressedRomOffset, e.compressedRomOffsetEnd))) });
  }
  return { files, log };
}

// -- mio0_extract.py -----------------------------------------------------

/** The `target_mio0_offsets = [...]` list from mio0_extract.py's source. */
export function parseMio0Offsets(source) {
  const m = /^\s*target_mio0_offsets\s*=\s*\[([^\]]*)\]/m.exec(source);
  if (!m) throw new Error("target_mio0_offsets not found in mio0_extract.py");
  return [...m[1].matchAll(/0[xX][0-9a-fA-F]+|\d+/g)].map((x) => Number(x[0]));
}

/**
 * mio0_extract.py's decompress_mio0, quirks included: the input is the (up to
 * 64 KiB) window the script cut, a stream that runs out of bitstream, raw or
 * back-reference bytes stops early instead of failing, and a back-reference
 * may overshoot the declared size by up to its length.
 * Throws {mio0Error:true} where the script raises ValueError.
 */
export function mio0DecompressScript(data) {
  const valueError = (msg) => Object.assign(new Error(msg), { mio0Error: true });
  if (data.length < 4 || data.toString("latin1", 0, 4) !== "MIO0") throw valueError("Not a valid MIO0 file");
  if (data.length < 16) throw new Error("struct.error: unpack requires a buffer of 4 bytes");
  const size = data.readUInt32BE(4), compOff = data.readUInt32BE(8), rawOff = data.readUInt32BE(12);
  const slice = (a, b) => data.subarray(Math.min(a, data.length), Math.max(Math.min(a, data.length), Math.min(b, data.length)));
  const bits = slice(16, compOff), comp = slice(compOff, rawOff), raw = slice(rawOff, data.length);
  const out = [];
  let bit = 0, ci = 0, ri = 0;
  while (out.length < size) {
    if ((bit >> 3) >= bits.length) break;
    const b = (bits[bit >> 3] >> (7 - (bit & 7))) & 1;
    bit++;
    if (b === 1) {
      if (ri >= raw.length) break;
      out.push(raw[ri++]);
    } else {
      if (ci + 2 > comp.length) break;
      const cmd = (comp[ci] << 8) | comp[ci + 1];
      ci += 2;
      const len = ((cmd >> 12) & 0xf) + 3, dist = (cmd & 0xfff) + 1;
      if (dist > out.length) throw valueError("Invalid MIO0 backreference distance");
      for (let k = 0; k < len; k++) out.push(out[out.length - dist]);
    }
  }
  return Buffer.from(out);
}

/**
 * mio0_extract.py <rom>: for each listed offset holding a MIO0 header, write
 * the 64 KiB window from there to mio0/mio0_extracted/mio0_<OFF>.bin and its
 * decompression to mio0/mio0_decompressed/decompressed_<OFF>.bin (relative
 * paths, in list order; a block that fails to decompress keeps only the
 * window and logs the error, as the script does).
 * @param {{rom:Buffer, offsets:number[]}} o
 * @returns {{files:Array<{path:string, bytes:Buffer}>, dirs:string[], log:string}}
 */
export function mio0Extract({ rom, offsets }) {
  const outDir = "mio0/mio0_extracted", decDir = "mio0/mio0_decompressed";
  const files = [];
  let log = "", extracted = 0;
  for (const off of offsets) {
    const window = Buffer.from(rom.subarray(Math.min(off, rom.length), Math.min(off + 0x10000, rom.length)));
    if (window.length < 4 || window.toString("latin1", 0, 4) !== "MIO0") continue;
    files.push({ path: `${outDir}/mio0_${hex(off, 8)}.bin`, bytes: window });
    extracted++;
    try {
      const dec = mio0DecompressScript(window);
      const p = `${decDir}/decompressed_${hex(off, 8)}.bin`;
      files.push({ path: p, bytes: dec });
      log += `[SUCCESS] Decompressed file saved: ${p}\n`;
    } catch (e) {
      if (!e.mio0Error) throw e;
      log += `[ERROR] Failed to decompress MIO0 block at ${hex(off, 8)}: ${e.message}\n`;
    }
  }
  log += "\n--- Extraction and Decompression Complete ---\n";
  log += `Extracted and decompressed ${extracted} MIO0 blocks.\n`;
  return { files, dirs: [outDir, decDir], log };
}
