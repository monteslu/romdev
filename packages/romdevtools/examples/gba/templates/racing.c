/* ── racing.c — Game Boy Advance Tonc top-down racing scaffold ──────
 *
 * Endless top-down lane racer. Player car at the bottom of the screen,
 * three lanes, obstacles spawn from the top and slide down. Left/Right
 * D-pad switches lanes. Survive as long as possible — score is the
 * frame count since the last collision.
 *
 * Game state:
 *   - Player car (1 sprite) at fixed Y, X = lane_x[lane]
 *   - 4 obstacle cars (object pool), spawning from a random lane
 *   - Speed grows slightly with score
 *   - On collision: 60-frame freeze then run resets
 */

#include <tonc.h>
#include "gba_sfx.h"

/* draw a 5-digit score WITHOUT tte_printf (broken in this libtonc — GBA-1). */
static void draw_score(int x, unsigned v) {
    char buf[24];
    int i, n = 0;
    buf[n++]='#'; buf[n++]='{'; buf[n++]='P'; buf[n++]=':';
    if (x >= 100) buf[n++] = '0' + (x/100)%10;
    if (x >= 10)  buf[n++] = '0' + (x/10)%10;
    buf[n++] = '0' + x%10;
    buf[n++]=','; buf[n++]='8'; buf[n++]='}';
    for (i = 4; i >= 0; i--) { buf[n+i] = '0' + (v % 10); v /= 10; }
    n += 5; buf[n] = 0;
    tte_write(buf);
}

#define LANE_LEFT_X    56
#define LANE_MID_X    116
#define LANE_RIGHT_X  176
#define PLAYER_Y      140
#define MAX_OBSTACLES   4

#define TILE_CAR_P1 1
#define TILE_CAR_EN 2

static const u32 tile_car_p1[8] = {
    0x01111110, 0x11111111, 0x12222221, 0x11111111,
    0x11111111, 0x12222221, 0x11111111, 0x01100110,
};
static const u32 tile_car_enemy[8] = {
    0x03333330, 0x33333333, 0x34444443, 0x33333333,
    0x33333333, 0x34444443, 0x33333333, 0x03300330,
};

/* ── Road backdrop tiles (4bpp) ──────────────────────────────────────
 * Fill the whole BG0 with a road scene instead of a flat black screen:
 *   tile 4 = grass roadside (palette index 5, with darker tufts 6)
 *   tile 5 = asphalt road   (palette index 7)
 *   tile 6 = asphalt + a centred white lane dash (index 8)
 *   tile 7 = road edge line (white index 8 down the left column) */
static const u32 tile_grass[8] = {
    0x55555555, 0x55655555, 0x55555555, 0x55556555,
    0x55555555, 0x65555555, 0x55555555, 0x55555655,
};
static const u32 tile_road[8] = {
    0x77777777, 0x77777777, 0x77777777, 0x77777777,
    0x77777777, 0x77777777, 0x77777777, 0x77777777,
};
static const u32 tile_road_dash[8] = {
    0x77877877, 0x77877877, 0x77877877, 0x77877877,
    0x77777777, 0x77777777, 0x77777777, 0x77777777,
};
static const u32 tile_road_edge[8] = {
    0x87777778, 0x87777778, 0x87777778, 0x87777778,
    0x87777778, 0x87777778, 0x87777778, 0x87777778,
};

typedef struct { s16 x, y; u16 alive; } Car;

static OBJ_ATTR obj_buffer[128];

static Car player;
static Car obstacles[MAX_OBSTACLES];
static u16 score;
static u16 spawn_timer;
static u16 game_over_timer;
static u16 prev_keys;
static u8  player_lane;

static const s16 lane_x[3] = { LANE_LEFT_X, LANE_MID_X, LANE_RIGHT_X };

static int aabb(const Car *a, const Car *b) {
    return a->x < b->x + 8 && a->x + 8 > b->x
        && a->y < b->y + 8 && a->y + 8 > b->y;
}

static void reset_run(void) {
    player_lane = 1;
    player.x = lane_x[1];
    player.y = PLAYER_Y;
    player.alive = 1;
    for (int i = 0; i < MAX_OBSTACLES; i++) obstacles[i].alive = 0;
    score = 0;
    spawn_timer = 0;
    game_over_timer = 0;
}

/* Galois LFSR (taps $B8), period 255 -- real per-spawn randomness.
 * The old code derived the spawn column from spawn_timer, but the caller
 * resets spawn_timer just before calling here, so it was CONSTANT and
 * every enemy spawned in the same left column/lane. */
static u8 rng_state = 0xA5;
static u8 rand8(void) {
  u8 lsb = (u8)(rng_state & 1);
  rng_state >>= 1;
  if (lsb) rng_state ^= 0xB8;
  return rng_state;
}

static void spawn_obstacle(void) {
    for (int i = 0; i < MAX_OBSTACLES; i++) {
        if (!obstacles[i].alive) {
            obstacles[i].x = lane_x[rand8() % 3];
            obstacles[i].y = -8;
            obstacles[i].alive = 1;
            return;
        }
    }
}

