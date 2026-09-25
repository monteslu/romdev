// The SNES ROM image as snes9x loads it (memmap.cpp LoadROMMem ->
// LoadROMInt -> InitROM, the path libretro's retro_load_game takes for a
// plain cartridge): copier header detection by score, the >4MB extended
// formats (ExHiROM and the "jumbo" LoROM, with the halves swapped into
// place), interleaved images, LoROM / HiROM by score, the header fields,
// the per-board memory map and the coprocessor / satellite / add-on
// detection. The recompiler works on the image this returns, so a file
// offset IS snes9x's Memory.ROM offset and its maps address it directly.
//
// Board-specific LoROM maps and forced-LoROM titles are chosen by header
// name, which snes9x does in code; those names are generated data here
// (snes9x-romfixes.json, from scripts/recompile-gen/snes9x-romfixes.mjs).
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { chipFor } from "./coproc.js";
import { loadMultiCart, addonAfterLoad } from "./addon-carts.js";

const FIXES = JSON.parse(readFileSync(new URL("./snes9x-romfixes.json", import.meta.url), "utf8"));

/** snes9x MAX_ROM_SIZE: LoadROMMem refuses a larger image. */
export const MAX_ROM_SIZE = 0xc00000;

const latin1 = (/** @type {Uint8Array} */ b, o, n) => {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]);
  return s;
};
/** C strncmp(a, b, n) == 0 where `a` is memory (NUL ends it) and `b` a latin1 string. */
function strneq(mem, off, str, n) {
  for (let i = 0; i < n; i++) {
    const a = mem[off + i] ?? 0, b = i < str.length ? str.charCodeAt(i) : 0;
    if (a !== b) return false;
    if (a === 0) return true;
  }
  return true;
}

function allASCII(b, o, n) {
  for (let i = 0; i < n; i++) if (b[o + i] < 32 || b[o + i] > 126) return false;
  return true;
}

/** snes9x CMemory::ScoreHiROM. */
function scoreHiROM(rom, calc, skipHeader, romoff = 0) {
  const o = 0xff00 + romoff + (skipHeader ? 0x200 : 0);
  const b = (i) => rom[o + i];
  let s = 0;
  if (b(0xd7) === 13 && calc > 1024 * 1024 * 4) s += 3;
  if (b(0xd5) & 1) s += 2;
  if (b(0xd5) === 0x23) s -= 2;
  if (b(0xd4) === 0x20) s += 2;
  if (b(0xdc) + (b(0xdd) << 8) + b(0xde) + (b(0xdf) << 8) === 0xffff) {
    s += 2;
    if (b(0xde) + (b(0xdf) << 8) !== 0) s++;
  }
  if (b(0xda) === 0x33) s += 2;
  if ((b(0xd5) & 0xf) < 4) s += 2;
  if (!(b(0xfd) & 0x80)) s -= 6;
  if (b(0xfc) + (b(0xfd) << 8) > 0xffb0) s -= 2;
  if (calc > 1024 * 1024 * 3) s += 4;
  if (b(0xd7) > 12) s -= 1;
  if (!allASCII(rom, o + 0xb0, 6)) s -= 1;
  if (!allASCII(rom, o + 0xc0, 22)) s -= 1;
  return s;
}

/** snes9x CMemory::ScoreLoROM. */
function scoreLoROM(rom, calc, skipHeader, romoff = 0) {
  const o = 0x7f00 + romoff + (skipHeader ? 0x200 : 0);
  const b = (i) => rom[o + i];
  let s = 0;
  if (!(b(0xd5) & 1)) s += 3;
  if (b(0xd5) === 0x23) s += 2;
  if (b(0xdc) + (b(0xdd) << 8) + b(0xde) + (b(0xdf) << 8) === 0xffff) {
    s += 2;
    if (b(0xde) + (b(0xdf) << 8) !== 0) s++;
  }
  if (b(0xda) === 0x33) s += 2;
  if ((b(0xd5) & 0xf) < 4) s += 2;
  if (!(b(0xfd) & 0x80)) s -= 6;
  if (b(0xfc) + (b(0xfd) << 8) > 0xffb0) s -= 2;
  if (calc <= 1024 * 1024 * 16) s += 2;
  // (1 << (buf[0xd7] - 7)) in C: a negative shift count is taken mod 32 on x86/wasm
  if ((1 << ((b(0xd7) - 7) & 31)) > 48) s -= 1;
  if (!allASCII(rom, o + 0xb0, 6)) s -= 1;
  if (!allASCII(rom, o + 0xc0, 22)) s -= 1;
  return s;
}

