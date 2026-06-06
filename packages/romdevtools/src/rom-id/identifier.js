// ROM identification.
//
// Given a path or raw bytes, figure out which retro platform this ROM is for
// and pull out the metadata the agent will want before loading it. Handles
// zip wrappers and the eight or so common header formats.
//
// Public API:
//   identifyFile(path) → IdentifyResult
//   identifyBytes(bytes, hint?) → IdentifyResult
//   identifyZip(path) → IdentifyResult[] (one per ROM inside)

import { readFile } from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";

/**
 * @typedef {Object} IdentifyResult
 * @property {string} platform        platform id from src/cores/registry.js (e.g. "nes")
 * @property {string} format          file extension we'd write (e.g. ".nes", ".gb")
 * @property {string} [title]         in-cart title if available
 * @property {string} [region]        "NTSC", "PAL", "World", etc.
 * @property {string | number} [mapper]
 * @property {Object} [sizes]         { prg, chr, rom, ram, ... }
 * @property {string[]} [notes]       freeform observations
 * @property {number} confidence      0..1 — how sure we are
 * @property {string} [source]        source file path or zip entry name
 */

/**
 * Sniff and identify a file on disk.
 * Unwraps a single-ROM zip automatically.
 * @param {string} filePath
 * @returns {Promise<IdentifyResult>}
 */
export async function identifyFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const data = await readFile(filePath);

  if (ext === ".zip" || isZip(data)) {
    const entries = await listZip(filePath);
    if (entries.length === 0) {
      return { platform: "unknown", format: ".zip", confidence: 0, notes: ["empty zip"] };
    }
    // Identify the first non-junk entry.
    for (const entry of entries) {
      if (/\/$/.test(entry.fileName)) continue;
      if (/__MACOSX/i.test(entry.fileName)) continue;
      const bytes = await extractEntry(filePath, entry.fileName);
      if (!bytes) continue;
      const result = identifyBytes(bytes, path.extname(entry.fileName));
      result.source = filePath + "::" + entry.fileName;
      return result;
    }
    return { platform: "unknown", format: ".zip", confidence: 0, notes: ["zip had no identifiable ROM"] };
  }

  const result = identifyBytes(data, ext);
  result.source = filePath;
  return result;
}

/**
 * Identify raw bytes. The optional `hint` (file extension) helps when the
 * format has no magic bytes (Atari 2600, raw bin Genesis).
 * @param {Uint8Array} bytes
 * @param {string} [hint] file extension (".nes", ".sfc", etc.)
 * @returns {IdentifyResult}
 */
export function identifyBytes(bytes, hint = "") {
  // 1. Try magic-byte signatures first — these are unambiguous.
  if (isINes(bytes)) return parseINes(bytes);
  if (isGenesis(bytes)) return parseGenesis(bytes);
  if (isLynx(bytes)) return parseLynx(bytes);
  if (isGameBoy(bytes)) return parseGameBoy(bytes);
  if (isGba(bytes)) return parseGba(bytes);
  if (isSnes(bytes)) return parseSnes(bytes);
  if (isSms(bytes)) return parseSms(bytes, hint);
  if (isNsf(bytes)) return { platform: "nes", format: ".nsf", confidence: 1, notes: ["NSF music file"] };

  // 2. No signature — fall back to extension + size heuristics.
  return guessByExtension(bytes, hint);
}

/** Recognize a zip by PK\x03\x04 magic. */
function isZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
      && bytes[2] === 0x03 && bytes[3] === 0x04;
}

// ───────── iNES (NES) ─────────

function isINes(b) {
  return b.length >= 16 && b[0] === 0x4e && b[1] === 0x45 && b[2] === 0x53 && b[3] === 0x1a;
}

function parseINes(b) {
  const prgBanks = b[4];
  const chrBanks = b[5];
  const f6 = b[6];
  const f7 = b[7];
  const mapper = (f7 & 0xf0) | (f6 >> 4);
  const mirroring = f6 & 1 ? "vertical" : "horizontal";
  const isNes2 = (f7 & 0x0c) === 0x08;
  const notes = [];
  notes.push(isNes2 ? "iNES 2.0 header" : "iNES 1.0 header");
  if (f6 & 0x02) notes.push("battery-backed save");
  if (f6 & 0x04) notes.push("trainer present");
  if (f6 & 0x08) notes.push("four-screen VRAM");

  return {
    platform: "nes",
    format: ".nes",
    mapper,
    region: "NTSC",
    sizes: {
      prg: prgBanks * 16384,
      chr: chrBanks * 8192,
      total: b.length,
    },
    notes: [...notes, `mirroring: ${mirroring}`],
    confidence: 1,
  };
}