int main(void) {
    /* Sprite palettes. Bank 0 for player (white+grey), bank 1 for enemy
     * (red+dark grey). Index 0 is always transparent. */
    pal_obj_bank[0][1] = CLR_WHITE;
    pal_obj_bank[0][2] = RGB15(20, 20, 20);
    pal_obj_bank[1][3] = CLR_RED;
    pal_obj_bank[1][4] = RGB15(12, 12, 12);

    /* Sprite tiles — OBJ char base 4. */
    tonccpy(&tile_mem[4][TILE_CAR_P1], tile_car_p1,    sizeof(tile_car_p1));
    tonccpy(&tile_mem[4][TILE_CAR_EN], tile_car_enemy, sizeof(tile_car_enemy));

    /* ── Road backdrop on BG0 ────────────────────────────────────────
     * Paint a full-screen road scene (grass shoulders + asphalt + lane
     * dashes) so the track doesn't read as a blank black screen. BG
     * palette: 5 grass / 6 grass-tuft / 7 asphalt / 8 white lines. Tile
     * data → char-block 0, map → screen-block 28 (clear of TTE on
     * char-block 2 / screen-block 30). BG0 is lowest priority so the
     * cars draw in front. The 240-px screen is 30 tiles wide; the road
     * occupies columns 5..24 with grass on either shoulder. */
    pal_bg_mem[0]  = CLR_BLACK;
    pal_bg_mem[5]  = RGB15(4, 16, 5);   /* grass            */
    pal_bg_mem[6]  = RGB15(2, 11, 3);   /* darker grass tuft*/
    pal_bg_mem[7]  = RGB15(7, 7, 8);    /* asphalt          */
    pal_bg_mem[8]  = CLR_WHITE;         /* lane / edge lines*/
    tonccpy(&tile_mem[0][4], tile_grass,     sizeof(tile_grass));
    tonccpy(&tile_mem[0][5], tile_road,      sizeof(tile_road));
    tonccpy(&tile_mem[0][6], tile_road_dash, sizeof(tile_road_dash));
    tonccpy(&tile_mem[0][7], tile_road_edge, sizeof(tile_road_edge));
    REG_BG0CNT = BG_CBB(0) | BG_SBB(28) | BG_REG_32x32 | BG_4BPP | BG_PRIO(3);
    {
        SCR_ENTRY *map = se_mem[28];
        for (int ty = 0; ty < 32; ty++) {
            for (int tx = 0; tx < 32; tx++) {
                int tile;
                if (tx < 5 || tx > 24) {
                    tile = 4;                       /* grass shoulder      */
                } else if (tx == 5 || tx == 24) {
                    tile = 7;                       /* white road edge     */
                } else if ((tx == 11 || tx == 18) && (ty & 1)) {
                    tile = 6;                       /* dashed lane divider */
                } else {
                    tile = 5;                       /* plain asphalt       */
                }
                map[ty * 32 + tx] = SE_BUILD(tile, 0, 0, 0);
            }
        }
    }

    oam_init(obj_buffer, 128);

    /* IRQ setup — required for VBlankIntrWait() to function. */
    irq_init(NULL);
    irq_add(II_VBLANK, NULL);

    sfx_init();

    /* TTE for score + hint on BG1 (BG0 holds the road). char-block 2 /
     * screen-block 30; priority 0 → text in front of everything. */
    tte_init_chr4c_default(1, BG_CBB(2) | BG_SBB(30));
    REG_BG1CNT |= BG_PRIO(0);
    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0 | DCNT_BG1 | DCNT_OBJ | DCNT_OBJ_1D;
    tte_write("#{P:160,8}SCORE 00000");
    tte_write("#{P:64,150}L/R MOVES LANE");

    reset_run();
    prev_keys = 0;

    while (1) {
        VBlankIntrWait();
        key_poll();

        if (game_over_timer > 0) {
            game_over_timer--;
            if (game_over_timer == 60) {
                tte_write("#{P:72,80}CRASH! TRY AGAIN");
            }
            if (game_over_timer == 0) {
                tte_erase_rect(72, 80, 240, 96);
                reset_run();
            }
        } else {
            u16 now = key_curr_state();
            if ((now & KEY_LEFT)  && !(prev_keys & KEY_LEFT)  && player_lane > 0) {
                player_lane--;
                sfx_tone(2, 1300, 2);   /* lane switch */
            }
            if ((now & KEY_RIGHT) && !(prev_keys & KEY_RIGHT) && player_lane < 2) {
                player_lane++;
                sfx_tone(2, 1300, 2);
            }
            player.x = lane_x[player_lane];
            prev_keys = now;

            /* Obstacle speed grows slowly with score. */
            s16 step = 2 + (s16)(score / 500);
            if (step > 4) step = 4;

            for (int i = 0; i < MAX_OBSTACLES; i++) {
                if (!obstacles[i].alive) continue;
                obstacles[i].y += step;
                if (obstacles[i].y > 160) obstacles[i].alive = 0;
            }

            if (++spawn_timer >= 32) { spawn_timer = 0; spawn_obstacle(); }

            for (int i = 0; i < MAX_OBSTACLES; i++) {
                if (obstacles[i].alive && aabb(&player, &obstacles[i])) {
                    game_over_timer = 60;
                    sfx_noise(30);          /* crash */
                    break;
                }
            }

            if (score < 65500u) score++;
        }

        /* Sprite slots: 0 = player, 1..4 = obstacles. */
        obj_set_attr(&obj_buffer[0],
            ATTR0_SQUARE,
            ATTR1_SIZE_8,
            ATTR2_PALBANK(0) | TILE_CAR_P1);
        obj_set_pos(&obj_buffer[0], player.x, player.y);
        for (int i = 0; i < MAX_OBSTACLES; i++) {
            s16 ey = obstacles[i].alive ? obstacles[i].y : 200;
            obj_set_attr(&obj_buffer[1 + i],
                ATTR0_SQUARE,
                ATTR1_SIZE_8,
                ATTR2_PALBANK(1) | TILE_CAR_EN);
            obj_set_pos(&obj_buffer[1 + i], obstacles[i].x, ey);
        }
        oam_copy(oam_mem, obj_buffer, 1 + MAX_OBSTACLES);

        tte_erase_rect(160 + 6*8, 8, 160 + 11*8, 16);
        draw_score(160 + 6*8, score);
    }
    return 0;
}