/** snes9x S9xDeinterleaveType1 (block swap of 32KB halves). */
function deinterleaveType1(size, base, off = 0) {
  const nblocks = size >> 16;
  const blocks = new Uint8Array(256);
  for (let i = 0; i < nblocks; i++) { blocks[i * 2] = i + nblocks; blocks[i * 2 + 1] = i; }
  const tmp = new Uint8Array(0x8000);
  for (let i = 0; i < nblocks * 2; i++) {
    for (let j = i; j < nblocks * 2; j++) {
      if (blocks[j] === i) {
        const bj = off + blocks[j] * 0x8000, bi = off + blocks[i] * 0x8000;
        tmp.set(base.subarray(bj, bj + 0x8000));
        base.copyWithin(bj, bi, bi + 0x8000);
        base.set(tmp, bi);
        const t = blocks[j]; blocks[j] = blocks[i]; blocks[i] = t;
        break;
      }
    }
  }
}

/** snes9x is_bsx (bsx.cpp / libretro.cpp). */
function isBsx(p, o) {
  const b = (i) => p[o + i] ?? 0;
  const validBank = [32, 33, 48, 49].includes(b(24));
  if ((b(26) === 0x33 || b(26) === 0xff) && (!b(21) || (b(21) & 131) === 128) && validBank) {
    const m = b(22);
    if (!m && !b(23)) return 2;
    if ((m === 0xff && b(23) === 0xff) || (!(m & 0xf) && (m >> 4) - 1 < 12)) return 1;   // int arithmetic: 0 - 1 < 12
  }
  return 0;
}

/** ROMType/ROMSpeed identifier -> coprocessor, as InitROM detects it. */
function coprocessorOf(romType, romSpeed, rom, hiRom, headerByte2a) {
  if (romType === 0x03) return romSpeed === 0x30 ? "DSP-4" : "DSP-1";
  if (romType === 0x05) {
    if (romSpeed === 0x20) return "DSP-2";
    if (romSpeed === 0x30 && headerByte2a === 0xb2) return "DSP-3";
    return "DSP-1";
  }
  const id = ((romType & 0xff) << 8) + (romSpeed & 0xff);
  switch (id) {
    case 0x5535: return "S-RTC";
    case 0xf93a: case 0xf53a: return "SPC7110";
    case 0x2530: return "OBC1";
    case 0x3423: case 0x3523: return "SA-1";
    case 0x1320: case 0x1420: case 0x1520: case 0x1a20:
    case 0x1330: case 0x1430: case 0x1530: case 0x1a30: return "SuperFX (GSU)";
    case 0x4332: case 0x4532: return "S-DD1";
    case 0xf530: return "ST018";
    case 0xf630: return rom[0x7fd7] === 0x09 ? "ST011" : "ST010";
    case 0xf320: return "CX4";
    default: return null;
  }
}

/**
 * Load a cartridge image the way snes9x (libretro retro_load_game) does:
 * a Sufami Turbo or BS cart with its BIOS (addon-carts.js), else
 * LoadROMMem, and then the add-on BIOSes run by themselves.
 * @param {Uint8Array} data
 * @param {{romPath?: string, bios?: string}} [opts]  where to look for a BIOS
 */
export function loadRom(data, opts) {
  const multi = loadMultiCart(data, opts);
  if (multi && !multi.refusal) return multi;
  const r = addonAfterLoad(loadRomPlain(data));
  if (multi?.refusal) return { ...r, refusal: multi.refusal };
  return r;
}

