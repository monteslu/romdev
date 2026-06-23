// NES-PPU-on-SNES PER-FRAME runtime — phase 2. The static shim
// (nes-ppu-shim.js) draws the boot picture ONCE then stubs the PPU seam; this
// runtime keeps it LIVE: every vblank it flushes the game's sprite state to SNES
// OAM and runs the game's own NMI handler, so animation actually moves. Pairs
// with recompile-65816.js (which wires the seam + NMI vector to these labels).
//
// WHY THIS IS TRACTABLE (not a full NES PPU in 65816):
//   The recompiled NES logic runs in 65816 EMULATION mode, so the game's NES RAM
//   IS SNES low RAM at the same addresses. A typical NES game builds a 256-byte
//   "shadow OAM" in RAM (commonly $0200) and copies it to the PPU each frame via
//   OAMDMA (`sta $4014`, A = source page). That shadow OAM therefore already
//   exists in SNES WRAM — the runtime just (a) learns the page from the OAMDMA
//   write, and (b) each vblank converts those 64 NES sprites to SNES OAM format
//   and DMAs them in. Sprites are the dominant per-frame change, so this single
//   feature turns "static screenshot" into "the sprites move."
//
// SCOPE (phase 2): sprites (OAM) + running the game's NMI each vblank + honoring
//   PPUCTRL NMI-enable. Background stays as the shim uploaded it (live $2007
//   nametable streaming is phase 3). APU is still no-op.
//
// FORMATS:
//   NES OAM (4 bytes/sprite): [0]=Y, [1]=tile, [2]=attr, [3]=X
//     attr: bit7=V-flip bit6=H-flip bit5=priority bits0-1=palette(4-7)
//   SNES low OAM (4 bytes): [0]=X, [1]=Y, [2]=tile, [3]=attr
//     attr: bit0=tile-bit8 bits1-3=palette bits4-5=priority bit6=H bit7=V
//   SNES high OAM (2 bits/sprite): X-bit8 + size. Phase 2 writes it all-zero
//     (X<256, small sprites).
//   Conversion (verified on snes9x): SNES.X=NES.X, SNES.Y=NES.Y, SNES.tile=NES.tile,
//     SNES.attr = (NES.attr & $C0) | ((NES.attr & 3) << 1).
//
// Plain JS ESM + JSDoc.

/**
 * Fixed runtime state in SNES low RAM ($0010-$0012 — a small window most NES
 * games leave free in zero page; the NMI also saves/restores DP scratch $00).
 */
export const RT_RAM = {
  OAMDMA_PAGE: "$0010", // high byte of the shadow-OAM source page (set by $4014)
};

/** The $7E WRAM staging buffer for the SNES OAM image (288 bytes: 256 + 32). */
const OAM_STAGE = 0x1000;

/**
 * Emit the phase-2 runtime as asar source: NES_RT_INIT (enable NMI + sprite
 * setup), NES_RT_NMI (the per-vblank flush + game NMI), NES_RT_FLUSH_SPRITES
 * (the verified OAM conversion+DMA), and the seam bodies that maintain the
 * OAMDMA-page mirror. recompile-65816 includes this INSTEAD of the v1 seam stub
 * when the runtime is on, points the native NMI vector at NES_RT_NMI, and calls
 * NES_RT_INIT from RESET_ENTRY.
 *
 * @param {Object} opts
 * @param {string|null} opts.nesNmiLabel  the translated NES NMI handler's entry
 *   label (the game's per-frame logic). If null, only the sprite flush runs.
 * @param {number} [opts.oamPage=0x02]    default shadow-OAM page until $4014 sets
 *   it (0x02 = $0200, the de-facto standard).
 * @returns {string} asar source.
 */
