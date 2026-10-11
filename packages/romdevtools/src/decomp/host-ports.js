// host-ports.js - JS ports of the small host programs decomp builds call
// around the compiler, so a project's recipe runs without them:
//   n64crc            fix the N64 header CRC1/CRC2 (the ROM step)
//   set_o32abi_bit    set EF_MIPS_ABI_O32 in an ELF header (libultra ll.o)
//   iconv             UTF-8 -> SHIFT-JIS / EUC-JP / EUC-CN (glibc's tables) and latin1/UTF-8
//   unifiedDiff       `diff -u` for integration patches
//   incFromBin / msgReencode / n64ChecksumUpdate / romCompress
//                     decompals-style build scripts (inc_from_bin.py,
//                     msg_reencoder.py, checksummer.py, rom_compressor.py)
import { readFileSync, writeFileSync } from "node:fs";
import { iconvEncode, tableName } from "./iconv-tables.js";

// -- n64crc --------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf, off, len) {
  let c = 0xffffffff;
  for (let i = off; i < off + len; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (~c) >>> 0;
}
const CHECKSUM_START = 0x1000, CHECKSUM_LENGTH = 0x100000;
const SEEDS = { 6101: 0xf8ca4ddc, 6102: 0xf8ca4ddc, 6103: 0xa3886759, 6105: 0xdf26f436, 6106: 0x1fea617a };

/** The boot chip the IPL3 in a ROM expects (as n64crc identifies it). */
export function n64Cic(rom) {
  switch (crc32(rom, 0x40, 0x1000 - 0x40)) {
    case 0x6170a4a1: return 6101;
    case 0x90bb6cb5: return 6102;
    case 0x0b050ee0: return 6103;
    case 0x98bc2c86: return 6105;
    case 0xacc8580a: return 6106;
    default: return 6105;
  }
}

/** [crc1, crc2] for a big-endian (z64) ROM image. */
export function n64Checksum(rom) {
  if (rom.length < CHECKSUM_START + CHECKSUM_LENGTH) throw new Error(`ROM too small for the N64 checksum (${rom.length} bytes)`);
  const cic = n64Cic(rom);
  const seed = SEEDS[cic];
  let t1 = seed, t2 = seed, t3 = seed, t4 = seed, t5 = seed, t6 = seed;
  const be = (o) => ((rom[o] << 24) | (rom[o + 1] << 16) | (rom[o + 2] << 8) | rom[o + 3]) >>> 0;
  for (let i = CHECKSUM_START; i < CHECKSUM_START + CHECKSUM_LENGTH; i += 4) {
    const d = be(i);
    if (((t6 + d) >>> 0) < t6) t4 = (t4 + 1) >>> 0;
    t6 = (t6 + d) >>> 0;
    t3 = (t3 ^ d) >>> 0;
    const s = d & 0x1f;
    const r = s ? ((d << s) | (d >>> (32 - s))) >>> 0 : d;
    t5 = (t5 + r) >>> 0;
    if (t2 > d) t2 = (t2 ^ r) >>> 0;
    else t2 = (t2 ^ t6 ^ d) >>> 0;
    if (cic === 6105) t1 = (t1 + ((be(0x40 + 0x0710 + (i & 0xff)) ^ d) >>> 0)) >>> 0;
    else t1 = (t1 + ((t5 ^ d) >>> 0)) >>> 0;
  }
  if (cic === 6103) return [(((t6 ^ t4) >>> 0) + t3) >>> 0, (((t5 ^ t2) >>> 0) + t1) >>> 0];
  if (cic === 6106) return [((Math.imul(t6, t4) >>> 0) + t3) >>> 0, ((Math.imul(t5, t2) >>> 0) + t1) >>> 0];
  return [(t6 ^ t4 ^ t3) >>> 0, (t5 ^ t2 ^ t1) >>> 0];
}