// ───────── Genesis / Mega Drive ─────────

function isGenesis(b) {
  if (b.length < 0x200) return false;
  // "SEGA GENESIS", "SEGA MEGA DRIVE", "SEGA 32X", "SEGA EVERDRIVE", "SEGA SSF", etc.
  const sig = decodeAscii(b, 0x100, 16);
  return /SEGA\s+(GENESIS|MEGA DRIVE|32X|SSF|EVERDRIVE)/i.test(sig);
}

function parseGenesis(b) {
  const sig = decodeAscii(b, 0x100, 16).trim();
  const titleDom = decodeAscii(b, 0x120, 48).trim();
  const titleInt = decodeAscii(b, 0x150, 48).trim();
  const region = decodeAscii(b, 0x1f0, 4).trim();
  return {
    platform: "genesis",
    format: ".bin",
    title: titleInt || titleDom,
    region: region || "World",
    sizes: { total: b.length },
    notes: [`signature: ${sig}`, titleDom && `domestic title: ${titleDom}`].filter(Boolean),
    confidence: 1,
  };
}

// ───────── Atari Lynx ─────────

function isLynx(b) {
  return b.length >= 4 && b[0] === 0x4c && b[1] === 0x59 && b[2] === 0x4e && b[3] === 0x58;
  // "LYNX"
}

function parseLynx(b) {
  return {
    platform: "lynx",
    format: ".lnx",
    sizes: { total: b.length },
    confidence: 1,
  };
}

// ───────── Game Boy / GBC ─────────

const NINTENDO_LOGO = new Uint8Array([
  0xCE,0xED,0x66,0x66,0xCC,0x0D,0x00,0x0B,
  0x03,0x73,0x00,0x83,0x00,0x0C,0x00,0x0D,
  0x00,0x08,0x11,0x1F,0x88,0x89,0x00,0x0E,
  0xDC,0xCC,0x6E,0xE6,0xDD,0xDD,0xD9,0x99,
  0xBB,0xBB,0x67,0x63,0x6E,0x0E,0xEC,0xCC,
  0xDD,0xDC,0x99,0x9F,0xBB,0xB9,0x33,0x3E,
]);

function isGameBoy(b) {
  if (b.length < 0x150) return false;
  for (let i = 0; i < NINTENDO_LOGO.length; i++) {
    if (b[0x104 + i] !== NINTENDO_LOGO[i]) return false;
  }
  return true;
}

function parseGameBoy(b) {
  const title = decodeAscii(b, 0x134, 16).replace(/\0.*$/, "").trim();
  const cgbFlag = b[0x143];
  const sgbFlag = b[0x146];
  const cartType = b[0x147];
  const romSizeCode = b[0x148];
  const ramSizeCode = b[0x149];
  const region = b[0x14a] === 0 ? "Japan" : "World";

  // ROM size: 32KB << romSizeCode for small carts.
  const romSize = 32 * 1024 * (1 << romSizeCode);
  const ramSizes = { 0: 0, 1: 2 * 1024, 2: 8 * 1024, 3: 32 * 1024, 4: 128 * 1024, 5: 64 * 1024 };
  const ramSize = ramSizes[ramSizeCode] ?? -1;

  const isGbc = cgbFlag === 0x80 || cgbFlag === 0xC0;
  const platform = isGbc ? "gbc" : "gb";

  const cartTypeNames = {
    0x00: "ROM only", 0x01: "MBC1", 0x02: "MBC1+RAM", 0x03: "MBC1+RAM+BATTERY",
    0x05: "MBC2", 0x06: "MBC2+BATTERY", 0x08: "ROM+RAM", 0x09: "ROM+RAM+BATTERY",
    0x0F: "MBC3+TIMER+BATTERY", 0x10: "MBC3+TIMER+RAM+BATTERY", 0x11: "MBC3",
    0x12: "MBC3+RAM", 0x13: "MBC3+RAM+BATTERY", 0x19: "MBC5", 0x1A: "MBC5+RAM",
    0x1B: "MBC5+RAM+BATTERY", 0x1C: "MBC5+RUMBLE", 0x1D: "MBC5+RUMBLE+RAM",
    0x1E: "MBC5+RUMBLE+RAM+BATTERY", 0xFC: "Pocket Camera", 0xFE: "HuC3", 0xFF: "HuC1+RAM+BATTERY",
  };

  return {
    platform,
    format: isGbc ? ".gbc" : ".gb",
    title: title || undefined,
    region,
    mapper: cartTypeNames[cartType] ?? `0x${cartType.toString(16)}`,
    sizes: { rom: romSize, ram: ramSize, total: b.length },
    notes: [
      isGbc ? "Game Boy Color cartridge" : "Original Game Boy cartridge",
      sgbFlag === 0x03 && "supports Super Game Boy enhancements",
    ].filter(Boolean),
    confidence: 1,
  };
}

