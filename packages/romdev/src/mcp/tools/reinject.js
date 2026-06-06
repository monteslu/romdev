// Re-inject path — the round-trip side of a ROM hack. You've FOUND a compressed
// or referenced asset (watchDma/findWriter/callSubroutine); these tools put an
// EDITED copy back in a form the game accepts:
//
//   findPointerTo   — scan a ROM for pointers that reference a byte offset, so you
//                     can redirect the thing that loads it.
//   relocateBlock   — write edited bytes to free space and repoint a pointer at
//                     the new location (the safe "don't overwrite in place" move).
//   makeStoredBlock — emit bytes the game's OWN decompressor expands verbatim,
//                     using the common stored/literal/raw-copy escape — so you can
//                     edit tiles → wrap → patchFile without writing a compressor.
//
// All three are pure-byte / file-level (no emulator core needed). Pointer encoding
// and the stored-block format are per-system; the per-system facts live in the
// PLATFORM_POINTER and STORED_FORMAT tables below, sourced from each platform's
// dev wiki (citations inline).

import { readFile, writeFile } from "node:fs/promises";
import { jsonContent, safeTool } from "../util.js";

// ───────────────────────────────────────────────────────────────────────────
// Pointer encoding per platform.
//
// `toCpuForms(fileOffset, data)` returns the set of in-ROM pointer VALUES that
// would reference `fileOffset` — i.e. what findPointerTo searches the ROM for.
// A platform can have several forms (e.g. NES: the same PRG offset is visible at
// $8000 and $C000 depending on bank), so we return an array of {value, width,
// endian, note}.
//
// Each table entry is filled from the research findings (see commit message);
// formulas are the inverse of the map*Address helpers in disasm.js.
// ───────────────────────────────────────────────────────────────────────────

/** Encode an integer as width bytes in the given endianness. */
function encodeInt(value, width, endian) {
  const out = new Uint8Array(width);
  for (let i = 0; i < width; i++) {
    const shift = endian === "be" ? (width - 1 - i) * 8 : i * 8;
    out[i] = (value >>> shift) & 0xFF;
  }
  return out;
}

/** Find every offset in `data` where `needle` occurs (all, overlapping). */
function findAllOccurrences(data, needle) {
  const hits = [];
  if (needle.length === 0) return hits;
  outer: for (let i = 0; i + needle.length <= data.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (data[i + j] !== needle[j]) continue outer;
    }
    hits.push(i);
  }
  return hits;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-platform pointer-form generators.
//
// pointerForms(fileOffset, data) → array of { value, width, endian, note }.
// These are the candidate in-ROM pointer values that reference `fileOffset`.
// findPointerTo scans the ROM for the encoded bytes of each.
//
// Sources cited per platform (dev wikis); formulas are the inverse of the
// map*Address helpers in disasm.js. Banked 8-bit systems return MULTIPLE forms
// (a paged offset is visible at different CPU windows depending on bank), so a
// hit must usually be paired with the nearby bank-set — we report all candidates
// and the caller correlates.
// ───────────────────────────────────────────────────────────────────────────

/** iNES PRG file-offset → CPU-address pointer candidates. 16-bit LE. */
function nesPointerForms(fileOffset, data) {
  // iNES: 16B header (+512B trainer if byte6 bit2). PRG starts after header.
  const trainer = (data[6] & 0x04) ? 0x200 : 0;
  const prgStart = 0x10 + trainer;
  const prgSize = (data[4] || 0) * 0x4000;
  if (fileOffset < prgStart || fileOffset >= prgStart + prgSize) return [];
  const prgOff = fileOffset - prgStart;
  const forms = [];
  const lastBank16 = Math.max(0, prgSize / 0x4000 - 1);
  const bank16 = Math.floor(prgOff / 0x4000);
  const within16 = prgOff & 0x3FFF;
  // Switchable-window alias ($8000-$BFFF) — valid only when this bank is selected.
  forms.push({ value: 0x8000 + within16, width: 2, endian: "le",
    note: `bank ${bank16} mapped at $8000-$BFFF (switchable)` });
  // Fixed-last-bank alias ($C000-$FFFF) — stable, the most reliably referenced.
  if (bank16 === lastBank16) {
    forms.push({ value: 0xC000 + within16, width: 2, endian: "le",
      note: "last bank, fixed at $C000-$FFFF (stable alias)" });
  }
  // NROM 32KB: linear $8000-$FFFF.
  if (prgSize === 0x8000) {
    forms.push({ value: 0x8000 + prgOff, width: 2, endian: "le", note: "NROM 32KB linear" });
  }
  // MMC3 8KB fixed slots: 2nd-last @ $C000, last @ $E000.
  const bank8 = Math.floor(prgOff / 0x2000);
  const within8 = prgOff & 0x1FFF;
  const lastBank8 = Math.max(0, prgSize / 0x2000 - 1);
  if (bank8 === lastBank8) forms.push({ value: 0xE000 + within8, width: 2, endian: "le", note: "MMC3 last 8KB @ $E000" });
  if (bank8 === lastBank8 - 1) forms.push({ value: 0xC000 + within8, width: 2, endian: "le", note: "MMC3 2nd-last 8KB @ $C000" });
  return dedupeForms(forms);
}

