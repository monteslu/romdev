// learnFontMap / encodeTextForRom / findEncodedText — text-hack workflow.
//
// Every retro game maps characters to tile-IDs differently (Excitebike:
// A=$0A, B=$0B, ..., Z=$23; Mario: ASCII offset; FF: sparse table). The
// agent currently reverse-engineers this by hand each session. These
// three tools automate it:
//
//   1. learnFontMap   — from known {text, offset} hints, infer the map.
//   2. encodeTextForRom — text + map → bytes (ready for patchFile).
//   3. findEncodedText — text + map → list of file offsets + cpu addr +
//                        context + likelySlotLength (catches length-byte
//                        overruns).
//
// All three are platform-agnostic — the mapping is per-ROM, not per-
// platform. The `platform` arg is only used for CPU-address translation
// in findEncodedText (NES/GB/GBC bank-aware, Genesis flat; SNES is mapper-
// dependent and left to fileOffset).

import { readFile, writeFile } from "node:fs/promises";
import { jsonContent, safeTool } from "../util.js";
import { getHost } from "../state.js";

/**
 * Map a RAW .nes file offset to its real 6502 CPU address + 16KB PRG bank.
 * PRG is split into 16KB banks; the byte at prg-relative offset O lives in
 * bank (O >> 14). The FIXED top bank (the last 16KB) is mapped at $C000-$FFFF;
 * any other (switchable) bank is mapped at $8000-$BFFF when banked in. A flat
 * `$8000 + O` (the old behavior) overflows past $FFFF for any bank > 0 on a
 * multi-bank ROM — e.g. it returned $15E03 for prg $DE03 instead of bank 3 /
 * $9E03. Returns null when the offset isn't inside PRG.
 * @param {number} fileOffset raw .nes offset (includes the 16-byte iNES header)
 * @param {number} prgSize total PRG size in bytes (header[4] * 16384)
 * @returns {{ cpuAddress: string, bank: number } | null}
 */
export function nesFileOffsetToCpu(fileOffset, prgSize) {
  const PRG_START = 16;
  if (!(prgSize > 0) || fileOffset < PRG_START || fileOffset >= PRG_START + prgSize) return null;
  const offInPrg = fileOffset - PRG_START;
  const numBanks = prgSize >> 14;
  const bank = offInPrg >> 14;
  const inBank = offInPrg & 0x3FFF;
  const isFixedTop = bank === numBanks - 1; // last 16KB is the fixed $C000 bank
  const base = (numBanks === 1 || isFixedTop) ? 0xC000 : 0x8000;
  return { cpuAddress: "$" + (base + inBank).toString(16).toUpperCase(), bank };
}

// ─── learnFontMap ────────────────────────────────────────────────

/**
 * Infer the character → tile-ID map from known-text-at-known-offset hints.
 * Solves the system of equations: for each {text, offset} pair, the byte
 * at offset+i must equal map[text[i]].
 *
 * Conflicts: if two known strings disagree on a character, throw with
 * both candidate values so the agent can investigate.
 */
async function learnFontMapCore({ romPath, knownStrings, alphabet }) {
  const data = new Uint8Array(await readFile(romPath));
  /** @type {Record<string, number>} */
  const fontMap = {};
  /** @type {Array<{text:string, offset:number, mappedChars:string}>} */
  const inferredFrom = [];

  for (const hint of knownStrings) {
    const { text, offset } = hint;
    let mapped = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const byte = data[offset + i];
      if (byte === undefined) {
        throw new Error(
          `learnFontMap: hint {text: "${text}", offset: 0x${offset.toString(16).toUpperCase()}} ` +
          `extends past EOF — char '${ch}' at position ${i} would read byte ${offset + i} but ROM is ${data.length} bytes.`
        );
      }
      if (fontMap[ch] !== undefined && fontMap[ch] !== byte) {
        throw new Error(
          `learnFontMap: conflict on character '${ch}'. ` +
          `Earlier hint mapped it to 0x${fontMap[ch].toString(16).toUpperCase()}; ` +
          `this hint (text="${text}", offset=0x${offset.toString(16).toUpperCase()}, position=${i}) ` +
          `says 0x${byte.toString(16).toUpperCase()}. Check that both hints' offsets are correct AND ` +
          `the source bytes weren't already patched.`
        );
      }
      fontMap[ch] = byte;
      mapped += ch;
    }
    inferredFrom.push({ text, offset, mappedChars: mapped });
  }

  const alphabetSet = alphabet ?? "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ©";
  const unknownChars = [];
  for (const ch of alphabetSet) {
    if (fontMap[ch] === undefined) unknownChars.push(ch);
  }

  return {
    romPath,
    fontMap,
    learnedChars: Object.keys(fontMap).sort().join(""),
    unknownChars,
    inferredFrom,
  };
}

