// Linear-memory layout of a recompiled SNES cart.
//
// The fixed regions below the ROM image are the emulated machine state and
// the debug probes; everything from the ROM image up is sized from the CART,
// because two bugs came from fixed addresses that were only right for a
// 512KB ROM (a 3MB LoROM image ran under the arm table, and a table
// that followed the ROM ran through the framebuffer and the WCInfo block).
// checkLayout() fails the BUILD on any overlap: a WAT store to a literal
// address hits whatever is there, and two probes sharing an address produce
// a reading that is neither one.
//
// Ported from the earlier Python emitter's constants.
//
// Plain JS ESM + JSDoc.

import { WC_SIZES, assertHostSpans } from "../cart-abi.js";

// The framebuffer holds the largest frame snes9x's libretro core reports
// (MAX_SNES_WIDTH x the 478-line interlaced overscan frame); each frame
// sets its own size in wc_info (256 or 512 wide, 224/239/448/478 tall
// before the overscan crop).
export const FB_W = 512;
export const FB_H = 478;
/** snes9x's GFX.Screen / SubScreen: 512-pixel pitch (RealPPL), MAX_SNES_HEIGHT + 64 rows, RGB565. */
export const SCREEN_ROWS = 478 + 64;

// Emulated machine state (hw_snes.py).
export const WRAM = 0x000000;   // 128KB work RAM ($7E0000-$7FFFFF)
export const VRAM = 0x020000;   // 64KB video RAM, word-addressed by $2116/$2118-9
export const CGRAM = 0x030000;  // 512 bytes: 256 BGR555 entries
export const OAM = 0x030400;    // 544 bytes: 128 sprites x 4 + 32-byte high table
export const PPUREG = 0x030800; // $2100-$213F shadow; +0x80 holds $4200-$43FF
export const SNESFB = 0x031000; // (unused by the renderer)
export const ROM = 0x100000;    // ROM image
/** Local alias the PPU templates use for the register shadow. */
export const R = PPUREG;

// PPU state that is not a register shadow, in the gap between PCRING and REGWATCH.
export const MAINC = 0x098000;  // 256 x u16 main-screen colour (RGB565)
export const MAINZ = 0x098200;  // 256 x u8 main-screen depth
export const SUBC = 0x098300;   // 256 x u16 sub-screen colour
export const SUBZ = 0x098500;   // 256 x u8 sub-screen depth
export const COL565 = 0x098600; // 256 x u16 CGRAM with brightness applied
export const DMTAB = 0x098800;  // 2 screens x 6 layers x 256 px window draw modes
export const OBJLIST = 0x099400; // 32 x (sprite, line) for the row being drawn
export const HDMAST = 0x099500; // 8 channels x 16 bytes of HDMA state
export const XBTAB = 0x099600;  // 16 x 32 brightness table (snes9x mul_brightness)
export const OBJSZ = 0x099800;  // 8 x (sw, sh, lw, lh)
export const PPUX_END = 0x099a00;

// APU state (apu-wat.js APU_OFF): DSP registers, port latches, IPL ROM, DSP
// tables and voices. ARAM itself is cart-sized-layout (lay.ARAM).
export const APUST = 0x09a000;
export const APUST_SZ = 0x1800;
// The CPU bus map (memmap.js): 4096 blocks x 8 bytes.
export const MAPTAB = 0x09c000;
export const MAPTAB_SZ = 0x8000;
// The S-DSP's output: a ring of 4096 stereo int16 frames at 32040 Hz that
// the wasmcart host drains (wc_info audioPtr/audioCap/audioWritePtr).
export const AUDIO = 0x0a4000;
export const AUDIO_FRAMES = 4096;
// snes9x's Resampler ring (int16 samples) for carts with a per-title APU
// speedup: S9xInitSound(32) sizes it max(1100, 32040 * 32 * 2 / 1000).
export const RESAMP = 0x0a8000;
export const RESAMP_SIZE = 2050;
// The row being rendered: main- and sub-screen depth buffers (snes9x
// ZBuffer / SubZBuffer for one line), 512 entries for double-width lines.
export const ZMAIN = 0x0aa000;
export const ZSUB = 0x0aa200;

