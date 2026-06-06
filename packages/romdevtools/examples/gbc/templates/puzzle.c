/* ── puzzle.c — Game Boy match-3 falling-block scaffold ─────────────
 *
 * Mirrors the NES/Genesis/SNES puzzle scaffolds. 6-wide × 12-tall
 * grid drawn via BG tilemap (each cell = 1 BG tile). 1×3 vertical
 * active piece; LEFT/RIGHT shifts, A rotates colour order, DOWN
 * soft-drops, START hard-drops. Horizontal triples clear and score.
 *
 * On the Game Boy we don't have a built-in font, so we render the
 * grid as coloured tile cells using three BG tile shapes (R/G/B
 * stripes). Score is kept in WRAM; rendering a numeric HUD requires
 * a digit-tile blob — left as an extension.
 */

#include "gb_hardware.h"
#include "gb_runtime.h"

#define COLS 6
#define ROWS 12

#define T_BLANK 0
#define T_R     1
#define T_G     2
#define T_B     3

static const uint8_t tile_blank[16] = { 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0 };
/* Three distinct tile shapes (since GB BG is 2bpp, we differentiate
 * by *shape*, not colour-on-CGB). The CGB palette path could give us
 * real colours; for DMG-compatibility we use shape. */
static const uint8_t tile_r[16] = {
    0xFF,0x00, 0xFF,0x00, 0xFF,0x00, 0xFF,0x00,
    0xFF,0x00, 0xFF,0x00, 0xFF,0x00, 0xFF,0x00,
};
static const uint8_t tile_g[16] = {
    0xAA,0x55, 0xAA,0x55, 0xAA,0x55, 0xAA,0x55,
    0xAA,0x55, 0xAA,0x55, 0xAA,0x55, 0xAA,0x55,
};
static const uint8_t tile_b[16] = {
    0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
    0x00,0xFF, 0x00,0xFF, 0x00,0xFF, 0x00,0xFF,
};

static const uint16_t bg_palette[4]  = { 0x7FFF, 0x5294, 0x294A, 0x0000 };

static uint8_t grid[ROWS][COLS];
static uint8_t piece[3];
static int16_t piece_x, piece_y;
static uint8_t fall_timer;
static uint16_t score;
static uint32_t rng = 1;

static uint32_t xorshift(void) {
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    return rng;
}

static uint8_t random_colour(void) { return 1 + (xorshift() % 3); }

static void new_piece(void) {
    piece[0] = random_colour();
    piece[1] = random_colour();
    piece[2] = random_colour();
    piece_x = COLS / 2 - 1;
    piece_y = -3;
}

static uint8_t tile_for(uint8_t c) {
    switch (c) {
        case 1: return T_R;
        case 2: return T_G;
        case 3: return T_B;
        default: return T_BLANK;
    }
}

static void draw_cell(int16_t col, int16_t row, uint8_t cell) {
    /* Map base $9800, 32 cells wide. Centre the 6-col grid → offset +7. */
    uint8_t *map = (uint8_t *)0x9800;
    if (row < 0 || row >= ROWS) return;
    map[(row + 1) * 32 + (col + 7)] = tile_for(cell);
}

static void draw_grid(void) {
    int16_t r, c;
    for (r = 0; r < ROWS; r++)
        for (c = 0; c < COLS; c++)
            draw_cell(c, r, grid[r][c]);
}

static uint8_t collides(int16_t col, int16_t row) {
    uint8_t i;
    int16_t r;
    if (col < 0 || col >= COLS) return 1;
    for (i = 0; i < 3; i++) {
        r = row + i;
        if (r >= ROWS) return 1;
        if (r >= 0 && grid[r][col] != 0) return 1;
    }
    return 0;
}

static void lock_piece(void) {
    uint8_t i;
    int16_t r;
    int16_t c;
    uint8_t a, b, d;
    for (i = 0; i < 3; i++) {
        r = piece_y + i;
        if (r >= 0 && r < ROWS) grid[r][piece_x] = piece[i];
    }
    for (i = 0; i < 3; i++) {
        r = piece_y + i;
        if (r < 0 || r >= ROWS) continue;
        for (c = 0; c <= COLS - 3; c++) {
            a = grid[r][c]; b = grid[r][c + 1]; d = grid[r][c + 2];
            if (a != 0 && a == b && b == d) {
                grid[r][c]     = 0;
                grid[r][c + 1] = 0;
                grid[r][c + 2] = 0;
                if (score < 65500) score += 30;
            }
        }
    }
    draw_grid();
}

static void upload_tile(uint8_t slot, const uint8_t *src) {
    uint8_t *dst = (uint8_t *)(0x8000 + slot * 16);
    uint8_t i;
    for (i = 0; i < 16; i++) dst[i] = src[i];
}

void main(void) {
    uint8_t pad, prev = 0, fall_rate, t;
    int16_t r, c;
    uint8_t i;
    uint8_t *map;
    int16_t pr;

    lcd_init_default();
    LCDC = 0;

    upload_tile(T_BLANK, tile_blank);
    upload_tile(T_R,     tile_r);
    upload_tile(T_G,     tile_g);
    upload_tile(T_B,     tile_b);

    BCPS = 0x80;
    for (i = 0; i < 4; i++) {
        BCPD = (uint8_t)(bg_palette[i] & 0xFF);
        BCPD = (uint8_t)((bg_palette[i] >> 8) & 0xFF);
    }

    map = (uint8_t *)0x9800;
    for (i = 0; i < 32; i++) {
        c = 0;
        while (c < 32) { map[i * 32 + c] = T_BLANK; c++; }
    }

    for (r = 0; r < ROWS; r++)
        for (c = 0; c < COLS; c++)
            grid[r][c] = 0;

    score = 0;
    fall_timer = 0;
    new_piece();
    draw_grid();

    LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_TILE_DATA_LO;

    while (1) {
        wait_vblank();

        /* Erase current piece visual (overwrite with what's underneath). */
        for (i = 0; i < 3; i++) {
            pr = piece_y + i;
            if (pr >= 0 && pr < ROWS)
                draw_cell(piece_x, pr, grid[pr][piece_x]);
        }

        pad = joypad_read();

        if ((pad & PAD_LEFT)  && !(prev & PAD_LEFT)
            && !collides(piece_x - 1, piece_y)) piece_x--;
        if ((pad & PAD_RIGHT) && !(prev & PAD_RIGHT)
            && !collides(piece_x + 1, piece_y)) piece_x++;
        if ((pad & PAD_A) && !(prev & PAD_A)) {
            t = piece[0]; piece[0] = piece[1]; piece[1] = piece[2]; piece[2] = t;
        }
        if ((pad & PAD_START) && !(prev & PAD_START)) {
            while (!collides(piece_x, piece_y + 1)) piece_y++;
            lock_piece();
            new_piece();
            prev = pad;
            continue;
        }
        prev = pad;

        fall_rate = (pad & PAD_DOWN) ? 4 : 30;
        if (++fall_timer >= fall_rate) {
            fall_timer = 0;
            if (collides(piece_x, piece_y + 1)) {
                lock_piece();
                new_piece();
            } else {
                piece_y++;
            }
        }

        /* Re-draw piece in new position. */
        for (i = 0; i < 3; i++) {
            pr = piece_y + i;
            if (pr >= 0 && pr < ROWS) draw_cell(piece_x, pr, piece[i]);
        }
    }
}
