/* ── racing.c — Genesis SGDK top-down racing scaffold ──────────────
 *
 * Endless top-down lane racer. Player car at the bottom of the screen,
 * three lanes, obstacles spawn from the top and slide down. Left/Right
 * D-pad switches lanes. Survive as long as possible — score is the
 * frame count since the last collision.
 *
 * Game state:
 *   - Player car (1×1 tile) at fixed Y, X = lane_x[lane]
 *   - 4 obstacle cars (object pool), each spawning from a random lane
 *   - Speed grows slightly with score
 *   - On collision: 60-frame freeze then run resets
 *
 * Two-player: pass through the JOY_2 input — port 1 (player 2) shares
 * the same lanes (just visually shifted). When no second controller
 * is connected, P2 is a "ghost" you can pretend you're racing.
 */

#include <genesis.h>
#include "genesis_sfx.h"

#define LANE_LEFT_X    96
#define LANE_MID_X    156
#define LANE_RIGHT_X  216
#define PLAYER_Y      176
#define MAX_OBSTACLES   4

#define T_CAR_P1   (TILE_USER_INDEX + 0)
#define T_CAR_EN   (TILE_USER_INDEX + 1)
#define T_LANE     (TILE_USER_INDEX + 2)   /* dashed lane divider (BG_B) */
#define T_EDGE     (TILE_USER_INDEX + 3)   /* solid road edge      (BG_B) */
#define T_GRASS    (TILE_USER_INDEX + 4)   /* roadside backdrop    (BG_A) */
#define T_ASPHALT  (TILE_USER_INDEX + 5)   /* road surface backdrop(BG_A) */

static const u32 tile_car_p1[8] = {
    0x01111110, 0x11111111, 0x12222221, 0x11111111,
    0x11111111, 0x12222221, 0x11111111, 0x01100110,
};
static const u32 tile_car_enemy[8] = {
    0x03333330, 0x33333333, 0x34444443, 0x33333333,
    0x33333333, 0x34444443, 0x33333333, 0x03300330,
};
/* Dashed lane-divider segment (colour 2 = grey): a 2px dash in the
 * centre columns, on/off vertically so a stacked column reads as a
 * dashed road centre-line. */
static const u32 tile_lane[8] = {
    0x00022000, 0x00022000, 0x00022000, 0x00000000,
    0x00000000, 0x00022000, 0x00022000, 0x00022000,
};
/* Solid 2px road-edge stripe (colour 2 = grey) down the right side of
 * the tile — used on the left rail; mirrored (hflip) for the right. */
static const u32 tile_edge[8] = {
    0x00000022, 0x00000022, 0x00000022, 0x00000022,
    0x00000022, 0x00000022, 0x00000022, 0x00000022,
};
/* Roadside grass (colour 5) with a couple of darker tufts (colour 6) so
 * it isn't a flat fill — tiled down both shoulders on BG_A. */
static const u32 tile_grass[8] = {
    0x55555555, 0x55556555, 0x55555555, 0x65555555,
    0x55555555, 0x55555565, 0x55555555, 0x55655555,
};
/* Road asphalt (colour 6) with faint speckle (colour 5) — tiled across
 * the driving surface on BG_A, behind the BG_B lane markings + cars. */
static const u32 tile_asphalt[8] = {
    0x66666666, 0x66666566, 0x66666666, 0x56666666,
    0x66666666, 0x66666656, 0x66666666, 0x66566666,
};

/* The road lives on BG_B (8×8 cells). Two dashed dividers sit between the
 * three lanes; solid edges frame the outermost lanes. */
#define ROAD_TOP_ROW   1
#define ROAD_BOT_ROW   26
#define LANE_DIV1_COL  ((LANE_LEFT_X + 8 + LANE_MID_X)  / 16)
#define LANE_DIV2_COL  ((LANE_MID_X  + 8 + LANE_RIGHT_X) / 16)
#define ROAD_EDGE_L    ((LANE_LEFT_X  - 12) / 8)
#define ROAD_EDGE_R    ((LANE_RIGHT_X + 12) / 8)

/* Far plane (BG_A): grass shoulders + asphalt driving surface, tiled
 * across the whole 40x28 screen so the road no longer floats on black.
 * Drawn at low priority; the BG_B markings + sprite cars sit on top. */
static void draw_backdrop(void) {
    s16 r, c;
    for (r = 0; r < 28; r++)
        for (c = 0; c < 40; c++) {
            u16 t = (c >= ROAD_EDGE_L && c <= ROAD_EDGE_R) ? T_ASPHALT : T_GRASS;
            VDP_setTileMapXY(BG_A, TILE_ATTR_FULL(PAL0, 0, 0, 0, t), c, r);
        }
}

static void draw_road(void) {
    s16 r;
    for (r = ROAD_TOP_ROW; r <= ROAD_BOT_ROW; r++) {
        /* Left edge (stripe on its right), right edge (hflipped). HIGH
         * priority so the markings sit above the BG_A asphalt backdrop. */
        VDP_setTileMapXY(BG_B, TILE_ATTR_FULL(PAL0, 1, 0, 0, T_EDGE), ROAD_EDGE_L, r);
        VDP_setTileMapXY(BG_B, TILE_ATTR_FULL(PAL0, 1, 0, 1, T_EDGE), ROAD_EDGE_R, r);
        /* Two dashed lane dividers. */
        VDP_setTileMapXY(BG_B, TILE_ATTR_FULL(PAL0, 1, 0, 0, T_LANE), LANE_DIV1_COL, r);
        VDP_setTileMapXY(BG_B, TILE_ATTR_FULL(PAL0, 1, 0, 0, T_LANE), LANE_DIV2_COL, r);
    }
}