/**
 * Load a cartridge image the way snes9x does.
 * @param {Uint8Array} data  the file bytes (a copier header, if any, included)
 * @returns {{ img: Uint8Array, calculatedSize: number, hiRom: boolean, extended: "none"|"bigfirst"|"smallfirst",
 *   headerStripped: boolean, interleaved: boolean, header: number, romName: string, romNameRaw: Uint8Array,
 *   romId: Uint8Array, romSize: number, sramSize: number, romSpeed: number, romType: number, region: number,
 *   pal: boolean, map: string, coprocessor: string|null, refusal: string|null }}
 */
function loadRomPlain(data) {
  let refusal = null;
  if (data.length > MAX_ROM_SIZE) refusal = `ROM image is ${data.length} bytes; snes9x loads at most ${MAX_ROM_SIZE}`;
  // Satellaview (BS-X) and Sufami Turbo carts load with a BIOS in libretro.
  if (!refusal && data.length >= 0x80000 && data.length <= 0x100000 &&
      strneq(data, 0, "BANDAI SFC-ADX", 14) && !strneq(data, 0x10, "SFC-ADX BACKUP", 14)) {
    refusal = "Sufami Turbo cart (needs the Sufami Turbo BIOS); the SNES recompiler models plain cartridges";
  }
  if (!refusal && (isBsx(data, 0x7fc0) === 1 || isBsx(data, 0xffc0) === 1)) {
    refusal = "Satellaview (BS-X) cart (needs the BS-X BIOS); the SNES recompiler models plain cartridges";
  }
  const rom = new Uint8Array(MAX_ROM_SIZE + 0x10000);   // snes9x Memory.ROM, zero-filled past the image
  rom.set(data.subarray(0, Math.min(data.length, MAX_ROM_SIZE)));
  let fill = Math.min(data.length, MAX_ROM_SIZE);

  // LoadROMInt: copier header by score.
  let calc = 0;
  let hi = scoreHiROM(rom, calc, false), lo = scoreLoROM(rom, calc, false);
  const nonHeadered = Math.max(hi, lo);
  let headered = Math.max(scoreHiROM(rom, calc, true), scoreLoROM(rom, calc, true));
  headered += ((fill - 512) & 0xffff) === 0 ? 2 : -2;
  let zeros = 0;
  for (let i = 0; i < 512; i++) if (rom[i] === 0) zeros++;
  headered += zeros >= 0x1e0 ? 2 : -2;
  let headerStripped = false;
  if (headered > nonHeadered) {
    rom.copyWithin(0, 512, fill);   // (memmove: the last 512 bytes stay as they were)
    fill -= 512;
    headerStripped = true;
  }
  calc = Math.floor((fill + 0x1fff) / 0x2000) * 0x2000;

  const w = (o) => rom[o] + (rom[o + 1] << 8);
  let extended = "none";
  if (calc > 0x400000 &&
      ![0x1320, 0x1420, 0x1520, 0x1a20, 0x3423, 0x3523, 0x4332, 0x4532].includes(w(0x7fd5)) &&
      ![0xf93a, 0xf53a].includes(w(0xffd5))) extended = "yes";
  let interleaved = false;
  if (extended === "none" && w(0x7ffc) < 0x8000 && w(0xfffc) < 0x8000) {
    deinterleaveType1(fill, rom);
    interleaved = true;
  }
  hi = scoreHiROM(rom, calc, false);
  lo = scoreLoROM(rom, calc, false);
  let hdr = 0;
  if (extended !== "none") {
    const shi = scoreHiROM(rom, calc, false, 0x400000), slo = scoreLoROM(rom, calc, false, 0x400000);
    if (Math.max(slo, shi) >= Math.max(lo, hi)) { extended = "bigfirst"; hi = shi; lo = slo; hdr = 0x400000; }
    else extended = "smallfirst";
  }

  let il = false, tales = false, loRom, hiRom;
  if (lo >= hi) {
    loRom = true; hiRom = false;
    const mm = rom[hdr + 0x7fd5];
    if ((mm & 0xf0) === 0x20 || (mm & 0xf0) === 0x30) {
      if ((mm & 0xf) === 1) il = true;
      else if ((mm & 0xf) === 5) { il = true; tales = true; }
    }
  } else {
    loRom = false; hiRom = true;
    const mm = rom[hdr + 0xffd5];
    if ((mm & 0xf0) === 0x20 || (mm & 0xf0) === 0x30) {
      if ((mm & 0xf) === 0 || (mm & 0xf) === 3) il = true;
    }
  }
  // Titles snes9x forces to LoROM (generated data).
  for (const f of FIXES.forceLoRom) {
    if (strneq(rom, f.offset, f.name, f.length)) { loRom = true; hiRom = false; il = false; tales = false; }
  }
  if (il) {
    interleaved = true;
    if (tales) {
      if (extended === "bigfirst") {
        deinterleaveType1(0x400000, rom);
        deinterleaveType1(calc - 0x400000, rom, 0x400000);
      } else {
        deinterleaveType1(calc - 0x400000, rom);
        deinterleaveType1(0x400000, rom, calc - 0x400000);
      }
      loRom = false; hiRom = true;
    } else {
      [loRom, hiRom] = [hiRom, loRom];
      deinterleaveType1(calc, rom);
    }
    hi = scoreHiROM(rom, calc, false);
    lo = scoreLoROM(rom, calc, false);
    if ((hiRom && (lo >= hi || hi < 0)) || (loRom && (hi > lo || lo < 0))) {
      // snes9x retries with ForceNotInterleaved; start over without it.
      return loadRomNotInterleaved(data, refusal);
    }
  }
  if (extended === "smallfirst") tales = true;
  if (tales) {
    const tmp = rom.slice(0, calc - 0x400000);
    rom.copyWithin(0, calc - 0x400000, calc);
    rom.set(tmp, 0x400000);
  }
  return finish(rom, calc, hiRom, extended, headerStripped, interleaved, refusal);
}

