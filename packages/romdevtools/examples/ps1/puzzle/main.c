/*
 * puzzle/main.c — DROP GRID: a 2D PlayStation falling-block puzzle.
 *
 * The one 2D game in the PS1 set — a grid puzzle is naturally flat, so it's drawn
 * with the GPU's 2D rectangles (no 3D pipeline). Colored blocks fall down a well;
 * steer + drop them; a full row clears and scores. Speed ramps up. Title -> play ->
 * game-over (stack reaches the top). 16.16 not needed — plain integer grid logic.
 *
 * Build: build({ platform:"ps1", language:"c" }). Controls: LEFT/RIGHT move the
 * falling block, DOWN soft-drop, START begin/restart.
 *
 * 2D technique: an integer GRID is the model; render() paints each filled cell as a
 * psx_rect. This is the right tool for a flat board even on a 3D machine.
 */
#include "psx.h"

#define GW 8
#define GH 12
#define CELL 16
#define OX 96    /* board origin on screen */
#define OY 24

enum { TITLE, PLAY, OVER };

static unsigned char grid[GH][GW];   /* 0 empty, else color index 1..4 */
static int fx, fy, fc;               /* falling block cell + color */
static int tick, fall_period;
static int state, score, hi;
static unsigned int prev_pad;

static const unsigned int PAL[5] = {
    0, RGB(230,60,60), RGB(60,200,90), RGB(80,150,255), RGB(240,200,60)
};

static void new_block(void)
{
    fx = GW/2; fy = 0; fc = 1 + (psx_rand() % 4);
    if (grid[0][fx]) { if (score>hi) hi=score; state = OVER; }
}

static void reset_game(void)
{
    int r,c;
    for (r=0;r<GH;r++) for(c=0;c<GW;c++) grid[r][c]=0;
    score = 0; tick = 0; fall_period = 30;
    new_block();
}

static int blocked(int x, int y) { return x<0 || x>=GW || y>=GH || (y>=0 && grid[y][x]); }

static void lock_and_clear(void)
{
    int r,c,rr;
    grid[fy][fx] = fc;
    /* clear full rows */
    for (r = GH-1; r >= 0; r--) {
        int full = 1;
        for (c=0;c<GW;c++) if (!grid[r][c]) { full = 0; break; }
        if (full) {
            for (rr = r; rr > 0; rr--) for(c=0;c<GW;c++) grid[rr][c]=grid[rr-1][c];
            for (c=0;c<GW;c++) grid[0][c]=0;
            score += 100;
            if (fall_period > 8) fall_period--;
            r++; /* recheck this row */
        }
    }
    new_block();
}

static void step_fall(void)
{
    if (!blocked(fx, fy+1)) fy++;
    else lock_and_clear();
}

static void update(void)
{
    unsigned int pad = psx_pad();
    if ((pad & PAD_LEFT)  && !(prev_pad & PAD_LEFT)  && !blocked(fx-1, fy)) fx--;
    if ((pad & PAD_RIGHT) && !(prev_pad & PAD_RIGHT) && !blocked(fx+1, fy)) fx++;
    if (pad & PAD_DOWN) { step_fall(); tick = 0; }
    if (++tick >= fall_period) { step_fall(); tick = 0; }
    prev_pad = pad;
}

static void render(void)
{
    int r,c;
    psx_clear(RGB(12, 12, 24));
    /* well border */
    psx_rect(OX-3, OY-3, GW*CELL+6, GH*CELL+6, RGB(60,60,90));
    psx_rect(OX, OY, GW*CELL, GH*CELL, RGB(20,20,36));
    /* settled blocks */
    for (r=0;r<GH;r++) for(c=0;c<GW;c++) if (grid[r][c])
        psx_rect(OX+c*CELL+1, OY+r*CELL+1, CELL-2, CELL-2, PAL[grid[r][c]]);
    /* falling block */
    if (fy>=0) psx_rect(OX+fx*CELL+1, OY+fy*CELL+1, CELL-2, CELL-2, PAL[fc]);
    psx_number(8, 6, (unsigned)score, RGB(255,255,255));
}

int main(void)
{
    psx_init();
    psx_srand(0xD0D0);
    state = TITLE; prev_pad = 0;
    for (;;) {
        unsigned int pad = psx_pad();
        if (state == TITLE) {
            psx_clear(RGB(20, 12, 30));
            psx_rect(110, 90, 100, 60, RGB(80,150,255));
            psx_rect(120, 100, 80, 40, RGB(230,60,60));
            if ((pad & PAD_START) && !(prev_pad & PAD_START)) { reset_game(); state = PLAY; }
            prev_pad = pad;
        } else if (state == PLAY) { update(); render(); }
        else {
            psx_clear(RGB(30, 8, 8));
            psx_number(110, 100, (unsigned)score, RGB(255, 120, 120));
            psx_number(120, 130, (unsigned)hi, RGB(255, 255, 120));
            if ((pad & PAD_START) && !(prev_pad & PAD_START)) { reset_game(); state = PLAY; }
            prev_pad = pad;
        }
        psx_vsync();
    }
    return 0;
}
