/*
 * pce_video.c — HuC6270 VDC + HuC6260 VCE helpers (cc65, C89).
 *
 * Talks to the two PCE video chips by hand: VRAM uploads, the VCE 9-bit-GRB
 * color table, the master display-enable bits, and a 64-entry shadow SATB you
 * build in RAM and DMA into the VDC. See pce_hw.h for the register map and the
 * empty-BSS trap note.
 */
#include "pce_hw.h"

/* Empty-BSS guard: keeps .bss non-empty so cc65's crt0 block-clear doesn't
 * underflow (see pce_hw.h). The shadow SATB below also lives in .bss, but we
 * keep this so the guard survives even if someone trims the SATB. */
unsigned char _pce_keep[4];

/* Shadow SATB: 64 sprites * 4 words. We build sprite state here in work RAM,
 * then satb_dma() copies it to VRAM and tells the VDC to load it. */
static u16 _pce_satb[64 * 4];

/* Select a VDC register index and write its 16-bit value (lo then hi). */
void vdc_set_reg(u8 reg, u16 val) {
    VDC_CTRL = reg;
    VDC_DATA_LO = (u8)(val & 0xFF);
    VDC_DATA_HI = (u8)(val >> 8);
}

/* Point the VDC VRAM write pointer (MAWR) at `addr` and select VWR so that
 * subsequent writes to VDC_DATA_LO/HI stream words into VRAM (auto-increment). */
void vram_set_write_addr(u16 addr) {
    vdc_set_reg(VDC_MAWR, addr);
    VDC_CTRL = VDC_VWR;   /* arm the data port for streaming */
}

/* Upload n 16-bit words to VRAM starting at word address `addr`. */
void vram_write(u16 addr, const u16 *data, u16 n) {
    u16 i;
    vram_set_write_addr(addr);
    for (i = 0; i < n; ++i) {
        VDC_DATA_LO = (u8)(data[i] & 0xFF);
        VDC_DATA_HI = (u8)(data[i] >> 8);
    }
}

/* Tile data is just VRAM words; this alias documents intent at call sites. */
void load_tiles(u16 vram, const u16 *src, u16 n) {
    vram_write(vram, src, n);
}

/* Set VCE palette entry `idx` (0..511) to a 9-bit GRB value. The color index
 * is 9 bits: low 8 in VCE_ADDR_LO, bit 8 (BG vs SPR half) in VCE_ADDR_HI bit0. */
void vce_set_color(u16 idx, u16 grb) {
    VCE_ADDR_LO = (u8)(idx & 0xFF);
    VCE_ADDR_HI = (u8)((idx >> 8) & 0x01);
    VCE_DATA_LO = (u8)(grb & 0xFF);
    VCE_DATA_HI = (u8)((grb >> 8) & 0x01);
}

/* Read-modify-write VDC R5 (CR) is awkward (it's write-only on real HW), so we
 * track the enable bits in a static shadow and rewrite the whole register.
 *
 * NOTE: every enable also sets the VBlank-IRQ bit. cc65's waitvsync() blocks
 * until the VBlank IRQ ticks a counter — without this bit, waitvsync() spins
 * FOREVER and your game loop never runs (the screen stays on the last frame).
 * If you only need a static screen and never call waitvsync(), the IRQ bit is
 * harmless; cc65's crt0 already installs the VBlank ISR. */
static u8 _pce_cr = 0;

void vblank_irq_enable(void) {
    _pce_cr |= VDC_CR_VBLANK_IRQ;
    vdc_set_reg(VDC_CR, _pce_cr);
}