/** `n64crc <rom>`: rewrite CRC1/CRC2 in place. Returns the tool's report text. */
export function n64crcFile(file) {
  const rom = readFileSync(file);
  const cic = n64Cic(rom);
  const [c1, c2] = n64Checksum(rom);
  const h = (v) => "0x" + v.toString(16).toUpperCase().padStart(8, "0");
  let out = `BootChip: CIC-NUS-${cic}\n`;
  const old1 = rom.readUInt32BE(0x10), old2 = rom.readUInt32BE(0x14);
  out += `CRC 1: ${h(old1)}  Calculated: ${h(c1)} ${old1 === c1 ? "(Good)" : "(Bad, fixed)"}\n`;
  out += `CRC 2: ${h(old2)}  Calculated: ${h(c2)} ${old2 === c2 ? "(Good)" : "(Bad, fixed)"}\n`;
  if (old1 !== c1 || old2 !== c2) {
    rom.writeUInt32BE(c1, 0x10);
    rom.writeUInt32BE(c2, 0x14);
    writeFileSync(file, rom);
  }
  return out;
}

// -- set_o32abi_bit ------------------------------------------------------
/** OR EF_MIPS_ABI_O32 (0x1000) into a big-endian ELF's e_flags. */
export function setO32AbiBit(file) {
  const b = readFileSync(file);
  if (b.readUInt32BE(0) !== 0x7f454c46) throw new Error("Error: Not an ELF file");
  b.writeUInt32BE((b.readUInt32BE(36) | 0x00001000) >>> 0, 36);
  writeFileSync(file, b);
}

// -- iconv ---------------------------------------------------------------
function normEnc(e) { return String(e ?? "").toLowerCase().replace(/[_-]/g, ""); }

/** `iconv --from-code=X --to-code=Y` over a buffer (the encodings decomp builds use). */
export function iconv(input, from, to) {
  const f = normEnc(from), t = normEnc(to);
  let text;
  if (f === "utf8") text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  else if (f === "latin1" || f === "iso88591") text = Buffer.from(input).toString("latin1");
  else if (f === "eucjp") text = new TextDecoder("euc-jp", { fatal: true }).decode(input);
  else if (f === "ascii" || f === "") text = Buffer.from(input).toString("latin1");
  else throw new Error(`iconv: unsupported source encoding ${from}`);
  if (tableName(to)) return iconvEncode(text, to);
  if (t === "utf8") return Buffer.from(text, "utf8");
  if (t === "latin1" || t === "iso88591" || t === "ascii") return Buffer.from(text, "latin1");
  throw new Error(`iconv: unsupported target encoding ${to}`);
}

/** Parse iconv's argv (-f/-t, --from-code/--to-code, = or separate). */
export function parseIconvArgs(args) {
  let from = null, to = null;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let m;
    if ((m = /^--from-code=(.*)$/.exec(a))) from = m[1];
    else if ((m = /^--to-code=(.*)$/.exec(a))) to = m[1];
    else if (a === "-f" || a === "--from-code") from = args[++i];
    else if (a === "-t" || a === "--to-code") to = args[++i];
    else if (/^-f./.test(a)) from = a.slice(2);
    else if (/^-t./.test(a)) to = a.slice(2);
    else if (!a.startsWith("-")) files.push(a);
  }
  return { from, to, files };
}

// -- unified diff --------------------------------------------------------
/**
 * `diff -u --label a --label b` of two texts (Myers' O(ND) edit script, three
 * lines of context, GNU hunk headers). Returns "" when the texts are equal.
 */
export function unifiedDiff(aText, bText, { labelA = "a", labelB = "b", context = 3 } = {}) {
  const split = (t) => { const l = t.split("\n"); if (l[l.length - 1] === "") l.pop(); return l; };
  const a = split(aText), b = split(bText);
  const aNoNl = aText.length && !aText.endsWith("\n"), bNoNl = bText.length && !bText.endsWith("\n");
  // A final line without its newline is a different line from the same text with one (as in GNU diff).
  const key = (lines, noNl) => lines.map((l, i) => (noNl && i === lines.length - 1 ? l + "\u0000" : l));
  const ops = myers(key(a, aNoNl), key(b, bNoNl)); // [{op:' '|'-'|'+', a:index|null, b:index|null}]
  if (!ops.some((o) => o.op !== " ")) return "";
  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  // Change runs; runs closer than 2*context lines share a hunk.
  const changed = [];
  for (let i = 0; i < ops.length; i++) if (ops[i].op !== " ") changed.push(i);
  const groups = [];
  for (const i of changed) {
    const g = groups[groups.length - 1];
    if (g && i - g.last - 1 <= 2 * context) g.last = i;
    else groups.push({ first: i, last: i });
  }
  // Lines of each file before op index j.
  const aBefore = [0], bBefore = [0];
  for (const o of ops) { aBefore.push(aBefore[aBefore.length - 1] + (o.op !== "+" ? 1 : 0)); bBefore.push(bBefore[bBefore.length - 1] + (o.op !== "-" ? 1 : 0)); }
  const range = (before, count) => (count === 0 ? `${before},0` : count === 1 ? `${before + 1}` : `${before + 1},${count}`);
  for (const g of groups) {
    const start = Math.max(0, g.first - context), end = Math.min(ops.length, g.last + 1 + context);
    const aCount = aBefore[end] - aBefore[start], bCount = bBefore[end] - bBefore[start];
    out.push(`@@ -${range(aBefore[start], aCount)} +${range(bBefore[start], bCount)} @@`);
    for (const o of ops.slice(start, end)) {
      out.push(o.op + (o.op === "+" ? b[o.b] : a[o.a]));
      const lastA = o.op !== "+" && o.a === a.length - 1 && aNoNl;
      const lastB = o.op !== "-" && o.b === b.length - 1 && bNoNl;
      if (lastA || lastB) out.push("\\ No newline at end of file");
    }
  }
  return out.join("\n") + "\n";
}