/** GB/GBC ROM (file=address space) → CPU-address pointer candidates. 16-bit LE. */
function gbPointerForms(fileOffset, data) {
  if (fileOffset >= data.length) return [];
  const bank = Math.floor(fileOffset / 0x4000);
  if (bank === 0) {
    return [{ value: fileOffset, width: 2, endian: "le", note: "bank 0, fixed $0000-$3FFF" }];
  }
  return [{ value: 0x4000 + (fileOffset & 0x3FFF), width: 2, endian: "le",
    note: `bank ${bank} @ $4000-$7FFF (page-ambiguous — pair with the bank-set write)` }];
}

/** SMS/GG ROM (file=address space) → CPU-address pointer candidates. 16-bit LE. */
function smsPointerForms(fileOffset, data) {
  if (fileOffset >= data.length) return [];
  const page = Math.floor(fileOffset / 0x4000);
  const within = fileOffset & 0x3FFF;
  const forms = [];
  // First 1KB of page 0 is fixed in slot 0.
  if (page === 0 && within < 0x400) {
    forms.push({ value: within, width: 2, endian: "le", note: "page 0, fixed slot 0 ($0000-$03FF)" });
  }
  forms.push({ value: 0x4000 + within, width: 2, endian: "le", note: `page ${page} via slot 1 ($4000-$7FFF)` });
  forms.push({ value: 0x8000 + within, width: 2, endian: "le", note: `page ${page} via slot 2 ($8000-$BFFF)` });
  return dedupeForms(forms);
}

/** C64 .prg (2-byte LE load addr + data) → CPU-address pointer candidates. 16-bit LE. */
function c64PointerForms(fileOffset, data) {
  if (fileOffset < 2 || fileOffset >= data.length) return [];
  const loadAddr = data[0] | (data[1] << 8);
  const cpu = loadAddr + (fileOffset - 2);
  if (cpu > 0xFFFF) return [];
  return [{ value: cpu, width: 2, endian: "le", note: `load $${loadAddr.toString(16)} → CPU $${cpu.toString(16)}` }];
}

/** Lynx .lnx (64-byte header, primary segment at $0200) → CPU pointer candidates. 16-bit LE. */
function lynxPointerForms(fileOffset, data) {
  const hasHdr = data.length >= 64 && data[0] === 0x4c && data[1] === 0x59 && data[2] === 0x4e && data[3] === 0x58;
  const base = hasHdr ? 64 : 0;
  if (fileOffset < base) return [];
  const cpu = 0x0200 + (fileOffset - base);
  if (cpu > 0xFFFF) return [];
  return [{ value: cpu, width: 2, endian: "le", note: `primary segment @ $0200 → CPU $${cpu.toString(16)} (multi-segment carts need the per-segment base)` }];
}

/** Atari 2600 raw 4KB-bank cart → CPU pointer candidates ($F000-$FFFF, + masked $1FFF). 16-bit LE. */
function atari2600PointerForms(fileOffset, data) {
  if (fileOffset >= data.length) return [];
  const within = fileOffset & 0x0FFF;          // 4KB bank window
  const forms = [
    { value: 0xF000 + within, width: 2, endian: "le", note: "4KB bank @ $F000-$FFFF" },
    { value: 0x1000 + within, width: 2, endian: "le", note: "mirror @ $1000-$1FFF (A13-masked)" },
  ];
  return dedupeForms(forms);
}

/** Atari 7800 .a78 (128-byte header) → CPU pointer candidates. 16-bit LE. */
function atari7800PointerForms(fileOffset, data) {
  // Detect 128-byte header ("ATARI7800" magic at +1).
  const hasHdr = data.length > 128 &&
    String.fromCharCode(...data.slice(1, 10)) === "ATARI7800";
  const base = hasHdr ? 128 : 0;
  if (fileOffset < base) return [];
  const romOff = fileOffset - base;
  const romSize = data.length - base;
  const forms = [];
  // Non-banked image mapped at the top of memory (fixed bank holds vectors).
  const top = 0x10000 - romSize + romOff;
  if (top >= 0x4000 && top <= 0xFFFF) forms.push({ value: top, width: 2, endian: "le", note: "fixed top-of-memory mapping" });
  // SuperGame: 16KB bank at $8000-$BFFF; bank 7 fixed at $C000-$FFFF.
  const within16 = romOff & 0x3FFF;
  forms.push({ value: 0x8000 + within16, width: 2, endian: "le", note: `SuperGame bank ${romOff >> 14} @ $8000-$BFFF` });
  const lastBank = Math.max(0, Math.floor(romSize / 0x4000) - 1);
  if ((romOff >> 14) === lastBank) forms.push({ value: 0xC000 + within16, width: 2, endian: "le", note: "fixed bank @ $C000-$FFFF" });
  return dedupeForms(forms);
}

