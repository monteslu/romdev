/* ── puzzle.c — Genesis SGDK match-3 falling-block scaffold ───────
 *
 * 6-wide × 12-tall grid. A 1×3 active piece (3 colours, randomly
 * chosen from the cell palette) drops from the top; LEFT/RIGHT
 * shifts, A rotates the colour order, DOWN soft-drops, START
 * triggers a hard-drop. Horizontal triples clear and bump score.
 *
 * The grid lives in plain RAM (u8 grid[12][6]) and is drawn to plane
 * B via VDP_setTileMapXY each frame the grid changes — we don't
 * redraw every frame, only on landings and clears, so the budget is
 * comfortable.
 *
 * Cells:
 *   0 = empty       1 = red       2 = green       3 = blue
 *
 * Yours to extend: vertical-triple clear, T/L shape pieces, gravity
 * after clears (current code just deletes; no settle), a score
 * display + game-over screen, music via XGM2.
 */

#include <genesis.h>
#include "genesis_sfx.h"

#define COLS    6
#define ROWS    12
#define CELL_PX 16   /* draw cells at 2×2 tiles for visibility */

#define T_BLANK (TILE_USER_INDEX + 0)
#define T_RED   (TILE_USER_INDEX + 1)
#define T_GREEN (TILE_USER_INDEX + 2)
#define T_BLUE  (TILE_USER_INDEX + 3)

static const u32 tile_blank[8] = { 0,0,0,0,0,0,0,0 };
static const u32 tile_red[8]   = {
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
    0x11111111, 0x11111111, 0x11111111, 0x11111111,
};
static const u32 tile_green[8] = {
    0x22222222, 0x22222222, 0x22222222, 0x22222222,
    0x22222222, 0x22222222, 0x22222222, 0x22222222,
};
static const u32 tile_blue[8]  = {
    0x33333333, 0x33333333, 0x33333333, 0x33333333,
    0x33333333, 0x33333333, 0x33333333, 0x33333333,
};

static u8 grid[ROWS][COLS];

static u8 piece[3];       /* the 3 colours in the active piece */
static s16 piece_x;       /* column 0..COLS-1 */
static s16 piece_y;       /* row, can be negative while above the grid */
static u16 fall_timer;
static u16 score;
static u32 rng_state = 1;

static u32 xorshift(void) {
    rng_state ^= rng_state << 13;
    rng_state ^= rng_state >> 17;
    rng_state ^= rng_state << 5;
    return rng_state;
}

static u8 random_colour(void) { return 1 + (xorshift() % 3); }

static void new_piece(void) {
    piece[0] = random_colour();
    piece[1] = random_colour();
    piece[2] = random_colour();
    piece_x = COLS / 2 - 1;
    piece_y = -3;
}

static u8 tile_for(u8 cell) {
    switch (cell) {
        case 1: return T_RED;
        case 2: return T_GREEN;
        case 3: return T_BLUE;
        default: return T_BLANK;
    }
}

static u16 pal_for(u8 cell) {
    /* All three colours share palette 1; we colour them via tile
     * index (each tile uses its own colour index). */
    return PAL1;
}

static void draw_cell(s16 col, s16 row) {
    if (row < 0 || row >= ROWS) return;
    u8 v = grid[row][col];
    /* Each grid cell is CELL_PX/8 = 2 tiles square. */
    for (u16 dy = 0; dy < 2; dy++) {
        for (u16 dx = 0; dx < 2; dx++) {
            VDP_setTileMapXY(BG_B,
                TILE_ATTR_FULL(pal_for(v), 0, 0, 0, tile_for(v)),
                col * 2 + dx + 6,
                row * 2 + dy + 1);
        }
    }
}

static void draw_grid(void) {
    for (s16 r = 0; r < ROWS; r++)
        for (s16 c = 0; c < COLS; c++)
            draw_cell(c, r);
}

static void draw_piece(s16 col, s16 row, bool clear) {
    /* Draw / un-draw the 1×3 vertical piece by writing as if the grid
     * had it. This is a *transient* overlay, so we restore from grid
     * when clearing. */
    for (u16 i = 0; i < 3; i++) {
        s16 r = row + i;
        if (r < 0 || r >= ROWS) continue;
        u8 v = clear ? grid[r][col] : piece[i];
        for (u16 dy = 0; dy < 2; dy++)
            for (u16 dx = 0; dx < 2; dx++)
                VDP_setTileMapXY(BG_B,
                    TILE_ATTR_FULL(pal_for(v), 0, 0, 0, tile_for(v)),
                    col * 2 + dx + 6,
                    r   * 2 + dy + 1);
    }
}