function myers(a, b) {
  const n = a.length, m = b.length, max = n + m;
  const v = new Map([[1, 0]]);
  const trace = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) x = v.get(k + 1) ?? 0;
      else x = (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }
  // Backtrack.
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && (vv.get(k - 1) ?? -1) < (vv.get(k + 1) ?? -1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv.get(prevK) ?? 0, prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ op: " ", a: x - 1, b: y - 1 }); x--; y--; }
    if (d > 0) {
      if (x === prevX) ops.push({ op: "+", a: null, b: y - 1 });
      else ops.push({ op: "-", a: x - 1, b: null });
    }
    x = prevX; y = prevY;
  }
  ops.reverse();
  // GNU diff prints deletions before insertions within a change block.
  const out = [];
  for (let i = 0; i < ops.length;) {
    if (ops[i].op === " ") { out.push(ops[i++]); continue; }
    const dels = [], adds = [];
    while (i < ops.length && ops[i].op !== " ") (ops[i].op === "-" ? dels : adds).push(ops[i++]);
    out.push(...dels, ...adds);
  }
  return out;
}

// -- N64 texture sheets / asset containers (a project's font_texture.py +
// build_font_container.py) ----------------------------------------------
const CHANNEL5 = Array.from({ length: 32 }, (_, v) => (v << 3) | (v >> 2));
const CHANNEL5_INVERSE = new Map(CHANNEL5.map((v, i) => [v, i]));

/**
 * Decode a PNG to RGBA8 rows, as pypng's Reader.asRGBA8() does (palette and
 * grey expanded, alpha added as 255, other bit depths rescaled to 8).
 */
export async function pngRgba8(file) {
  const { PNG } = await import("pngjs");
  const png = PNG.sync.read(readFileSync(file));
  return { width: png.width, height: png.height, data: Buffer.from(png.data.buffer, png.data.byteOffset, png.width * png.height * 4) };
}

/** encode(source, fmt) of font_texture.py: a PNG sheet to linear ia8/rgba16/rgba32 bytes. */
export async function encodeTexture(file, fmt) {
  const { width, height, data } = await pngRgba8(file);
  if (fmt === "rgba32") return { width, height, data: Buffer.from(data) };
  const out = Buffer.alloc(width * height * (fmt === "rgba16" ? 2 : 1));
  for (let p = 0; p < width * height; p++) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2], a = data[p * 4 + 3];
    if (fmt === "rgba16") {
      if (![r, g, b].every((v) => CHANNEL5_INVERSE.has(v)) || (a !== 0 && a !== 255)) throw new Error("RGBA16 requires expanded 5-bit RGB and binary alpha");
      out.writeUInt16BE((CHANNEL5_INVERSE.get(r) << 11) | (CHANNEL5_INVERSE.get(g) << 6) | (CHANNEL5_INVERSE.get(b) << 1) | (a === 255 ? 1 : 0), p * 2);
    } else if (fmt === "ia8") {
      if (r !== g || r !== b || r % 17 || a % 17) throw new Error("IA8 requires gray RGB and intensity/alpha multiples of 17");
      out[p] = ((r / 17) << 4) | (a / 17);
    } else throw new Error(`Unsupported format: ${fmt}`);
  }
  return { width, height, data: out };
}