/** PC Engine HuCard → CPU pointer candidates (16-bit LE within an 8KB MPR page). */
function pcePointerForms(fileOffset, data) {
  // Strip a 512-byte copier header if present.
  const copier = (data.length % 1024 === 512) ? 512 : 0;
  const off = fileOffset - copier;
  if (off < 0 || off >= data.length - copier) return [];
  const bank = off >> 13;                       // 8KB physical bank
  const within = off & 0x1FFF;
  // The same physical byte is reachable through ANY MPR slot; the most common
  // data window for paged HuCard data is MPR-mapped at $4000-$5FFF or higher.
  // Report the within-page low pointer plus the bank, since the full address
  // needs the active MPR. Offer the common page bases.
  const forms = [];
  for (const pageBase of [0x4000, 0x6000, 0x8000, 0xA000]) {
    forms.push({ value: pageBase + within, width: 2, endian: "le",
      note: `physical bank $${bank.toString(16)} via an MPR mapped at $${pageBase.toString(16)} (track the TAMi bank-set)` });
  }
  return dedupeForms(forms);
}

/** MSX cartridge (16-byte "AB" header, page at $4000) → CPU pointer candidates. 16-bit LE. */
function msxPointerForms(fileOffset, data) {
  if (fileOffset >= data.length) return [];
  // Page-1 mapping ($4000) is the convention; page-2 ($8000) also occurs.
  const within = fileOffset & 0x3FFF;
  const bank = fileOffset >> 14;
  const forms = [
    { value: 0x4000 + within, width: 2, endian: "le", note: `bank ${bank} @ $4000-$7FFF (page 1)` },
    { value: 0x8000 + within, width: 2, endian: "le", note: `bank ${bank} @ $8000-$BFFF (page 2)` },
  ];
  return dedupeForms(forms);
}

/** Genesis ROM (1:1 at $000000, 68000 big-endian) → pointer candidates. 32-bit BE = offset. */
function genesisPointerForms(fileOffset, data) {
  if (fileOffset >= data.length) return [];
  // Pointer value == ROM offset (ROM maps 1:1 at $000000). 32-bit BE primary;
  // 24-bit BE secondary (rare, more false positives — flagged).
  const forms = [
    { value: fileOffset, width: 4, endian: "be", note: "32-bit BE absolute (= ROM offset, 1:1 at $000000)" },
  ];
  if (fileOffset <= 0xFFFFFF) {
    forms.push({ value: fileOffset, width: 3, endian: "be", note: "24-bit BE packed (rare; expect false positives)" });
  }
  return forms;
}

/** SNES ROM (LoROM/HiROM) → pointer candidates. 16-bit (bank-implied) LE + 24-bit long LE. */
function snesPointerForms(fileOffset, data, mapperHint) {
  // Strip optional 512B copier header.
  const copier = (data.length % 0x8000 === 0x200) ? 0x200 : 0;
  const off = fileOffset - copier;
  if (off < 0 || off >= data.length - copier) return [];
  // Detect mapper if not hinted.
  let isLo;
  if (mapperHint === "lorom") isLo = true;
  else if (mapperHint === "hirom") isLo = false;
  else {
    const lo = data[copier + 0x7FC0 + 0x15];
    const hi = data[copier + 0xFFC0 + 0x15];
    const dLo = lo === 0x20 || lo === 0x30 || lo === 0x32;
    const dHi = hi === 0x21 || hi === 0x31;
    isLo = dHi && !dLo ? false : true;   // default LoROM
  }
  const forms = [];
  if (isLo) {
    const bank = Math.floor(off / 0x8000);
    const offset = (off % 0x8000) + 0x8000;     // upper half of the bank
    forms.push({ value: offset, width: 2, endian: "le", note: `LoROM 16-bit (bank $${bank.toString(16)} implied), offset $${offset.toString(16)}` });
    const cpu = (bank << 16) | offset;
    forms.push({ value: cpu, width: 3, endian: "le", note: `LoROM 24-bit long $${cpu.toString(16)}` });
  } else {
    const offset = off & 0xFFFF;
    const bank = (off >> 16) & 0x3F;
    forms.push({ value: offset, width: 2, endian: "le", note: `HiROM 16-bit (bank $C${bank.toString(16)} implied), offset $${offset.toString(16)}` });
    const cpu = (0xC0 | bank) << 16 | offset;
    forms.push({ value: cpu >>> 0, width: 3, endian: "le", note: `HiROM 24-bit long $${(cpu >>> 0).toString(16)}` });
  }
  return dedupeForms(forms);
}