/**
 * Infer the font map from text RENDERED ON SCREEN: read the live nametable and
 * pull the tile IDs at each hint's (row,col) position — the tile ID IS the
 * fontMap byte for that character. Solves the chicken-and-egg (you'd otherwise
 * need the ROM offset, which is what you're hunting). Works on every tilemap
 * platform via makeTilemapReader (NES/SNES/Genesis/GB-GBC/SMS-GG/C64).
 */
/**
 * Build a live tile-id reader for `platform`: resolves the active tilemap base
 * from the platform's VDP/PPU registers and returns `(row,col) → tileId`, plus
 * the grid width so we can range-check. Each tilemap platform stores the BG map
 * differently (1 vs 2 bytes/entry, different grid width, different tile-index
 * mask, host byte order); we reuse the platform decoders so the layout math
 * isn't re-derived here. Returns null for platforms with no text-tile nametable
 * (atari2600/7800: race-the-beam / display list; lynx/gba: bitmap framebuffer).
 * @returns {Promise<{ tile:(row:number,col:number)=>number, cols:number, rows:number, baseLabel:string } | null>}
 */
async function makeTilemapReader(host, platform, which) {
  if (platform === "nes") {
    const nt = host.readMemory("nes_nametables", which * 1024, 1024);
    return { cols: 32, rows: 30, baseLabel: `nes_nametables[${which}]`, tile: (r, c) => nt[r * 32 + c] };
  }
  if (platform === "gb" || platform === "gbc") {
    const { decodeLcdc } = await import("../../platforms/gb/ppu.js");
    const io = host.readMemory("gb_io", 0, 0x80);
    const lcdc = decodeLcdc(io[0x40]); // LCDC at $FF40
    // `which` overrides the BG map select: 0=$9800, 1=$9C00; default = live LCDC.
    const base = (which === 1 ? 0x9C00 : which === 0 ? 0x9800 : lcdc.bgTileMapBaseDec) - 0x8000;
    const vram = host.readMemory("gb_vram", 0, 0x2000);
    return { cols: 32, rows: 32, baseLabel: `gb_vram@$${(base + 0x8000).toString(16)}`, tile: (r, c) => vram[base + r * 32 + c] };
  }
  if (platform === "sms" || platform === "gg") {
    const { decodeSmsVdpRegs } = await import("../../platforms/sms/vdp.js");
    const regs = host.readMemory("sms_vdp_regs", 0, 16);
    const vdp = decodeSmsVdpRegs(regs);
    const base = vdp.nameTableBaseDec; // VRAM byte offset
    const region = platform === "gg" ? "gg_vram" : "sms_vram";
    const vram = host.readMemory(region, 0, 0x4000);
    // Mode-4 name table: 32×28 entries of 2 bytes LE; tile index = low 9 bits.
    return { cols: 32, rows: 28, baseLabel: `${region}@$${base.toString(16)}`,
      tile: (r, c) => { const o = base + (r * 32 + c) * 2; return (vram[o] | (vram[o + 1] << 8)) & 0x1FF; } };
  }
  if (platform === "genesis" || platform === "megadrive" || platform === "md") {
    const { decodeVDPRegs } = await import("../../platforms/genesis/vdp.js");
    const regs = host.readMemory("genesis_vdp_regs", 0, 0x20);
    const vdp = decodeVDPRegs(regs);
    const base = which === 1 ? vdp.nameTableB : vdp.nameTableA; // Plane A default, B if which=1
    const vram = host.readMemory("video_ram", 0, 0x10000);
    // Genesis VRAM words are stored host-big-endian: word = (hi<<8)|lo. Plane is
    // 64 wide by default (H40); tile index = low 11 bits.
    return { cols: 64, rows: 32, baseLabel: `video_ram@$${base.toString(16)} (plane ${which === 1 ? "B" : "A"})`,
      tile: (r, c) => { const o = base + (r * 64 + c) * 2; return ((vram[o] << 8) | vram[o + 1]) & 0x7FF; } };
  }
  if (platform === "snes") {
    const { decodePpuRegs } = await import("../../platforms/snes/ppu.js");
    const fillram = host.readMemory("snes_fillram", 0, 0x8000);
    const ppu = decodePpuRegs(fillram);
    const bg = ppu.bg?.[which] ?? ppu.bg?.[0];
    if (!bg) throw new Error("learnFontMap fromScreen: couldn't resolve a SNES BG tilemap base (PPU regs not populated — step a frame first).");
    const base = bg.scBaseByte; // VRAM byte offset of the BG map
    const vram = host.readMemory("video_ram", 0, 0x10000);
    // BG map entry: 2 bytes LE; tile index = low 10 bits. 32×32 per screen.
    return { cols: bg.mapWidth ?? 32, rows: bg.mapHeight ?? 32, baseLabel: `video_ram@$${base.toString(16)} (BG${which})`,
      tile: (r, c) => { const o = base + (r * 32 + c) * 2; return (vram[o] | (vram[o + 1] << 8)) & 0x3FF; } };
  }
  if (platform === "c64") {
    const { decodeViciiRegs } = await import("../../platforms/c64/vic.js");
    const regs = host.readMemory("c64_vic_regs", 0, 0x2F);
    const vic = decodeViciiRegs(regs);
    const base = vic.memPointers?.screenRamBaseDec ??
      parseInt(String(vic.memPointers?.screenRamBaseInVicBank ?? "$0400").replace("$", ""), 16);
    const ram = host.readMemory("system_ram", 0, 0x10000);
    // Text mode: 40×25 screen-codes, 1 byte/cell.
    return { cols: 40, rows: 25, baseLabel: `system_ram@$${base.toString(16)} (screen RAM)`,
      tile: (r, c) => ram[base + r * 40 + c] };
  }
  return null; // no text-tile nametable on this platform
}

