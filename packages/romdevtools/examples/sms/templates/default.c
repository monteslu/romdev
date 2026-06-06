/* SMS hello-world. Writes a yellow 'H' tile to VRAM, places it in the
 * name table, enables display. Pressing P1-B1 scrolls the BG by one
 * pixel per frame.
 *
 * Single-file example — inlines the VDP helpers. For a more modular
 * multi-file project, see `hello_sprite` and `tile_engine` templates
 * (they pull in src/platforms/sms/lib/c/vdp_init.c, joypad_read.c,
 * load_tiles.c, load_palette.c).
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
  vdp_write_reg(1,  0x80);
  vdp_write_reg(2,  0xFF);
  vdp_write_reg(3,  0xFF);
  vdp_write_reg(4,  0xFF);
  vdp_write_reg(5,  0xFF);
  vdp_write_reg(6,  0xFB);
  vdp_write_reg(7,  0x00);
  vdp_write_reg(8,  0x00);
  vdp_write_reg(9,  0x00);
  vdp_write_reg(10, 0xFF);
}

static const uint8_t palette[32] = {
  0x30, 0x0F, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

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
  vdp_set_addr(32, VDP_VRAM_WRITE);
  for (i = 0; i < 32; i++) PORT_VDP_DATA = tile_h[i];
}

static void clear_name_table(void) {
  uint16_t i;
  vdp_set_addr(0x3800, VDP_VRAM_WRITE);
  for (i = 0; i < 1792; i++) PORT_VDP_DATA = 0;
}

static void place_h(void) {
  vdp_set_addr(0x3800 + (13 * 32 + 15) * 2, VDP_VRAM_WRITE);
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

  vdp_write_reg(1, 0xE0);

  do {
    uint8_t pressed;
    wait_vblank();
    pressed = (~PORT_JOY_A & JOY_B1) ? 1 : 0;
    scroll = (uint8_t)(scroll + pressed);
    vdp_write_reg(8, scroll);
  } while (1);
}