export function emitPpuRuntime({ nesNmiLabel = null, oamPage = 0x02 } = {}) {
  const stageHex = "$" + OAM_STAGE.toString(16).toUpperCase();
  const highHex = "$" + (OAM_STAGE + 0x100).toString(16).toUpperCase();

  // We are already in EMULATION mode here (NES_RT_NMI switched back before this),
  // so just call the game's 6502 NMI body directly — no mode switch.
  const callGameNmi = nesNmiLabel
    ? [
        "        ; run the game's own NMI handler (its per-frame logic), in E-mode",
        `        jsr     ${nesNmiLabel}`,
      ]
    : ["        ; (no translated NES NMI handler — sprite flush only)"];

  return [
    "; ── NES-PPU-on-SNES per-frame runtime (phase 2: live sprites) ─────────",
    "",
    "!INIDISP  = $2100",
    "!OBSEL    = $2101",
    "!OAMADDL  = $2102",
    "!OAMADDH  = $2103",
    "!TM       = $212C",
    "!NMITIMEN = $4200",
    "!MDMAEN   = $420B",
    "!DMAP0    = $4300",
    "!BBAD0    = $4301",
    "!A1T0L    = $4302",
    "!A1B0     = $4304",
    "!DAS0L    = $4305",
    "",
    "; called from RESET_ENTRY (native mode) before the game's reset runs.",
    "NES_RT_INIT:",
    "        php",
    "        sep #$20",
    "        rep #$10",
    `        lda #$${oamPage.toString(16).padStart(2, "0")}`,
    `        sta ${RT_RAM.OAMDMA_PAGE}   ; default shadow-OAM page until $4014 sets it`,
    "        lda #$00",
    "        sta !OBSEL              ; 8x8 sprites, sprite tiles share VRAM word $0000",
    "        lda #$10",
    "        sta !TM                 ; enable OBJ (sprites) on the main screen",
    "        lda #$80",
    "        sta !NMITIMEN           ; enable the vblank NMI (the game's heartbeat)",
    "        plp",
    "        rts",
    "",
    "; The per-vblank NMI handler. The recompiled game runs in 65816 EMULATION",
    "; mode, so this is entered with e=1 (8-bit regs, page-1 stack, 6502-style NMI",
    "; frame on the stack). We save the 8-bit regs, drop to NATIVE mode for the",
    "; 16-bit-index sprite flush, come back to emulation, run the game's NMI, then",
    "; rti in emulation mode so the pushed PC/P frame returns correctly.",
    "NES_RT_NMI:",
    "        pha",
    "        phx",
    "        phy",
    "        ; save bank + DP, then go native for the flush.",
    "        phb",
    "        phd",
    "        clc",
    "        xce                     ; e=1 → native (saves e in carry)",
    "        pea $0000",
    "        pld                     ; DP = $0000 for scratch + low-RAM reads",
    "        sep #$30",
    "",
    "        jsr NES_RT_FLUSH_SPRITES",
    "",
    "        sec",
    "        xce                     ; native → back to EMULATION mode",
    "",
    ...callGameNmi,
    "",
    "        pld",
    "        plb",
    "        ply",
    "        plx",
    "        pla",
    "        rti                     ; emulation-mode rti (pops P + 16-bit PC)",
    "",
    "; NES shadow OAM → SNES OAM. Verified on snes9x. Phase 2 reads the shadow OAM",
    "; from $0200 (the de-facto-standard page); the OAMDMA seam records the actual",
    "; page in OAMDMA_PAGE, and the init seeds it to $02. X walks the NES sprites,",
    "; Y the SNES low table — both step by 4 in lockstep.",
    "NES_RT_FLUSH_SPRITES:",
    "        php",
    "        sep #$20",
    "        rep #$10",
    "        lda #$7E",
    "        pha",
    "        plb                     ; DBR = $7E for the staging stores",
    "        ldx #$0000              ; NES sprite byte index (0,4,..252) — DBR-independent",
    "        ldy #$0000              ; SNES low-table byte index",
    "-",
    "        lda $0200,x             ; NES Y    ($0200 is bank-0 low RAM == $7E:0200)",
    `        sta ${stageHex}+1,y     ; SNES [1] = Y`,
    "        lda $0201,x             ; NES tile",
    `        sta ${stageHex}+2,y     ; SNES [2] = tile`,
    "        lda $0203,x             ; NES X",
    `        sta ${stageHex}+0,y     ; SNES [0] = X`,
    "        lda $0202,x             ; NES attr",
    "        pha",
    "        and #$C0                ; V/H flip bits (already aligned)",
    "        sta $00",
    "        pla",
    "        and #$03                ; NES palette 0-3",
    "        asl                     ; → SNES palette bits 1-3",
    "        ora $00",
    `        sta ${stageHex}+3,y     ; SNES [3] = attr`,
    "        inx",
    "        inx",
    "        inx",
    "        inx",
    "        iny",
    "        iny",
    "        iny",
    "        iny",
    "        cpy.w #$0100            ; 64 sprites",
    "        bne -",
    "        ; high table (32 bytes) = all zero",
    "        ldx #$0000",
    "        lda #$00",
    "-",
    `        sta ${highHex},x`,
    "        inx",
    "        cpx.w #$0020",
    "        bne -",
    "        lda #$00",
    "        pha",
    "        plb                     ; DBR = $00",
    "        ; DMA staging buffer → OAM",
    "        lda #$00",
    "        sta !OAMADDL",
    "        sta !OAMADDH",
    "        sta !DMAP0              ; 1-reg, increment",
    "        lda #$04",
    "        sta !BBAD0              ; B-bus = $2104 (OAMDATA)",
    `        ldx #${stageHex}`,
    "        stx !A1T0L              ; src addr low 16",
    "        lda #$7E",
    "        sta !A1B0               ; src bank",
    "        ldx #$0120              ; 288 bytes",
    "        stx !DAS0L",
    "        lda #$01",
    "        sta !MDMAEN             ; fire DMA channel 0",
    "        plp",
    "        rts",
    "",
    "; ── seam: maintain the OAMDMA-page mirror; no-op the rest in phase 2 ──",
    "NES_PPU_WRITE:",
    "        cpx #$14                ; $4014 (OAMDMA)?",
    "        bne +",
    `        sta ${RT_RAM.OAMDMA_PAGE}   ; A = the shadow-OAM source page`,
    "+",
    "        rts",
    "NES_PPU_READ:",
    "        lda #$80                ; PPUSTATUS vblank set → boot wait-loops exit",
    "        rts",
    "NES_APU_WRITE:",
    "        rts",
    "NES_OAM_DMA:",
    "        rts",
    "",
  ].join("\n");
}
