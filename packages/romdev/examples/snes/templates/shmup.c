/* ── shmup.c — SNES PVSnesLib vertical-shooter scaffold ─────────────
 *
 * Complete runnable vertical-shmup baseline. Layout mirrors the NES
 * and Genesis shmup scaffolds:
 *   - Player ship (8×8 OAM 0), d-pad moves, B fires
 *   - 6 bullet slots (OAM 1..6), 6 enemy slots (OAM 7..12)
 *   - Wave spawner: one enemy from the top every ~28 frames
 *   - Linear movement, AABB collision (8×8 vs 8×8)
 *
 * SNES screen is 256×224 (NTSC). All movement / spawn coords use
 * that range. PVSnesLib's oamSet places OAM entries; oamUpdate
 * flushes them via DMA on the NMI.
 *
 * Sibling data.asm provides the font + sprite-tile + sprite-palette
 * blobs. We use tile index 0 (ship), 1 (bullet), 2 (enemy).
 *
 * ⚠ TWO PVSnesLib footguns this scaffold handles for you:
 *  1. oamSet's FIRST arg is a BYTE OFFSET into OAM, not a slot number.
 *     Each sprite is 4 bytes, so sprite slot N lives at offset N*4.
 *     Passing a plain slot number interleaves/corrupts entries. We use
 *     the SPR(slot) macro below — always address sprites through it.
 *  2. sfx_init() must run AFTER setScreenOn() and its return must be
 *     checked. If it stalls before the screen is on, you get a black
 *     screen forever. See the main() ordering below.
 */

#include <snes.h>
/* Single .c file in buildSnesC, so the sound wrapper is #include'd
 * inline rather than linked separately. */
#include "snes_sfx.c"

extern char tilfont, palfont;
extern char tilsprite, palsprite;

/* OAM is addressed by BYTE OFFSET; sprite slot N = offset N*4. */
#define SPR(slot) ((slot) << 2)

#define MAX_BULLETS 6
#define MAX_ENEMIES 6

typedef struct { s16 x, y; u8 alive; } Obj;

static Obj player;
static Obj bullets[MAX_BULLETS];
static Obj enemies[MAX_ENEMIES];
static u16 score;
static u16 spawn_timer;

static u8 aabb(Obj* a, Obj* b) {
    return a->x < b->x + 8 && a->x + 8 > b->x
        && a->y < b->y + 8 && a->y + 8 > b->y;
}

static void render_score(void) {
    char buf[8];
    u16 v;
    s8 i;
    buf[0]='0'; buf[1]='0'; buf[2]='0'; buf[3]='0'; buf[4]='0'; buf[5]=0;
    v = score;
    for (i = 4; i >= 0; i--) { buf[i] = '0' + (v % 10); v /= 10; }
    consoleDrawText(20, 1, buf);
}

static void fire(void) {
    u16 i;
    for (i = 0; i < MAX_BULLETS; i++) {
        if (!bullets[i].alive) {
            bullets[i].x = player.x;
            bullets[i].y = player.y - 8;
            bullets[i].alive = 1;
            return;
        }
    }
}

static void spawn(void) {
    u16 i;
    for (i = 0; i < MAX_ENEMIES; i++) {
        if (!enemies[i].alive) {
            enemies[i].x = ((spawn_timer * 37) & 0xFF) % (256 - 16) + 4;
            enemies[i].y = 0;
            enemies[i].alive = 1;
            return;
        }
    }
}

int main(void) {
    u16 i, j, pad;
    u16 prev = 0;
    u16 by, ey;

    dmaClearVram();

    consoleSetTextMapPtr(0x6800);
    consoleSetTextGfxPtr(0x3000);
    consoleSetTextOffset(0x0100);
    consoleInitText(0, 16 * 2, &tilfont, &palfont);
    setMode(BG_MODE1, 0);
    bgSetDisable(1);
    bgSetDisable(2);
    /* NOTE: the text BG (BG0) currently shows a garbage font (stub font in
     * data.asm — see the ⚠ there). The game plays correctly; the HUD text
     * is unreadable until a real pvsneslibfont .pic is dropped in. */

    /* 3 sprite tiles (ship/bullet/enemy) × 32 bytes = 96 bytes. */
    oamInitGfxSet(&tilsprite, 96, &palsprite, 32, 0,
                  0x0000, OBJ_SIZE8_L16);

    player.x = 120; player.y = 180; player.alive = 1;
    for (i = 0; i < MAX_BULLETS; i++) bullets[i].alive = 0;
    for (i = 0; i < MAX_ENEMIES; i++) enemies[i].alive = 0;
    score = 0;
    spawn_timer = 0;

    consoleDrawText(14, 1, "SCORE");
    consoleDrawText(2, 26, "D-PAD MOVE B FIRE");

    /* Pre-stage all 13 OAM slots — hidden initially (SPR() = slot*4). */
    for (i = 0; i < 13; i++) oamSet(SPR(i), 0, 240, 3, 0, 0, 0, 0);

    /* Screen ON first, THEN sound. If the SPC wedges, sfx_init returns
     * nonzero and we keep running silently — never a black screen. */
    setScreenOn();
    sfx_init();

    while (1) {
        pad = padsCurrent(0);

        if (pad & KEY_LEFT  && player.x > 8)       player.x -= 2;
        if (pad & KEY_RIGHT && player.x < 256 - 16) player.x += 2;
        if (pad & KEY_UP    && player.y > 16)      player.y -= 2;
        if (pad & KEY_DOWN  && player.y < 224 - 16) player.y += 2;
        if ((pad & KEY_B) && !(prev & KEY_B)) { fire(); sfx_play(1); }
        prev = pad;

        for (i = 0; i < MAX_BULLETS; i++) {
            if (!bullets[i].alive) continue;
            bullets[i].y -= 4;
            if (bullets[i].y < 0 || bullets[i].y > 230) bullets[i].alive = 0;
        }
        for (i = 0; i < MAX_ENEMIES; i++) {
            if (!enemies[i].alive) continue;
            enemies[i].y += 1;
            if (enemies[i].y >= 224) enemies[i].alive = 0;
        }
        if (++spawn_timer >= 28) { spawn_timer = 0; spawn(); }

        for (i = 0; i < MAX_BULLETS; i++) {
            if (!bullets[i].alive) continue;
            for (j = 0; j < MAX_ENEMIES; j++) {
                if (!enemies[j].alive) continue;
                if (aabb(&bullets[i], &enemies[j])) {
                    bullets[i].alive = 0;
                    enemies[j].alive = 0;
                    if (score < 65500) score += 10;
                    sfx_play(2);
                    break;
                }
            }
        }

        /* Stage OAM. Tile index = gfxoffset (32-byte stride). Address
         * each sprite by SPR(slot) — OAM is byte-indexed (slot*4). */
        oamSet(SPR(0), player.x, player.y, 3, 0, 0, 0,  0);
        for (i = 0; i < MAX_BULLETS; i++) {
            by = bullets[i].alive ? bullets[i].y : 240;
            oamSet(SPR(1 + i), bullets[i].x, by, 3, 0, 0, 32, 0);
        }
        for (i = 0; i < MAX_ENEMIES; i++) {
            ey = enemies[i].alive ? enemies[i].y : 240;
            oamSet(SPR(7 + i), enemies[i].x, ey, 3, 0, 0, 64, 0);
        }
        oamUpdate();

        render_score();
        WaitForVBlank();
    }
    return 0;
}
