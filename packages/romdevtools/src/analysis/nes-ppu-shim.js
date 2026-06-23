// NES-PPU-on-SNES runtime shim — the piece that fills the STUBBED seam left by
// the NES→SNES recompile backend (recompile-65816.js). Without it, a recompiled
// port boots and runs the 6502 logic but renders BLANK, because every NES PPU
// write the logic makes is trapped to rts. This shim makes the boot picture
// actually appear on SNES hardware.
//
// STATUS: WORKING (phase-1 static boot picture). The CONVERSION half
// (nesTileToSnes4bpp / nesColorToBgr555 / buildSnesAssets) is correct and
// unit-tested, and the emitted 65816 UPLOAD routine (emitPpuShim →
// NES_SHIM_PRESENT) now DMAs tiles+tilemap+palette to SNES VRAM/CGRAM and turns
// the screen on — verified end-to-end on snes9x (test/recompile-shim-render.test.js
// asserts the converted assets land in VRAM/CGRAM; a recompiled NES boot screen
// renders in color). The recompile op still gates the shim behind withShim:true
// because phase 1 only draws the STATIC first screen — the recompiled NES logic
// then runs in emulation mode against a STUBBED PPU seam, so animation/scroll/
// sprites are not maintained yet (next layer; see the design note below).
//
// The bug that made this "experimental" for a while: `rep #$10` makes X 16-bit at
// runtime, but asar sizes index immediates by the literal and assembled a bare
// `cpx #32` (the small CGRAM count) as an 8-bit instruction — the CPU then decoded
// 3 bytes, ate the next opcode, and the whole routine derailed (blank screen +
// CPU runaway). Fix: `cpx.w` on every loop. The compareRender/findDiverge oracles
// were the tools that localized it.
//
// DESIGN (phase 1 — the STATIC boot picture). Rather than hand-write a full NES
// PPU emulator in 65816 asm, the shim is generated at recompile time from the
// LIVE NES PPU state: the recompiler already boots the original ROM, so we read
// its CHR (tiles), nametable (the background map), and palette AFTER boot,
// CONVERT them to SNES formats in JS, and emit:
//   - SNES tile data (NES 2bpp → SNES 4bpp), as bytes to incbin/db
//   - a SNES tilemap (from the NES nametable), and
//   - a SNES palette (NES indices → BGR555 CGRAM)
//   - a small fixed 65816 routine that DMAs all three to VRAM/CGRAM and turns
//     the screen on.
// The result: the port shows the same first screen as the original. This is the
// static path; animated/scrolling/sprite presentation is the next layer (the
// shim would then run per-frame off the seam's maintained NES-VRAM mirror).
//
// Plain JS ESM + JSDoc. Pairs with recompile-65816.js + the NES PPU read/decode
// helpers in platforms/nes/ppu.js.

import { decodeTile, nesPaletteIndexToRgb } from "../platforms/nes/ppu.js";

/**
 * Convert one NES 2bpp tile (16 bytes) to one SNES 4bpp tile (32 bytes).
 *
 * NES tile: 8 bytes plane0 then 8 bytes plane1 (bit per pixel each), giving a
 * 2-bit (0-3) index per pixel. SNES 4bpp tile: 32 bytes as TWO bitplane pairs —
 * bytes 0-15 are planes 0&1 row-interleaved (lo,hi,lo,hi,... per row), bytes
 * 16-31 are planes 2&3 the same way. We map the NES 2-bit index straight into
 * the low two SNES planes; planes 2&3 stay 0 (NES only has 4 colors per tile).
 *
 * @param {Uint8Array} nesTile16
 * @returns {Uint8Array} 32-byte SNES 4bpp tile
 */
export function nesTileToSnes4bpp(nesTile16) {
  const px = decodeTile(nesTile16); // 64 entries, each 0-3
  const out = new Uint8Array(32);
  for (let y = 0; y < 8; y++) {
    let p0 = 0, p1 = 0;
    for (let x = 0; x < 8; x++) {
      const v = px[y * 8 + x];
      const bit = 7 - x;
      if (v & 1) p0 |= 1 << bit;
      if (v & 2) p1 |= 1 << bit;
    }
    // planes 0&1 row-interleaved in the first 16 bytes
    out[y * 2] = p0;
    out[y * 2 + 1] = p1;
    // planes 2&3 (bytes 16-31) remain 0
  }
  return out;
}