// RAM interpreter tables (emit_snes.py).
export const OPTAB = 0x030c00;  // opcode -> operation id
export const MODTAB = 0x030d00; // opcode -> addressing-mode id
export const ICOST = 0x030e00;  // opcode -> [length | flags, internal cycles] (interpCostTable)

// Debug probes. The host writes 80 bytes of pad state at inputPtr every
// frame (4 x 20-byte wc_pad_t, ABI v4) without a zero check, so INPUT must be
// a real address clear of WRAM (at 0 it overwrote the SNES direct page
// between frames). Pad N is at INPUT + 20 * N.
export const INPUT = 0x03e000;
export const INPUT_SZ = WC_SIZES.input;
export const PROBE_N = 34;          // i32 counters, mirrored every frame
export const PROBE = 0x03f000;
export const ITRACE_N = 160;        // (pc, opcode, S) triples
export const ITRACE = 0x03f100;
export const DPWATCH = 0x041000;    // direct-page write-watch
export const DPWATCH_SZ = 0x1000;
export const PCRING_N = 65536;      // ROM pc ring, one i32 per entry
export const PCRING = 0x050000;
export const REGWATCH_N = 6000;     // (A, X, Y, P, $8D, D, [$00])
export const REGWATCH_STRIDE = 28;
export const REGWATCH = 0x0d0000;
export const DMALOG_N = 1024;       // (bport, mode, src24, count, vaddr, pc)
export const DMALOG_STRIDE = 24;
export const DMALOG = 0x0fa000;

/** PROBE block field offsets (bytes from PROBE), as mirrored by wc_render. */
export const PROBE_FIELDS = {
  steps: 0, nvram: 4, trapped: 8, trappc: 12, pc: 16, nnmi: 20, ndma: 24,
  npal: 28, ramsrc: 32, s: 36, ninterp: 40, napuw: 44, nspc: 48, spcpc: 52,
  stkw: 56, stkwa: 60, npc: 64, nrw: 68, ptrw: 72, ptrwa: 76, ptrwv: 80,
  ptrwy: 84, ptrarm: 88, nptrw: 92, ptrw1: 96, ptrwv1: 100, ptrwy1: 104,
  nptrw1: 108, nsamples: 112, spcclock: 116, dspphase: 120,
  // where the vblank line end (V 224 -> 225) caught the APU up, and where
  // the instruction that crossed it began (master clocks into line 224)
  // and its pc
  vblankpos: 124, vblankistart: 128, vblankpc: 132,
};

/**
 * @typedef {object} SnesLayout
 * @property {number} romlen  ROM image length (>= 1)
 * @property {number} sram    SRAM address mask
 * @property {number} PCTAB   one i32 per ROM byte: arm index + 1, or 0
 * @property {number} PACKED  the (offset, arm) pairs $initmap expands
 * @property {number} FB      the RGBA framebuffer the host presents
 * @property {number} ABI     the WCInfo block the host reads
 * @property {number} SRAM    cartridge SRAM (512KB)
 * @property {number} ARAM    64KB SPC700 audio RAM
 * @property {number} narms   arm count (one per ROM offset)
 * @property {number} pages   wasm memory pages
 */

/**
 * Place the cart-sized regions for a ROM image of `imgLen` bytes carrying
 * `narms` arms, and check every region against its neighbours.
 * @param {number} imgLen
 * @param {number} sram
 * @param {number} narms
 * @returns {SnesLayout}
 */
