/* Hello, NES — a real hello-world scaffold, not just while(1) {}.
 *
 * What this does:
 *   1. Disables PPU during init (avoids race with first frame).
 *   2. Uploads a 4-color palette.
 *   3. Writes a single 8x8 tile (a yellow 'H') into CHR-RAM.
 *   4. Drops a single sprite into shadow OAM ($0200..) — the NMI
 *      handler DMAs it to the PPU every vblank.
 *   5. Enables the PPU and loops forever (NMI does all the real work).
 *
 * BUILD: this file expects linkerConfig: "chr-ram" so the CHR-RAM
 * region is writable at runtime. Pass it to buildSource:
 *
 *   buildSource({
 *     platform: "nes",
 *     language: "c",
 *     linkerConfig: "chr-ram",
 *     sources: {
 *       "main.c": <this file>,
 *     },
 *   });
 *
 * The chr-ram preset auto-includes a custom crt0 that emits an iNES
 * header with CHR-RAM=0, points the NMI vector at a `nmi: rti` stub.
 * To install a real NMI handler, add nmi_handler.c + nmi_trampoline.s
 * from getStarterSnippet and modify the crt0 to drop its `nmi:` line
 * (see those snippets' comments for the exact edits).
 *
 * cc65 IS C89: declare loop variables at the top of blocks, no //
 * comments inside some contexts, no s16/uint64_t (cc65 stdint.h covers
 * uint8/16/32 and int8/16/32 only). Use C89 idioms or you'll get
 * 200+ errors on first build.
 */

#include <stdint.h>

/* PPU registers. */
#define PPUCTRL    (*(volatile uint8_t*)0x2000)
#define PPUMASK    (*(volatile uint8_t*)0x2001)
#define PPUSTATUS  (*(volatile uint8_t*)0x2002)
#define PPUADDR    (*(volatile uint8_t*)0x2006)
#define PPUDATA    (*(volatile uint8_t*)0x2007)
#define OAMADDR    (*(volatile uint8_t*)0x2003)
#define OAMDMA     (*(volatile uint8_t*)0x4014)

/* Shadow OAM — DMA'd to PPU sprite RAM every vblank by the NMI. */
#pragma bss-name(push, "OAM")
uint8_t oam[256];
#pragma bss-name(pop)

/* Tile 1 — an 8x8 'H' glyph. NES tiles are 2bpp (16 bytes per tile:
 * 8 bytes plane 0, 8 bytes plane 1). For a 1-color glyph we use plane
 * 0 only; plane 1 is all zeros. */
static const uint8_t tile_H[16] = {
    /* plane 0: shape */
    0b10000010,
    0b10000010,
    0b10000010,
    0b11111110,
    0b10000010,
    0b10000010,
    0b10000010,
    0b00000000,
    /* plane 1: empty (color stays in palette 0) */
    0,0,0,0,0,0,0,0,
};

/* Palette: 4 colors per palette × 4 sprite palettes + 4 BG palettes. */
static const uint8_t palette[32] = {
    /* BG palette 0..3 (4 colors each) */
    0x0F, 0x30, 0x10, 0x00,   /* gray-on-white */
    0x0F, 0x21, 0x11, 0x01,   /* blue */
    0x0F, 0x27, 0x17, 0x07,   /* orange */
    0x0F, 0x2A, 0x1A, 0x0A,   /* green */
    /* Sprite palette 0..3 (color 0 is transparent) */
    0x0F, 0x28, 0x18, 0x08,   /* yellow — used by our sprite */
    0x0F, 0x21, 0x11, 0x01,
    0x0F, 0x27, 0x17, 0x07,
    0x0F, 0x2A, 0x1A, 0x0A,
};

static void wait_vblank(void) {
    /* Spin until bit 7 of PPUSTATUS is set, then reset latch. */
    while ((PPUSTATUS & 0x80) == 0) { /* wait */ }
}

static void ppu_addr(uint16_t a) {
    PPUSTATUS;             /* clear address latch */
    PPUADDR = (uint8_t)(a >> 8);
    PPUADDR = (uint8_t)(a & 0xFF);
}

void main(void) {
    uint16_t i;

    /* 1. Initial PPU off — disable rendering, NMI, IRQ. */
    PPUCTRL = 0;
    PPUMASK = 0;

    /* 2. Wait two vblanks (NES init protocol — PPU warm-up). */
    wait_vblank();
    wait_vblank();

    /* 3. Upload our tile to CHR-RAM at $0010 (tile index 1, sprite table). */
    ppu_addr(0x0010);
    for (i = 0; i < 16; i++) PPUDATA = tile_H[i];

    /* 4. Upload palette to $3F00. */
    ppu_addr(0x3F00);
    for (i = 0; i < 32; i++) PPUDATA = palette[i];

    /* 5. Init shadow OAM: hide all sprites (Y = $FF moves off screen). */
    for (i = 0; i < 256; i += 4) {
        oam[i + 0] = 0xFF;  /* Y */
        oam[i + 1] = 0;     /* tile */
        oam[i + 2] = 0;     /* attr */
        oam[i + 3] = 0;     /* X */
    }
    /* Drop sprite 0 in the middle of the screen, using tile 1, sprite palette 0. */
    oam[0] = 110;     /* Y */
    oam[1] = 0x01;    /* tile index */
    oam[2] = 0x00;    /* attrs: palette 0, no flip, in front */
    oam[3] = 124;     /* X */

    /* 6. Reset scroll. */
    ppu_addr(0x2000);
    PPUSTATUS;
    /* Scroll regs would go here (write to $2005) if we wanted to scroll. */

    /* 7. One-shot OAM DMA now (NMI will keep doing this every frame
     *    if you install an NMI handler — see nmi_handler.c). */
    OAMADDR = 0;
    OAMDMA = 0x02;  /* DMA from $0200 */

    /* 8. Enable rendering: show sprites, leftmost 8px shown. */
    PPUMASK = 0x1E;
    /* PPUCTRL = $80 to enable NMI; leaving disabled for this minimal
     * scaffold so vblank doesn't fire (we don't have an NMI handler
     * installed). The screen will just sit showing the sprite.
     * Add NMI later via nmi_handler.c. */

    while (1) { /* park here forever */ }
}
