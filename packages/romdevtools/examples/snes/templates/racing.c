/* ── racing.c — SNES PVSnesLib top-down racing scaffold ────────────
 *
 * Endless 3-lane top-down racer for SNES. LEFT/RIGHT switches lanes
 * (edge-detected), obstacles slide down at speed that grows with
 * score. Collision triggers a 60-frame game-over freeze + auto-reset.
 *
 * tcc-65816 is C89 — declarations at block top.
 */

#include <snes.h>
#include "snes_sfx.c"

extern char tilfont, palfont;
extern char tilsprite, palsprite;

#define LANE_LEFT_X    72
#define LANE_MID_X    124
#define LANE_RIGHT_X  176
#define PLAYER_Y      180
#define MAX_OBSTACLES   4

/* oamSet's FIRST arg is a BYTE OFFSET into OAM (slot N → N*4), not a slot
 * number — passing the raw slot corrupts OAM → black/garbled (SNES-1). */
#define SPR(slot) ((slot) << 2)

typedef struct { s16 x, y; u8 alive; } Car;

static Car player;
static Car obstacles[MAX_OBSTACLES];
static u16 score;
static u8  spawn_timer;
static u8  game_over_timer;
static u16 prev_pad;
static u8  player_lane;

static const s16 lane_x[3] = { LANE_LEFT_X, LANE_MID_X, LANE_RIGHT_X };

static u8 aabb(Car *a, Car *b) {
    return a->x < b->x + 8 && a->x + 8 > b->x
        && a->y < b->y + 8 && a->y + 8 > b->y;
}

static void reset_run(void) {
    u8 i;
    player_lane = 1;
    player.x = lane_x[1];
    player.y = PLAYER_Y;
    player.alive = 1;
    for (i = 0; i < MAX_OBSTACLES; i++) obstacles[i].alive = 0;
    score = 0;
    spawn_timer = 0;
    game_over_timer = 0;
}

static void spawn_obstacle(void) {
    u8 i;
    for (i = 0; i < MAX_OBSTACLES; i++) {
        if (!obstacles[i].alive) {
            obstacles[i].x = lane_x[(spawn_timer * 13) % 3];
            obstacles[i].y = 0;
            obstacles[i].alive = 1;
            return;
        }
    }
}

static void render_score(void) {
    char buf[6];
    u16 v;
    s8 i;
    buf[0]='0'; buf[1]='0'; buf[2]='0'; buf[3]='0'; buf[4]='0'; buf[5]=0;
    v = score;
    for (i = 4; i >= 0; i--) { buf[i] = '0' + (v % 10); v /= 10; }
    consoleDrawText(22, 2, buf);
}

int main(void) {
    u16 pad;
    u8 i;
    s16 step;

    consoleSetTextMapPtr(0x6800);
    consoleSetTextGfxPtr(0x3000);
    consoleSetTextOffset(0x0100);
    consoleInitText(0, 16 * 2, &tilfont, &palfont);
    setMode(BG_MODE1, 0);
    bgSetDisable(1);
    bgSetDisable(2);

    /* 2 sprite tiles × 32 bytes = 64 bytes */
    oamInitGfxSet(&tilsprite, 64, &palsprite, 32, 0, 0x0000, OBJ_SIZE8_L16);

    consoleDrawText(2, 2, "SCORE");
    consoleDrawText(6, 26, "L/R SWITCH LANES");

    /* Hide all OAM. */
    for (i = 0; i < 1 + MAX_OBSTACLES; i++) oamSet(SPR(i), 0, 240, 3, 0, 0, 0, 0);

    setScreenOn();
    sfx_init();
    reset_run();
    prev_pad = 0;

    while (1) {
        /* Stage OAM. */
        oamSet(SPR(0), player.x, player.y, 3, 0, 0, 0, 0);
        for (i = 0; i < MAX_OBSTACLES; i++) {
            u16 ey = obstacles[i].alive ? obstacles[i].y : 240;
            oamSet(SPR((u16)(1 + i)), obstacles[i].x, ey, 3, 0, 0, 1, 0); /* gfxoffset = tile INDEX 1 (SNES-5; was 32) */
        }
        oamUpdate();
        render_score();
        WaitForVBlank();

        pad = padsCurrent(0);

        if (game_over_timer > 0) {
            game_over_timer--;
            if (game_over_timer == 0) reset_run();
            prev_pad = pad;
            continue;
        }

        if ((pad & KEY_LEFT)  && !(prev_pad & KEY_LEFT)  && player_lane > 0) { player_lane--; sfx_play(1); }
        if ((pad & KEY_RIGHT) && !(prev_pad & KEY_RIGHT) && player_lane < 2) { player_lane++; sfx_play(1); }
        player.x = lane_x[player_lane];
        prev_pad = pad;

        step = (s16)(2 + (score / 500));
        if (step > 4) step = 4;

        for (i = 0; i < MAX_OBSTACLES; i++) {
            if (!obstacles[i].alive) continue;
            obstacles[i].y = (s16)(obstacles[i].y + step);
            if (obstacles[i].y >= 224) obstacles[i].alive = 0;
        }
        spawn_timer++;
        if (spawn_timer >= 36) { spawn_timer = 0; spawn_obstacle(); }

        for (i = 0; i < MAX_OBSTACLES; i++) {
            if (obstacles[i].alive && aabb(&player, &obstacles[i])) {
                game_over_timer = 60;
                sfx_play(2);  /* crash */
                break;
            }
        }
        if (score < 65500) score++;
    }
    return 0;
}