/**
 * build_font_container.py: concatenate a layout's raw ranges and encoded
 * texture sheets, checking every offset/size exactly as the Python does.
 */
export async function buildAssetContainer(layoutPath) {
  const manifest = JSON.parse(readFileSync(layoutPath, "utf8"));
  const dir = layoutPath.replace(/[^/]*$/, "");
  const parts = [];
  let len = 0;
  for (const seg of manifest.segments) {
    if (seg.offset !== len) throw new Error("Asset ranges must be contiguous and ordered");
    const source = dir + seg.file;
    let data;
    if (seg.format === "raw") data = readFileSync(source);
    else if (["ia8", "rgba16", "rgba32"].includes(seg.format)) {
      const t = await encodeTexture(source, seg.format);
      if (t.width !== seg.width || t.height !== seg.height) throw new Error(`Incorrect texture sheet dimensions: ${source}`);
      data = t.data;
    } else throw new Error(`Unsupported format: ${seg.format}`);
    if (data.length !== seg.size) throw new Error(`Incorrect asset size: ${source}`);
    parts.push(data);
    len += data.length;
  }
  if (len !== manifest.size) throw new Error("Incorrect container size");
  return Buffer.concat(parts);
}

// -- decompals-style N64 build scripts ---------------------------------------

/** inc_from_bin.py: bytes as a C initializer, 8 per line with offsets. */
export function incFromBin(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const off = i.toString(16).toUpperCase().padStart(6, "0");
    if (i === 0) out += `    /* 0x${off} */`;
    else if (i % 8 === 0) out += `\n    /* 0x${off} */`;
    out += ` 0x${bytes[i].toString(16).toUpperCase().padStart(2, "0")},`;
  }
  return out;
}

/**
 * msg_reencoder.py: re-encode the contents of every C string literal in cpp
 * output to `encoding` (glibc's table for the Japanese/Chinese charsets),
 * writing non-printable bytes as "\xNN""" escapes. The first line and cpp's
 * `# line` markers pass through untouched.
 */
export function msgReencode(inputText, encoding) {
  let prev = inputText.indexOf("\n") + 1;
  let out = inputText.slice(0, prev);
  for (;;) {
    let index = inputText.indexOf('"', prev);
    if (index === -1) break;
    const lineInfo = inputText.slice(prev, index).indexOf("\n# ");
    if (lineInfo !== -1) {
      index = inputText.indexOf("\n", index + 1) + 1;
      out += inputText.slice(prev, index);
      prev = index;
      continue;
    }
    out += inputText.slice(prev, index);
    prev = index + 1;
    index = inputText.indexOf('"', prev);
    if (index === -1) break;
    const contents = inputText.slice(prev, index);
    out += '"';
    for (const c of encodeText(contents, encoding)) {
      out += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : `\\x${c.toString(16).toUpperCase().padStart(2, "0")}""`;
    }
    out += '"';
    prev = index + 1;
  }
  out += inputText.slice(prev);
  for (let i = 0; i < out.length; i++) if (out.charCodeAt(i) > 0x7f) throw new Error(`msg_reencoder: output is not ASCII at offset ${i}`);
  return out;
}

function encodeText(text, encoding) {
  if (tableName(encoding)) return iconvEncode(text, encoding);
  const n = String(encoding).toLowerCase().replace(/[_-]/g, "");
  if (n === "utf8") return Buffer.from(text, "utf8");
  if (n === "ascii") {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) throw new Error(`cannot encode U+${text.charCodeAt(i).toString(16)} as ASCII`);
    return Buffer.from(text, "latin1");
  }
  throw new Error(`no encoder for ${encoding}`);
}

// The IPL3s romdev's checksum implements (n64Cic's table without its default).
const KNOWN_IPL3 = new Set([0x6170a4a1, 0x90bb6cb5, 0x0b050ee0, 0x98bc2c86, 0xacc8580a]);

/**
 * checksummer.py (ipl3checksum): write CRC1/CRC2 for the ROM's IPL3 at 0x10.
 * The script falls back to 6102 for an IPL3 ipl3checksum does not know; an
 * IPL3 outside the five this port knows is refused rather than guessed, since
 * ipl3checksum recognises more kinds (7102, 8303, ...) than the five here.
 */