export function computeLayout(imgLen, sram, narms) {
  const n1 = Math.max(1, imgLen);
  const PCTAB = (ROM + imgLen + 0xffff) & ~0xffff;
  const PACKED = PCTAB + 4 * n1;
  // PACKED's upper bound is 8 bytes per ROM byte (at most one arm per offset).
  const FB = (PACKED + 8 * n1 + 0xfffff) & ~0xfffff;
  const ABI = FB + FB_W * FB_H * 4 + 0x1000;
  const ARAM = (ABI + 0x1000 + 0xffff) & ~0xffff;
  // cartridge SRAM: snes9x's 512KB buffer (SRAMMask decides what is used)
  const SRAM = ARAM + 0x10000;
  // GFX.Screen (persistent across frames, as snes9x's is) and GFX.SubScreen
  const SCREEN = SRAM + 0x80000;
  const SUBSCR = SCREEN + 512 * SCREEN_ROWS * 2;
  const lay = { romlen: n1, sram, PCTAB, PACKED, FB, ABI, ARAM, SRAM, SCREEN, SUBSCR, narms, pages: 0 };
  checkLayout(lay, imgLen);
  const packedTop = PACKED + narms * 8;
  for (const [name, addr] of [["FB", FB], ["ABI", ABI], ["ARAM", ARAM]]) {
    if (packedTop > addr) {
      throw new Error(`snes layout: PACKED ends 0x${hex(packedTop)}, past ${name} 0x${hex(addr)}`);
    }
  }
  const top = Math.max(packedTop, ROM + imgLen, ABI + 0x1000, SUBSCR + 512 * SCREEN_ROWS * 2);
  lay.pages = Math.floor(top / 65536) + 4;
  return lay;
}

const hex = (v) => v.toString(16).toUpperCase();

/**
 * Fail on any overlap between probe, state, host and table regions, and on
 * a probe that runs past the ROM image (probes are addressed by literals).
 * @param {SnesLayout} lay
 * @param {number} imgLen
 */
export function checkLayout(lay, imgLen) {
  const regions = [
    ["INPUT", INPUT, INPUT_SZ],
    ["PROBE", PROBE, PROBE_N * 4],
    ["ITRACE", ITRACE, ITRACE_N * 12],
    ["DPWATCH", DPWATCH, DPWATCH_SZ],
    ["PCRING", PCRING, PCRING_N * 4],
    ["REGWATCH", REGWATCH, REGWATCH_N * REGWATCH_STRIDE],
    ["DMALOG", DMALOG, DMALOG_N * DMALOG_STRIDE],
    ["ARAM", lay.ARAM, 0x10000],
    ["PPUX", MAINC, PPUX_END - MAINC],
    ["APUST", APUST, APUST_SZ],
    ["MAPTAB", MAPTAB, MAPTAB_SZ],
    ["AUDIO", AUDIO, AUDIO_FRAMES * 4],
    ["RESAMP", RESAMP, RESAMP_SIZE * 2],
    ["ZROW", ZMAIN, 0x400],
    ["FB", lay.FB, FB_W * FB_H * 4],
    ["ABI", lay.ABI, 0x1000],
    ["ROM", ROM, Math.max(1, imgLen)],
    ["PCTAB", lay.PCTAB, lay.PACKED - lay.PCTAB],
  ];
  regions.sort((a, b) => a[1] - b[1]);
  for (let i = 0; i + 1 < regions.length; i++) {
    const [na, aa, sa] = regions[i], [nb, ab, sb] = regions[i + 1];
    if (aa + sa > ab) {
      throw new Error(`snes layout: ${na} (0x${hex(aa)}..0x${hex(aa + sa)}) overlaps ${nb} (0x${hex(ab)}..0x${hex(ab + sb)})`);
    }
  }
  // The host-written spans inside the ABI block (audio cursor +0x100,
  // clock +0x180) and the pads at INPUT, against each other and everything
  // above (ABI v4 grew the pad block from 64 to 80 bytes).
  assertHostSpans({ who: "snes", info: lay.ABI, input: INPUT, time: lay.ABI + 0x180, audioWrite: lay.ABI + 0x100,
    audio: AUDIO, audioBytes: AUDIO_FRAMES * 4, others: regions.filter((r) => r[0] !== "INPUT" && r[0] !== "ABI" && r[0] !== "AUDIO") });
  const skip = new Set(["ROM", "PCTAB", "ARAM", "FB", "ABI"]);
  const probetop = Math.max(...regions.filter((r) => !skip.has(r[0])).map((r) => r[1] + r[2]));
  if (probetop > ROM) throw new Error(`snes layout: probes end 0x${hex(probetop)}, past ROM 0x${hex(ROM)}`);
}
