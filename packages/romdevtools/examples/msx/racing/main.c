/* ── racing/main.c — MSX top-down 3-lane racing scaffold (screen 2) ──
 *
 * Mirrors the SMS/GB/etc racing scaffolds, translated to the MSX VDP via
 * the romdev helper lib (msx_hw.h + msx_vdp.c).
 *
 * Endless 3-lane top-down racer. Grey road down the centre lanes + green
 * grass shoulders fill the whole 32x24 screen-2 name table. The player car
 * sits near the bottom; obstacle cars (object pool) spawn at the top and
 * slide down. Speed grows with score; an AABB crash triggers a ~60-frame
 * freeze then auto-reset. SCORE is drawn as on-screen tiles.
 *
 * Controls: joystick PORT 1 LEFT/RIGHT (edge-detected) switches lanes.
 *
 * Cartridge rule: INIT must never return — main() ends in for(;;).
 */
#include "msx_hw.h"

/* ── interrupt-free vblank sync (poll VDP status S#0 bit 7) ────────────── */
__sfr __at 0x99 VDPSTATUS;
static void vsync(void) {
    (void)VDPSTATUS;
    while (!(VDPSTATUS & 0x80)) {
    }
}

#define LANE_LEFT_X    96
#define LANE_MID_X    124
#define LANE_RIGHT_X  152
#define PLAYER_Y      160
#define MAX_OBSTACLES   4

/* ── tile font (digits + S C O R E) + track tiles ─────────────────────── */
#define T_SPACE 0
#define T_S     1
#define T_C     2
#define T_O     3
#define T_R     4
#define T_E     5
#define T_0     6
#define T_GRASS 16
#define T_ROAD  17
#define T_LANE  18   /* dashed lane marker */

static const uint8_t font[19][8] = {
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
    /* 16 GRASS */ {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF},
    /* 17 ROAD  */ {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF},
    /* 18 LANE  */ {0x18,0x18,0x18,0x00,0x00,0x18,0x18,0x18}
};

/* colour bytes. 3=green(dark), 12=green(light), 14=grey, 15=white, 1=black */
#define COL_TEXT  0xF1   /* white text on black              */
#define COL_GRASS 0xC1   /* light green grass on black       */
#define COL_ROAD  0xE1   /* grey road on black               */
#define COL_LANE  0xAE   /* yellow dashes on grey road       */

/* sprite patterns (8x8): player car + enemy car */
static const uint8_t spr_player[8] = {0x18,0x3C,0x24,0x3C,0x7E,0x24,0x7E,0x66};
static const uint8_t spr_enemy[8]  = {0x66,0x7E,0x24,0x7E,0x3C,0x24,0x3C,0x18};
#define PAT_PLAYER 0
#define PAT_ENEMY  1
#define COL_PLAYER 15   /* white  */
#define COL_ENEMY  9    /* red    */

typedef struct { uint8_t x, y, alive; } Car;

static Car      player;
static Car      obstacles[MAX_OBSTACLES];
static uint16_t score;
static uint8_t  spawn_timer;
static uint8_t  game_over_timer;
static uint8_t  player_lane;
static uint16_t rng;
static uint8_t  blip;

static const uint8_t lane_x[3] = { LANE_LEFT_X, LANE_MID_X, LANE_RIGHT_X };

static uint8_t next_rand(void) {
    rng ^= (uint16_t)(rng << 7);
    rng ^= (uint16_t)(rng >> 9);
    rng ^= (uint16_t)(rng << 8);
    return (uint8_t)(rng & 0xFF);
}

static uint8_t aabb(Car *a, Car *b) {
    return a->x < b->x + 8 && a->x + 8 > b->x
        && a->y < b->y + 8 && a->y + 8 > b->y;
}

static void load_tiles(void) {
    uint8_t third, i;
    uint16_t pat, col;
    for (third = 0; third < 3; third++) {
        pat = (uint16_t)(VRAM_PATTERN + ((uint16_t)third << 11));
        col = (uint16_t)(VRAM_COLOR   + ((uint16_t)third << 11));
        for (i = 0; i < 19; i++) {
            uint8_t cc = COL_TEXT;
            if (i == T_GRASS) cc = COL_GRASS;
            else if (i == T_ROAD) cc = COL_ROAD;
            else if (i == T_LANE) cc = COL_LANE;
            msx_vram_write((uint16_t)(pat + ((uint16_t)i << 3)), font[i], 8);
            msx_fill_vram((uint16_t)(col + ((uint16_t)i << 3)), 8, cc);
        }
    }
}