export function n64ChecksumUpdate(rom) {
  if (rom.length < 0x101000) throw new Error(`ROM is too small: 0x${rom.length.toString(16).toUpperCase()}`);
  if (!KNOWN_IPL3.has(crc32(rom, 0x40, 0x1000 - 0x40))) throw new Error("checksummer: this ROM's IPL3 is not one of CIC 6101/6102/6103/6105/6106 (the kinds romdev's port implements)");
  const [c1, c2] = n64Checksum(rom);
  const out = Buffer.from(rom);
  out.writeUInt32BE(c1, 0x10);
  out.writeUInt32BE(c2, 0x14);
  return out;
}

function elf32(buf) {
  if (buf.readUInt32BE(0) !== 0x7f454c46 || buf[4] !== 1 || buf[5] !== 2) throw new Error("not a 32-bit big-endian ELF");
  const shoff = buf.readUInt32BE(0x20), shentsize = buf.readUInt16BE(0x2e), shnum = buf.readUInt16BE(0x30), shstrndx = buf.readUInt16BE(0x32);
  const sections = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    sections.push({ nameOff: buf.readUInt32BE(o), type: buf.readUInt32BE(o + 4), flags: buf.readUInt32BE(o + 8), addr: buf.readUInt32BE(o + 12), offset: buf.readUInt32BE(o + 16), size: buf.readUInt32BE(o + 20) });
  }
  const cstr = (base, off) => { let e = base + off; while (buf[e]) e++; return buf.toString("latin1", base + off, e); };
  const shstr = sections[shstrndx];
  for (const s of sections) s.name = cstr(shstr.offset, s.nameOff);
  const symtab = sections.find((s) => s.name === ".symtab" && s.type === 2);
  const strtab = sections.find((s) => s.name === ".strtab" && s.type === 3);
  return { sections, symtab, strtab, cstr };
}

/** compression_common.readSegmentsCsv */
export function readSegmentsCsv(text, version) {
  const dict = new Map();
  const rows = text.split(/\r?\n/).map((l) => (l.length ? l.split(",") : []));
  let header = true;
  for (const row of rows) {
    if (header) { header = false; continue; }
    if (row.length === 0) continue;
    if (row.length !== 6) throw new Error(`segments csv: expected 6 columns, got ${row.length}`);
    const [name, start, end, hash, level, tool] = row;
    dict.set(`.${name}`, { segmentName: name, compressedRomOffset: Number(start), compressedRomOffsetEnd: Number(end), uncompressedHash: hash, compressionLevel: parseInt(level, 10), compressionTool: tool, compressedPath: `bin/${version}/compressed_segments/${name}_compressed.bin` });
  }
  return dict;
}

/**
 * rom_compressor.py: rebuild the compressed ROM from the uncompressed one and
 * its ELF. `gzip(bytes, level, smallMem)` is crunch64's gzip and
 * `zlibRaw(bytes, level)` vanilla zlib's raw deflate (romdev runs both as
 * WASM); each returns (a promise of) the compressed bytes.
 */