/**
 * Decide whether a run of (char, tileId) reads from a live tilemap is FONT TEXT
 * (a reusable character→tile map) or a PRE-RENDERED GRAPHIC (a name/logo drawn as
 * a bitmap, where each cell is a unique tile). The trap a long RE session hit:
 * NBA Jam's player names are bitmaps, so patching the ASCII string did nothing.
 * Signals a graphic when: (1) a repeated character used a DIFFERENT tile each
 * time (a real font reuses one tile per letter) — the direct proof; OR (2) every
 * tile is unique AND the ids form a near-contiguous run (tiles X,X+1,X+2,… = one
 * ripped image). `repeatedCharReuse` is null/true/false from the scan loop.
 * @param {Array<{ch:string, tileId:number}>} reads
 * @param {boolean|null} repeatedCharReuse
 * @returns {{ looksLikeGraphic:boolean, reason:string|null }}
 */
export function detectPreRenderedGraphic(reads, repeatedCharReuse) {
  if (repeatedCharReuse === false) {
    return { looksLikeGraphic: true, reason: "repeated-char-different-tile" };
  }
  const tileIds = reads.map((r) => r.tileId);
  const unique = new Set(tileIds);
  const allUnique = unique.size === tileIds.length && tileIds.length >= 3;
  const sorted = [...unique].sort((a, b) => a - b);
  let contiguous = sorted.length >= 3;
  for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] > 2) { contiguous = false; break; }
  if (allUnique && contiguous) {
    return { looksLikeGraphic: true, reason: "unique-contiguous-tiles" };
  }
  return { looksLikeGraphic: false, reason: null };
}