/** LoadROMInt's second pass after "ROM lied about its type": ForceNotInterleaved. */
function loadRomNotInterleaved(data, refusal) {
  const rom = new Uint8Array(MAX_ROM_SIZE + 0x10000);
  rom.set(data.subarray(0, Math.min(data.length, MAX_ROM_SIZE)));
  let fill = Math.min(data.length, MAX_ROM_SIZE);
  let calc = 0;
  let hi = scoreHiROM(rom, calc, false), lo = scoreLoROM(rom, calc, false);
  const nonHeadered = Math.max(hi, lo);
  let headered = Math.max(scoreHiROM(rom, calc, true), scoreLoROM(rom, calc, true));
  headered += ((fill - 512) & 0xffff) === 0 ? 2 : -2;
  let zeros = 0;
  for (let i = 0; i < 512; i++) if (rom[i] === 0) zeros++;
  headered += zeros >= 0x1e0 ? 2 : -2;
  let headerStripped = false;
  if (headered > nonHeadered) {
    rom.copyWithin(0, 512, fill);   // (memmove: the last 512 bytes stay as they were)
    fill -= 512;
    headerStripped = true;
  }
  calc = Math.floor((fill + 0x1fff) / 0x2000) * 0x2000;
  const w = (o) => rom[o] + (rom[o + 1] << 8);
  let extended = "none";
  if (calc > 0x400000 &&
      ![0x1320, 0x1420, 0x1520, 0x1a20, 0x3423, 0x3523, 0x4332, 0x4532].includes(w(0x7fd5)) &&
      ![0xf93a, 0xf53a].includes(w(0xffd5))) extended = "yes";
  hi = scoreHiROM(rom, calc, false);
  lo = scoreLoROM(rom, calc, false);
  if (extended !== "none") {
    const shi = scoreHiROM(rom, calc, false, 0x400000), slo = scoreLoROM(rom, calc, false, 0x400000);
    if (Math.max(slo, shi) >= Math.max(lo, hi)) { extended = "bigfirst"; hi = shi; lo = slo; }
    else extended = "smallfirst";
  }
  let hiRom = !(lo >= hi);
  for (const f of FIXES.forceLoRom) if (strneq(rom, f.offset, f.name, f.length)) hiRom = false;
  if (extended === "smallfirst") {
    const tmp = rom.slice(0, calc - 0x400000);
    rom.copyWithin(0, calc - 0x400000, calc);
    rom.set(tmp, 0x400000);
  }
  return finish(rom, calc, hiRom, extended, headerStripped, false, refusal);
}

