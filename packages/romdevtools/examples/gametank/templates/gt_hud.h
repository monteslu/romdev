/* ── gt_hud.h — box-drawn HUD digits for the romdev GameTank examples ─────────
 *
 * The SDK's text_print_string() draws a FONT that's baked by the Node asset
 * pipeline (a .bmp loaded into GRAM) — not available on romdev's bare single-bank
 * path. So these examples render score/lives digits as small `gt_rect`
 * segments (a 7-seg-style 3x5 cell). Pure SDK draw-queue API, no assets.
 *
 * Each digit is a 3-wide x 5-tall grid of `px`-sized boxes; we draw one box per
 * lit cell. Cheap for short HUD numbers (score, lives, level).
 */
#ifndef GT_HUD_H
#define GT_HUD_H
#include "gametank.h"
#include "gt_draw.h"

/* 3x5 bitmaps for 0-9, row-major, bit 2 = leftmost of the 3 columns. */
static const unsigned char GT_DIG[10][5] = {
  {0x7,0x5,0x5,0x5,0x7}, {0x2,0x6,0x2,0x2,0x7}, {0x7,0x1,0x7,0x4,0x7},
  {0x7,0x1,0x3,0x1,0x7}, {0x5,0x5,0x7,0x1,0x1}, {0x7,0x4,0x7,0x1,0x7},
  {0x7,0x4,0x7,0x5,0x7}, {0x7,0x1,0x2,0x2,0x2}, {0x7,0x5,0x7,0x5,0x7},
  {0x7,0x5,0x7,0x1,0x7},
};

/* draw one digit (0-9) at (x,y), box size px, in color c. */
static void hud_digit(unsigned char d, unsigned char x, unsigned char y,
                      unsigned char px, unsigned char c) {
  unsigned char r, col;
  for (r = 0; r < 5; r++) {
    unsigned char bits = GT_DIG[d % 10][r];
    for (col = 0; col < 3; col++)
      if (bits & (0x4 >> col))
        gt_rect(x + col * px, y + r * px, px, px, c);
  }
}

/* draw a number right-aligned with its UNITS digit's left edge at x. */
static void hud_number(unsigned int n, unsigned char x, unsigned char y,
                       unsigned char px, unsigned char c) {
  unsigned char cx = x;
  do {
    hud_digit((unsigned char)(n % 10), cx, y, px, c);
    n /= 10;
    cx -= 4 * px;
  } while (n);
}

/* a row of `n` small pips (lives/ammo) starting at x, gap-spaced. */
static void hud_pips(unsigned char n, unsigned char x, unsigned char y,
                     unsigned char size, unsigned char c) {
  unsigned char i;
  for (i = 0; i < n; i++)
    gt_rect(x + i * (size + 2), y, size, size, c);
}

/* ── 3x5 box-letter font (A-Z + space) so titles can show real WORDS without the
 * asset-pipeline font. Same row-major bit format as GT_DIG (bit2 = leftmost). */
static const unsigned char GT_LET[27][5] = {
  {0x2,0x5,0x7,0x5,0x5}, /*A*/ {0x6,0x5,0x6,0x5,0x6}, /*B*/ {0x3,0x4,0x4,0x4,0x3}, /*C*/
  {0x6,0x5,0x5,0x5,0x6}, /*D*/ {0x7,0x4,0x6,0x4,0x7}, /*E*/ {0x7,0x4,0x6,0x4,0x4}, /*F*/
  {0x3,0x4,0x5,0x5,0x3}, /*G*/ {0x5,0x5,0x7,0x5,0x5}, /*H*/ {0x7,0x2,0x2,0x2,0x7}, /*I*/
  {0x1,0x1,0x1,0x5,0x2}, /*J*/ {0x5,0x6,0x4,0x6,0x5}, /*K*/ {0x4,0x4,0x4,0x4,0x7}, /*L*/
  {0x5,0x7,0x7,0x5,0x5}, /*M*/ {0x5,0x7,0x7,0x7,0x5}, /*N*/ {0x2,0x5,0x5,0x5,0x2}, /*O*/
  {0x6,0x5,0x6,0x4,0x4}, /*P*/ {0x2,0x5,0x5,0x6,0x3}, /*Q*/ {0x6,0x5,0x6,0x5,0x5}, /*R*/
  {0x3,0x4,0x2,0x1,0x6}, /*S*/ {0x7,0x2,0x2,0x2,0x2}, /*T*/ {0x5,0x5,0x5,0x5,0x7}, /*U*/
  {0x5,0x5,0x5,0x5,0x2}, /*V*/ {0x5,0x5,0x7,0x7,0x5}, /*W*/ {0x5,0x5,0x2,0x5,0x5}, /*X*/
  {0x5,0x5,0x2,0x2,0x2}, /*Y*/ {0x7,0x1,0x2,0x4,0x7}, /*Z*/ {0x0,0x0,0x0,0x0,0x0}, /*space*/
};

/* draw one 3x5 char (A-Z, space) at (x,y), box size px, color c. */
static void hud_char(char ch, unsigned char x, unsigned char y,
                     unsigned char px, unsigned char c) {
  unsigned char r, col, idx;
  if (ch >= 'A' && ch <= 'Z') idx = ch - 'A';
  else if (ch >= 'a' && ch <= 'z') idx = ch - 'a';
  else idx = 26; /* space / unknown */
  for (r = 0; r < 5; r++) {
    unsigned char bits = GT_LET[idx][r];
    for (col = 0; col < 3; col++)
      if (bits & (0x4 >> col)) gt_rect(x + col * px, y + r * px, px, px, c);
  }
}

/* draw a string (A-Z + spaces) starting at (x,y); 4*px per char advance. */
static void hud_text(const char *s, unsigned char x, unsigned char y,
                     unsigned char px, unsigned char c) {
  while (*s) { hud_char(*s, x, y, px, c); x += 4 * px; s++; }
}

#endif /* GT_HUD_H */