async function learnFontMapFromScreen({ platform, fromScreen, which = 0, alphabet, sessionKey }) {
  const host = getHost(sessionKey);
  const plat = platform ?? host.getStatus?.().platform;
  const reader = await makeTilemapReader(host, plat, which);
  if (!reader) {
    throw new Error(`learnFontMap fromScreen: '${plat ?? "unknown"}' has no text-tile nametable to read (atari2600/7800 race the beam; lynx/gba are bitmap). Use ROM mode (knownStrings+offset) instead.`);
  }

  /** @type {Record<string, number>} */
  const fontMap = {};
  const inferredFrom = [];
  // Track every (char, tileId) read AND the raw tile sequence, so we can detect
  // the "this isn't font text, it's a pre-rendered graphic" case (see below).
  const allReads = [];        // { ch, tileId }
  let repeatedCharReuse = null; // true once we see a repeated char reuse its tile
  for (const hint of fromScreen) {
    const { text, row, col } = hint;
    if (row < 0 || row >= reader.rows) throw new Error(`learnFontMap fromScreen: row ${row} out of range (0-${reader.rows - 1} for ${plat}).`);
    let mapped = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const c = col + i;
      if (c >= reader.cols) throw new Error(`learnFontMap fromScreen: text "${text}" at col ${col} runs past the ${reader.cols}-tile row width.`);
      const tileId = reader.tile(row, c);
      // A real font reuses the SAME tile for the SAME letter. A pre-rendered
      // graphic (the name drawn as a bitmap) uses a different tile per cell even
      // for repeated letters — so a same-char-different-tile is NOT a conflict
      // there, it's the tell. Record it instead of hard-erroring; decide after.
      if (fontMap[ch] !== undefined) {
        if (fontMap[ch] === tileId) repeatedCharReuse = true;
        else if (repeatedCharReuse === null) repeatedCharReuse = false;
      }
      allReads.push({ ch, tileId });
      if (fontMap[ch] === undefined) fontMap[ch] = tileId;
      mapped += ch;
    }
    inferredFrom.push({ text, row, col, mappedChars: mapped });
  }

  // ── Detect pre-rendered GRAPHIC vs font TEXT ──────────────────────────────
  const { looksLikeGraphic } = detectPreRenderedGraphic(allReads, repeatedCharReuse);

  const alphabetSet = alphabet ?? "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ©";
  const unknownChars = [];
  for (const ch of alphabetSet) if (fontMap[ch] === undefined) unknownChars.push(ch);

  const result = {
    source: "live-tilemap",
    platform: plat,
    which,
    tilemap: reader.baseLabel,
    fontMap,
    learnedChars: Object.keys(fontMap).sort().join(""),
    unknownChars,
    inferredFrom,
    note: "Tile/char IDs read from the live tilemap — they ARE the in-ROM character bytes for a game that stores text as raw tile indices. Verify with findEncodedText before patching.",
  };
  if (looksLikeGraphic) {
    result.likelyPreRenderedGraphic = true;
    result.warning =
      "⚠ These tiles look like a PRE-RENDERED GRAPHIC, not font-rendered text — " +
      (repeatedCharReuse === false
        ? "a repeated character used a DIFFERENT tile each time (a real font reuses one tile per letter). "
        : "every tile is unique and the ids form a contiguous run (tiles X,X+1,X+2,… = one ripped bitmap). ") +
      "So this on-screen text is NOT sourced from a string/font you can patch — it's an image uploaded to VRAM. " +
      "Editing it means changing the TILE BITMAPS (the pixels), not an ASCII string. Do NOT patch a text string " +
      "expecting this to change. To find where the graphic came from, trace the VRAM source (watch the VRAM-DMA " +
      "source address). The fontMap below is unreliable here — it's per-cell tile ids, not a reusable character map.";
  }
  return result;
}

// ─── encodeTextForRom ────────────────────────────────────────────

function hex2(n) {
  return n.toString(16).toUpperCase().padStart(2, "0");
}

async function encodeTextForRomCore({ text, fontMap, fontMapPath, unknownChar }) {
  let map = fontMap;
  if (!map && fontMapPath) {
    map = JSON.parse(await readFile(fontMapPath, "utf-8"));
    // Accept both {fontMap:{...}} and a bare {ch:byte} shape.
    if (map.fontMap) map = map.fontMap;
  }
  if (!map) {
    throw new Error("encodeTextForRom: must pass either fontMap (inline) or fontMapPath.");
  }
  const fallback = unknownChar ?? 0xFC; // NES blank-tile convention
  const bytes = [];
  const unknownChars = [];
  for (const ch of text) {
    const b = map[ch];
    if (b === undefined) {
      bytes.push(fallback);
      if (!unknownChars.includes(ch)) unknownChars.push(ch);
    } else {
      bytes.push(b & 0xFF);
    }
  }
  return {
    text,
    bytes,
    hex: bytes.map(hex2).join(" "),
    base64: Buffer.from(bytes).toString("base64"),
    length: bytes.length,
    unknownChars,
    fallbackUsed: unknownChars.length > 0 ? "0x" + hex2(fallback) : null,
  };
}

// ─── findEncodedText ─────────────────────────────────────────────

/**
 * Build the reverse map (byte → char) from a forward map. For findEncodedText
 * to render contextBefore/contextAfter as readable text.
 */