export async function romCompress({ inRom, elf, segmentsCsv, version, padRom, cwd, gzip, zlibRaw }) {
  const { createHash } = await import("node:crypto");
  const md5 = (b) => createHash("md5").update(b).digest("hex");
  const segs = readSegmentsCsv(segmentsCsv, version);
  const e = elf32(elf);
  if (!e.symtab || !e.strtab) throw new Error("The elf->z64 process and compression algorithm requires a symtab and a strtab");
  const out = [];
  let outLen = 0, offset = 0, sizeWrote = 0;
  const segmentOffsets = new Map(), rels = new Map(), romOffsetValues = new Map();
  const align = (v, n) => (v + (n - 1)) & ~(n - 1);
  const log = [];
  for (const sec of e.sections) {
    if (sec.type === 9 /* REL */) {
      if (!segs.has(sec.name)) {
        const referenced = sec.name.replace(".rel.", ".");
        for (let o = sec.offset; o < sec.offset + sec.size; o += 8) {
          const rOffset = elf.readUInt32BE(o), info = elf.readUInt32BE(o + 4);
          const sym = e.symtab.offset + (info >>> 8) * 16;
          const symName = e.cstr(e.strtab.offset, elf.readUInt32BE(sym));
          if (symName.endsWith("_ROM_START") || symName.endsWith("_ROM_END")) {
            const seg = segmentOffsets.get(referenced);
            if (!seg) throw new Error(`relocation in ${sec.name} against ${symName} before its segment`);
            rels.set(rOffset - seg[1] + seg[0], [symName, info & 0xff]);
          }
        }
      }
    }
    if (sec.type !== 1 /* PROGBITS */) continue;
    if (!(sec.flags & 2) /* ALLOC */) continue;
    segmentOffsets.set(sec.name, [offset, sec.addr]);
    const romStart = `${sec.name.slice(1)}_ROM_START`, romEnd = `${sec.name.slice(1)}_ROM_END`;
    const offsetStart = sizeWrote;
    let offsetEnd;
    const entry = segs.get(sec.name);
    const bytes = inRom.subarray(offset, offset + sec.size);
    if (bytes.length !== sec.size) throw new Error(`'${sec.name}': 0x${bytes.length.toString(16)} 0x${sec.size.toString(16)}`);
    if (!entry) {
      offsetEnd = sec.size + offsetStart;
      out.push(Buffer.from(bytes)); outLen += bytes.length;
      sizeWrote += sec.size;
    } else {
      let comp;
      if (entry.compressionTool === "reuse_original") {
        const h = md5(bytes);
        if (h === entry.uncompressedHash) comp = [...fs_read(cwd, entry.compressedPath)];
        else {
          log.push(`Segment '${sec.name}' doesn't match, should have hash '${entry.uncompressedHash}' but has hash '${h}'.\nCompressing...\n`);
          comp = [...(await zlibFramed(bytes, entry.compressionLevel, zlibRaw))];
        }
      } else if (entry.compressionTool === "gzip" || entry.compressionTool === "gzip_smallmem") {
        comp = [...(await gzip(bytes, entry.compressionLevel, entry.compressionTool === "gzip_smallmem"))];
      } else if (entry.compressionTool === "zlib") {
        comp = [...(await zlibFramed(bytes, entry.compressionLevel, zlibRaw))];
      } else throw new Error(`Unknown compression tool: ${entry.compressionTool}`);
      while (comp.length % 0x10 !== 0) {
        const i = comp.length - 0x2000;
        comp.push(i > 0 && version !== "cn" ? comp[i] : 0);
      }
      offsetEnd = offsetStart + comp.length;
      const b = Buffer.from(comp);
      out.push(b); outLen += b.length;
      sizeWrote += comp.length;
    }
    romOffsetValues.set(romStart, offsetStart);
    romOffsetValues.set(romEnd, offsetEnd);
    offset += align(sec.size, 0x10);
  }
  if (padRom) {
    const [aligned, fill] = version === "cn" ? [align(sizeWrote, 0x2000), 0x00] : [align(sizeWrote, 0x100000), 0xff];
    out.push(Buffer.alloc(aligned - sizeWrote, fill));
  }
  const rom = Buffer.concat(out);
  for (const [relRomOffset, [symName, rType]] of rels) {
    const value = romOffsetValues.get(symName);
    if (value === undefined) throw new Error(`no ROM offset for ${symName}`);
    let hi = value >>> 16;
    const lo = value & 0xffff;
    if (lo >= 0x8000) hi += 1;
    if (rType === 5) rom.writeUInt16BE(hi & 0xffff, relRomOffset + 2);
    else if (rType === 6) rom.writeUInt16BE(lo, relRomOffset + 2);
    else if (rType === 2) rom.writeUInt32BE(value >>> 0, relRomOffset);
    else throw new Error(`relocation type ${rType} against ${symName}`);
  }
  return { rom, log: log.join("") };
}

function fs_read(cwd, rel) {
  const b = readFileSync(cwd ? `${cwd}/${rel}` : rel);
  if (!b.length) throw new Error(`'${rel}' could not be opened`);
  return b;
}

/** compression_common.compressZlib: raw deflate + crc32 + size, little-endian. */
async function zlibFramed(bytes, level, zlibRaw) {
  const d = await zlibRaw(bytes, level);
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(crc32(bytes, 0, bytes.length), 0);
  tail.writeUInt32LE(bytes.length >>> 0, 4);
  return Buffer.concat([d, tail]);
}
