/* ── shmup/main.c — MSX vertical-shooter scaffold (screen 2) ─────────
 *
 * Mirrors the NES/Genesis/SNES/GB/SMS shmup scaffolds, translated to the
 * MSX VDP via the romdev MSX helper lib (msx_hw.h + msx_vdp.c).
 *
 * Player ship (sprite plane 0) + 4 bullet slots (planes 1-4) + 4 enemy
 * slots (planes 5-8), a wave spawner, and AABB collisions. Score is drawn
 * as on-screen tiles ("SCORE 000") along the top row. The whole 32x24
 * screen-2 name table is painted with a banded starfield so the display is
 * clearly space, not a flat backdrop.
 *
 * Controls: joystick LEFT/RIGHT/UP/DOWN moves the ship, trigger A fires.
 *   We read joystick PORT 1 (and the keyboard cursor on stick 0 as a
 *   fallback), and GTTRIG for the fire button.
 *
 * Cartridge rule: INIT must never return, so main() ends in for(;;).
 *
 * Hardware path (all through the MSX helper lib):
 *   - msx_set_screen2()    screen 2 (GRAPHIC II), 256x192, display ON
 *   - msx_vram_write()     upload tile font + sprite patterns to VRAM
 *   - msx_set_sprite()     position the ship/bullets/enemies each frame
 *   - msx_read_joystick()  BIOS GTSTCK — 0=center, 1-8 = direction CW
 *   - msx_psg_tone/off()   fire blip + explosion noise
 *   - vsync()              one game step per VDP frame (interrupt-free)
 */
#include "msx_hw.h"

/* ── interrupt-free vblank sync (poll VDP status S#0 bit 7) ────────────── */
__sfr __at 0x99 VDPSTATUS;
static void vsync(void) {
    (void)VDPSTATUS;
    while (!(VDPSTATUS & 0x80)) {
    }
}

/* fire-button trigger uses the BIOS GTTRIG wrapper (gttrig) from msx_hw.h:
 * gttrig(0)=space/any, gttrig(1)/gttrig(2)=port-A/B triggers. */

#define MAX_BULLETS 4
#define MAX_ENEMIES 4

/* ── tile font: SPACE, S C O R E, digits, plus a couple starfield tiles ── */
#define T_SPACE 0
#define T_S     1
#define T_C     2
#define T_O     3
#define T_R     4
#define T_E     5
#define T_0     6   /* digits 0..9 are consecutive: T_0 + n */
#define T_DEEP  16  /* solid deep-space band (dark blue)        */
#define T_BAND  17  /* solid lighter space band (medium blue)   */
#define T_STAR1 18  /* deep-space cell with a faint star        */
#define T_STAR2 19  /* lighter-band cell with a bright star     */

static const uint8_t font[20][8] = {
    /* 0  SPACE */ {0,0,0,0,0,0,0,0},
    /* 1  S */ {0x7C,0xC0,0xC0,0x78,0x0C,0x0C,0xF8,0x00},
    /* 2  C */ {0x7C,0xC6,0xC0,0xC0,0xC0,0xC6,0x7C,0x00},
    /* 3  O */ {0x7C,0xC6,0xC6,0xC6,0xC6,0xC6,0x7C,0x00},
    /* 4  R */ {0xFC,0xC6,0xC6,0xFC,0xD8,0xCC,0xC6,0x00},
    /* 5  E */ {0xFE,0xC0,0xC0,0xF8,0xC0,0xC0,0xFE,0x00},
    /* 6  0 */ {0x7C,0xCE,0xDE,0xF6,0xE6,0xC6,0x7C,0x00},
    /* 7  1 */ {0x18,0x38,0x18,0x18,0x18,0x18,0x7E,0x00},
    /* 8  2 */ {0x7C,0xC6,0x06,0x1C,0x70,0xC0,0xFE,0x00},
    /* 9  3 */ {0x7C,0xC6,0x06,0x3C,0x06,0xC6,0x7C,0x00},
    /* 10 4 */ {0x1C,0x3C,0x6C,0xCC,0xFE,0x0C,0x0C,0x00},
    /* 11 5 */ {0xFE,0xC0,0xFC,0x06,0x06,0xC6,0x7C,0x00},
    /* 12 6 */ {0x3C,0x60,0xC0,0xFC,0xC6,0xC6,0x7C,0x00},
    /* 13 7 */ {0xFE,0x06,0x0C,0x18,0x30,0x30,0x30,0x00},
    /* 14 8 */ {0x7C,0xC6,0xC6,0x7C,0xC6,0xC6,0x7C,0x00},
    /* 15 9 */ {0x7C,0xC6,0xC6,0x7E,0x06,0x0C,0x78,0x00},
    /* 16 DEEP  (solid fill) */ {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF},
    /* 17 BAND  (solid fill) */ {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF},
    /* 18 STAR1 (deep + dot) */ {0xFF,0xFF,0xFF,0xEF,0xFF,0xFF,0xFF,0xFF},
    /* 19 STAR2 (band + dot) */ {0xFF,0xEF,0xEF,0x83,0xEF,0xEF,0xFF,0xFF}
};

