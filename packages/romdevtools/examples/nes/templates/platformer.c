/* ── platformer.c — NES single-screen platformer scaffold ────────────
 *
 * A complete, runnable platformer baseline. Includes:
 *   - Player (8x8 sprite) — d-pad LEFT/RIGHT moves, A jumps
 *   - Gravity + jump physics with fixed-point Y (Q4.4: 4 frac bits)
 *   - Static platform list (5 horizontal rects) — collide-from-above only
 *   - Walk + jump animation via tile-id swapping
 *   - Right-edge → "you win" silence; fall off bottom → respawn
 *
 * Why fixed-point Y: gravity adds < 1 pixel/frame at peak jump, so we
 * need sub-pixel precision. X stays integer because horizontal motion
 * is integer-speed (no acceleration). Standard NES platformer trick.
 *
 * Collision is rect-vs-rect "land on top" only — no side-collision,
 * no head-bump-stop. Add those when your scaffold proves out. This
 * keeps the baseline understandable + extendable.
 *
 * SINGLE-SCREEN as shipped (platforms are drawn as SPRITES, not BG).
 * To make it a SIDE-SCROLLER you must draw platforms into the BACKGROUND
 * nametables (so hardware scroll moves them), use ppu_scroll(camX, 0) —
 * which flips the PPUCTRL nametable-select bit past 256 px for you — and
 * for a world wider than 512 px stream a fresh nametable column + its
 * attribute byte into the off-screen nametable each 8-px camera step.
 * The chr-ram-runtime crt0 uses VERTICAL mirroring, giving NT0 (left) +
 * NT1 (right) side by side = a free 512-px world. See the NES
 * MENTAL_MODEL.md "Backgrounds" + "NMI" sections.
 */

#include "nes_runtime.h"