static void lock_piece(void) {
    for (u16 i = 0; i < 3; i++) {
        s16 r = piece_y + i;
        if (r >= 0 && r < ROWS) grid[r][piece_x] = piece[i];
    }
    /* Check horizontal triples on the affected rows. */
    for (u16 i = 0; i < 3; i++) {
        s16 r = piece_y + i;
        if (r < 0 || r >= ROWS) continue;
        for (s16 c = 0; c <= COLS - 3; c++) {
            u8 a = grid[r][c], b = grid[r][c + 1], d = grid[r][c + 2];
            if (a != 0 && a == b && b == d) {
                grid[r][c]     = 0;
                grid[r][c + 1] = 0;
                grid[r][c + 2] = 0;
                if (score < 65500u) score += 30;
                sfx_tone(0, 250, 12);  /* triple-clear chime */
            }
        }
    }
    draw_grid();
}

static bool collides(s16 col, s16 row) {
    if (col < 0 || col >= COLS) return TRUE;
    for (u16 i = 0; i < 3; i++) {
        s16 r = row + i;
        if (r >= ROWS) return TRUE;
        if (r >= 0 && grid[r][col] != 0) return TRUE;
    }
    return FALSE;
}

static void render_score(void) {
    char buf[6];
    u16 v = score;
    for (s16 i = 4; i >= 0; i--) { buf[i] = '0' + (v % 10); v /= 10; }
    buf[5] = 0;
    VDP_drawText(buf, 24, 1);
}

int main(bool hard) {
    (void)hard;

    /* Palette 1: tile colours for red/green/blue cells. */
    PAL_setColor(16 + 1, 0x000E); /* red */
    PAL_setColor(16 + 2, 0x00E0); /* green */
    PAL_setColor(16 + 3, 0x0E00); /* blue */

    VDP_loadTileData(tile_blank, T_BLANK, 1, DMA);
    VDP_loadTileData(tile_red,   T_RED,   1, DMA);
    VDP_loadTileData(tile_green, T_GREEN, 1, DMA);
    VDP_loadTileData(tile_blue,  T_BLUE,  1, DMA);

    for (s16 r = 0; r < ROWS; r++)
        for (s16 c = 0; c < COLS; c++)
            grid[r][c] = 0;

    score = 0;
    fall_timer = 0;
    sfx_init();
    new_piece();
    draw_grid();

    VDP_drawText("SCORE", 18, 1);
    VDP_drawText("LR MOVE A ROT START DROP", 7, 26);

    u16 prev = 0;

    while (TRUE) {
        u16 pad = JOY_readJoypad(JOY_1);

        /* Erase current piece visual. */
        draw_piece(piece_x, piece_y, TRUE);

        if ((pad & BUTTON_LEFT)  && !(prev & BUTTON_LEFT)
            && !collides(piece_x - 1, piece_y)) piece_x--;
        if ((pad & BUTTON_RIGHT) && !(prev & BUTTON_RIGHT)
            && !collides(piece_x + 1, piece_y)) piece_x++;
        if ((pad & BUTTON_A) && !(prev & BUTTON_A)) {
            u8 t = piece[0]; piece[0] = piece[1]; piece[1] = piece[2]; piece[2] = t;
            sfx_tone(2, 450, 2);   /* rotate click */
        }
        if ((pad & BUTTON_START) && !(prev & BUTTON_START)) {
            /* Hard-drop. */
            while (!collides(piece_x, piece_y + 1)) piece_y++;
            lock_piece();
            new_piece();
            prev = pad;
            render_score();
            sfx_update();
            SYS_doVBlankProcess();
            continue;
        }
        prev = pad;

        u16 fall_rate = (pad & BUTTON_DOWN) ? 4 : 30;
        if (++fall_timer >= fall_rate) {
            fall_timer = 0;
            if (collides(piece_x, piece_y + 1)) {
                lock_piece();
                new_piece();
            } else {
                piece_y++;
            }
        }

        /* Re-draw piece in its new position. */
        draw_piece(piece_x, piece_y, FALSE);

        render_score();
        sfx_update();
        SYS_doVBlankProcess();
    }
    return 0;
}
