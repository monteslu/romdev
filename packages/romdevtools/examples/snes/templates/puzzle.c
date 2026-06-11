/* ── puzzle.c — SNES PVSnesLib match-3 falling-block scaffold ──────
 *
 * 6-wide × 12-tall grid drawn entirely via text-mode characters
 * (R = red, G = green, B = blue). Active piece is 1×3 vertical;
 * LEFT/RIGHT shifts, A rotates colour order, DOWN soft-drops, START
 * hard-drops. Horizontal triples clear and score.
 *
 * Why text-mode? PVSnesLib's consoleDrawText is the simplest
 * "draw something to a cell" path on SNES. Real puzzle games use
 * BG-tile sprite cells with proper graphics — that's the natural
 * next step from this scaffold.
 */

#include <snes.h>
#include "snes_sfx.c"

extern char tilfont, palfont;
extern char tilbg, palbg;       /* wallpaper tile + palette (data.asm) */

/* consoleVblank() copies the dirty text tilemap to VRAM during VBlank.
 * No public prototype in console.h, so declare it; call once per frame. */
extern void consoleVblank(void);

/* BG1 wallpaper map: a full 32x32 screen of the 4-colour tile so the
 * playfield reads as a real backdrop, not flat blank. Filled at runtime. */
static u16 bg_map[32 * 32];

#define COLS 6
#define ROWS 12

static u8 grid[ROWS][COLS];
static u8 piece[3];
static s16 piece_x;
static s16 piece_y;
static u16 fall_timer;
static u16 score;
static u32 rng = 1;

static u32 xorshift(void) {
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    return rng;
}

static u8 random_colour(void) { return 1 + (xorshift() % 3); }

static char glyph_for(u8 v) {
    switch (v) {
        case 1: return 'R';
        case 2: return 'G';
        case 3: return 'B';
        default: return '.';
    }
}

static void new_piece(void) {
    piece[0] = random_colour();
    piece[1] = random_colour();
    piece[2] = random_colour();
    piece_x = COLS / 2 - 1;
    piece_y = -3;
}

static void draw_cell(s16 col, s16 row) {
    char s[2];
    if (row < 0 || row >= ROWS) return;
    s[0] = glyph_for(grid[row][col]);
    s[1] = 0;
    consoleDrawText(col + 12, row + 4, s);
}

static void draw_grid(void) {
    s16 r, c;
    for (r = 0; r < ROWS; r++)
        for (c = 0; c < COLS; c++)
            draw_cell(c, r);
}

static void draw_piece(u8 clear) {
    u16 i;
    s16 r;
    char s[2];
    for (i = 0; i < 3; i++) {
        r = piece_y + i;
        if (r < 0 || r >= ROWS) continue;
        s[0] = clear ? glyph_for(grid[r][piece_x])
                     : glyph_for(piece[i]);
        s[1] = 0;
        consoleDrawText(piece_x + 12, r + 4, s);
    }
}

static u8 collides(s16 col, s16 row) {
    u16 i;
    s16 r;
    if (col < 0 || col >= COLS) return 1;
    for (i = 0; i < 3; i++) {
        r = row + i;
        if (r >= ROWS) return 1;
        if (r >= 0 && grid[r][col] != 0) return 1;
    }
    return 0;
}

/* ── match / clear / gravity core (ported from the GBC reference puzzle).
 * The old scan was horizontal-only AND cleared cells mid-scan, so vertical
 * and diagonal runs never cleared, 4+ runs half-cleared, and nothing ever
 * fell afterwards ("rows don't shift down"). This marks every 3+ run in all
 * 4 directions, clears them, applies per-column gravity, and loops so
 * cascades chain (score scales with chain depth). */
static u8 matched[ROWS][COLS];
static const s8 DIRS4[4][2] = { {0,1}, {1,0}, {1,1}, {1,-1} };

static u8 mark_and_count(void) {
  u8 r, c, d, len, k, cnt;
  u8 col;
  s8 dr, dc;
  int sr, sc;
  cnt = 0;
  for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) matched[r][c] = 0;
  for (r = 0; r < ROWS; r++) {
    for (c = 0; c < COLS; c++) {
      col = grid[r][c];
      if (col == 0) continue;
      for (d = 0; d < 4; d++) {
        dr = DIRS4[d][0]; dc = DIRS4[d][1];
        sr = (int)r - dr; sc = (int)c - dc;
        if (sr >= 0 && sr < ROWS && sc >= 0 && sc < COLS
            && grid[sr][sc] == col) continue;  /* not the run's start */
        len = 1;
        sr = (int)r + dr; sc = (int)c + dc;
        while (sr >= 0 && sr < ROWS && sc >= 0 && sc < COLS
               && grid[sr][sc] == col) { len++; sr += dr; sc += dc; }
        if (len >= 3) {
          sr = r; sc = c;
          for (k = 0; k < len; k++) {
            if (!matched[sr][sc]) { matched[sr][sc] = 1; cnt++; }
            sr += dr; sc += dc;
          }
        }
      }
    }
  }
  return cnt;
}

/* collapse each column so survivors rest on the floor (in place: walk
 * from the bottom, copying gems down to a write cursor, then zero above) */
static void apply_gravity(void) {
  u8 c;
  int r, w;
  for (c = 0; c < COLS; c++) {
    w = ROWS - 1;
    for (r = ROWS - 1; r >= 0; r--) {
      if (grid[r][c] != 0) { grid[w][c] = grid[r][c]; w--; }
    }
    for (; w >= 0; w--) grid[w][c] = 0;
  }
}

