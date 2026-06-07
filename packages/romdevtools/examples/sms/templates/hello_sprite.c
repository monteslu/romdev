/* ── hello_sprite.c — SMS starter (one sprite + d-pad) ──────────────
 *
 * Drives one sprite around the SMS screen with the directional pad.
 * Uses the bundled SMS runtime helpers (sms_vdp_init, sms_load_tiles,
 * sms_load_palette, sms_sprite_*, sms_vblank_wait, sms_joypad_read).
 *
 * SMS hardware notes the templates assume:
 *   - 256×192 visible area in mode 4
 *   - Sprite attribute table at VRAM $3F00 (configured by sms_vdp_init)
 *   - Sprite tile data at VRAM $2000 (R6 = 0xFB)
 *   - 64 sprite slots × 4 bytes (Y / X / tile / unused)
 *
 * Multi-file project — main.c plus the runtime .c files. Build with:
 *   build({ output: "rom", platform:"sms", language:"c",
 *                sources: { "main.c": ..., "vdp_init.c": ..., ... },
 *                includes: { "sms_hw.h": ... }})
 *
 * createProject({platform:"sms", template:"hello_sprite"}) copies all
 * the bits into your project tree.
 */
#include "sms_hw.h"
#include "sms_sfx.h"
#include <stdint.h>

extern void sms_vdp_init(void);
extern void sms_vdp_display_on(void);
extern void sms_vdp_write_reg(uint8_t reg, uint8_t value);
extern void sms_vdp_set_addr(uint16_t addr, uint8_t prefix);
extern void sms_load_palette(const uint8_t *palette);
extern void sms_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count);
extern void sms_vblank_wait(void);
extern uint8_t sms_joypad_read(void);
extern void sms_sprite_init(void);
extern void sms_sprite_set(uint8_t slot, uint8_t x, uint8_t y, uint8_t tile);
extern void sms_sat_upload(void);

/* BG palette: backdrop blue + yellow. Sprite palette (entries 16-31)
 * we set white at index 17 so our sprite is visible.
 * SMS CRAM is 2-2-2 BGR: 0x00=black, 0x3F=white. */
static const uint8_t palette[32] = {
  0x10,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x3F,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
};

/* One 8×8 sprite tile (4bpp interleaved). Filled square in color 1. */
static const uint8_t sprite_tile[32] = {
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
};

void main(void) {
  uint8_t x = 124;   /* mid-screen X */
  uint8_t y = 88;    /* mid-screen Y */
  uint8_t prev = 0;

  sms_vdp_init();
  sms_load_palette(palette);
  /* Upload one sprite tile to VRAM $2000 (sprite tile area). */
  sms_load_tiles(0x2000, sprite_tile, 32);

  sms_sprite_init();
  sfx_init();
  sfx_tone(0, 220, 12);  /* boot chime — confirms sound works */
  sms_sprite_set(0, x, y, /*tile*/ 0);
  sms_sat_upload();

  sms_vdp_display_on();

  do {
    uint8_t pad;
    sms_vblank_wait();
    sfx_update();
    /* Stage sprite for the next frame BEFORE we read input — the SAT
     * upload below pushes the staging buffer to VRAM at vblank. */
    sms_sprite_set(0, x, y, 0);
    sms_sat_upload();

    pad = sms_joypad_read();
    if (pad & JOY_LEFT  && x > 0)       x = (uint8_t)(x - 2);
    if (pad & JOY_RIGHT && x < 248)     x = (uint8_t)(x + 2);
    if (pad & JOY_UP    && y > 0)       y = (uint8_t)(y - 2);
    if (pad & JOY_DOWN  && y < 184)     y = (uint8_t)(y + 2);
    prev = pad;
    (void)prev;
  } while (1);
}