function reverseMap(fontMap) {
  const rev = {};
  for (const [ch, byte] of Object.entries(fontMap)) {
    if (rev[byte] === undefined) rev[byte] = ch;
  }
  return rev;
}

/**
 * Decode bytes around a match site to readable text using the reverse map.
 * Unknown bytes are rendered as ·.
 */
function decodeContext(data, start, end, rev) {
  let out = "";
  for (let i = start; i < end; i++) {
    if (i < 0 || i >= data.length) continue;
    out += rev[data[i]] ?? "·";
  }
  return out;
}

/**
 * Detect a plausible length-prefix byte preceding the match. Many ROMs
 * store text with a leading "length" byte (PPU command, RLE marker, etc).
 * If the byte at offset-1, offset-2, or offset-3 equals the match length
 * (or length-1 / length+1), report it as a possible slot-length.
 */
function detectLengthByte(data, offset, matchLen) {
  for (let probe = 1; probe <= 4; probe++) {
    const at = offset - probe;
    if (at < 0) continue;
    const v = data[at];
    if (v === matchLen || v === matchLen - 1 || v === matchLen + 1) {
      return { atOffset: at, value: v, distance: probe };
    }
  }
  return null;
}

async function findEncodedTextCore({ romPath, text, fontMap, fontMapPath, platform, maxResults = 16 }) {
  let map = fontMap;
  if (!map && fontMapPath) {
    const parsed = JSON.parse(await readFile(fontMapPath, "utf-8"));
    map = parsed.fontMap ?? parsed;
  }
  if (!map) {
    throw new Error("findEncodedText: must pass either fontMap (inline) or fontMapPath.");
  }
  // Encode the search needle.
  const needle = [];
  const unknown = [];
  for (const ch of text) {
    const b = map[ch];
    if (b === undefined) {
      unknown.push(ch);
      needle.push(null); // wildcard
    } else {
      needle.push(b & 0xFF);
    }
  }
  if (unknown.length > 0) {
    // Don't bail — wildcards still find partial matches.
  }

  const data = new Uint8Array(await readFile(romPath));
  const rev = reverseMap(map);
  const matches = [];

  for (let i = 0; i + needle.length <= data.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (needle[j] !== null && data[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    // Build context.
    const ctxBefore = decodeContext(data, i - 8, i, rev);
    const ctxAfter = decodeContext(data, i + needle.length, i + needle.length + 8, rev);
    const surrStart = Math.max(0, i - 4);
    const surrEnd = Math.min(data.length, i + needle.length + 4);
    const surroundingHex = Array.from(data.slice(surrStart, surrEnd))
      .map((b, k) => {
        const absIdx = surrStart + k;
        const inMatch = absIdx >= i && absIdx < i + needle.length;
        return inMatch ? `[${hex2(b)}]` : hex2(b);
      })
      .join(" ");

    const lengthByte = detectLengthByte(data, i, needle.length);

    let cpuAddress = null;
    let bank = null;
    if (platform === "nes") {
      const m = nesFileOffsetToCpu(i, (data[4] || 0) * 16384);
      if (m) { cpuAddress = m.cpuAddress; bank = m.bank; }
    } else if (platform === "gb" || platform === "gbc") {
      // GB ROM: raw 16KB banks (no header). Bank 0 is fixed at $0000-$3FFF;
      // any other bank maps to $4000-$7FFF when switched in.
      bank = i >> 14;
      const inBank = i & 0x3FFF;
      cpuAddress = "$" + ((bank === 0 ? 0x0000 : 0x4000) + inBank).toString(16).toUpperCase();
    } else if (platform === "genesis" || platform === "megadrive" || platform === "md") {
      // Genesis: flat 68k ROM mapped at $000000, no header — file offset IS the
      // CPU address.
      cpuAddress = "$" + i.toString(16).toUpperCase();
    }
    // SNES is intentionally left null: file-offset → CPU address depends on the
    // LoROM/HiROM mapper (and a possible 512B copier header), so a correct value
    // needs the mapper — not guessed here. Use prgFileOffset/fileOffset for SNES.

    // PRG-frame offset (NES: subtract the 16-byte iNES header). Useful
    // because patchFile against `prg.bin` (from extractCart) needs the
    // header-less offset, while patchFile against the .nes file uses the
    // raw `fileOffset`. Emit BOTH to remove that footgun.
    let prgFileOffset = null;
    let prgFileOffsetDec = null;
    if (platform === "nes" && i >= 16) {
      const prgSize = data[4] * 16384;
      if (i < 16 + prgSize) {
        prgFileOffsetDec = i - 16;
        prgFileOffset = "0x" + prgFileOffsetDec.toString(16).toUpperCase();
      }
    }

    matches.push({
      fileOffset: "0x" + i.toString(16).toUpperCase(),
      fileOffsetDec: i,
      prgFileOffset,
      prgFileOffsetDec,
      cpuAddress,
      // NES/GB/GBC: the 16KB bank this byte lives in. cpuAddress is the in-bank
      // CPU address (valid only when this bank is mapped in) — pair them when
      // feeding disassembleRom({ startAddress: cpuAddress, bank }).
      ...(bank != null ? { bank } : {}),
      contextBefore: ctxBefore,
      contextAfter: ctxAfter,
      surroundingHex,
      likelySlotLength: lengthByte
        ? { atFileOffset: "0x" + lengthByte.atOffset.toString(16).toUpperCase(),
            value: lengthByte.value,
            distanceFromMatch: lengthByte.distance,
            hint: `byte ${lengthByte.distance} before the match equals match length (${lengthByte.value} ≈ ${needle.length}); ` +
              `looks like a length prefix. Don't write more than ${lengthByte.value} bytes at the match offset OR the next ` +
              `tile-list command will start parsing your replacement bytes as commands.`,
          }
        : null,
    });
    if (matches.length >= maxResults) break;
  }

  return {
    romPath,
    text,
    needleHex: needle.map((b) => b === null ? "??" : hex2(b)).join(" "),
    wildcardChars: unknown,
    matchesFound: matches.length,
    matches,
    truncated: matches.length === maxResults ? `Stopped at maxResults=${maxResults}. Raise to see more.` : undefined,
  };
}

// ─── MCP registration ────────────────────────────────────────────

export function registerFontMapTools(server, z, sessionKey) {
  server.tool(
    "learnFontMap",
    "Use this to infer a ROM's custom character→tile-ID map (most retro games use their own font " +
    "encoding) instead of reverse-engineering it by hand. TWO modes:\n" +
    "• ROM mode (`knownStrings:[{text, offset}]`): you found the text's bytes in the ROM file.\n" +
    "• LIVE mode (`fromScreen:[{text, row, col}]`): the text is RENDERED on screen RIGHT NOW — read the tile " +
    "IDs straight from the live nametable at a tile position (row,col in 8×8 tiles from the top-left). This " +
    "solves the chicken-and-egg where you'd need the ROM offset (the thing you're hunting) to learn the map: " +
    "inspectBackgroundMap shows you where the text is on screen, and this reads the tile IDs there. Live mode " +
    "works on every tilemap platform — NES, SNES, Genesis, GB/GBC, SMS/GG, C64 — each reading its own live " +
    "BG map (the active base is resolved from the VDP/PPU registers). `which` selects the nametable/plane/BG " +
    "layer (NES 0-3; Genesis 0=A/1=B; SNES BG index; GB 0=$9800/1=$9C00). NOT available on atari2600/7800 " +
    "(race-the-beam, no nametable) or lynx/gba (bitmap framebuffer) — use ROM mode there.\n" +
    "Returns `{fontMap, learnedChars, unknownChars}` — save it as JSON and pass `fontMapPath` to " +
    "encodeTextForRom / findEncodedText. Per-ROM.\n" +
    "⚠ GRAPHIC vs FONT (live mode): if the on-screen 'text' is actually a PRE-RENDERED GRAPHIC (a name/logo drawn " +
    "as a bitmap, not font-rendered from a string — common for player names, title logos), this tool DETECTS it " +
    "(repeated letters use different tiles, or the tiles are a unique contiguous run) and returns " +
    "`likelyPreRenderedGraphic:true` + a `warning`. In that case the text is NOT editable as a string — you must " +
    "change the tile bitmaps, not patch ASCII. Heed that warning before patching a string that won't do anything.",
    {
      romPath: z.string().optional().describe("Absolute path to the ROM file. Required for ROM mode (knownStrings); not needed for live mode (fromScreen)."),
      platform: z.string().optional().describe("Platform — required for `fromScreen` live mode (selects the nametable region). Informational for ROM mode."),
      knownStrings: z.array(z.object({
        text: z.string().describe("The string you can see rendered in-game."),
        offset: z.number().int().min(0).describe("File offset where those bytes live in the ROM (find via findEncodedText hints or inspection)."),
      })).optional().describe("ROM mode hints: text + its ROM file offset. One or more covers more of the alphabet."),
      fromScreen: z.array(z.object({
        text: z.string().describe("The string visible on screen now."),
        row: z.number().int().min(0).describe("Tile row of the text's first character (8px tiles from the top — e.g. row 13)."),
        col: z.number().int().min(0).describe("Tile column of the first character (8px tiles from the left)."),
      })).optional().describe("LIVE mode hints: text + its tile (row,col) in the rendered nametable. Reads tile IDs from live VRAM — no ROM offset needed."),
      which: z.number().int().min(0).max(3).default(0).describe("NES live mode: which nametable (0-3). Default 0."),
      alphabet: z.string().optional().describe("Which characters to track in unknownChars[]. Default: A-Z, 0-9, space, ©."),
    },
    safeTool(async (args) => {
      if (args.fromScreen && args.fromScreen.length) {
        const r = await learnFontMapFromScreen({ ...args, sessionKey });
        return jsonContent(r);
      }
      if (!args.knownStrings || !args.knownStrings.length) {
        throw new Error("learnFontMap: pass `knownStrings:[{text, offset}]` (ROM mode) or `fromScreen:[{text, row, col}]` (live mode).");
      }
      if (!args.romPath) throw new Error("learnFontMap: `knownStrings` (ROM mode) needs `romPath`.");
      const r = await learnFontMapCore(args);
      return jsonContent(r);
    }),
  );

  server.tool(
    "encodeTextForRom",
    "Encode a text string to ROM bytes using a font map. Inverse of learnFontMap. Returns hex AND " +
    "base64, ready to feed directly into patchFile.hex / patchFile.base64.\n\n" +
    "Unknown characters fall back to `unknownChar` (default 0xFC = NES blank tile) and are listed " +
    "in `unknownChars[]` so you can investigate. For non-NES platforms with a different blank " +
    "convention, pass an explicit `unknownChar`.",
    {
      text: z.string().describe("The text to encode."),
      fontMap: z.record(z.string(), z.number().int().min(0).max(255)).optional().describe("Inline char→byte map."),
      fontMapPath: z.string().optional().describe("JSON file containing the font map (either {fontMap:{...}} or a bare {ch:byte} object)."),
      unknownChar: z.number().int().min(0).max(255).optional().describe("Fallback byte for characters not in the map. Default 0xFC (NES blank-tile convention)."),
    },
    safeTool(async (args) => {
      const r = await encodeTextForRomCore(args);
      return jsonContent(r);
    }),
  );

  server.tool(
    "findEncodedText",
    "Use this to locate a text string in a ROM via a font map (from learnFontMap) — decodes surrounding " +
    "context bytes and flags a likely length-prefix byte before each match (catches the classic off-by-one " +
    "where text has a leading length byte and overwriting past it corrupts the next command). Returns both " +
    "`fileOffset` (raw .nes, for patching the .nes file) and `prgFileOffset` (header-stripped, for prg.bin " +
    "from extractCart), plus the NES bank-aware `cpuAddress` + `bank`: cpuAddress is the real in-bank 6502 " +
    "address ($8000-$BFFF for a switchable bank, $C000-$FFFF for the fixed top bank), and `bank` is its 16KB " +
    "PRG bank — pass them together to disassembleRom({ startAddress: cpuAddress, bank }) on a banked ROM.",
    {
      romPath: z.string().describe("Absolute path to the ROM."),
      text: z.string().describe("Text to search for."),
      fontMap: z.record(z.string(), z.number().int().min(0).max(255)).optional(),
      fontMapPath: z.string().optional(),
      platform: z.enum(["nes", "snes", "genesis", "megadrive", "md", "gb", "gbc"]).optional().describe("Optional — enables CPU-address translation. NES/GB/GBC return a bank-aware in-bank cpuAddress + `bank` (16KB banks); Genesis returns a flat cpuAddress (= file offset). SNES is mapper-dependent (LoROM/HiROM) so cpuAddress is left null — use prgFileOffset/fileOffset."),
      maxResults: z.number().int().min(1).max(256).default(16),
    },
    safeTool(async (args) => {
      const r = await findEncodedTextCore(args);
      return jsonContent(r);
    }),
  );
}
