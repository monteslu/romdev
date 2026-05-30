/* ── music_demo.c — Game Gear music_demo template ──────────────────
 *
 * Plays a hand-authored note table on PSG channel 2 via gg_music, and
 * fires a "pew" sfx tone on PSG channel 0 via gg_sfx when the player
 * presses button 1. Controls:
 *
 *   D-pad LEFT / RIGHT  → switch song (0 / 1 / 2)
 *   D-pad UP            → stop music
 *   D-pad DOWN          → restart current song
 *   BUTTON 1            → SFX "pew" (does not interrupt music)
 *
 * Visible viewport notes (GG-specific):
 *   The GG screen shows only the centered 160×144 region of the SMS
 *   256×192 framebuffer. That maps to screen X ∈ [48, 207] and screen
 *   Y ∈ [24, 167]. All visible UI in this demo lives in that band.
 *
 * Wire-up: gg_music shares the SN76489 PSG with gg_sfx. We hand them
 * different channels (sfx_tone uses 0/1, sfx_noise uses 3, gg_music
 * owns 2) so they can coexist without stepping on each other.
 *
 * Multi-file project — main.c + the GG runtime + gg_music + gg_sfx.
 */
#include "gg_hw.h"
#include "gg_sfx.h"
#include "gg_music.h"
#include <stdint.h>

extern void gg_vdp_init(void);
extern void gg_vdp_display_on(void);
extern void gg_vdp_set_addr(uint16_t addr, uint8_t prefix);
extern void gg_load_palette(const uint8_t *palette);
extern void gg_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count);
extern void gg_vblank_wait(void);
extern uint8_t gg_joypad_read(void);
extern void gg_sprite_init(void);
extern void gg_sprite_set(uint8_t slot, uint8_t x, uint8_t y, uint8_t tile);
extern void gg_sat_upload(void);

/* Background = black. Sprite palette (entries 16+):
 *   16 = transparent backdrop, 17 = white, 18 = green, 19 = red.
 * CRAM bytes on SMS/GG are 2-2-2 BGR. */
static const uint8_t palette[32] = {
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x3F,0x0C,0x03, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
};

/* Three 8×8 sprite tiles, 4bpp interleaved (4 planes × 8 rows):
 *   tile 0: solid color 1 (white)
 *   tile 1: solid color 2 (green)
 *   tile 2: solid color 3 (red)
 */
static const uint8_t sprite_tiles[32 * 3] = {
  /* tile 0 — white (plane 0 = $FF) */
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  /* tile 1 — green (plane 1 = $FF) */
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  /* tile 2 — red (planes 0+1 = $FF, so color 3) */
  0xFF,0xFF,0x00,0x00, 0xFF,0xFF,0x00,0x00,
  0xFF,0xFF,0x00,0x00, 0xFF,0xFF,0x00,0x00,
  0xFF,0xFF,0x00,0x00, 0xFF,0xFF,0x00,0x00,
  0xFF,0xFF,0x00,0x00, 0xFF,0xFF,0x00,0x00,
};

/* GG visible region center on the SMS framebuffer:
 *   X: 48..207  (160 px wide)
 *   Y: 24..167  (144 px tall)
 * We put three sprite "song indicator" blocks at Y=80, X=80/120/160.
 */
#define GG_VIS_X0  48
#define GG_VIS_Y0  24

#define IND_Y      80
#define IND_X0     80
#define IND_DX     40

static uint8_t pad_prev = 0xFF;

static uint8_t edge_pressed(uint8_t pad, uint8_t mask) {
  /* Active-high after gg_joypad_read inversion: bit set = pressed. */
  return (pad & mask) && !(pad_prev & mask);
}

void main(void) {
  uint8_t song = 0;
  uint8_t sfx_cooldown = 0;
  uint8_t indicator_tile;
  uint8_t i;

  gg_vdp_init();
  gg_load_palette(palette);
  gg_load_tiles(0x2000, sprite_tiles, sizeof(sprite_tiles));
  gg_sprite_init();

  sfx_init();
  music_init();
  music_play(0);   /* start with song 0 */

  /* Stage 3 indicator sprites + a "playhead" sprite. */
  for (i = 0; i < 3; i++) {
    gg_sprite_set(i, IND_X0 + i * IND_DX, IND_Y, 0);  /* dim white */
  }
  /* Playhead — moves above the currently selected song slot. */
  gg_sprite_set(3, IND_X0, IND_Y - 16, 1);            /* green dot */
  gg_sat_upload();
  gg_vdp_display_on();

  for (;;) {
    uint8_t pad;
    gg_vblank_wait();
    sfx_update();
    music_update();

    pad = gg_joypad_read();

    if (edge_pressed(pad, JOY_RIGHT)) {
      if (song + 1 < music_song_count) song++;
      music_play(song);
    }
    if (edge_pressed(pad, JOY_LEFT)) {
      if (song > 0) song--;
      music_play(song);
    }
    if (edge_pressed(pad, JOY_DOWN)) {
      music_play(song);   /* restart current */
    }
    if (edge_pressed(pad, JOY_UP)) {
      music_stop();
    }
    if (edge_pressed(pad, JOY_B1) && sfx_cooldown == 0) {
      sfx_tone(0, 200, 6);  /* high pew on PSG ch 0 */
      sfx_cooldown = 10;
    }
    if (sfx_cooldown) sfx_cooldown--;

    /* Repaint indicators: currently-selected = red, others = white. */
    for (i = 0; i < 3; i++) {
      indicator_tile = (i == song) ? 2 : 0;  /* tile 2 = red, 0 = white */
      gg_sprite_set(i, IND_X0 + i * IND_DX, IND_Y, indicator_tile);
    }
    /* Playhead floats above the selected song. */
    gg_sprite_set(3, IND_X0 + song * IND_DX, IND_Y - 16, 1);

    gg_sat_upload();
    pad_prev = pad;
    (void)GG_VIS_X0;
    (void)GG_VIS_Y0;
  }
}