/** GBA ROM (mapped at 0x08000000, ARM LE) → pointer candidates. 32-bit LE = 0x08000000+offset. */
function gbaPointerForms(fileOffset, data) {
  if (fileOffset >= data.length) return [];
  // Value-search-complete: every code ref funnels through a literal pool, so a
  // single 32-bit LE value scan catches both tables and code refs. Include the
  // WS0 mirror (0x08), plus the slower mirrors (0x0A/0x0C) as secondary.
  return [
    { value: (0x08000000 + fileOffset) >>> 0, width: 4, endian: "le", note: "32-bit LE = 0x08000000 + offset (WS0; literal-pool or table)" },
    { value: (0x0A000000 + fileOffset) >>> 0, width: 4, endian: "le", note: "WS1 mirror 0x0A000000 (less common)" },
    { value: (0x0C000000 + fileOffset) >>> 0, width: 4, endian: "le", note: "WS2 mirror 0x0C000000 (less common)" },
  ];
}

/** Drop duplicate {value,width,endian} forms (keep the first note). */
function dedupeForms(forms) {
  const seen = new Set();
  const out = [];
  for (const f of forms) {
    const k = `${f.value}:${f.width}:${f.endian}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Stored-block emitters — produce bytes a game's OWN decompressor expands
// verbatim, via the common literal/raw-copy escape of each format.
//
// Each emitter takes a Uint8Array payload and returns { bytes, note } or throws
// with a clear "no clean stored escape" message. The dominant real-world case is
// RAW (uncompressed) — most retro graphics are stored verbatim in native planar
// format, so `raw` is the default and the most-used path.
// ───────────────────────────────────────────────────────────────────────────

/** RAW — no wrapper. The game stores this asset uncompressed (most common). */
function storedRaw(payload) {
  return { bytes: Uint8Array.from(payload), note: "raw (uncompressed) — emit the payload verbatim" };
}

/**
 * PackBits literal runs (the most common NES/generic RLE literal escape).
 * Control 0x00-0x7F → copy next (n+1) bytes literally. Max 128 per control.
 */
function storedPackBits(payload) {
  const out = [];
  for (let i = 0; i < payload.length; i += 128) {
    const chunk = payload.subarray(i, i + 128);
    out.push(chunk.length - 1);            // 0x00..0x7F = copy chunk.length literally
    for (const b of chunk) out.push(b);
  }
  return { bytes: Uint8Array.from(out),
    note: "PackBits literal runs (control 0x00-0x7F = copy n+1 bytes). Verify the game's RLE matches this dialect." };
}

/**
 * Konami-style RLE literal escape: control 0x81-0xFE → copy (n-128) literal
 * bytes. Max 126 literals per control.
 */
function storedKonamiRle(payload) {
  const out = [];
  for (let i = 0; i < payload.length; i += 126) {
    const chunk = payload.subarray(i, i + 126);
    out.push(0x80 + chunk.length);         // 0x81..0xFE = copy (n-128) literally
    for (const b of chunk) out.push(b);
  }
  return { bytes: Uint8Array.from(out),
    note: "Konami RLE literal runs (control 0x81-0xFE = copy n-128 bytes)." };
}

/**
 * Sega / Phantasy Star RLE literal escape (SMS/GG): control 0x80|n + n raw
 * bytes (n=1..127). Optionally wrap a whole block with the 16-bit size header
 * and the 0x00 terminator. NOTE: a faithful whole-block wrap must emit the
 * payload in the DEINTERLEAVED order the game's routine expects — we emit the
 * literal run as given; the caller is responsible for deinterleaving if wrapping
 * a complete tile block.
 */
function storedSegaRle(payload, { wrapBlock = false, interleave = 4 } = {}) {
  const body = [];
  for (let i = 0; i < payload.length; i += 127) {
    const chunk = payload.subarray(i, i + 127);
    body.push(0x80 | chunk.length);        // 0x81..0xFF = literal run of n bytes
    for (const b of chunk) body.push(b);
  }
  if (!wrapBlock) {
    return { bytes: Uint8Array.from(body),
      note: "Sega/Phantasy Star literal run (0x80|n + n bytes). Not block-wrapped." };
  }
  body.push(0x00);                          // end-of-block terminator
  const count = Math.floor(payload.length / interleave);
  const header = [count & 0xFF, (count >>> 8) & 0xFF];   // 16-bit LE size/interleave
  return { bytes: Uint8Array.from([...header, ...body]),
    note: `Sega/Phantasy Star block: 16-bit size header (count=${count}, interleave=${interleave}) + literal runs + 0x00 terminator. Payload must already be deinterleaved.` };
}

// ───────────────────────────────────────────────────────────────────────────
// Platform registry — pointer-form fn, stored-block verdict, applicable formats.
//
// verdict: "raw" (graphics stored uncompressed — the dominant real case),
//          "literal-escape" (a clean byte-aligned literal-run wrapper exists),
//          "no-clean-escape" (the common codec can't be hand-authored verbatim).
// `formats` lists the stored-block format keys makeStoredBlock accepts for the
// platform; `raw` is always available. `genesisPointerForms`/`snesPointerForms`/
// `gbaPointerForms` are filled in once the Genesis/SNES/GBA research lands.
// ───────────────────────────────────────────────────────────────────────────

const PLATFORM_REGISTRY = {
  nes:       { forms: nesPointerForms,       verdict: "raw", formats: ["raw", "packbits", "konami-rle"],
               note: "CHR-ROM tiles are stored uncompressed (2bpp planar) — raw is the common case. PackBits / Konami-RLE literal runs cover the common NES RLE dialects." },
  gb:        { forms: gbPointerForms,        verdict: "raw", formats: ["raw"],
               note: "2bpp planar tiles often uncompressed. Pokémon-gen RLE is bit/plane-granular — NO clean byte stored escape; relocate to uncompressed space instead." },
  gbc:       { forms: gbPointerForms,        verdict: "raw", formats: ["raw"],
               note: "Same as GB." },
  sms:       { forms: smsPointerForms,       verdict: "literal-escape", formats: ["raw", "sega-rle"],
               note: "4bpp planar tiles often uncompressed. Sega/Phantasy-Star RLE has a clean literal-run escape (0x80|n + n bytes)." },
  gg:        { forms: smsPointerForms,       verdict: "literal-escape", formats: ["raw", "sega-rle"],
               note: "Same as SMS." },
  c64:       { forms: c64PointerForms,       verdict: "raw", formats: ["raw"],
               note: "RAW when data is uncompressed. Exomizer/ByteBoozer/pucrunch crunched regions have NO clean stored escape (bit-packed) — decrunch→edit→re-crunch instead." },
  lynx:      { forms: lynxPointerForms,      verdict: "raw", formats: ["raw"],
               note: "Graphics stored uncompressed (Suzy blitter reads raw) — raw bytes, no wrapper." },
  atari2600: { forms: atari2600PointerForms, verdict: "raw", formats: ["raw"],
               note: "2K-4K ROMs, playfield/sprite bytes read directly — everything uncompressed. Raw bytes." },
  atari7800: { forms: atari7800PointerForms, verdict: "raw", formats: ["raw"],
               note: "MARIA display lists point at raw bitmaps — graphics uncompressed. Raw bytes." },
  pce:       { forms: pcePointerForms,       verdict: "raw", formats: ["raw"],
               note: "Planar tiles usually uncompressed (DMA'd to VDC). Raw planar bytes; custom-LZ games are no-clean-escape." },
  msx:       { forms: msxPointerForms,       verdict: "literal-escape", formats: ["raw", "konami-rle"],
               note: "RAW when uncompressed; Konami/other RLE has a literal-run token, so a literal-escape stored block is producible." },
  genesis:   { forms: genesisPointerForms, verdict: "literal-escape", formats: ["raw", "kosinski-literal"],
               note: "Pointers are 32-bit BE = ROM offset (1:1 at $000000). Kosinski has an all-literal path (experimental terminator — self-verify). Nemesis is Huffman — NO stored escape; custom LZ (e.g. NBA Jam) — confirm the literal-run shape per game." },
  snes:      { forms: snesPointerForms, verdict: "literal-escape", formats: ["raw", "lz2-direct"],
               note: "Pointers 16-bit (bank-implied) or 24-bit long LE; needs LoROM/HiROM (auto-detected). LC_LZ2 has a clean direct-copy (000) literal command + 0xFF end — common but per-game; confirm the codec." },
  gba:       { forms: gbaPointerForms, verdict: "literal-escape", formats: ["raw", "lz77-literal"],
               note: "Pointers 32-bit LE = 0x08000000+offset (value-search-complete — catches literal pools + tables). BIOS LZ77 (SWI 0x11) has a clean all-literal stream (flag byte 0x00 = 8 literals)." },
};

/** Build a stored block from a payload for a given format key. */
function buildStored(format, payload, opts = {}) {
  switch (format) {
    case "raw":         return storedRaw(payload);
    case "packbits":    return storedPackBits(payload);
    case "konami-rle":  return storedKonamiRle(payload);
    case "sega-rle":    return storedSegaRle(payload, opts);
    case "lz77-literal": return storedGbaLz77(payload);
    case "lz2-direct":  return storedSnesLz2(payload);
    case "kosinski-literal": return storedKosinskiLiteral(payload);
    default:
      throw new Error(`makeStoredBlock: unknown format '${format}'`);
  }
}

/**
 * GBA BIOS LZ77 (SWI 0x11/0x12) all-literal stream. Header = 0x10 + 24-bit LE
 * decompressed size; then flag bytes (MSB-first), each followed by up to 8
 * literal bytes (every flag bit 0 = "copy one literal"). An all-zero flag byte
 * = 8 literals. No minimum-match rule forces compression, so an all-literal
 * stream is valid input to the BIOS decompressor. (GBATEK.)
 */
function storedGbaLz77(payload) {
  const n = payload.length;
  const out = [0x10, n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF];  // type + 24-bit LE size
  for (let i = 0; i < n; i += 8) {
    out.push(0x00);                       // flag byte: next ≤8 blocks all literal
    for (let j = i; j < Math.min(i + 8, n); j++) out.push(payload[j]);
  }
  while (out.length % 4 !== 0) out.push(0x00);   // BIOS expects 4-byte-aligned src
  return { bytes: Uint8Array.from(out),
    note: "GBA BIOS LZ77 (SWI 0x11) all-literal: 0x10 + 24-bit LE size, flag bytes 0x00, raw literals. Decompresses verbatim." };
}

/**
 * SNES LC_LZ2 all-literal (direct-copy) block. Command byte CCC LLLLL: command
 * 000 = direct copy of (L+1) literal bytes (max 32); command 111 = long-length
 * extended form for runs >32. Stream ends with 0xFF. (SnesLab LC_LZ2.)
 */
function storedSnesLz2(payload) {
  const out = [];
  let i = 0;
  while (i < payload.length) {
    const remaining = payload.length - i;
    if (remaining <= 32) {
      out.push((remaining - 1) & 0x1F);   // 000 LLLLL, length = L+1
      for (let j = 0; j < remaining; j++) out.push(payload[i + j]);
      i += remaining;
    } else {
      // Long form: 111 000 LL / LLLLLLLL → command 000 (direct copy), 10-bit len.
      const chunk = Math.min(remaining, 1024);
      const len = chunk - 1;
      out.push(0xE0 | ((len >> 8) & 0x03));   // 111 000 LL
      out.push(len & 0xFF);                   // LLLLLLLL
      for (let j = 0; j < chunk; j++) out.push(payload[i + j]);
      i += chunk;
    }
  }
  out.push(0xFF);                         // end marker
  return { bytes: Uint8Array.from(out),
    note: "SNES LC_LZ2 all-literal: command 000 (direct copy L+1) chunks + 0xFF end. Common SMW-era codec; per-game codecs vary — confirm the game uses LC_LZ2." };
}

/**
 * Genesis Kosinski all-literal block. 16-bit LE descriptor field, bits popped
 * LSB-first; bit 1 = copy one literal byte, bit 0 = match. Terminator = a full
 * match with count 0. NOTE: the agent flagged the EXACT terminator bytes as the
 * one residual uncertainty — emitters differ slightly. This emits the documented
 * form but is marked experimental; ALWAYS self-verify via a round-trip through
 * the game's own decompressor (callSubroutine) before trusting it.
 */
function storedKosinskiLiteral(payload) {
  const out = [];
  let i = 0;
  while (i < payload.length) {
    const chunk = Math.min(payload.length - i, 16);
    // Descriptor: low `chunk` bits = 1 (literals). If this is the final chunk and
    // there's room, append the match-terminator bits (0,0). 16-bit LE.
    let desc = 0;
    for (let b = 0; b < chunk; b++) desc |= (1 << b);
    out.push(desc & 0xFF, (desc >> 8) & 0xFF);
    for (let j = 0; j < chunk; j++) out.push(payload[i + j]);
    i += chunk;
  }
  // Documented terminator: a full match with count 0 → 00 F8 00.
  out.push(0x00, 0xF8, 0x00);
  return { bytes: Uint8Array.from(out), experimental: true,
    note: "EXPERIMENTAL Kosinski all-literal (16-bit LE descriptor, bit 1 = literal). The exact end-terminator varies by decompressor — self-verify via a callSubroutine round-trip through the game's own routine before shipping." };
}

export {
  encodeInt, findAllOccurrences, dedupeForms,
  nesPointerForms, gbPointerForms, smsPointerForms,
  c64PointerForms, lynxPointerForms, atari2600PointerForms,
  atari7800PointerForms, pcePointerForms, msxPointerForms,
  genesisPointerForms, snesPointerForms, gbaPointerForms,
  storedRaw, storedPackBits, storedKonamiRle, storedSegaRle,
  storedGbaLz77, storedSnesLz2, storedKosinskiLiteral,
  PLATFORM_REGISTRY, buildStored,
};

// ───────────────────────────────────────────────────────────────────────────
// Platform detection from a file path (mirrors find-references.js).
// ───────────────────────────────────────────────────────────────────────────
function detectPlatform(path) {
  if (/\.nes$/i.test(path)) return "nes";
  if (/\.(sfc|smc)$/i.test(path)) return "snes";
  if (/\.sms$/i.test(path)) return "sms";
  if (/\.gg$/i.test(path)) return "gg";
  if (/\.gbc$/i.test(path)) return "gbc";
  if (/\.gb$/i.test(path)) return "gb";
  if (/\.gba$/i.test(path)) return "gba";
  if (/\.a26$/i.test(path)) return "atari2600";
  if (/\.a78$/i.test(path)) return "atari7800";
  if (/\.prg$/i.test(path)) return "c64";
  if (/\.lnx$/i.test(path)) return "lynx";
  if (/\.pce$/i.test(path)) return "pce";
  if (/\.rom$/i.test(path)) return "msx";
  if (/\.(gen|md|bin)$/i.test(path)) return "genesis";
  return null;
}

const hex6 = (n) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(6, "0");
const hexB = (bytes) => Array.from(bytes).map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

// ───────────────────────────────────────────────────────────────────────────
// findPointerTo — scan a ROM for pointers that reference a byte offset.
// ───────────────────────────────────────────────────────────────────────────
export async function findPointerToCore({ path, platform, romOffset, mapper, maxHitsReturned = 256 }) {
  const data = new Uint8Array(await readFile(path));
  const plat = platform ?? detectPlatform(path);
  if (!plat) throw new Error(`findPointerTo: could not detect platform for '${path}'. Pass platform explicitly.`);
  const entry = PLATFORM_REGISTRY[plat];
  if (!entry || !entry.forms) throw new Error(`findPointerTo: platform '${plat}' not supported.`);
  if (romOffset < 0 || romOffset >= data.length) {
    throw new Error(`findPointerTo: romOffset ${hex6(romOffset)} is outside the ROM (${data.length} bytes).`);
  }

  const forms = plat === "snes" ? entry.forms(romOffset, data, mapper) : entry.forms(romOffset, data);
  const hits = [];
  for (const form of forms) {
    const needle = encodeInt(form.value, form.width, form.endian);
    for (const at of findAllOccurrences(data, needle)) {
      hits.push({
        atOffset: hex6(at),
        atOffsetDec: at,
        pointerValue: "0x" + (form.value >>> 0).toString(16).toUpperCase(),
        bytes: hexB(needle),
        width: form.width,
        endian: form.endian,
        form: form.note,
      });
    }
  }
  // Sort by file offset; dedupe identical (atOffset,pointerValue).
  hits.sort((a, b) => a.atOffsetDec - b.atOffsetDec);

  return {
    path,
    platform: plat,
    romOffset: hex6(romOffset),
    searchedForms: forms.map((f) => ({ value: "0x" + (f.value >>> 0).toString(16).toUpperCase(), width: f.width, endian: f.endian, note: f.note })),
    hitsFound: hits.length,
    hits: hits.slice(0, maxHitsReturned),
    truncated: hits.length > maxHitsReturned
      ? `${hits.length - maxHitsReturned} more hits (raise maxHitsReturned).`
      : undefined,
    note: hits.length === 0
      ? "No pointer found. The reference may be computed/indirect, in a different bank's window, or the data may be reached via an index+base rather than an absolute pointer."
      : (plat === "nes" || plat === "gb" || plat === "gbc" || plat === "sms" || plat === "gg" || plat === "pce")
        ? "Banked system: a 16-bit pointer value is page-ambiguous. Correlate each hit with the nearby bank/page-set instruction (or the known active bank) to confirm it's the real reference."
        : undefined,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// makeStoredBlock — emit bytes a game's own decompressor expands verbatim.
// ───────────────────────────────────────────────────────────────────────────
export async function makeStoredBlockCore({ platform, rawHex, rawBytes, format, interleave }) {
  const entry = PLATFORM_REGISTRY[platform];
  if (!entry) throw new Error(`makeStoredBlock: unknown platform '${platform}'.`);
  // Accept hex string or byte array.
  let payload;
  if (rawHex != null) {
    const clean = rawHex.replace(/[^0-9a-fA-F]/g, "");
    if (clean.length % 2 !== 0) throw new Error("makeStoredBlock: rawHex must be an even number of hex digits.");
    payload = Uint8Array.from(clean.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
  } else if (Array.isArray(rawBytes)) {
    payload = Uint8Array.from(rawBytes);
  } else {
    throw new Error("makeStoredBlock: pass rawHex (hex string) or rawBytes (number array).");
  }
  if (payload.length === 0) throw new Error("makeStoredBlock: empty payload.");

  const fmt = format ?? "raw";
  if (!entry.formats.includes(fmt)) {
    throw new Error(`makeStoredBlock: format '${fmt}' is not valid for ${platform}. Valid: ${entry.formats.join(", ")}. ${entry.note}`);
  }
  const result = buildStored(fmt, payload, { interleave });

  return {
    platform,
    format: fmt,
    verdict: entry.verdict,
    inputBytes: payload.length,
    outputBytes: result.bytes.length,
    hex: hexB(result.bytes),
    base64: Buffer.from(result.bytes).toString("base64"),
    note: result.note,
    experimental: result.experimental || undefined,
    platformNote: entry.note,
    nextStep: "Write these bytes into the ROM with patchFile (or to free space via relocateBlock), then VERIFY by running the game's own decompressor on them with callSubroutine and comparing the output to your payload — especially for any 'experimental' format.",
  };
}

// ───────────────────────────────────────────────────────────────────────────
// relocateBlock — write edited bytes to free space and repoint a pointer.
// ───────────────────────────────────────────────────────────────────────────
export async function relocateBlockCore({
  path, platform, newHex, newBase64, toOffset, pointerOffset, pointerWidth, pointerEndian,
  pointerValue, outputPath, dryRun = false,
}) {
  const data = new Uint8Array(await readFile(path));
  const plat = platform ?? detectPlatform(path);

  // Decode the new bytes.
  let newBytes;
  if (newHex != null) {
    const clean = newHex.replace(/[^0-9a-fA-F]/g, "");
    newBytes = Uint8Array.from(clean.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
  } else if (newBase64 != null) {
    newBytes = new Uint8Array(Buffer.from(newBase64, "base64"));
  } else {
    throw new Error("relocateBlock: pass newHex or newBase64 (the edited block bytes).");
  }
  if (newBytes.length === 0) throw new Error("relocateBlock: empty block.");
  if (toOffset == null) throw new Error("relocateBlock: pass toOffset (where to write the block — e.g. a run from findFreeSpace).");
  if (toOffset + newBytes.length > data.length) {
    throw new Error(`relocateBlock: block (${newBytes.length} bytes) at ${hex6(toOffset)} overruns the ROM (${data.length} bytes). Pick a smaller toOffset or expand the ROM first.`);
  }

  const out = new Uint8Array(data);   // copy
  out.set(newBytes, toOffset);
  const writes = [{ at: hex6(toOffset), length: newBytes.length, what: "block bytes" }];

  // Repoint, if a pointer location was given.
  let pointer;
  if (pointerOffset != null) {
    const width = pointerWidth ?? (plat === "genesis" || plat === "gba" ? 4 : 2);
    const endian = pointerEndian ?? (plat === "genesis" ? "be" : "le");
    // The value to write: explicit override, or derive from toOffset via the
    // platform's pointer form (first/primary form for that offset).
    let value = pointerValue;
    if (value == null) {
      const entry = PLATFORM_REGISTRY[plat];
      if (!entry || !entry.forms) throw new Error(`relocateBlock: can't derive a pointer value for '${plat}' — pass pointerValue explicitly.`);
      const forms = (plat === "snes" ? entry.forms(toOffset, data, undefined) : entry.forms(toOffset, data))
        .filter((f) => f.width === width && f.endian === endian);
      if (forms.length === 0) throw new Error(`relocateBlock: no ${width}-byte ${endian} pointer form maps to ${hex6(toOffset)} on ${plat}; pass pointerValue explicitly.`);
      value = forms[0].value;
    }
    const enc = encodeInt(value >>> 0, width, endian);
    const before = hexB(out.slice(pointerOffset, pointerOffset + width));
    out.set(enc, pointerOffset);
    writes.push({ at: hex6(pointerOffset), length: width, what: `pointer → ${hex6(value)}`, before, after: hexB(enc) });
    pointer = { offset: hex6(pointerOffset), width, endian, value: "0x" + (value >>> 0).toString(16).toUpperCase(), before, after: hexB(enc) };
  }

  if (!dryRun) {
    const dest = outputPath ?? path;
    await writeFile(dest, Buffer.from(out));
  }

  return {
    path,
    platform: plat,
    dryRun,
    wrote: dryRun ? null : (outputPath ?? path),
    blockAt: hex6(toOffset),
    blockBytes: newBytes.length,
    pointer: pointer ?? "(no pointer repointed — pass pointerOffset to redirect the loader)",
    writes,
    note: pointerOffset == null
      ? "Block written but NOT yet referenced. Find the pointer that feeds the loader with findPointerTo, then re-run with pointerOffset to repoint it."
      : "Block written and pointer repointed. Verify in the emulator (load + screenshot) — and on banked systems confirm the bank that pointer resolves in is the one selected when the loader runs.",
  };
}

// findPointerTo/makeStoredBlock/relocateBlock folded into the `romPatch` tool
// (rom-id.js, which imports their cores). Nothing registered here anymore.
export function registerReinjectTools() {}

