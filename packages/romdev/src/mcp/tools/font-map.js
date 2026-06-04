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
// in findEncodedText (reuses mapNesAddress/mapSnesAddress from disasm).

import { readFile, writeFile } from "node:fs/promises";
import { jsonContent, safeTool } from "../util.js";
import { mapNesAddress, mapSnesAddress } from "./disasm.js";

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
    }

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
      // NES: the 16KB PRG bank this byte lives in. cpuAddress is the in-bank
      // 6502 address (valid only when this bank is mapped in) — pair them when
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

export function registerFontMapTools(server, z) {
  server.tool(
    "learnFontMap",
    "Use this to infer a ROM's custom character→tile-ID map (most retro games use their own font " +
    "encoding) from known-text-at-known-offset hints, instead of reverse-engineering it by hand. Workflow: " +
    "find a recognizable on-screen string, locate its bytes in the ROM, pass `{text, offset}` hints; " +
    "returns `{fontMap, learnedChars, unknownChars}` — save it as JSON and pass `fontMapPath` to " +
    "encodeTextForRom / findEncodedText. Throws on conflicting hints (usually a wrong offset). Per-ROM, " +
    "not per-platform.",
    {
      romPath: z.string().describe("Absolute path to the ROM file."),
      platform: z.string().optional().describe("Optional — purely informational here; reuses the same map regardless of platform."),
      knownStrings: z.array(z.object({
        text: z.string().describe("The string you can see rendered in-game."),
        offset: z.number().int().min(0).describe("File offset where those bytes live in the ROM (find via findEncodedText hints or inspection)."),
      })).min(1).describe("Hints. One or more is enough to start; more hints cover more of the alphabet."),
      alphabet: z.string().optional().describe("Which characters to track in unknownChars[]. Default: A-Z, 0-9, space, ©."),
    },
    safeTool(async (args) => {
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
      platform: z.enum(["nes", "snes", "genesis", "megadrive", "md", "gb", "gbc"]).optional().describe("Optional — enables CPU-address translation in the response."),
      maxResults: z.number().int().min(1).max(256).default(16),
    },
    safeTool(async (args) => {
      const r = await findEncodedTextCore(args);
      return jsonContent(r);
    }),
  );
}