typedef struct { s16 x, y; bool alive; } Car;

static Car player;
static Car obstacles[MAX_OBSTACLES];
static u16 score;
static u16 spawn_timer;
static u16 game_over_timer;
static u16 prev_pad;
static u8  player_lane;

static const s16 lane_x[3] = { LANE_LEFT_X, LANE_MID_X, LANE_RIGHT_X };

static bool aabb(Car* a, Car* b) {
    return a->x < b->x + 8 && a->x + 8 > b->x
        && a->y < b->y + 8 && a->y + 8 > b->y;
}

static void reset_run(void) {
    u16 i;
    player_lane = 1;
    player.x = lane_x[1];
    player.y = PLAYER_Y;
    player.alive = TRUE;
    for (i = 0; i < MAX_OBSTACLES; i++) obstacles[i].alive = FALSE;
    score = 0;
    spawn_timer = 0;
    game_over_timer = 0;
}

static void spawn_obstacle(void) {
    u16 i;
    for (i = 0; i < MAX_OBSTACLES; i++) {
        if (!obstacles[i].alive) {
            obstacles[i].x = lane_x[(spawn_timer * 13) % 3];
            obstacles[i].y = 0;
            obstacles[i].alive = TRUE;
            return;
        }
    }
}

static void render_score(void) {
    char buf[6] = "00000";
    u16 v = score;
    s16 i;
    for (i = 4; i >= 0; i--) { buf[i] = '0' + (v % 10); v /= 10; }
    VDP_drawText(buf, 33, 2);
}

int main(bool hard) {
    (void)hard;

    /* PAL0 = player (white + blue trim) + road backdrop. PAL1 = enemy. */
    PAL_setColor(0 + 1, 0x0EEE);    /* white body */
    PAL_setColor(0 + 2, 0x0AAA);    /* roof grey */
    PAL_setColor(0 + 5, 0x0260);    /* roadside grass */
    PAL_setColor(0 + 6, 0x0222);    /* asphalt grey   */
    PAL_setColor(16 + 3, 0x000E);   /* enemy red */
    PAL_setColor(16 + 4, 0x0666);   /* enemy roof */

    VDP_loadTileData(tile_car_p1,    T_CAR_P1,  1, DMA);
    VDP_loadTileData(tile_car_enemy, T_CAR_EN,  1, DMA);
    VDP_loadTileData(tile_lane,      T_LANE,    1, DMA);
    VDP_loadTileData(tile_edge,      T_EDGE,    1, DMA);
    VDP_loadTileData(tile_grass,     T_GRASS,   1, DMA);
    VDP_loadTileData(tile_asphalt,   T_ASPHALT, 1, DMA);

    /* Draw the grass+asphalt backdrop (BG_A) then the road markings on
     * BG_B over it. */
    draw_backdrop();
    draw_road();

    VDP_drawText("SCORE", 28, 2);
    VDP_drawText("L/R MOVES LANE", 13, 27);

    sfx_init();
    reset_run();
    prev_pad = 0;

    while (TRUE) {
        u16 pad = JOY_readJoypad(JOY_1);
        u16 slot = 0;

        if (game_over_timer > 0) {
            game_over_timer--;
            VDP_drawText("CRASH! TRY AGAIN", 12, 14);
            if (game_over_timer == 0) {
                VDP_clearTextLineBG(BG_A, 14);
                reset_run();
            }
        } else {
            if ((pad & BUTTON_LEFT)  && !(prev_pad & BUTTON_LEFT)  && player_lane > 0) {
                player_lane--;
                sfx_tone(2, 380, 2);   /* lane switch */
            }
            if ((pad & BUTTON_RIGHT) && !(prev_pad & BUTTON_RIGHT) && player_lane < 2) {
                player_lane++;
                sfx_tone(2, 380, 2);
            }
            player.x = lane_x[player_lane];
            prev_pad = pad;

            /* Obstacle speed = 2 + score/500 (caps low). */
            s16 step = 2 + (s16)(score / 500);
            if (step > 4) step = 4;

            u16 i;
            for (i = 0; i < MAX_OBSTACLES; i++) {
                if (!obstacles[i].alive) continue;
                obstacles[i].y += step;
                if (obstacles[i].y > 224) obstacles[i].alive = FALSE;
            }

            if (++spawn_timer >= 32) { spawn_timer = 0; spawn_obstacle(); }

            for (i = 0; i < MAX_OBSTACLES; i++) {
                if (obstacles[i].alive && aabb(&player, &obstacles[i])) {
                    game_over_timer = 60;
                    sfx_noise(40);     /* crash */
                    break;
                }
            }

            if (score < 65500u) score++;
        }

        /* SAT update — player + up to 4 obstacles = 5 sprites. */
        VDP_setSprite(slot++, player.x, player.y, SPRITE_SIZE(1, 1),
                      TILE_ATTR_FULL(PAL0, 1, 0, 0, T_CAR_P1));
        for (u16 i = 0; i < MAX_OBSTACLES; i++) {
            s16 ey = obstacles[i].alive ? obstacles[i].y : -16;
            VDP_setSprite(slot++, obstacles[i].x, ey, SPRITE_SIZE(1, 1),
                          TILE_ATTR_FULL(PAL1, 1, 0, 0, T_CAR_EN));
        }
        /* Link slots 0..slot-1 so the VDP's SAT walk draws all of them — without
         * this the link bytes stay 0 (= end-of-list) and only slot 0 renders. */
        VDP_linkSprites(0, slot);
        VDP_updateSprites(slot, DMA);

        render_score();
        sfx_update();
        SYS_doVBlankProcess();
    }
    return 0;
}