/* colour bytes per glyph: high nibble fg, low nibble bg.
 * TMS9918 fixed palette: 1=black, 4=dark blue, 5=med blue, 14=grey, 15=white.
 * The solid space tiles fill entirely with their fg colour. The star tiles
 * use a white star (fg) over the band colour (bg). */
#define COL_TEXT  0xF1   /* white text on black                       */
#define COL_DEEP  0x44   /* solid dark-blue deep space                */
#define COL_BAND  0x55   /* solid medium-blue band                    */
#define COL_STAR1 0xF4   /* white star pixel over dark-blue field     */
#define COL_STAR2 0xF5   /* white star over medium-blue band          */

/* ── sprite patterns (8x8) ─────────────────────────────────────────────── */
static const uint8_t spr_ship[8]   = {0x18,0x3C,0x7E,0x7E,0xFF,0xFF,0xDB,0x81};
static const uint8_t spr_bullet[8] = {0x18,0x3C,0x3C,0x3C,0x3C,0x3C,0x18,0x00};
static const uint8_t spr_enemy[8]  = {0x81,0x42,0x24,0x18,0x18,0x24,0x42,0x81};

#define PAT_SHIP   0
#define PAT_BULLET 1
#define PAT_ENEMY  2

/* TMS9918 fixed sprite palette: 15=white, 10=yellow, 9=red(ish) */
#define COL_SHIP   15
#define COL_BULLET 10
#define COL_ENEMY  9

typedef struct { uint8_t x, y, alive; } Obj;

static Obj      player;
static Obj      bullets[MAX_BULLETS];
static Obj      enemies[MAX_ENEMIES];
static uint16_t score;
static uint8_t  spawn_timer;
static uint16_t rng;
static uint8_t  blip;

static uint8_t next_rand(void) {
    rng ^= (uint16_t)(rng << 7);
    rng ^= (uint16_t)(rng >> 9);
    rng ^= (uint16_t)(rng << 8);
    return (uint8_t)(rng & 0xFF);
}

/* upload the glyph patterns into ALL THREE screen-2 pattern thirds */
static void load_font(void) {
    uint8_t third, i;
    uint16_t patbase, colbase;
    for (third = 0; third < 3; third++) {
        patbase = (uint16_t)(VRAM_PATTERN + ((uint16_t)third << 11));
        colbase = (uint16_t)(VRAM_COLOR   + ((uint16_t)third << 11));
        for (i = 0; i < 20; i++) {
            uint8_t col = COL_TEXT;
            if (i == T_DEEP) col = COL_DEEP;
            else if (i == T_BAND) col = COL_BAND;
            else if (i == T_STAR1) col = COL_STAR1;
            else if (i == T_STAR2) col = COL_STAR2;
            msx_vram_write((uint16_t)(patbase + ((uint16_t)i << 3)), font[i], 8);
            msx_fill_vram((uint16_t)(colbase + ((uint16_t)i << 3)), 8, col);
        }
    }
}

static void put_tile(uint8_t col, uint8_t row, uint8_t tile) {
    msx_vram_write((uint16_t)(VRAM_NAME + (uint16_t)row * 32 + col), &tile, 1);
}

/* paint a banded starfield across the WHOLE 32x24 name table: alternating
 * 3-row bands of deep/medium blue (so neither colour dominates) with a sparse
 * scattering of white stars. Row 0 stays blank for the SCORE line. */
static void draw_starfield(void) {
    uint8_t row, col, band, tile, h;
    msx_fill_vram(VRAM_NAME, 32, T_SPACE);   /* blank row 0 (HUD) */
    for (row = 1; row < 24; row++) {
        band = (uint8_t)(((row / 3) & 1));   /* alternate every 3 rows */
        for (col = 0; col < 32; col++) {
            h = (uint8_t)((row * 7 + col * 5) & 15);
            if (h == 0) tile = band ? T_STAR2 : T_STAR1;  /* a star */
            else tile = band ? T_BAND : T_DEEP;           /* solid band */
            put_tile(col, row, tile);
        }
    }
}

