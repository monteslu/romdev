// Game Boy + Game Boy Color WAT backend: statically recompile a whole GB/GBC
// ROM into one wasmcart module, verified against gambatte.
//
//   platforms            ['gb', 'gbc'] - the ROM header decides the mode
//   describe(rom, opts)  header-derived config, layout, probe, warnings
//   emitWat(rom, opts)   async generator of WAT text chunks of ONE (module ...)
//
// Every CGB-flagged ROM ($0143 bit 7) builds in CGB mode, as gambatte runs it;
// everything else builds in DMG mode on the same machine model. Block
// discovery is romdev's own IR decode, in process (blocks.js).
//
// Options (all optional):
//   blocks     a precomputed block index (Map offset -> {m,o,n}, or its JSON
//              object form); default: decode the ROM through the IR exporter
//   watch      [lo, hi] CPU-address write-watch window (debug; probe ring at
//              PROBE+1024), default off
//   hits       ROM offsets (<= 64) to count dispatches of (debug; counters at
//              PROBE+128), default none
//   stopAt     {pc, fromFrame?}: trap the first time that pc is dispatched on
//              or after host frame `fromFrame` (debug), default off
//   stats      an object filled with arm/lowering counts after emit
import { createHash } from "node:crypto";
import { emitGbWat, gbLayout, gbOriginAndPages, PROBE, PROBE_FIELDS } from "./emit.js";
import { mbcKind, VRAM0, VRAM1, WRAMX, BGPAL, OBJPAL } from "./hw-gbc.js";
import { OAM, IOREG, WRAM, FB_W, FB_H } from "./hw-gb.js";
import { discoverBlocks, blocksFromJson } from "./blocks.js";

export const platforms = ["gb", "gbc"];

const CART_TYPES = {
  0x00: "ROM ONLY", 0x01: "MBC1", 0x02: "MBC1+RAM", 0x03: "MBC1+RAM+BATTERY",
  0x05: "MBC2", 0x06: "MBC2+BATTERY", 0x08: "ROM+RAM", 0x09: "ROM+RAM+BATTERY",
  0x0B: "MMM01", 0x0C: "MMM01+RAM", 0x0D: "MMM01+RAM+BATTERY",
  0x0F: "MBC3+TIMER+BATTERY", 0x10: "MBC3+TIMER+RAM+BATTERY", 0x11: "MBC3",
  0x12: "MBC3+RAM", 0x13: "MBC3+RAM+BATTERY",
  0x19: "MBC5", 0x1A: "MBC5+RAM", 0x1B: "MBC5+RAM+BATTERY", 0x1C: "MBC5+RUMBLE",
  0x1D: "MBC5+RUMBLE+RAM", 0x1E: "MBC5+RUMBLE+RAM+BATTERY",
  0x20: "MBC6", 0x22: "MBC7+SENSOR+RUMBLE+RAM+BATTERY",
  0xFC: "POCKET CAMERA", 0xFD: "BANDAI TAMA5", 0xFE: "HuC3", 0xFF: "HuC1+RAM+BATTERY",
};
const RAM_SIZES = { 0: 0, 1: 2048, 2: 8192, 3: 32768, 4: 131072, 5: 65536 };

/**
 * Header-derived configuration, the linear-memory layout the verify op
 * compares, and the probe block. Pure: no decode.
 * @param {Uint8Array} rom
 * @param {object} [opts]
 */