static void put_tile(uint8_t col, uint8_t row, uint8_t tile) {
    msx_vram_write((uint16_t)(VRAM_NAME + (uint16_t)row * 32 + col), &tile, 1);
}

/* road spans cols ~11..20 (player X 96..152); grass elsewhere; dashed lane
 * markers between the three lanes (cols 14 and 17) on alternating rows. */
static void draw_track(void) {
    uint8_t row, col, t;
    for (row = 0; row < 24; row++) {
        for (col = 0; col < 32; col++) {
            t = (col >= 11 && col <= 20) ? T_ROAD : T_GRASS;
            if ((col == 14 || col == 17) && (row & 1)) t = T_LANE;
            put_tile(col, row, t);
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

static void reset_run(void) {
    uint8_t i;
    player_lane = 1;
    player.x = lane_x[1];
    player.y = PLAYER_Y;
    player.alive = 1;
    for (i = 0; i < MAX_OBSTACLES; i++) obstacles[i].alive = 0;
    score = 0;
    spawn_timer = 0;
    game_over_timer = 0;
    draw_score();
}

static void spawn_obstacle(void) {
    uint8_t i;
    for (i = 0; i < MAX_OBSTACLES; i++) {
        if (!obstacles[i].alive) {
            obstacles[i].x = lane_x[next_rand() % 3];
            obstacles[i].y = 16;
            obstacles[i].alive = 1;
            return;
        }
    }
}

void main(void) {
    uint8_t i, slot, dir, prev_dir;
    int16_t step;

    msx_set_screen2();
    msx_clear_sprites();
    load_tiles();
    draw_track();
    draw_label();

    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_PLAYER * 8), spr_player, 8);
    msx_vram_write((uint16_t)(VRAM_SPRPAT + PAT_ENEMY  * 8), spr_enemy,  8);

    rng = 0xACE1;
    blip = 0;
    prev_dir = 0;
    reset_run();

    for (;;) {
        vsync();

        /* push sprites */
        slot = 0;
        msx_set_sprite(slot++, player.x, player.y, PAT_PLAYER, COL_PLAYER);
        for (i = 0; i < MAX_OBSTACLES; i++)
            msx_set_sprite(slot++, obstacles[i].x,
                           obstacles[i].alive ? obstacles[i].y : SPRITE_END_Y,
                           PAT_ENEMY, COL_ENEMY);

        dir = msx_read_joystick(1);
        if (dir == STICK_CENTER) dir = msx_read_joystick(0);

        if (game_over_timer > 0) {
            game_over_timer--;
            if (game_over_timer == 0) reset_run();
            prev_dir = dir;
            if (blip) { blip--; if (!blip) msx_psg_off(0); }
            continue;
        }

        if ((dir == STICK_LEFT || dir == STICK_UL || dir == STICK_DL)
            && !(prev_dir == STICK_LEFT || prev_dir == STICK_UL || prev_dir == STICK_DL)
            && player_lane > 0) { player_lane--; msx_psg_tone(1, 0x280, 6); blip = 3; }
        if ((dir == STICK_RIGHT || dir == STICK_UR || dir == STICK_DR)
            && !(prev_dir == STICK_RIGHT || prev_dir == STICK_UR || prev_dir == STICK_DR)
            && player_lane < 2) { player_lane++; msx_psg_tone(1, 0x280, 6); blip = 3; }
        player.x = lane_x[player_lane];
        prev_dir = dir;

        step = (int16_t)(2 + (score / 200));
        if (step > 4) step = 4;

        for (i = 0; i < MAX_OBSTACLES; i++) {
            if (!obstacles[i].alive) continue;
            obstacles[i].y = (uint8_t)(obstacles[i].y + step);
            if (obstacles[i].y >= 184) obstacles[i].alive = 0;
        }

        spawn_timer = (uint8_t)(spawn_timer + 1);
        if (spawn_timer >= 36) { spawn_timer = 0; spawn_obstacle(); }

        for (i = 0; i < MAX_OBSTACLES; i++) {
            if (obstacles[i].alive && aabb(&player, &obstacles[i])) {
                game_over_timer = 60;
                msx_psg_tone(0, 0x600, 15); blip = 12;
                break;
            }
        }

        if (score < 999) { score++; draw_score(); }

        if (blip) { blip--; if (!blip) { msx_psg_off(0); msx_psg_off(1); } }
    }
}
