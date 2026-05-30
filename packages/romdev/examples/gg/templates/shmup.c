/* ── shmup.c — SMS vertical-shooter scaffold ────────────────────────
 *
 * Mirrors the NES/Genesis/SNES/GB shmup scaffolds. Player ship + 4
 * bullet slots + 4 enemy slots, wave spawner, AABB collisions.
 *
 * SMS has 64 sprites max, 8 per scanline. Player at slot 0,
 * bullets 1-4, enemies 5-8. Score kept in WRAM.
 */
#include "gg_hw.h"
#include "gg_sfx.h"
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

#define MAX_BULLETS 4
#define MAX_ENEMIES 4

/* ── Game Gear visible viewport ──────────────────────────────────────
 * Sprite OAM uses SMS HARDWARE coordinates (256x192 space), but the GG
 * LCD only shows the CENTER 160x144. Anything outside the box below is
 * placed "correctly" in hardware terms yet INVISIBLE on the real screen
 * (and in the core's screenshot, which is the visible crop). Keep all
 * gameplay sprites inside [VIS_X0..VIS_X1] x [VIS_Y0..VIS_Y1]. */
#define VIS_X0  48    /* left edge of the visible region (hardware X)  */
#define VIS_Y0  24    /* top edge  (hardware Y)                        */
#define VIS_X1  207   /* right edge: 48 + 160 - 1                      */
#define VIS_Y1  167   /* bottom edge: 24 + 144 - 1                     */
#define VIS_W   160
#define VIS_H   144
/* Convert a visible-space coordinate (0..159, 0..143) to the hardware
 * coordinate oam/gg_sprite_set wants. Use these if you'd rather think
 * in screen space: gg_sprite_set(slot, VIS_TO_HW_X(sx), VIS_TO_HW_Y(sy), tile). */
#define VIS_TO_HW_X(sx) ((uint8_t)((sx) + VIS_X0))
#define VIS_TO_HW_Y(sy) ((uint8_t)((sy) + VIS_Y0))

#define T_SHIP   0
#define T_BULLET 1
#define T_ENEMY  2

static const uint8_t palette[32] = {
  0x10,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  /* Sprite palette: white, yellow, red */
  0x00,0x3F,0x0F,0x03, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
};

static const uint8_t sprite_tiles[32 * 3] = {
  /* T_SHIP — diamond using colour 1 (white) */
  0x18,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00,
  0x7E,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0x7E,0x00,0x00,0x00,
  0x3C,0x00,0x00,0x00, 0x18,0x00,0x00,0x00,
  /* T_BULLET — small ball using colour 2 (yellow → plane 1) */
  0x00,0x18,0x00,0x00, 0x00,0x3C,0x00,0x00,
  0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00,
  0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00,
  0x00,0x18,0x00,0x00, 0x00,0x00,0x00,0x00,
  /* T_ENEMY — X using colour 3 (red → planes 0+1) */
  0x81,0x81,0x00,0x00, 0x42,0x42,0x00,0x00,
  0x24,0x24,0x00,0x00, 0x18,0x18,0x00,0x00,
  0x18,0x18,0x00,0x00, 0x24,0x24,0x00,0x00,
  0x42,0x42,0x00,0x00, 0x81,0x81,0x00,0x00,
};

typedef struct { uint8_t x, y, alive; } Obj;

static Obj player;
static Obj bullets[MAX_BULLETS];
static Obj enemies[MAX_ENEMIES];
static uint16_t score;
static uint8_t spawn_timer;

static uint8_t aabb(Obj *a, Obj *b) {
  return a->x < b->x + 8 && a->x + 8 > b->x
      && a->y < b->y + 8 && a->y + 8 > b->y;
}

static void fire(void) {
  uint8_t i;
  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullets[i].alive) {
      bullets[i].x = player.x;
      bullets[i].y = (uint8_t)(player.y - 8);
      bullets[i].alive = 1;
      return;
    }
  }
}

