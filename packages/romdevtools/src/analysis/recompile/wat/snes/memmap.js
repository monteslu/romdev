// The SNES memory map of a recompiled cart, built the way snes9x builds its
// own: a table of 4096 blocks of 4KB (snes9x memmap.cpp Memory.Map, one
// entry per MEMMAP_BLOCK_SIZE), filled by Map_LoROMMap / Map_HiROMMap
// (map_System, map_lorom / map_hirom with map_mirror, map_LoROMSRAM /
// map_HiROMSRAM, map_WRAM) and read the way getset.h S9xGetByte /
// S9xSetByte dispatch on it. The cart's $rd8/$wr8 index the same table, so
// ROM mirroring (including non-power-of-two sizes), the unmapped holes that
// read open bus, SRAM windows and write protection are snes9x's, not a
// hand-written approximation of them.
//
// Each entry is 8 bytes: u32 type, u32 base. For ROM and RAM blocks `base`
// is the linear-memory address of the block's first byte (so an access is
// base + (addr & 0xFFF)); the other types dispatch to a handler.
//
// Plain JS ESM + JSDoc.

import { WRAM, ROM } from "./layout.js";
import { sufamiMap } from "./addon-carts.js";

export const MAP_TYPE = Object.freeze({
  NONE: 0,      // open bus; writes ignored
  ROM: 1,       // read-only direct (map_WriteProtectROM)
  RAM: 2,       // read/write direct (WRAM and its $0000-$1FFF mirror)
  PPU: 3,       // $2000-$3FFF (S9xGetPPU / S9xSetPPU)
  CPU: 4,       // $4000-$5FFF (S9xGetCPU / S9xSetCPU)
  LOSRAM: 5,    // MAP_LOROM_SRAM
  HISRAM: 6,    // MAP_HIROM_SRAM
  CHIP: 7,      // a coprocessor's window (coproc.js $chip_rd / $chip_wr)
});

/**
 * snes9x CMemory::map_mirror (from bsnes): where `pos` lands in a ROM of
 * `size` bytes that is mirrored to fill the address space.
 * @param {number} size
 * @param {number} pos
 * @returns {number}
 */
export function mapMirror(size, pos) {
  if (size === 0) return 0;
  if (pos < size) return pos;
  let mask = 0x80000000;
  while (!(pos & mask)) mask = mask >>> 1;
  if (size <= (pos & mask)) return mapMirror(size, pos - mask);
  return mask + mapMirror(size - mask, pos - mask);
}

/**
 * Build the 4096-block map for one of snes9x's plain-cartridge boards
 * (memmap.cpp Map_LoROMMap, Map_HiROMMap, Map_ExtendedHiROMMap,
 * Map_JumboLoROMMap, Map_NoMAD1LoROMMap, Map_ROM24MBSLoROMMap,
 * Map_SRAM512KLoROMMap).
 * @param {object} o
 * @param {string} o.map          snes9x board map name without Map_ / Map (loader.js)
 * @param {number} o.romSize      snes9x CalculatedSize (the image, 8KB-rounded)
 * @param {number} o.romSizeByte  header ROM size byte (snes9x ROMSize)
 * @param {number} o.sramSizeByte snes9x SRAMSize
 * @param {number} o.sramBase     linear address of the SRAM buffer (for boards that map it directly)
 * @param {{offsetA: number, sizeA: number, offsetB: number, sizeB: number}} [o.multi]  a Sufami Turbo cart's slots (addon-carts.js)
 * @param {(api: object) => void} [o.chipMap]  a coprocessor's part of the map (coproc.js): it builds
 *   a board of its own (a map name this switch does not know) or adds its window to a known one;
 *   called after the board, before map_WRAM
 * @returns {Uint8Array} 4096 * 8 bytes
 */