/**
 * Convert a NES palette byte (a 6-bit NES color index) to a SNES BGR555 uint16.
 * NES index → RGB888 (via the canonical NES palette) → BGR555 (5 bits each,
 * blue high). This is the CGRAM word format.
 * @param {number} nesIndex
 * @returns {number} 0..0x7FFF
 */
export function nesColorToBgr555(nesIndex) {
  const [r, g, b] = nesPaletteIndexToRgb(nesIndex & 0x3f);
  const r5 = (r >> 3) & 0x1f;
  const g5 = (g >> 3) & 0x1f;
  const b5 = (b >> 3) & 0x1f;
  return (b5 << 10) | (g5 << 5) | r5;
}

/**
 * Build the SNES presentation assets from live NES PPU state.
 *
 * @param {Object} state
 * @param {Uint8Array} state.chr        NES pattern data (>=4096 bytes; the BG
 *   pattern table — we take the first 256 tiles / 4KB).
 * @param {Uint8Array} state.nametable  one 32x30 NES nametable's tile indices
 *   (960 bytes; the attribute bytes that follow are ignored in phase 1).
 * @param {Uint8Array} state.palette    32-byte NES palette ($3F00-$3F1F). We use
 *   the BG palette (first 16 bytes) for CGRAM.
 * @returns {{ tiles: Uint8Array, tilemap: Uint8Array, cgram: Uint8Array,
 *             tileCount: number, mapEntries: number }}
 */
export function buildSnesAssets({ chr, nametable, palette }) {
  // Tiles: first 256 NES tiles (4KB) → 256 SNES 4bpp tiles (8KB).
  const tileCount = Math.min(256, Math.floor(chr.length / 16));
  const tiles = new Uint8Array(tileCount * 32);
  for (let t = 0; t < tileCount; t++) {
    const nes = chr.subarray(t * 16, t * 16 + 16);
    tiles.set(nesTileToSnes4bpp(nes), t * 32);
  }

  // Tilemap: NES nametable is 32x30 of 1-byte tile indices. SNES BG map entries
  // are 16-bit (tile# in low 10 bits + palette/priority/flip in the high bits).
  // Phase 1: palette 0, no flip/priority → entry = tile index. SNES BG map is
  // 32x32; we fill the first 30 rows and leave the bottom 2 as tile 0.
  const mapEntries = 32 * 32;
  const tilemap = new Uint8Array(mapEntries * 2);
  for (let row = 0; row < 30; row++) {
    for (let col = 0; col < 32; col++) {
      const nesTile = nametable[row * 32 + col] ?? 0;
      const e = (row * 32 + col) * 2;
      tilemap[e] = nesTile;     // low byte = tile index
      tilemap[e + 1] = 0;       // high byte = palette 0, no flip/prio
    }
  }

  // CGRAM: NES BG palette (16 bytes) → 16 BGR555 colors. NES color 0 ($3F00) is
  // the universal backdrop → CGRAM index 0.
  const cgram = new Uint8Array(16 * 2);
  for (let i = 0; i < 16; i++) {
    const bgr = nesColorToBgr555(palette[i] ?? 0);
    cgram[i * 2] = bgr & 0xff;
    cgram[i * 2 + 1] = (bgr >> 8) & 0xff;
  }

  return { tiles, tilemap, cgram, tileCount, mapEntries };
}

/** Format a byte array as asar `db $xx,$xx,...` lines (16 per line). */
function dbLines(bytes, indent = "        ") {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = Array.from(bytes.subarray(i, i + 16))
      .map((b) => "$" + b.toString(16).padStart(2, "0"))
      .join(",");
    lines.push(`${indent}db ${chunk}`);
  }
  return lines.join("\n");
}

/**
 * Emit the SNES PPU shim as asar source: the converted data tables + a fixed
 * 65816 routine `NES_SHIM_PRESENT` that DMAs tiles→VRAM, tilemap→VRAM,
 * palette→CGRAM, sets BG mode 0 / bases, and turns the screen on. The
 * recompiled reset wrapper calls NES_SHIM_PRESENT once after the game's boot
 * logic has run (so the NES state is fully set up before we snapshot+convert).
 *
 * VRAM layout (word addresses): tiles at $0000, BG1 tilemap at $4000.
 *
 * @param {ReturnType<typeof buildSnesAssets>} assets
 * @returns {string} asar source (define NES_SHIM_PRESENT + the data)
 */