static void spawn(void) {
  uint8_t i;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemies[i].alive) {
      /* Spawn across the VISIBLE width (hardware X in [VIS_X0..VIS_X1-8]). */
      enemies[i].x = (uint8_t)(VIS_X0 + ((spawn_timer * 37u) % (VIS_W - 8)));
      enemies[i].y = VIS_Y0;   /* enter at the top of the visible region */
      enemies[i].alive = 1;
      return;
    }
  }
}

void main(void) {
  uint8_t prev = 0;

  gg_vdp_init();
  gg_load_palette(palette);
  gg_load_tiles(0x2000, sprite_tiles, 32 * 3);

  /* Start the ship centered, near the bottom of the VISIBLE region. */
  player.x = (uint8_t)(VIS_X0 + VIS_W / 2 - 4); player.y = (uint8_t)(VIS_Y1 - 16); player.alive = 1;
  {
    uint8_t i;
    for (i = 0; i < MAX_BULLETS; i++) bullets[i].alive = 0;
    for (i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = 0;
  }
  score = 0;
  spawn_timer = 0;

  gg_sprite_init();
  sfx_init();
  gg_vdp_display_on();

  do {
    uint8_t pad;
    uint8_t i, j;
    gg_vblank_wait();
    sfx_update();

    /* Stage SAT for the new frame. */
    gg_sprite_set(0, player.x, player.y, T_SHIP);
    for (i = 0; i < MAX_BULLETS; i++) {
      uint8_t by = bullets[i].alive ? bullets[i].y : 0xE0; /* off-screen */
      gg_sprite_set((uint8_t)(1 + i), bullets[i].x, by, T_BULLET);
    }
    for (i = 0; i < MAX_ENEMIES; i++) {
      uint8_t ey = enemies[i].alive ? enemies[i].y : 0xE0;
      gg_sprite_set((uint8_t)(5 + i), enemies[i].x, ey, T_ENEMY);
    }
    gg_sat_upload();

    pad = gg_joypad_read();
    /* Clamp movement to the VISIBLE box so the ship never slides off-screen. */
    if (pad & JOY_LEFT  && player.x > VIS_X0)        player.x = (uint8_t)(player.x - 2);
    if (pad & JOY_RIGHT && player.x < VIS_X1 - 8)    player.x = (uint8_t)(player.x + 2);
    if (pad & JOY_UP    && player.y > VIS_Y0)        player.y = (uint8_t)(player.y - 2);
    if (pad & JOY_DOWN  && player.y < VIS_Y1 - 8)    player.y = (uint8_t)(player.y + 2);
    if ((pad & JOY_B1) && !(prev & JOY_B1)) { fire(); sfx_tone(0, 200, 4); }
    prev = pad;

    for (i = 0; i < MAX_BULLETS; i++) {
      if (!bullets[i].alive) continue;
      if (bullets[i].y < VIS_Y0 + 4) { bullets[i].alive = 0; continue; }
      bullets[i].y = (uint8_t)(bullets[i].y - 4);
    }
    for (i = 0; i < MAX_ENEMIES; i++) {
      if (!enemies[i].alive) continue;
      enemies[i].y = (uint8_t)(enemies[i].y + 1);
      if (enemies[i].y >= VIS_Y1) enemies[i].alive = 0;  /* off the visible bottom */
    }
    spawn_timer = (uint8_t)(spawn_timer + 1);
    if (spawn_timer >= 28) { spawn_timer = 0; spawn(); }

    for (i = 0; i < MAX_BULLETS; i++) {
      if (!bullets[i].alive) continue;
      for (j = 0; j < MAX_ENEMIES; j++) {
        if (!enemies[j].alive) continue;
        if (aabb(&bullets[i], &enemies[j])) {
          bullets[i].alive = 0;
          enemies[j].alive = 0;
          if (score < 65500) score = (uint16_t)(score + 10);
          sfx_noise(8);
          break;
        }
      }
    }
  } while (1);
}