/** InitROM: header fields, chips, board map, the truncated name. */
function finish(rom, calc, hiRom, extended, headerStripped, interleaved, refusal) {
  let header = 0x7fb0;
  if (extended === "bigfirst") header += 0x400000;
  if (hiRom) header += 0x8000;
  // ParseSNESHeader (not a BS cart: those were refused)
  const nameRaw = new Uint8Array(22);
  for (let i = 0; i < 22; i++) { const c = rom[header + 0x10 + i]; if (!c) break; nameRaw[i] = c; }
  const romSize = rom[header + 0x27];
  let sramSize = rom[header + 0x28];
  const romSpeed = rom[header + 0x25];
  const romType = rom[header + 0x26];
  const region = rom[header + 0x29];
  const romId = rom.slice(header + 0x02, header + 0x06);
  const coprocessor = coprocessorOf(romType, romSpeed, rom, hiRom, rom[header + 0x2a]);
  // BS-X in the loaded image (S9xInitBSX), after the load-time check.
  if (!refusal && (isBsx(rom, 0x7fc0) === 1 || isBsx(rom, 0xffc0) === 1)) {
    refusal = "Satellaview (BS-X) cart (needs the BS-X BIOS); the SNES recompiler models plain cartridges";
  }
  // The LoROM board map by name (untruncated ROMName, strncmp prefixes).
  let map = hiRom ? (extended !== "none" ? "ExtendedHiROM" : "HiROM") : (extended !== "none" ? "JumboLoROM" : "LoROM");
  if (!hiRom && extended === "none") {
    for (const m of FIXES.loRomMaps) {
      if (strneq(nameRaw, 0, m.name, m.length)) { map = m.map; break; }
    }
  }
  // A coprocessor the cart models (coproc.js) may bring its own board
  // (InitROM picks Map_SDD1LoROMMap, Map_SPC7110HiROMMap, ... by chip).
  const chip = chipFor(coprocessor);
  if (chip?.board) map = chip.board({ hiRom, extended, map }) ?? map;
  // ... and its own SRAM size (InitROM: the SuperFX case reads ROM[$7FBD])
  if (chip?.sramSize) sramSize = chip.sramSize(rom, sramSize);
  // ... and SNESGameFixes.SRAMInitialValue (InitROM: 0x00 for the SETA chips)
  const sramInit = chip?.sramInit;
  if (!refusal && coprocessor && !chip) refusal = `cart uses the ${coprocessor} coprocessor; the SNES recompiler models the base console only`;
  if (!refusal && !chip?.boards?.includes(map) && !["LoROM", "HiROM", "ExtendedHiROM", "JumboLoROM", ...FIXES.loRomMaps.map((m) => m.map).filter((m) => MAPS_SUPPORTED.has(m))].includes(map)) {
    refusal = `cart uses snes9x's ${map} board map (an add-on / satellite board); the SNES recompiler models plain cartridges`;
  }
  // The name the per-title fixes match: NUL at 22, cut after 21 when the
  // 21st character is a space, trailing spaces stripped.
  let n = nameRaw.indexOf(0); if (n < 0) n = 22;
  let p = n;
  if (p > 21 && nameRaw[20] === 0x20) p = 21;
  while (p > 0 && nameRaw[p - 1] === 0x20) p--;
  const romName = latin1(nameRaw, 0, p);
  // NTSC / PAL by region byte
  const pal = (region >= 2 && region <= 12) || region === 18;
  return {
    img: rom.slice(0, calc), calculatedSize: calc, hiRom, extended, headerStripped, interleaved,
    header, romName, romNameRaw: nameRaw.slice(0, n), romId, romSize, sramSize, romSpeed, romType, region, pal,
    map, coprocessor, refusal, ...(sramInit != null ? { sramInit } : {}),
  };
}

/** Board maps memmap.js implements. */
export const MAPS_SUPPORTED = new Set(["LoROM", "HiROM", "ExtendedHiROM", "JumboLoROM", "NoMAD1LoROM", "ROM24MBSLoROM", "SRAM512KLoROM", "SufamiTurboPseudoLoROM", "SufamiTurboLoROM"]);
