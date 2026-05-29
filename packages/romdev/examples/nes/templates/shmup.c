/* ── shmup.c — NES vertical-scrolling shooter scaffold ───────────────
 *
 * A complete, runnable vertical shmup baseline. Includes:
 *   - Player ship (8x8 sprite) — d-pad moves, A fires
 *   - 4 bullet slots + 4 enemy slots (object pools, no malloc)
 *   - Enemy wave spawner: one enemy per ~32 frames from the top
 *   - Linear bullet/enemy movement + AABB collision (8x8 vs 8x8)
 *   - Score (16-bit, packed BCD-ish) in zero page; not yet rendered
 *
 * The scaffold is GENRE-shaped — gameplay-specific tuning (enemy
 * patterns, scoring rules, art) is yours to fill in. Tile data here
 * is intentionally minimal (3 outlined boxes for ship/bullet/enemy);
 * replace with your real sprites.
 *
 * Frame budget (NTSC): 60 fps × ~3 collision checks per bullet =
 * 4 bullets × 4 enemies = 16 checks/frame. Well under the cycle budget.
 *
 * Read TROUBLESHOOTING.md before editing — the two-vblank PPU warm-up,
 * shadow_oam staging-before-NMI-fires, and palette-at-$3F00 are the
 * NES gotchas you'll trip on first.
 */

#include "nes_runtime.h"

/* ── Tile data: ship (1), bullet (2), enemy (3) ──────────────────── */
/* Each 8x8 tile is 16 bytes: 8 plane-0 bytes then 8 plane-1 bytes.
 * Plane-0 only sets give color index 1 (palette entry 1). */
static const uint8_t tile_blank[16] = { 0 };
static const uint8_t tile_ship[16] = {
  0x18, 0x3C, 0x7E, 0xFF, 0xFF, 0x7E, 0x3C, 0x18,  /* plane 0 */
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t tile_bullet[16] = {
  0x00, 0x18, 0x3C, 0x3C, 0x3C, 0x3C, 0x18, 0x00,  /* plane 0 */
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t tile_enemy[16] = {
  0x81, 0x42, 0x24, 0xFF, 0xFF, 0x24, 0x42, 0x81,  /* plane 0 — spider-ish */
  0,    0,    0,    0,    0,    0,    0,    0,
};

/* ── Palette ─────────────────────────────────────────────────────── */
static const uint8_t palette[32] = {
  /* BG (unused but PPU reads $3F00 backdrop) */
  0x0F, 0x10, 0x20, 0x30,
  0x0F, 0x10, 0x20, 0x30,
  0x0F, 0x10, 0x20, 0x30,
  0x0F, 0x10, 0x20, 0x30,
  /* Sprite palettes 0..3 */
  0x0F, 0x21, 0x32, 0x30,  /* sp0: ship — blue/white */
  0x0F, 0x37, 0x27, 0x16,  /* sp1: bullet — yellow */
  0x0F, 0x16, 0x06, 0x36,  /* sp2: enemy — red */
  0x0F, 0x2A, 0x1A, 0x0A,
};

/* ── Object pools ────────────────────────────────────────────────── */
#define MAX_BULLETS 4
#define MAX_ENEMIES 4
#define TILE_SHIP    1
#define TILE_BULLET  2
#define TILE_ENEMY   3
#define SHIP_PAL     0
#define BULLET_PAL   1
#define ENEMY_PAL    2

static uint8_t bullet_active[MAX_BULLETS];
static uint8_t bullet_x[MAX_BULLETS];
static uint8_t bullet_y[MAX_BULLETS];

static uint8_t enemy_active[MAX_ENEMIES];
static uint8_t enemy_x[MAX_ENEMIES];
static uint8_t enemy_y[MAX_ENEMIES];

/* ── Game state ──────────────────────────────────────────────────── */
static uint8_t ship_x = 120;
static uint8_t ship_y = 200;
static uint8_t fire_cooldown = 0;
static uint8_t spawn_timer = 0;
static uint16_t score = 0;
static uint16_t rng = 0xACE1;  /* simple xorshift seed */

/* xorshift16 — cheap LFSR-quality randomness, ~$10 cycles per call. */
static uint8_t random8(void) {
  uint16_t r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (uint8_t)r;
}

static void fire_bullet(void) {
  uint8_t i;
  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullet_active[i]) {
      bullet_active[i] = 1;
      bullet_x[i] = ship_x;
      bullet_y[i] = ship_y - 4;
      return;
    }
  }
}

