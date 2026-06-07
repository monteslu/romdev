/* ── Hello, Game Boy in C — SDCC sm83 port ─────────────────────────
 * Minimal: cycle the BG palette on every vblank.
 *
 * Build: build({ output: "rom",  platform: "gb", source: <this file>, language: "c" })
 *
 * SDCC 4.4.0 codegen quirks to avoid in `__sfr __at` register-heavy
 * code:
 *   - `for (;;) { switch (x) { ... } }`  → crashes the register allocator.
 *     Workaround: do { ... } while (1).
 *   - `if (cond) { switch (x) { ... write to __sfr } }` → same crash.
 *     Workaround: lift the writes into a small lookup-table read
 *     (`BGP = palettes[idx]`) so there's no branching-into-sfr-write.
 *
 * The workaround is what this example uses; it cycles BGP through 4
 * preset values continuously rather than via a frame-counter `if`.
 */

__sfr __at 0xFF40 LCDC;
__sfr __at 0xFF42 SCY;
__sfr __at 0xFF43 SCX;
__sfr __at 0xFF44 LY;
__sfr __at 0xFF47 BGP;

static const unsigned char palettes[4] = { 0xE4, 0xB1, 0x6C, 0x1B };

void main(void) {
  unsigned char idx;
  unsigned char vblank_count;
  idx = 0;
  vblank_count = 0;

  /* Wait for safe LCD-off. */
  while (LY < 144) { }
  LCDC = 0;
  BGP  = 0xE4;
  SCY  = 0;
  SCX  = 0;
  LCDC = 0x91;                 /* LCD on + BG on, tile data $8000 */

  do {
    /* Wait one full vblank period. */
    while (LY <  144) { }
    while (LY >= 144) { }
    vblank_count++;
    /* Cycle palette every 32 frames — leaves the eye time to register. */
    idx = (vblank_count >> 5) & 0x03;
    BGP = palettes[idx];
  } while (1);
}
