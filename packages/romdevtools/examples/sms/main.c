/* SMS hello-world. Writes a yellow 'H' tile to VRAM, places it in the
 * name table, enables display. Pressing P1-B1 scrolls the BG by one
 * pixel per frame.
 *
 * Single-file example — pulls the SMS hardware port declarations
 * directly. For a more realistic multi-file project, see
 * src/platforms/sms/lib/c/ (vdp_init.c, load_tiles.c, etc.) — those
 * snippets are bundled as part of the starter library:
 *
 *   getStarterSnippet({platform:"sms", name:"vdp_init", language:"c"})
 */
#include <stdint.h>

/* ─── SMS hardware ports ──────────────────────────────────────────── */
__sfr __at 0xBE PORT_VDP_DATA;
__sfr __at 0xBF PORT_VDP_CTRL;
__sfr __at 0xDC PORT_JOY_A;

#define VDP_VRAM_WRITE 0x40
#define VDP_REG_WRITE  0x80
#define VDP_CRAM_WRITE 0xC0
#define JOY_B1         0x10

/* ─── VDP helpers ─────────────────────────────────────────────────── */
static void vdp_write_reg(uint8_t reg, uint8_t value) {
  PORT_VDP_CTRL = value;
  PORT_VDP_CTRL = VDP_REG_WRITE | reg;
}

static void vdp_set_addr(uint16_t addr, uint8_t prefix) {
  PORT_VDP_CTRL = (uint8_t)(addr & 0xFF);
  PORT_VDP_CTRL = (uint8_t)((addr >> 8) & 0x3F) | prefix;
}

static void vdp_init(void) {
  vdp_write_reg(0,  0x36);
  vdp_write_reg(1,  0x80);  /* display OFF for now */
  vdp_write_reg(2,  0xFF);  /* name table at $3800 */
  vdp_write_reg(3,  0xFF);
  vdp_write_reg(4,  0xFF);  /* BG tile data at $0000 */
  vdp_write_reg(5,  0xFF);  /* sprite attr table at $3F00 */
  vdp_write_reg(6,  0xFB);  /* sprite tile data at $2000 */
  vdp_write_reg(7,  0x00);
  vdp_write_reg(8,  0x00);
  vdp_write_reg(9,  0x00);
  vdp_write_reg(10, 0xFF);
}

/* ─── Palette + tile data ─────────────────────────────────────────── */
/* SMS CRAM: 2-2-2 BGR. Entry 0 = backdrop. */
static const uint8_t palette[32] = {
  0x30, 0x0F, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,   /* BG: blue, yellow */
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,   /* sprite palette unused */
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

/* One 8x8 tile, 4bpp interleaved (32 bytes = 8 rows × 4 planes per row).
 * Only plane 0 has bits set → renders in color index 1 (yellow). */
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

/* ─── Upload helpers ──────────────────────────────────────────────── */
static void load_palette(void) {
  uint8_t i;
  vdp_set_addr(0, VDP_CRAM_WRITE);
  for (i = 0; i < 32; i++) PORT_VDP_DATA = palette[i];
}

static void load_tile(void) {
  uint8_t i;
  /* Tile 1 at VRAM offset 32 (= tile_idx * 32). Tile 0 left blank. */
  vdp_set_addr(32, VDP_VRAM_WRITE);
  for (i = 0; i < 32; i++) PORT_VDP_DATA = tile_h[i];
}

static void clear_name_table(void) {
  uint16_t i;
  vdp_set_addr(0x3800, VDP_VRAM_WRITE);
  /* 32 cols × 28 rows × 2 bytes = 1792 entries. */
  for (i = 0; i < 1792; i++) PORT_VDP_DATA = 0;
}

static void place_h(void) {
  /* Cell at row 13, col 15 (center-ish). */
  vdp_set_addr(0x3800 + (13 * 32 + 15) * 2, VDP_VRAM_WRITE);
  PORT_VDP_DATA = 1;       /* tile 1 */
  PORT_VDP_DATA = 0;       /* no flips, BG palette, no priority */
}

static void wait_vblank(void) {
  while ((PORT_VDP_CTRL & 0x80) == 0) { }
}

/* ─── main ───────────────────────────────────────────────────────── */
void main(void) {
  uint8_t scroll = 0;
  uint8_t pressed;          /* C89: decls must precede statements */

  vdp_init();
  load_palette();
  load_tile();
  clear_name_table();
  place_h();

  /* Enable display: vblank IRQ on, display on, 192-line. */
  vdp_write_reg(1, 0xE0);

  /* Main loop. SDCC z80 is C89-only; all locals declared above.
   * The do/while(1) shape works around an SDCC 4.4.0 register-
   * allocation bug in `for(;;) { if (cond) f(literal, local); }`
   * (the branchless update is what you'd write for max throughput
   * on Z80 anyway). */
  do {
    wait_vblank();
    /* Hold B1 to scroll the BG. */
    pressed = (~PORT_JOY_A & JOY_B1) ? 1 : 0;
    scroll = (uint8_t)(scroll + pressed);
    vdp_write_reg(8, scroll);   /* R8 = BG X scroll */
  } while (1);
}