// ───────── GBA ─────────

function isGba(b) {
  if (b.length < 0xC0) return false;
  // The Nintendo logo at $0004 (156 bytes).
  // We accept on a quick fingerprint: first 4 bytes of the GBA logo are 0x24 0xFF 0xAE 0x51.
  return b[4] === 0x24 && b[5] === 0xff && b[6] === 0xae && b[7] === 0x51;
}

function parseGba(b) {
  const title = decodeAscii(b, 0xa0, 12).replace(/\0.*$/, "").trim();
  const code = decodeAscii(b, 0xac, 4).trim();
  return {
    platform: "gba",
    format: ".gba",
    title: title || undefined,
    notes: [`game code: ${code}`],
    sizes: { total: b.length },
    confidence: 1,
  };
}

// ───────── SNES ─────────

function isSnes(b) {
  if (b.length < 0x8000) return false;
  // Headerless SMC: lorom header at $7FC0, hirom at $FFC0.
  // Also handle 512-byte copier header.
  const off = b.length % 0x8000 === 0x200 ? 0x200 : 0;
  if (b.length < off + 0xffe0) return false;
  return checkSnesHeader(b, off + 0x7fc0) || checkSnesHeader(b, off + 0xffc0);
}

function checkSnesHeader(b, baseOff) {
  if (baseOff + 32 > b.length) return false;
  // Title is at baseOff (21 bytes of ASCII), maker code at baseOff+21, etc.
  // Heuristic: title chars should be mostly printable, mapper byte at +0x15 is 0x20|0x21|0x30|0x31.
  let printable = 0;
  for (let i = 0; i < 21; i++) {
    const c = b[baseOff + i];
    if ((c >= 0x20 && c < 0x7f) || c === 0) printable++;
  }
  const mapper = b[baseOff + 0x15];
  return printable >= 18 && (mapper === 0x20 || mapper === 0x21 || mapper === 0x30 || mapper === 0x31 || mapper === 0x32);
}

function parseSnes(b) {
  const copierHdr = b.length % 0x8000 === 0x200 ? 0x200 : 0;
  const tryLoOff = copierHdr + 0x7fc0;
  const tryHiOff = copierHdr + 0xffc0;
  const isLo = checkSnesHeader(b, tryLoOff);
  const baseOff = isLo ? tryLoOff : tryHiOff;
  const title = decodeAscii(b, baseOff, 21).replace(/\0.*$/, "").trim();
  const mapByte = b[baseOff + 0x15];
  const romSizeCode = b[baseOff + 0x17];
  const ramSizeCode = b[baseOff + 0x18];
  const regionCode = b[baseOff + 0x19];

  const regionNames = {
    0: "Japan", 1: "USA/NTSC", 2: "Europe/PAL", 3: "Sweden/PAL", 4: "Finland/PAL",
    5: "Denmark/PAL", 6: "France/PAL", 7: "Holland/PAL", 8: "Spain/PAL", 9: "Germany/PAL",
    0xa: "Italy/PAL", 0xb: "China", 0xd: "Korea", 0xf: "Canada",
  };
  return {
    platform: "snes",
    format: ".sfc",
    title: title || undefined,
    mapper: isLo ? (mapByte === 0x20 ? "LoROM" : mapByte === 0x21 ? "HiROM" : `0x${mapByte.toString(16)}`)
                 : (mapByte === 0x21 ? "HiROM" : `0x${mapByte.toString(16)}`),
    region: regionNames[regionCode] ?? `0x${regionCode.toString(16)}`,
    sizes: {
      rom: 1024 << romSizeCode,
      ram: ramSizeCode > 0 ? (1024 << ramSizeCode) : 0,
      total: b.length,
    },
    notes: [
      copierHdr ? "has 512-byte copier header" : null,
      isLo ? "LoROM layout" : "HiROM layout",
    ].filter(Boolean),
    confidence: 1,
  };
}