/* ── Tiles: player idle/jump + platform block (SPRITES, table $0000) ── */
static const uint8_t tile_blank[16] = { 0 };
static const uint8_t tile_player_idle[16] = {
  0x3C, 0x7E, 0xFF, 0xFF, 0xFF, 0xFF, 0x7E, 0x3C,  /* plane 0 — round blob */
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t tile_player_jump[16] = {
  0x18, 0x7E, 0xFF, 0xFF, 0xE7, 0xC3, 0x81, 0x00,  /* plane 0 — arms up */
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t tile_platform[16] = {
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,  /* plane 0 — solid */
  0,    0,    0,    0,    0,    0,    0,    0,
};

/* ── BG scenery tiles (BACKGROUND pattern table $1000) ────────────────
 * Painted into the nametable so the world reads as a real outdoor scene on
 * boot (sky + clouds + dirt) instead of sprites floating on flat black. The
 * BG backdrop colour (palette[0]) is sky blue, so the colours used here are
 * cloud white (idx1), dirt brown (idx2) and grass green (idx3).
 *
 *   BG_CLOUD — a puffy cloud (idx1) dotted across the upper sky.
 *   BG_DIRT  — solid dirt fill (idx2) for the ground band.
 *   BG_GRASS — a grass-topped dirt tile (idx3 cap over idx2) for the
 *              surface row of the ground. */
#define BG_CLOUD  1   /* BG tile index 1 → uploaded to $1010 */
#define BG_DIRT   2   /* BG tile index 2 → uploaded to $1020 */
#define BG_GRASS  3   /* BG tile index 3 → uploaded to $1030 */
static const uint8_t bg_tile_cloud[16] = {
  0x00, 0x18, 0x3C, 0x7E, 0x7E, 0x00, 0x00, 0x00,  /* plane 0 → cloud (idx1) */
  0,    0,    0,    0,    0,    0,    0,    0,
};
static const uint8_t bg_tile_dirt[16] = {
  0,    0,    0,    0,    0,    0,    0,    0,        /* plane 0 clear  */
  0xFF, 0xFF, 0xEF, 0xFF, 0xFF, 0xFE, 0xFF, 0xFF,   /* plane 1 → dirt (idx2) */
};
static const uint8_t bg_tile_grass[16] = {
  0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  /* plane0: top 2 rows on */
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,  /* plane1: all rows on   */
};  /* rows 0-1 → both planes = idx3 (grass cap); rows 2-7 → plane1 = idx2 (dirt) */

static const uint8_t palette[32] = {
  /* BG0: sky-blue backdrop, cloud white (idx1), dirt brown (idx2),
   * grass green (idx3) */
  0x21, 0x30, 0x17, 0x2A,
  0x21, 0x30, 0x17, 0x2A,
  0x21, 0x30, 0x17, 0x2A,
  0x21, 0x30, 0x17, 0x2A,
  /* The universal backdrop ($3F00) is MIRRORED at $3F10 — the sprite
   * palette-0 colour-0 slot. palette_load writes all 32 bytes in order, so
   * byte 16 (this slot) is the LAST write to that mirror and therefore wins.
   * Keep it equal to the BG backdrop (sky blue) or the sky renders as
   * whatever colour-0 you put here, not the BG[0] above. (Sprite colour 0 is
   * transparent regardless, so this never affects how sprites draw.) */
  0x21, 0x21, 0x32, 0x30,  /* sp0: player — blue (colour 0 = backdrop mirror) */
  0x0F, 0x18, 0x28, 0x38,  /* sp1: platforms — green */
  0x0F, 0x16, 0x06, 0x36,
  0x0F, 0x2A, 0x1A, 0x0A,
};

/* ── Platforms (static rectangles) ───────────────────────────────── */
typedef struct { uint8_t x, y, w; } Platform;  /* 8 px tall, w in tiles */
#define NUM_PLATFORMS 5
static const Platform platforms[NUM_PLATFORMS] = {
  {  16, 200, 20 },  /* ground band */
  {  40, 168,  4 },
  { 104, 144,  4 },
  { 168, 168,  4 },
  { 200, 120,  4 },
};

#define TILE_PLAYER_IDLE  1
#define TILE_PLAYER_JUMP  2
#define TILE_PLATFORM     3
#define PLAYER_PAL        0
#define PLATFORM_PAL      1

/* ── Player state ────────────────────────────────────────────────── */
static uint8_t  px = 24;
static uint16_t py_q44 = (200 - 8) << 4;  /* Q4.4 — start above leftmost platform */
static int8_t   vy_q44 = 0;
static uint8_t  on_ground = 0;

#define GRAVITY_Q44    1   /* +1/16 px per frame per frame */
#define JUMP_VEL_Q44 (-40) /* initial vy → peak ~5 tile jump */
#define MOVE_SPEED     1   /* 1 px / frame */

/* AABB: player rect vs platform top edge (treat platform as 8 px tall). */
static uint8_t landed_on(uint8_t pl_idx, uint8_t player_y) {
  const Platform *p = &platforms[pl_idx];
  uint8_t feet_y = player_y + 7;
  if (feet_y < p->y || feet_y > p->y + 4) return 0;          /* not at top edge */
  if (px + 7 < p->x) return 0;
  if (px > p->x + (p->w << 3) - 1) return 0;
  return 1;
}

void main(void) {
  uint8_t pad, prev_pad = 0;
  uint8_t player_y, i;

  ppu_off();

  chr_ram_upload(0x0000, tile_blank,        16);
  chr_ram_upload(0x0010, tile_player_idle,  16);
  chr_ram_upload(0x0020, tile_player_jump,  16);
  chr_ram_upload(0x0030, tile_platform,     16);

  /* BG scenery tiles go in pattern table 1 ($1000) — where the default
   * PPUCTRL points the background fetch. */
  chr_ram_upload(0x1010, bg_tile_cloud, 16);
  chr_ram_upload(0x1020, bg_tile_dirt,  16);
  chr_ram_upload(0x1030, bg_tile_grass, 16);

  palette_load(palette);

  /* Paint the outdoor scene into the nametable while rendering is off
   * (vram_unsafe_set = raw write; tile_set's NMI queue would deadlock before
   * ppu_on). Sky-blue backdrop shows through the empty upper rows; we dot
   * clouds across it, cap the ground with a grass row, and fill the bottom
   * band with solid dirt. The sprite platforms still draw on top of this. */
  {
    uint16_t r, c;
    /* clouds scattered through the upper sky (rows 2..9) */
    for (r = 2; r < 10; r++)
      for (c = (uint16_t)((r * 3) % 6); c < 32; c += 6)
        vram_unsafe_set((uint16_t)(0x2000 + r * 32 + c), BG_CLOUD);
    /* grass cap row + solid dirt to the bottom of the screen */
    for (c = 0; c < 32; c++)
      vram_unsafe_set((uint16_t)(0x2000 + 24 * 32 + c), BG_GRASS);
    for (r = 25; r < 30; r++)
      for (c = 0; c < 32; c++)
        vram_unsafe_set((uint16_t)(0x2000 + r * 32 + c), BG_DIRT);
  }

  oam_clear();
  ppu_on_all();
  sound_init();

  for (;;) {
    player_y = (uint8_t)(py_q44 >> 4);

    /* ── Stage sprites BEFORE ppu_wait_nmi() ────────────────────
     * The NMI handler DMAs shadow OAM at vblank-start, so oam_clear +
     * oam_spr MUST run before the wait below — flip the order and the
     * visible frame lags / shows stale sprites. */
    oam_clear();
    /* player tile depends on whether airborne */
    oam_spr(px, player_y,
            on_ground ? TILE_PLAYER_IDLE : TILE_PLAYER_JUMP,
            PLAYER_PAL);
    /* draw each platform tile (one OAM entry per 8 px column) */
    for (i = 0; i < NUM_PLATFORMS; i++) {
      uint8_t k;
      for (k = 0; k < platforms[i].w; k++) {
        oam_spr(platforms[i].x + (k << 3), platforms[i].y, TILE_PLATFORM, PLATFORM_PAL);
      }
    }

    ppu_wait_nmi();

    /* ── Input ──────────────────────────────────────────────── */
    pad = pad_poll(0);
    if ((pad & PAD_LEFT)  && px > 8)   px -= MOVE_SPEED;
    if ((pad & PAD_RIGHT) && px < 240) px += MOVE_SPEED;
    /* Jump on rising-edge of A while on ground. */
    if ((pad & PAD_A) && !(prev_pad & PAD_A) && on_ground) {
      vy_q44 = JUMP_VEL_Q44;
      on_ground = 0;
      sound_play_tone(0, 0x150, 6, 6);
    }
    prev_pad = pad;

    /* ── Physics ────────────────────────────────────────────── */
    /* gravity */
    if (vy_q44 < 80) vy_q44 += GRAVITY_Q44;  /* terminal velocity */
    py_q44 += vy_q44;

    /* ── Ground / platform collision (descending only) ──────── */
    on_ground = 0;
    if (vy_q44 >= 0) {                       /* falling */
      for (i = 0; i < NUM_PLATFORMS; i++) {
        if (landed_on(i, (uint8_t)(py_q44 >> 4))) {
          py_q44 = (platforms[i].y - 8) << 4;
          vy_q44 = 0;
          on_ground = 1;
          break;
        }
      }
    }

    /* ── Off-bottom → respawn at top-left ───────────────────── */
    if ((py_q44 >> 4) >= 232) {
      px = 24;
      py_q44 = 100 << 4;
      vy_q44 = 0;
      sound_play_noise(8, 8, 8);  /* respawn buzz */
    }
  }
}