/* Program the VDC display-timing registers for a standard NTSC 256x224 (H32)
 * screen. WITHOUT this the geargrafx core falls back to power-on register
 * defaults that composite the 32-row BAT into the display DOUBLED (the scene
 * drawn twice, top + bottom halves, with a black right margin) — the PCE-1
 * "doubled picture" bug. Values match cc65's pce.lib / standard PCE homebrew:
 *   MWR  R9  = 32x32 virtual screen, 256px-wide BAT
 *   HSR  R10 / HDR R11 = 256px (32 char) horizontal display
 *   VPR  R12 / VDW R13 / VCR R14 = 224-line vertical window
 * Called automatically the first time the display is enabled (idempotent). */
static u8 _pce_vdc_inited = 0;
void vdc_init(void) {
    if (_pce_vdc_inited) return;
    _pce_vdc_inited = 1;
    vdc_set_reg(VDC_MWR, 0x0000);  /* 32x32 virtual map (SCREEN field=000); 256px BAT. (0x10 was 64x32 — its 64-wide stride left the bottom rows as uninitialized VRAM = vertical-stripe garbage.) */
    vdc_set_reg(VDC_BXR, 0x0000);  /* BG X scroll = 0                       */
    vdc_set_reg(VDC_BYR, 0x0000);  /* BG Y scroll = 0                       */
    vdc_set_reg(VDC_HSR, 0x0202);  /* horizontal sync width/start           */
    vdc_set_reg(VDC_HDR, 0x031F);  /* horizontal display = 32 chars (256px) */
    vdc_set_reg(VDC_VPR, 0x0F02);  /* vertical sync                         */
    vdc_set_reg(VDC_VDW, 0x00DF);  /* vertical display = 224 lines           */
    vdc_set_reg(VDC_VCR, 0x00EE);  /* vertical display end                  */
}

void bg_enable(void) {
    vdc_init();
    _pce_cr |= (VDC_CR_BG_ON | VDC_CR_VBLANK_IRQ);
    vdc_set_reg(VDC_CR, _pce_cr);
}

void spr_enable(void) {
    vdc_init();
    _pce_cr |= (VDC_CR_SPR_ON | VDC_CR_VBLANK_IRQ);
    vdc_set_reg(VDC_CR, _pce_cr);
}

void disp_enable(void) {
    vdc_init();
    _pce_cr |= (VDC_CR_BG_ON | VDC_CR_SPR_ON | VDC_CR_VBLANK_IRQ);
    vdc_set_reg(VDC_CR, _pce_cr);
}

/* Fill one shadow-SATB slot. Hardware quirks handled for you:
 *   - Y is stored +64, X is stored +32 (VDC's coordinate bias).
 *   - pattern is the 16x16 cell index; the VDC wants (cell << 1) in bits 1..10.
 *   - attr low nibble selects the sprite sub-palette (0..15).
 *   - the SPBG priority bit (0x80) is set so the sprite draws IN FRONT of the
 *     background. Without it, an opaque BG tile (any non-zero color) hides the
 *     sprite — the classic "my sprite vanished over a full tilemap" bug. Slot 0
 *     of the BG sub-palette is transparent, so the sprite still shows over the
 *     backdrop either way; the bit only matters over solid tiles.
 * Call satb_dma() after building all slots to push them to the VDC. */
void set_sprite(u8 slot, u16 x, u16 y, u16 pattern, u8 palette) {
    u16 *e;
    if (slot >= 64) return;
    e = &_pce_satb[slot * 4];
    e[0] = (u16)(y + 64);                          /* word0: Y (biased)        */
    e[1] = (u16)(x + 32);                          /* word1: X (biased)        */
    e[2] = (u16)((pattern & 0x3FF) << 1);          /* word2: pattern (cell<<1) */
    e[3] = (u16)(0x0080 | (palette & 0x0F));       /* word3: SPBG-front + pal  */
}

/* Copy the shadow SATB into VRAM at PCE_SATB_VRAM, then tell the VDC to DMA it
 * into its internal sprite table (R19 = SATB source). */
void satb_dma(void) {
    vram_write(PCE_SATB_VRAM, _pce_satb, 64 * 4);
    vdc_set_reg(VDC_SATB, PCE_SATB_VRAM);
}