// ───────── Sega Master System / Game Gear ─────────

function isSms(b) {
  if (b.length < 0x8000) return false;
  // "TMR SEGA" magic at offset 0x7FF0 (or other offsets, but this is the standard).
  return (
    b[0x7ff0] === 0x54 && b[0x7ff1] === 0x4d && b[0x7ff2] === 0x52 && b[0x7ff3] === 0x20 &&
    b[0x7ff4] === 0x53 && b[0x7ff5] === 0x45 && b[0x7ff6] === 0x47 && b[0x7ff7] === 0x41
  );
}

function parseSms(b, hint) {
  // The header itself doesn't distinguish SMS from GG; rely on the extension.
  const platform = hint === ".gg" ? "gg" : "sms";
  const regionByte = (b[0x7fff] >> 4) & 0xf;
  const regions = { 3: "SMS Japan", 4: "SMS Export", 5: "GG Japan", 6: "GG Export", 7: "GG International" };
  return {
    platform,
    format: hint === ".gg" ? ".gg" : ".sms",
    region: regions[regionByte] ?? `code ${regionByte}`,
    sizes: { total: b.length },
    notes: ["TMR SEGA header present"],
    confidence: 1,
  };
}

// ───────── NSF (NES music) ─────────

function isNsf(b) {
  return b.length >= 5 && b[0] === 0x4e && b[1] === 0x45 && b[2] === 0x53 && b[3] === 0x4d && b[4] === 0x1a;
  // "NESM\x1A"
}

// ───────── Extension fallback ─────────

function guessByExtension(bytes, ext) {
  const e = ext.toLowerCase();
  switch (e) {
    case ".a26":
    case ".bin": // ambiguous; size heuristic below
      // Atari 2600 ROMs are 2, 4, 8, 16, or 32 KB.
      if ([2048, 4096, 8192, 16384, 32768].includes(bytes.length)) {
        return { platform: "atari2600", format: ".a26", sizes: { total: bytes.length }, confidence: 0.7 };
      }
      // .bin without 2600 sizing — could be Genesis if signature was missed
      // (we check signature first so this falls through to unknown).
      return { platform: "unknown", format: e, confidence: 0.2, notes: ["bin file but no recognized header"] };
    case ".a78":
      return { platform: "atari7800", format: ".a78", sizes: { total: bytes.length }, confidence: 0.8 };
    case ".prg":
    case ".d64":
    case ".t64":
    case ".crt":
      return { platform: "c64", format: e, sizes: { total: bytes.length }, confidence: 0.9, notes: ["C64 media"] };
    case ".pce":
      return { platform: "pce", format: ".pce", sizes: { total: bytes.length }, confidence: 0.8 };
    case ".sg":
    case ".sc":
      return { platform: "sg1000", format: ".sg", sizes: { total: bytes.length }, confidence: 0.6 };
    default:
      return { platform: "unknown", format: e || "unknown", sizes: { total: bytes.length }, confidence: 0 };
  }
}

// ───────── Zip helpers ─────────

function listZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      const entries = [];
      zipfile.on("entry", (entry) => {
        entries.push(entry);
        zipfile.readEntry();
      });
      zipfile.on("end", () => resolve(entries));
      zipfile.on("error", reject);
      zipfile.readEntry();
    });
  });
}

function extractEntry(filePath, name) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.on("entry", (entry) => {
        if (entry.fileName !== name) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const chunks = [];
          stream.on("data", (c) => chunks.push(c));
          stream.on("end", () => resolve(Buffer.concat(chunks)));
          stream.on("error", reject);
        });
      });
      zipfile.on("end", () => resolve(null));
      zipfile.on("error", reject);
      zipfile.readEntry();
    });
  });
}

function decodeAscii(b, off, len) {
  let s = "";
  for (let i = 0; i < len && off + i < b.length; i++) {
    s += String.fromCharCode(b[off + i]);
  }
  return s;
}