static void resolve_board(void) {
  u8 n, r, c, chain;
  unsigned int amt;
  chain = 0;
  while (1) {
    n = mark_and_count();
    if (n == 0) break;
    chain++;
    for (r = 0; r < ROWS; r++)
      for (c = 0; c < COLS; c++)
        if (matched[r][c]) grid[r][c] = 0;
    amt = (unsigned int)n * 10u;
    if (chain > 1) amt = amt * chain;
    if (score < 65500) score += amt;
    sfx_play(2);  /* clear chime */
    apply_gravity();
  }
}

static void lock_piece(void) {
    u16 i;
    s16 r;
    for (i = 0; i < 3; i++) {
        r = piece_y + i;
        if (r >= 0 && r < ROWS) grid[r][piece_x] = piece[i];
    }
    resolve_board();
    draw_grid();
}

static void render_score(void) {
    char buf[6];
    u16 v;
    s8 i;
    buf[0]='0'; buf[1]='0'; buf[2]='0'; buf[3]='0'; buf[4]='0'; buf[5]=0;
    v = score;
    for (i = 4; i >= 0; i--) { buf[i] = '0' + (v % 10); v /= 10; }
    consoleDrawText(20, 2, buf);
}

int main(void) {
    s16 r, c;
    u16 pad, prev = 0, fall_rate;
    u16 i;
    u8 t;

    consoleSetTextMapPtr(0x6800);
    consoleSetTextGfxPtr(0x3000);
    consoleSetTextOffset(0x0000);   /* tile index = (char-0x20); font is at the BG char base */
    consoleInitText(0, 16 * 2, &tilfont, &palfont);
    setMode(BG_MODE1, 0);
    /* consoleInitText DMAs the font but does NOT set the PPU BG base
     * registers — point BG0 at the same font ($3000) + map ($6800). */
    bgSetGfxPtr(0, 0x3000);
    bgSetMapPtr(0, 0x6800, SC_32x32);

    /* BG1 = full-screen wallpaper so the playfield never reads as blank.
     * Tiles -> VRAM $2000, map -> VRAM $4000 (clear of sprites $0000 and
     * the console gfx $3000 / map $6800). Map entries use palette block 1
     * (0x0400) so the wallpaper palette doesn't disturb the console font
     * palette in block 0 (HUD/grid text stays legible). */
    bgInitTileSet(1, (u8 *)&tilbg, (u8 *)&palbg, 1,
                  32, 32, BG_16COLORS, 0x2000);

    /* Per-genre backdrop tint — every SNES scaffold used to ship the same
     * blue checkered wallpaper ('no variety'). Recolor the wallpaper's
     * CGRAM entries (block 1 = entries 16+) to a deep violet scheme. */
    setPaletteColor(0, RGB5(4,2,8));
    setPaletteColor(17, RGB5(9,5,15));
    setPaletteColor(18, RGB5(6,3,11));
    for (i = 0; i < 32 * 32; i++) bg_map[i] = 0x0400;
    bgInitMapSet(1, (u8 *)bg_map, sizeof(bg_map), SC_32x32, 0x4000);
    bgSetEnable(1);
    bgSetDisable(2);

    for (r = 0; r < ROWS; r++)
        for (c = 0; c < COLS; c++)
            grid[r][c] = 0;

    score = 0;
    fall_timer = 0;
    new_piece();

    consoleDrawText(14, 2, "SCORE");
    consoleDrawText(2, 26, "LR MOVE A ROT START DROP");
    draw_grid();

    /* Screen ON first, THEN sound. sfx_init() must run AFTER setScreenOn()
     * (snes_sfx.h:63) — if the SPC stalls before the screen is on you get a
     * black/forced-blank screen forever. */
    setScreenOn();
    sfx_init();
    WaitForVBlank();   /* one frame before any SPC command — the driver seeds its
                        * command edge-detector AFTER init returns; a same-frame
                        * command is silently swallowed (see music_demo.c) */

    while (1) {
        pad = padsCurrent(0);
        draw_piece(1);

        if ((pad & KEY_LEFT)  && !(prev & KEY_LEFT)
            && !collides(piece_x - 1, piece_y)) piece_x--;
        if ((pad & KEY_RIGHT) && !(prev & KEY_RIGHT)
            && !collides(piece_x + 1, piece_y)) piece_x++;
        if ((pad & KEY_A) && !(prev & KEY_A)) {
            t = piece[0]; piece[0] = piece[1]; piece[1] = piece[2]; piece[2] = t;
            sfx_play(1);  /* rotate click */
        }
        if ((pad & KEY_START) && !(prev & KEY_START)) {
            while (!collides(piece_x, piece_y + 1)) piece_y++;
            lock_piece();
            new_piece();
            prev = pad;
            render_score();
            WaitForVBlank();
            consoleVblank();
            continue;
        }
        prev = pad;

        fall_rate = (pad & KEY_DOWN) ? 4 : 30;
        if (++fall_timer >= fall_rate) {
            fall_timer = 0;
            if (collides(piece_x, piece_y + 1)) {
                lock_piece();
                new_piece();
            } else {
                piece_y++;
            }
        }

        draw_piece(0);
        render_score();
        WaitForVBlank();
        consoleVblank();
    }
    return 0;
}