static void spawn_enemy(void) {
  uint8_t i;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemy_active[i]) {
      enemy_active[i] = 1;
      enemy_x[i] = 16 + (random8() & 0x7F);  /* 16..143 */
      enemy_y[i] = 0;
      return;
    }
  }
}

/* AABB 8x8 vs 8x8 — both objects assumed 8-pixel boxes. */
static uint8_t hits(uint8_t ax, uint8_t ay, uint8_t bx, uint8_t by) {
  uint8_t dx, dy;
  dx = (ax > bx) ? (ax - bx) : (bx - ax);
  dy = (ay > by) ? (ay - by) : (by - ay);
  return (dx < 8) && (dy < 8);
}

void main(void) {
  uint8_t i, pad, prev_pad = 0;

  ppu_off();

  /* Upload tile data — blank in slot 0 + 3 sprite tiles in slots 1..3. */
  chr_ram_upload(0x0000, tile_blank,  16);
  chr_ram_upload(0x0010, tile_ship,   16);
  chr_ram_upload(0x0020, tile_bullet, 16);
  chr_ram_upload(0x0030, tile_enemy,  16);

  palette_load(palette);

  oam_clear();
  ppu_on_all();
  sound_init();

  /* Initialize pools to inactive. */
  for (i = 0; i < MAX_BULLETS; i++) bullet_active[i] = 0;
  for (i = 0; i < MAX_ENEMIES; i++) enemy_active[i] = 0;

  for (;;) {
    /* ── Stage sprites for the upcoming NMI ──────────────────── */
    oam_clear();
    oam_spr(ship_x, ship_y, TILE_SHIP, SHIP_PAL);
    for (i = 0; i < MAX_BULLETS; i++) {
      if (bullet_active[i]) {
        oam_spr(bullet_x[i], bullet_y[i], TILE_BULLET, BULLET_PAL);
      }
    }
    for (i = 0; i < MAX_ENEMIES; i++) {
      if (enemy_active[i]) {
        oam_spr(enemy_x[i], enemy_y[i], TILE_ENEMY, ENEMY_PAL);
      }
    }

    ppu_wait_nmi();

    /* ── Input ───────────────────────────────────────────────── */
    pad = pad_poll(0);
    if ((pad & PAD_LEFT)  && ship_x > 8)   --ship_x;
    if ((pad & PAD_RIGHT) && ship_x < 240) ++ship_x;
    if ((pad & PAD_UP)    && ship_y > 16)  --ship_y;
    if ((pad & PAD_DOWN)  && ship_y < 216) ++ship_y;

    if ((pad & PAD_A) && fire_cooldown == 0) {
      fire_bullet();
      fire_cooldown = 8;  /* 8-frame cooldown */
      sound_play_tone(0, 0x100, 6, 4);  /* short pew */
    }
    if (fire_cooldown > 0) --fire_cooldown;
    prev_pad = pad;

    /* ── Update bullets (move up, despawn off-screen) ────────── */
    for (i = 0; i < MAX_BULLETS; i++) {
      if (!bullet_active[i]) continue;
      if (bullet_y[i] < 4) {
        bullet_active[i] = 0;
      } else {
        bullet_y[i] -= 4;
      }
    }

    /* ── Update enemies (move down, despawn off-screen) ──────── */
    for (i = 0; i < MAX_ENEMIES; i++) {
      if (!enemy_active[i]) continue;
      if (enemy_y[i] >= 232) {
        enemy_active[i] = 0;
      } else {
        ++enemy_y[i];
      }
    }

    /* ── Collisions: bullets ↔ enemies ───────────────────────── */
    {
      uint8_t b, e;
      for (b = 0; b < MAX_BULLETS; b++) {
        if (!bullet_active[b]) continue;
        for (e = 0; e < MAX_ENEMIES; e++) {
          if (!enemy_active[e]) continue;
          if (hits(bullet_x[b], bullet_y[b], enemy_x[e], enemy_y[e])) {
            bullet_active[b] = 0;
            enemy_active[e] = 0;
            ++score;  /* TODO: render score */
            sound_play_noise(8, 8, 6);  /* period 8, vol 8, 6 frames */
            break;
          }
        }
      }
    }

    /* ── Spawner: one enemy every ~32 frames ─────────────────── */
    ++spawn_timer;
    if (spawn_timer >= 32) {
      spawn_timer = 0;
      spawn_enemy();
    }
  }
}