export function buildMemMap({ map, romSize, romSizeByte, sramSizeByte, sramBase, chipMap, multi }) {
  const tab = new Uint8Array(4096 * 8);
  const dv = new DataView(tab.buffer);
  const set = (block, type, base = 0) => { dv.setUint32(block * 8, type, true); dv.setUint32(block * 8 + 4, base >>> 0, true); };
  const size = romSize;
  const each = (b0, b1, a0, a1, f) => {
    for (let c = b0; c <= b1; c++) for (let i = a0; i <= a1; i += 0x1000) f(c, i, (c << 4) | (i >> 12));
  };
  // map_lorom / map_hirom and their _offset forms (addr from the range's first bank)
  const lorom = (b0, b1, a0, a1, sz, off = null) => each(b0, b1, a0, a1, (c, i, p) =>
    set(p, MAP_TYPE.ROM, ROM + (off ?? 0) + mapMirror(sz, (off === null ? c & 0x7f : (c - b0) & 0x7f) * 0x8000) - (i & 0x8000) + i));
  const hirom = (b0, b1, a0, a1, sz, off = null) => each(b0, b1, a0, a1, (c, i, p) =>
    set(p, MAP_TYPE.ROM, ROM + (off ?? 0) + mapMirror(sz, (off === null ? c : c - b0) << 16) + i));
  const loSram = () => {
    const hiEnd = romSizeByte > 11 || sramSizeByte > 5 ? 0x7fff : 0xffff;
    each(0x70, 0x7d, 0x0000, hiEnd, (c, i, p) => set(p, MAP_TYPE.LOSRAM));
    if (sramSizeByte > 0) each(0xf0, 0xff, 0x0000, hiEnd, (c, i, p) => set(p, MAP_TYPE.LOSRAM));
  };
  const hiSram = () => {
    each(0x20, 0x3f, 0x6000, 0x7fff, (c, i, p) => set(p, MAP_TYPE.HISRAM));
    each(0xa0, 0xbf, 0x6000, 0x7fff, (c, i, p) => set(p, MAP_TYPE.HISRAM));
  };
  // Map_Initialize: everything MAP_NONE. map_System:
  for (const [b0, b1] of [[0x00, 0x3f], [0x80, 0xbf]]) {
    each(b0, b1, 0x0000, 0x1fff, (c, i, p) => set(p, MAP_TYPE.RAM, WRAM + i));
    each(b0, b1, 0x2000, 0x3fff, (c, i, p) => set(p, MAP_TYPE.PPU));
    each(b0, b1, 0x4000, 0x5fff, (c, i, p) => set(p, MAP_TYPE.CPU));
  }
  switch (map) {
    case "HiROM":
      hirom(0x00, 0x3f, 0x8000, 0xffff, size); hirom(0x40, 0x7f, 0x0000, 0xffff, size);
      hirom(0x80, 0xbf, 0x8000, 0xffff, size); hirom(0xc0, 0xff, 0x0000, 0xffff, size);
      hiSram();
      break;
    case "ExtendedHiROM":
      hirom(0x00, 0x3f, 0x8000, 0xffff, size - 0x400000, 0x400000);
      hirom(0x40, 0x7f, 0x0000, 0xffff, size - 0x400000, 0x400000);
      hirom(0x80, 0xbf, 0x8000, 0xffff, 0x400000, 0);
      hirom(0xc0, 0xff, 0x0000, 0xffff, 0x400000, 0);
      hiSram();
      break;
    case "LoROM":
      lorom(0x00, 0x3f, 0x8000, 0xffff, size); lorom(0x40, 0x7f, 0x0000, 0xffff, size);
      lorom(0x80, 0xbf, 0x8000, 0xffff, size); lorom(0xc0, 0xff, 0x0000, 0xffff, size);
      loSram();
      break;
    case "JumboLoROM":
      lorom(0x00, 0x3f, 0x8000, 0xffff, size - 0x400000, 0x400000);
      lorom(0x40, 0x7f, 0x0000, 0xffff, size - 0x600000, 0x600000);
      lorom(0x80, 0xbf, 0x8000, 0xffff, 0x400000, 0);
      lorom(0xc0, 0xff, 0x0000, 0xffff, 0x400000, 0x200000);
      loSram();
      break;
    case "NoMAD1LoROM":
      lorom(0x00, 0x3f, 0x8000, 0xffff, size); lorom(0x40, 0x7f, 0x0000, 0xffff, size);
      lorom(0x80, 0xbf, 0x8000, 0xffff, size); lorom(0xc0, 0xff, 0x0000, 0xffff, size);
      each(0x70, 0x7f, 0x0000, 0xffff, (c, i, p) => set(p, MAP_TYPE.LOSRAM));
      each(0xf0, 0xff, 0x0000, 0xffff, (c, i, p) => set(p, MAP_TYPE.LOSRAM));
      break;
    case "ROM24MBSLoROM":
      lorom(0x00, 0x1f, 0x8000, 0xffff, 0x100000, 0);
      lorom(0x20, 0x3f, 0x8000, 0xffff, 0x100000, 0x100000);
      lorom(0x80, 0x9f, 0x8000, 0xffff, 0x100000, 0x200000);
      lorom(0xa0, 0xbf, 0x8000, 0xffff, 0x100000, 0x100000);
      loSram();
      break;
    case "SRAM512KLoROM":
      lorom(0x00, 0x3f, 0x8000, 0xffff, size); lorom(0x40, 0x7f, 0x0000, 0xffff, size);
      lorom(0x80, 0xbf, 0x8000, 0xffff, size); lorom(0xc0, 0xff, 0x0000, 0xffff, size);
      // map_space: SRAM as plain RAM, 32KB steps per bank
      for (let b = 0; b < 4; b++) each(0x70 + b, 0x70 + b, 0x0000, 0xffff, (c, i, p) => set(p, MAP_TYPE.RAM, sramBase + b * 0x8000 + i));
      break;
    case "SufamiTurboLoROM":
    case "SufamiTurboPseudoLoROM":
      // Map_SufamiTurboLoROMMap / Map_SufamiTurboPseudoLoROMMap (addon-carts.js)
      sufamiMap({ lorom, each, set, MAP_TYPE }, map, multi, sramBase);
      break;
    default:
      if (!chipMap) throw new Error(`snes memmap: board map ${map} is not implemented`);
  }
  if (chipMap) chipMap({ set, each, lorom, hirom, loSram, hiSram, size, romSizeByte, sramSizeByte, map, MAP_TYPE });
  // map_WRAM
  each(0x7e, 0x7f, 0x0000, 0xffff, (c, i, p) => set(p, MAP_TYPE.RAM, WRAM + ((c - 0x7e) << 16) + i));
  return tab;
}

/**
 * snes9x Memory.SRAMMask for the header's SRAM size byte.
 * @param {number} sramSizeByte
 */
export function sramMaskFor(sramSizeByte) {
  if (!sramSizeByte) return 0;
  // (C int arithmetic; the buffer is snes9x's 512KB SRAMStorage)
  return (((1 << ((sramSizeByte + 3) & 31)) * 128) - 1) & SRAM_MAX_MASK;
}
/** snes9x's SRAM buffer is 512KB. */
export const SRAM_MAX_MASK = 0x7ffff;
