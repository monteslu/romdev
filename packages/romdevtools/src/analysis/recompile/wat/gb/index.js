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
//   traceEntries  ALSO record a whole-frame instruction ring (a power of two,
//              1024 to 4194304; a frame runs ~5,000-15,000 instructions, so
//              16384 or more holds one, but a frame the reference never
//              blits (the LCD toggled before every VBlank) can run millions) of {pc, rombank, sp, hl, bc, de, af}
//              for findDiverge level:'instruction', which otherwise sees the
//              default ring's last 2,048. Off by default: the default module
//              is unchanged.
//   breakArm   DEBUG / MUST-FAIL CONTROL: every arm at this CPU address also
//              flips bit 0 of L after it runs, so an instruction-level differ
//              must name exactly this instruction (the section carries a
//              warning). Pick a straight-line instruction.
//   stats      an object filled with arm/lowering counts after emit
//   muteChannels  MUST-FAIL CONTROL: channels (ch1..ch4 or 1-4) the cart's
//              mixer silences from power-on (presets the section's
//              audio.muteMask byte). Not a faithful cart.
import { createHash } from "node:crypto";
import { emitGbWat, gbLayout, gbOriginAndPages, gbBigRing, PROBE, PROBE_FIELDS } from "./emit.js";
import { mbcKind, VRAM0, VRAM1, WRAMX, BGPAL, OBJPAL } from "./hw-gbc.js";
import { OAM, IOREG, WRAM, FB_W, FB_H } from "./hw-gb.js";
import { discoverBlocks, blocksFromJson, opcodeCatalogue } from "./blocks.js";
import { RTC_CLOCK } from "../../recompile-section.js";
import { APU_LAYOUT, APU_SAMPLE_RATE, APU_MUTE_CHANNELS } from "./apu.js";

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
  else if (ramSizeCode >= 4) warnings.push(`header RAM size code $${ramSizeCode.toString(16)}: 16 banks of 8KB (128KB), as gambatte allocates them.`);
  if (headerRomBytes !== null && (rom.length & (rom.length - 1))) warnings.push(`the ROM is ${rom.length} bytes, not a power of two: gambatte pads it with $FF to the next power of two and masks the bank number; the cart does not (bank numbers past the file read other memory).`);
  if (cartType === 0x0F || cartType === 0x10) warnings.push("MBC3 real-time clock: it counts the host's frame clock (the wasmcart time value) from power-on, as gambatte counts time(0) from load; verification pins gambatte's clock to the same frames.");
  if ([0x1C, 0x1D, 0x1E].includes(cartType)) warnings.push("MBC5 rumble motor is not modelled.");
  if (cartType === 0x08 || cartType === 0x09) warnings.push("cart type ROM+RAM: gambatte runs it as MBC2 ($2100 writes select a ROM bank), and so does the recompile.");
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
    // Face buttons by position: GB A = east (WC_BTN_B), GB B = south (WC_BTN_A).
    buttons: "positional",
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
    // an MBC3 clock reads the host frame clock; the verifier pins gambatte's time(0) to it
    ...([0x0F, 0x10].includes(rom[0x147]) ? { clock: { ...RTC_CLOCK } } : {}),
    // gambatte-libretro's audio_batch_cb stream: blipper at 32768 Hz, s16 stereo (apu.js)
    audio: { sampleRate: APU_SAMPLE_RATE, channels: 2, format: "s16", reference: "output",
      muteMask: { offset: APU_LAYOUT.mute, size: 1, channels: APU_MUTE_CHANNELS } },
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
export function recompileSection(rom, sha1, opts = {}) {
  const layout = describe(rom).layout;
  if (opts.traceEntries != null) {
    // the block index has one arm per ROM offset (emitWat refuses anything else)
    const big = gbBigRing(rom.length, rom.length, opts.traceEntries);
    const lo = (offset) => ({ offset, mask: 0xffff });
    layout.trace = {
      offset: big.offset, entries: big.entries, stride: big.stride,
      cursor: { offset: big.cursor, mode: "count", writable: true, note: "every dispatched instruction, RAM-interpreted ones included" },
      pc: lo(0),
      // gambatte's cycle counter before the instruction ($abscc starts at its power-on value)
      clock: { offset: 28 },
      fields: { rombank: { offset: 4 }, sp: lo(8), hl: lo(12), bc: lo(16), de: lo(20), af: lo(24) },
      note: "options.traceEntries: registers before each instruction; sp/hl/bc/de/af are compared with gambatte's per-instruction columns (af from a gambatte build that records it)",
    };
  }
  if (opts.breakArm != null) Object.assign(layout, { debugBreakArm: parseBreakArm(opts.breakArm), warning: "built with options.breakArm: one instruction also flips bit 0 of L (a must-fail control), NOT a faithful cart" });
  return { json: layout };
}

/**
 * @param {unknown} v  a CPU address: a number or "$1234" / "0x1234" / "1234" hex
 * @returns {number|null}
 */
function parseBreakArm(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/^\$|^0x/i, ""), 16);
  if (!Number.isInteger(n) || n < 0 || n > 0x7fff) throw new Error(`gb recompile: options.breakArm must be a ROM CPU address ($0000-$7FFF), got ${JSON.stringify(v)}`);
  return n;
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
  const opcat = await opcodeCatalogue();
  yield* emitGbWat(rom, blocks, { opcat, cgb: d.cgb, mbc: d.mbc, watch: opts.watch, hits: opts.hits, stopAt: opts.stopAt, stats: opts.stats, traceEntries: opts.traceEntries, breakArm: parseBreakArm(opts.breakArm), muteChannels: opts.muteChannels });
}

export { gbLayout, gbOriginAndPages };