export function emitPpuShim(assets) {
  const { tiles, tilemap, cgram, tileCount } = assets;
  return [
    "; ── NES-PPU-on-SNES shim (phase 1: static boot picture) ──────────────",
    "; Converted from the original ROM's live PPU state at recompile time:",
    `;   ${tileCount} tiles (NES 2bpp → SNES 4bpp), a 32x30 BG tilemap, 16 colors.`,
    "; NES_SHIM_PRESENT DMAs them to VRAM/CGRAM and enables BG1. Call it once",
    "; after the game's boot logic has set up its PPU state.",
    "",
    "; SNES PPU registers used by the shim",
    "!INIDISP = $2100",
    "!BGMODE  = $2105",
    "!BG1SC   = $2107   ; BG1 map base + size",
    "!BG12NBA = $210B   ; BG1/BG2 char base",
    "!VMAIN   = $2115",
    "!VMADDL  = $2116",
    "!VMDATAL = $2118",
    "!CGADD   = $2121",
    "!CGDATA  = $2122",
    "!TM      = $212C",
    "",
    "NES_SHIM_PRESENT:",
    "        php",
    "        sep #$20                 ; 8-bit A for register writes",
    "        rep #$10                 ; 16-bit X/Y for loop indices",
    "",
    "        lda #$80",
    "        sta !INIDISP             ; forced blank during upload",
    "        lda #$80",
    "        sta !VMAIN               ; VRAM addr +1 word after the HIGH-byte write",
    "",
    "        ; ── tiles → VRAM word $0000 ── (word writes via VMDATAL/H)",
    "        ldx #$0000",
    "        stx !VMADDL              ; VRAM word address $0000 (16-bit store)",
    "        ldx #$0000",
    "-       lda.l NES_SHIM_TILES,x",
    "        sta !VMDATAL             ; low byte",
    "        inx",
    "        lda.l NES_SHIM_TILES,x",
    "        sta !VMDATAL+1           ; high byte → triggers +1 word",
    "        inx",
    // `cpx.w` forces the 16-bit immediate form. We ran `rep #$10`, so X is
    // 16-bit at RUNTIME, but asar does NOT track register width across rep/sep —
    // it sizes index immediates by the literal, defaulting <256 to 8-bit. A bare
    // `cpx #32` would assemble to 2 bytes while the CPU decodes 3, eating the
    // next opcode and derailing the routine. The big tile/map counts (>255)
    // happen to force 16-bit anyway; the small CGRAM count (32) is the one that
    // bit us — so make ALL three explicit with `.w` and never rely on the value.
    `        cpx.w #${tiles.length}`,
    "        bne -",
    "",
    "        ; ── tilemap → VRAM word $4000 ──",
    "        ldx #$4000",
    "        stx !VMADDL              ; VRAM word address $4000",
    "        ldx #$0000",
    "-       lda.l NES_SHIM_MAP,x",
    "        sta !VMDATAL",
    "        inx",
    "        lda.l NES_SHIM_MAP,x",
    "        sta !VMDATAL+1",
    "        inx",
    `        cpx.w #${tilemap.length}`,
    "        bne -",
    "",
    "        ; ── palette → CGRAM index 0 ──",
    "        lda #$00",
    "        sta !CGADD",
    "        ldx #$0000",
    `-       lda.l NES_SHIM_CGRAM,x`,
    "        sta !CGDATA              ; CGADD auto-increments after each byte",
    "        inx",
    `        cpx.w #${cgram.length}    ; .w: 16-bit X at runtime (see note above)`,
    "        bne -",
    "",
    "        ; ── BG setup + screen on ──",
    "        lda #$00",
    "        sta !BGMODE              ; mode 0, 8x8 tiles",
    "        lda #$40",
    "        sta !BG1SC               ; BG1 map base = VRAM word $4000 ((reg>>2)<<10)",
    "        lda #$00",
    "        sta !BG12NBA             ; BG1 char base = VRAM word $0000",
    "        lda #$01",
    "        sta !TM                  ; enable BG1 on main screen",
    "        lda #$0f",
    "        sta !INIDISP             ; full brightness, blank off",
    "        plp",
    "        rts",
    "",
    "; Shim data in its OWN bank so `lda.l TABLE,x` indexing never straddles a",
    "; LoROM 32KB bank boundary (the 8KB tile table would otherwise wrap). Bank 2",
    "; ($02:8000) is free after the code (bank 0) and the recompiled body.",
    "org $028000",
    "NES_SHIM_TILES:",
    dbLines(tiles),
    "NES_SHIM_MAP:",
    dbLines(tilemap),
    "NES_SHIM_CGRAM:",
    dbLines(cgram),
    "",
  ].join("\n");
}
