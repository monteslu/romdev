/* Game Gear hello-world. Writes a yellow 'H' tile to VRAM, places it in
 * the center of the 160×144 visible viewport, enables display. Pressing
 * P1-B1 scrolls the BG by one pixel per frame.
 *
 * Self-contained — inlines the VDP helpers so this single file + the
 * bundled gg_crt0.s are all you need to compile and run. For a more
 * modular multi-file project that pulls in src/platforms/gg/lib/c/*,
 * see `hello_sprite` and `tile_engine`.
 *
 * GG specifics this file demonstrates (read MENTAL_MODEL.md for details):
 *   - Visible viewport is 160×144 centered in the 256×192 framebuffer.
 *     OAM/name-table coords are in 256×192 space; the visible region
 *     starts at hw coord (48, 24). The 'H' goes at name-table row 12
 *     col 16 = visible center.
 *   - CRAM entries are 12-bit BGR (2 bytes each, little-endian), 16 BG
 *     colors at $0000-$1F and 16 sprite colors at $0020-$3F.
 *   - VDP R6 default is 0xFB → sprite tiles read from $0000 (NOT $2000
 *     as some references claim). Use inspectSprites to verify.
 */
#include <stdint.h>

/* ─── GG hardware ports ──────────────────────────────────────────── */
__sfr __at 0xBE PORT_VDP_DATA;
__sfr __at 0xBF PORT_VDP_CTRL;
__sfr __at 0xDC PORT_JOY_A;
__sfr __at 0x00 PORT_GG_INPUT;       /* bit 7 = START (active low) */

#define VDP_VRAM_WRITE 0x40
#define VDP_REG_WRITE  0x80
#define VDP_CRAM_WRITE 0xC0
#define JOY_B1         0x10

/* ─── GG visible viewport (160×144 centered in 256×192 framebuffer) ─
 * sprite/OAM coords use the FULL 256×192 hardware coord space, but
 * only the windowed region below is on-screen on a real GG.
 *   sprite/OAM:        x ∈ [GG_VIS_X_MIN..GG_VIS_X_MAX],
 *                      y ∈ [GG_VIS_Y_MIN..GG_VIS_Y_MAX]
 *   nametable cell:    col ∈ [GG_VIS_COL_MIN..GG_VIS_COL_MAX],
 *                      row ∈ [GG_VIS_ROW_MIN..GG_VIS_ROW_MAX]
 *   visible center:    (row 11, col 15)
 */
#define GG_VIS_X_MIN     48
#define GG_VIS_X_MAX    207
#define GG_VIS_Y_MIN     24
#define GG_VIS_Y_MAX    167
#define GG_VIS_COL_MIN    6
#define GG_VIS_COL_MAX   25
#define GG_VIS_ROW_MIN    3
#define GG_VIS_ROW_MAX   20

static void vdp_write_reg(uint8_t reg, uint8_t value) {
  PORT_VDP_CTRL = value;
  PORT_VDP_CTRL = VDP_REG_WRITE | reg;
}

static void vdp_set_addr(uint16_t addr, uint8_t prefix) {
  PORT_VDP_CTRL = (uint8_t)(addr & 0xFF);
  PORT_VDP_CTRL = (uint8_t)((addr >> 8) & 0x3F) | prefix;
}

static void vdp_init(void) {
  vdp_write_reg(0,  0x36);   /* Mode 4 */
  vdp_write_reg(1,  0x80);   /* display OFF until we've loaded assets */
  vdp_write_reg(2,  0xFF);   /* name table at $3800 */
  vdp_write_reg(3,  0xFF);
  vdp_write_reg(4,  0xFF);   /* BG tile data at $0000 */
  vdp_write_reg(5,  0xFF);   /* sprite attr table at $3F00 */
  vdp_write_reg(6,  0xFB);   /* sprite tile data at $0000 */
  vdp_write_reg(7,  0x00);
  vdp_write_reg(8,  0x00);   /* BG X scroll */
  vdp_write_reg(9,  0x00);   /* BG Y scroll */
  vdp_write_reg(10, 0xFF);
}

/* 12-bit BGR palette. 16 BG entries (CRAM $0000-$1F) + 16 sprite
 * entries (CRAM $0020-$3F). Each entry is 2 bytes, little-endian:
 *   byte 0 = (G<<4) | R   (4-bit each)
 *   byte 1 = B            (low nibble; high nibble unused)
 *
 * Examples:  {0xFF, 0x0F} = R=F G=F B=F → white
 *            {0xFF, 0x00} = R=F G=F B=0 → yellow
 *            {0x0F, 0x00} = R=F G=0 B=0 → red
 *            {0xF0, 0x0F} = R=0 G=F B=F → cyan
 *
 * Entry 0 = backdrop / transparent. */
static const uint8_t palette[32] = {
  0x00, 0x00,   /* 0  backdrop (black) */
  0xFF, 0x00,   /* 1  yellow */
  0x00, 0x00,   0x00, 0x00,   0x00, 0x00,   0x00, 0x00,
  0x00, 0x00,   0x00, 0x00,   0x00, 0x00,   0x00, 0x00,
  0x00, 0x00,   0x00, 0x00,   0x00, 0x00,   0x00, 0x00,
};

/* 8×8 4bpp tile of an 'H'. Mode 4 stores 4 bytes per scanline (one per
 * bitplane). Setting plane 0 only → color index 1 = yellow. */
static const uint8_t tile_h[32] = {
  0x66, 0x00, 0x00, 0x00,
  0x66, 0x00, 0x00, 0x00,
  0x66, 0x00, 0x00, 0x00,
  0x7E, 0x00, 0x00, 0x00,
  0x7E, 0x00, 0x00, 0x00,
  0x66, 0x00, 0x00, 0x00,
  0x66, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
};

static void load_palette(void) {
  uint8_t i;
  vdp_set_addr(0, VDP_CRAM_WRITE);
  for (i = 0; i < 32; i++) PORT_VDP_DATA = palette[i];
}

static void load_tile(void) {
  uint8_t i;
  vdp_set_addr(32, VDP_VRAM_WRITE);    /* tile slot 1 = VRAM offset 32 */
  for (i = 0; i < 32; i++) PORT_VDP_DATA = tile_h[i];
}

static void clear_name_table(void) {
  uint16_t i;
  vdp_set_addr(0x3800, VDP_VRAM_WRITE);
  for (i = 0; i < 1792; i++) PORT_VDP_DATA = 0;
}

/* Drop the 'H' at name-table (row 12, col 16). Visible GG viewport
 * sits at name-table cols 6..25 / rows 3..20 — so (12,16) is roughly
 * the visible center. */
static void place_h(void) {
  vdp_set_addr(0x3800 + (12 * 32 + 16) * 2, VDP_VRAM_WRITE);
  PORT_VDP_DATA = 1;
  PORT_VDP_DATA = 0;
}

static void wait_vblank(void) {
  while ((PORT_VDP_CTRL & 0x80) == 0) { }
}

void main(void) {
  uint8_t scroll = 0;

  vdp_init();
  load_palette();
  load_tile();
  clear_name_table();
  place_h();

  vdp_write_reg(1, 0xE0);   /* display ON, vblank IRQ on, 192-line */

  do {
    uint8_t pressed;
    wait_vblank();
    pressed = (~PORT_JOY_A & JOY_B1) ? 1 : 0;
    scroll = (uint8_t)(scroll + pressed);
    vdp_write_reg(8, scroll);
  } while (1);
}