export function describe(rom, opts = {}) {
  if (rom.length < 0x150) throw new Error(`gb: ${rom.length} bytes is too small for a Game Boy ROM (the header ends at $014F)`);
  const warnings = [];
  const cgbFlag = rom[0x143];
  const cgb = (cgbFlag & 0x80) !== 0;
  const title = Buffer.from(rom.subarray(0x134, cgb ? 0x13F : 0x144)).toString("latin1").replace(/\0+$/, "").trim();
  const sgb = rom[0x146] === 0x03;
  const cartType = rom[0x147];
  const mbc = mbcKind(rom);
  const romSizeCode = rom[0x148];
  const headerRomBytes = romSizeCode <= 8 ? 0x8000 << romSizeCode : null;
  const ramSizeCode = rom[0x149];
  const headerRamBytes = RAM_SIZES[ramSizeCode] ?? null;
  let hsum = 0;
  for (let i = 0x134; i <= 0x14C; i++) hsum = (hsum - rom[i] - 1) & 0xFF;

  if (sgb) warnings.push("SGB flag set ($0146 = $03): Super Game Boy borders, palettes and packets are not modelled. gambatte runs the ROM as a plain " + (cgb ? "CGB" : "DMG") + ", and so does the recompile.");
  if (cgbFlag === 0xC0) warnings.push("CGB-only ROM ($0143 = $C0).");
  if (headerRomBytes !== null && headerRomBytes !== rom.length) warnings.push(`header ROM size $${romSizeCode.toString(16)} says ${headerRomBytes} bytes; the file is ${rom.length}. Banks wrap by the file size.`);
  if (headerRamBytes === null) warnings.push(`unknown RAM size code $${ramSizeCode.toString(16)}.`);
  else if (headerRamBytes > 0x8000) warnings.push(`header RAM size is ${headerRamBytes} bytes; the cart models 4 banks of 8KB (32KB), so RAM banks 4+ alias banks 0-3.`);
  if (cartType === 0x0F || cartType === 0x10) warnings.push("MBC3 real-time clock: the RTC registers are a stub that holds what was written (a stopped clock).");
  if ([0x1C, 0x1D, 0x1E].includes(cartType)) warnings.push("MBC5 rumble motor is not modelled.");
  if (hsum !== rom[0x14D]) warnings.push(`header checksum $${rom[0x14D].toString(16)} does not match the computed $${hsum.toString(16)}.`);

  const L = gbLayout(rom.length);
  // Linear-memory spans the verify op byte-compares against gambatte's
  // memory regions (romdev's gambatte patch: gb_vram 8/16KB, gb_oam, gb_io
  // $FF00-$FF7F, gb_hram $FF80-$FFFF, gb_bgpdata/gb_objpdata, system_ram =
  // WRAM bank n at n*0x1000).
  const regions = {
    vram0: { offset: VRAM0, length: 0x2000, ref: "gb_vram", refOffset: 0 },
    ...(cgb ? { vram1: { offset: VRAM1, length: 0x2000, ref: "gb_vram", refOffset: 0x2000 } } : {}),
    oam: { offset: OAM, length: 0xA0, ref: "gb_oam", refOffset: 0 },
    wram0: { offset: WRAM, length: 0x1000, ref: "system_ram", refOffset: 0 },
  };
  // $D000-$DFFF: bank n (SVBK 1..7 on CGB; always 1 on DMG) lives at
  // WRAMX + n*0x1000 in the cart.
  for (let n = 1; n <= (cgb ? 7 : 1); n++) {
    regions[`wram${n}`] = { offset: WRAMX + n * 0x1000, length: 0x1000, ref: "system_ram", refOffset: n * 0x1000 };
  }
  // HRAM only: the I/O page's LY/STAT/DIV are computed on read, so its bytes
  // are not the reference's registers by design. IE is compared too.
  regions.hram = { offset: IOREG + 0x80, length: 0x80, ref: "gb_hram", refOffset: 0 };
  if (cgb) {
    regions.bgPalette = { offset: BGPAL, length: 64, ref: "gb_bgpdata", refOffset: 0 };
    regions.objPalette = { offset: OBJPAL, length: 64, ref: "gb_objpdata", refOffset: 0 };
  } else {
    regions.dmgPalettes = { offset: IOREG + 0x47, length: 3, ref: "gb_io", refOffset: 0x47 };
  }
  const F = PROBE_FIELDS;
  const layout = {
    version: 1,
    platform: cgb ? "gbc" : "gb",
    reference: cgb ? "gbc" : "gb",
    referenceCore: "gambatte",
    romSha1: createHash("sha1").update(rom).digest("hex"),
    // Host frame alignment is the verify op's (gambatte settles 5 frames,
    // the wasmcart host 1); the cart runs no extra frames inside wc_render.
    warmupFrames: 0,
    // The cart reads wasmcart pad bit 0 as the Game Boy's A and bit 1 as B
    // (the convention it was verified with), i.e. by NAME.
    buttons: "byName",
    screen: { origin: [0, 0] },
    regions,
    vramZero: cgb ? ["vram0", "vram1"] : ["vram0"],
    // CPU state the frame loop mirrors at every frame hand-off.
    fields: {
      pc: { offset: PROBE + F.pc, size: 2, ref: "cpu:pc" },
      sp: { offset: PROBE + F.sp, size: 2, ref: "cpu:sp" },
      a: { offset: PROBE + F.a, size: 1, ref: "cpu:registers.A" },
    },
    probe: {
      trapped: { offset: PROBE + F.trapped, size: 4 },
      trappc: { offset: PROBE + F.trappc, size: 4 },
      frames: { offset: PROBE + F.frames, size: 4 },
      steps: { offset: PROBE + F.steps, size: 4 },
      rombank: { offset: PROBE + F.rombank, size: 4 },
      line: { offset: PROBE + F.line, size: 4 },
    },
    framebuffer: { offset: L.FB, width: FB_W, height: FB_H, format: "xrgb8888" },
    probeBase: PROBE,
    probeFields: PROBE_FIELDS,
  };

  return {
    platform: layout.platform,
    referenceCore: "gambatte",
    title, cgb, cgbFlag, sgb, cartType, cartTypeName: CART_TYPES[cartType] ?? `unknown $${cartType.toString(16)}`,
    mbc, romBytes: rom.length, headerRomBytes, headerRamBytes,
    romSha1: layout.romSha1,
    warnings,
    layout,
  };
}

/**
 * The `romdev.recompile` custom section for a cart built from `rom`
 * (schema: src/analysis/recompile/recompile-section.js).
 * @param {Uint8Array} rom
 */
export function recompileSection(rom) {
  return { json: describe(rom).layout };
}

/**
 * Emit the whole cart as WAT text chunks of ONE (module ...).
 * @param {Uint8Array} rom
 * @param {object} [opts] see the module header
 */
export async function* emitWat(rom, opts = {}) {
  const d = describe(rom, opts);
  let blocks = opts.blocks;
  if (!blocks) blocks = await discoverBlocks(rom);
  else if (!(blocks instanceof Map)) blocks = blocksFromJson(blocks);
  if (blocks.size !== rom.length) throw new Error(`gb: block index covers ${blocks.size} offsets; the ROM has ${rom.length}. A hole becomes a silent trap.`);
  yield* emitGbWat(rom, blocks, { cgb: d.cgb, mbc: d.mbc, watch: opts.watch, hits: opts.hits, stopAt: opts.stopAt, stats: opts.stats });
}

export { gbLayout, gbOriginAndPages };