static void draw_label(void) {
    put_tile(1, 0, T_S); put_tile(2, 0, T_C); put_tile(3, 0, T_O);
    put_tile(4, 0, T_R); put_tile(5, 0, T_E);
}

static void draw_score(void) {
    uint16_t s = score;
    put_tile(7, 0, (uint8_t)(T_0 + (s / 100) % 10));
    put_tile(8, 0, (uint8_t)(T_0 + (s / 10) % 10));
    put_tile(9, 0, (uint8_t)(T_0 + s % 10));
}

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
            msx_psg_tone(0, 0x100, 12);
            blip = 4;
            return;
        }
    }
}

static void spawn(void) {
    uint8_t i;
    for (i = 0; i < MAX_ENEMIES; i++) {
        if (!enemies[i].alive) {
            enemies[i].x = (uint8_t)(8 + (next_rand() % 232));
            enemies[i].y = 16;
            enemies[i].alive = 1;
            return;
        }
    }
}

void main(void) {
    uint8_t i, j, dir, trig, prev_trig;

    msx_set_screen2();
    msx_clear_sprites();
    load_font();
    draw_starfield();
    draw_label();

    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_SHIP   * 8), spr_ship,   8);
    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_BULLET * 8), spr_bullet, 8);
    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_ENEMY  * 8), spr_enemy,  8);

    player.x = 120; player.y = 160; player.alive = 1;
    for (i = 0; i < MAX_BULLETS; i++) bullets[i].alive = 0;
    for (i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = 0;
    score = 0;
    spawn_timer = 0;
    rng = 0xACE1;
    blip = 0;
    prev_trig = 0;
    draw_score();

    for (;;) {
        vsync();
        msx_music_tick();

        dir = msx_read_joystick(1);
        if (dir == STICK_CENTER) dir = msx_read_joystick(0);
        trig = (uint8_t)(gttrig(1) || gttrig(2));

        if ((dir == STICK_LEFT || dir == STICK_UL || dir == STICK_DL)
            && player.x > 4) player.x = (uint8_t)(player.x - 2);
        if ((dir == STICK_RIGHT || dir == STICK_UR || dir == STICK_DR)
            && player.x < 248) player.x = (uint8_t)(player.x + 2);
        if ((dir == STICK_UP || dir == STICK_UL || dir == STICK_UR)
            && player.y > 16) player.y = (uint8_t)(player.y - 2);
        if ((dir == STICK_DOWN || dir == STICK_DL || dir == STICK_DR)
            && player.y < 168) player.y = (uint8_t)(player.y + 2);

        if (trig && !prev_trig) fire();
        prev_trig = trig;

        /* advance bullets */
        for (i = 0; i < MAX_BULLETS; i++) {
            if (!bullets[i].alive) continue;
            if (bullets[i].y < 18) { bullets[i].alive = 0; continue; }
            bullets[i].y = (uint8_t)(bullets[i].y - 4);
        }
        /* advance enemies */
        for (i = 0; i < MAX_ENEMIES; i++) {
            if (!enemies[i].alive) continue;
            enemies[i].y = (uint8_t)(enemies[i].y + 1);
            if (enemies[i].y >= 184) enemies[i].alive = 0;
        }
        spawn_timer = (uint8_t)(spawn_timer + 1);
        if (spawn_timer >= 28) { spawn_timer = 0; spawn(); }

        /* bullet vs enemy */
        for (i = 0; i < MAX_BULLETS; i++) {
            if (!bullets[i].alive) continue;
            for (j = 0; j < MAX_ENEMIES; j++) {
                if (!enemies[j].alive) continue;
                if (aabb(&bullets[i], &enemies[j])) {
                    bullets[i].alive = 0;
                    enemies[j].alive = 0;
                    if (score < 999) { score++; draw_score(); }
                    msx_psg_tone(1, 0x400, 14);
                    blip = 6;
                    break;
                }
            }
        }

        if (blip) { blip--; if (!blip) { msx_psg_off(0); msx_psg_off(1); } }

        /* push sprites */
        msx_set_sprite(0, player.x, player.y, PAT_SHIP, COL_SHIP);
        for (i = 0; i < MAX_BULLETS; i++)
            msx_set_sprite((uint8_t)(1 + i), bullets[i].x,
                           bullets[i].alive ? bullets[i].y : SPRITE_END_Y,
                           PAT_BULLET, COL_BULLET);
        for (i = 0; i < MAX_ENEMIES; i++)
            msx_set_sprite((uint8_t)(5 + i), enemies[i].x,
                           enemies[i].alive ? enemies[i].y : SPRITE_END_Y,
                           PAT_ENEMY, COL_ENEMY);
    }
}
