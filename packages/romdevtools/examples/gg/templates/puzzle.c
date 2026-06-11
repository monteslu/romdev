/* ── puzzle.c — Game Gear falling-gem versus puzzle (complete example game) ───
 *
 * SLUICE STACK — a COMPLETE, working game: title screen, 1P MARATHON mode
 * (levels speed the fall as you clear) and 2P SIMULTANEOUS VERSUS mode — two
 * narrow wells side by side, P1 on PORT A, P2 on PORT B, both falling at once,
 * where every cascade chain you score lays SIEGE to the other well: garbage
 * rows rise from the bottom of your rival's board. Score + persistent
 * hi-score (Sega-mapper cart RAM — see the honesty note at hiscore_save),
 * PSG music + SFX, and the GG/SMS signature LINE-INTERRUPT split: a fixed HUD
 * strip over the wells, timed by the VDP's programmable line counter — but
 * EVERYTHING is fit to the GG's 160×144 visible window.
 *
 * The game: a falling-trio match-3. A vertical trio of gems "sluices" down a
 * well; LEFT/RIGHT move it, button 1 cycles its three colours, DOWN
 * soft-drops, button 2 hard-drops. When it lands, any straight run of 3+
 * same-coloured gems (horizontal, vertical, or diagonal) clears; survivors
 * fall and cascades chain for multiplied score. First stack to reach the rim
 * loses.
 *
 * THIS FILE IS THE GG TWIN of the SMS puzzle (GEODE GAMBIT). The GG VDP IS the
 * SMS VDP — same Mode-4 hardware, same SN76489 PSG, same I/O. There is exactly
 * ONE thing that changes everything about placement:
 *
 *   THE GG VISIBLE WINDOW — the VDP renders a full 256×192 frame; the LCD
 *   shows only the CENTERED 160×144 of it. Every hardware coordinate (sprite
 *   OAM x/y, tilemap rows/cols, AND the line counter's scanline number) is in
 *   the FULL 256×192 frame; content placed outside the centered window is
 *   rendered "correctly" and simply never shown. So the HUD, the title, and
 *   BOTH wells must sit INSIDE the window — derive every coordinate from the
 *   VIS_* block below, never hardcode an SMS-frame number. (The emulator
 *   screenshot is the 160×144 visible crop — "my well is at col 3 but
 *   off-screen" means it's parked in the unseen border, not a render bug.)
 *
 *   THE WELL-WIDTH ADAPTATION (load-bearing for the layout): the SMS GEODE
 *   GAMBIT had 256 px = 32 cols to spend, so its wells were 6 cells wide and
 *   the 2P split put P1 at cols 3-8 and P2 at cols 23-28. The GG window is only
 *   20 cols (160 px) wide — two 6-wide wells (each frame+6+frame = 8 cols, so
 *   16 cols + a centre gutter) do NOT fit. So the GG wells are GRID_W = 5 cells
 *   wide: each well is 7 cols (frame+5+frame), two = 14 cols, leaving a 5-col
 *   centre gutter for the VS marker, all inside the 20 visible columns. A
 *   5-wide well is still a real match-3 board (3-run clears, cascades, garbage
 *   all work unchanged) — only the geometry constants moved. If you reshape the
 *   wells, derive their columns from VIS_* and keep 2*(GRID_W+2) under VIS_COLS.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented GG footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — match rules, garbage, tuning, art: reshape freely.
 *
 * What depends on what:
 *   gg_hw.h / vdp_init.c / load_palette.c / load_tiles.c / sprite_table.c /
 *     joypad_read.c — the bundled VDP + input runtime (this file's externs).
 *   gg_sfx.{h,c} + gg_music.{h,c} — SN76489 PSG sound layers.
 *   gg_crt0.s — boot + vector table. Its $0038 IM-1 handler is the OTHER
 *     HALF of the line-interrupt idiom below: it acks the VDP (one status
 *     read clears BOTH the frame and line IRQ flags) and returns with
 *     ei/reti. Load-bearing; edit with TROUBLESHOOTING open.
 *
 * Frame budget (NTSC, 60fps) — and a TEACHING POINT vs the NES version of
 * this game (examples/nes/templates/puzzle.c): on the NES, board repaints
 * squeeze through a ~16-entry vblank queue, so a full-board repaint is
 * BUDGETED across 12 frames of dirty-row bitmask tricks. The GG has no such
 * famine: the BOARD IS A BG TILEMAP, and a whole well (12 rows × 5 cells) is
 * 60 gg_set_tilemap_cell writes — well under a single vblank's VRAM
 * bandwidth. So when a lock dirties a board we just repaint the WHOLE well in
 * the next vblank (board_dirty flag) — no per-row drip, no queue. The only
 * thing we DO budget is the HUD's software 16-bit divisions (see the BUDGET
 * FOOTGUN at the main loop), exactly as the platformer/shmup do. Same genre,
 * two bandwidth worlds — fork accordingly.
 *
 * SDCC FOOTGUN (bites every fork): uint8 loop bounds silently wrap —
 * `for (uint8_t i = 0; i < 12 * 5; i++)` is fine (60 < 255), but a full-board
 * paint `for (uint8_t i = 0; i < 24 * 32; i++)` is an INFINITE loop (768 >
 * 255; SDCC even warns "comparison is always true"). Treat that warning as an
 * error: widen the counter to uint16_t or keep loops nested per-row like the
 * painters below.
 */
#include "gg_hw.h"
#include "gg_sfx.h"
#include "gg_music.h"
#include <stdint.h>

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "SLUICE STACK"

extern void    gg_vdp_init(void);
extern void    gg_vdp_write_reg(uint8_t reg, uint8_t value);
extern void    gg_vdp_display_on(void);
extern void    gg_vdp_display_off(void);
extern void    gg_vdp_set_addr(uint16_t addr, uint8_t prefix);
extern void    gg_load_palette(const uint8_t *palette);
extern void    gg_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count);
extern void    gg_set_tilemap_cell(uint8_t row, uint8_t col, uint8_t tile_idx, uint8_t attr);
extern uint8_t gg_joypad_read(void);
extern uint8_t gg_joypad_read_p2(void);
extern void    gg_sprite_init(void);
extern void    gg_sprite_set(uint8_t slot, uint8_t x, uint8_t y, uint8_t tile);
extern void    gg_sat_upload(void);

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * THE GG VISIBLE WINDOW. The VDP frame is 256×192; the LCD shows the
 * centered 160×144. In FULL-FRAME hardware units the window is:
 *
 *   pixels:  x ∈ [48..207]   y ∈ [24..167]    (sprite coords, scanlines)
 *   tilemap: col ∈ [6..25]   row ∈ [3..20]    (20×18 visible cells)
 *
 * EVERYTHING the hardware takes is full-frame: gg_sprite_set x/y, tilemap
 * row/col, and — easy to forget — the LINE COUNTER (VDP R10) counts
 * full-frame scanlines from the top of the 192-line active area, NOT from
 * the top of the LCD. The window's first visible scanline is 24.
 *
 * Requires: nothing — these are constants of the machine. Everything below
 * (HUD placement, split line, well geometry, sprite Y, text columns) is
 * derived from them; if you reshape the layout, derive from VIS_*, never
 * hardcode SMS-frame numbers. */
#define VIS_X0    48          /* left edge of the LCD window (hardware X)  */
#define VIS_Y0    24          /* top edge (hardware Y / scanline)          */
#define VIS_X1    207         /* right edge:  48 + 160 - 1                 */
#define VIS_Y1    167         /* bottom edge: 24 + 144 - 1                 */
#define VIS_W     160
#define VIS_H     144
#define VIS_COL0  6           /* first visible tilemap column (48 / 8)     */
#define VIS_ROW0  3           /* first visible tilemap row    (24 / 8)     */
#define VIS_COLS  20          /* 160 / 8 */
#define VIS_ROWS  18          /* 144 / 8 */
/* Think in window space (0..19 cols, 0..17 rows), convert at the call: */
#define VROW(r)   ((uint8_t)((r) + VIS_ROW0))
#define VCOL(c)   ((uint8_t)((c) + VIS_COL0))

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Palette. THE GG's HEADLINE UPGRADE over the SMS: CRAM holds 12-bit 4-4-4
 * BGR colour (4096 colours) instead of the SMS's 6-bit 2-2-2 (64). The WRITE
 * FORMAT differs too — that's the #2 GG footgun:
 *
 *   SMS: 32 entries × 1 byte   --BBGGRR
 *   GG:  32 entries × 2 bytes  little-endian: low byte = GGGGRRRR
 *                                             high byte = ----BBBB
 *
 * So a GG palette array is 64 bytes (entries 0-15 BG, 16-31 sprite). Feeding
 * gg_load_palette a 32-byte SMS-style table reads past the array — the sprite
 * palette loads garbage and every sprite renders invisible (this exact bug
 * shipped in an earlier GG scaffold round). Pack an entry with:
 * low = (g << 4) | r, high = b, each channel 0..15. The ruby/emerald/sapphire
 * gems and the recessed well floor below all use the 4096-colour panel (the
 * GEODE GAMBIT SMS palette only had 64 to choose from). */
static const uint8_t palette[64] = {
  /* BG 0-15: 0 = cabinet navy (backdrop/border), 1 = ruby, 2 = emerald,
   * 3 = white (text + glint), 4 = HUD-bar steel, 5 = sapphire,
   * 6 = well-frame grey, 7 = dim well floor (so the well reads as recessed) */
  0x20,0x02, 0x13,0x00, 0xA1,0x00, 0xFF,0x0F, 0x86,0x06,
  0x4C,0x0E, 0xAA,0x0A, 0x32,0x03,
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
  /* SPRITE 16-31: 16 = transparent, 17 = ruby, 18 = emerald, 19 = sapphire
   * (the falling trio's three colours). One shared sprite palette on GG/SMS —
   * per-"sprite" colour means per-TILE colour indices, not per-sprite palettes. */
  0,0, 0x13,0x00, 0xA1,0x00, 0x4C,0x0E,
  0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0, 0,0,
};

/* ── GAME LOGIC (clay) — BG tile inventory (BG bank $0000) ───────────────────
 * tile 0          = blank cabinet (colour 0)
 * tiles 1..37     = font: digits 0-9, A-Z, '-'  (uploaded 1bpp→4bpp below)
 * tiles 38..40    = gem colours 1/2/3 (ruby/emerald/sapphire) as BG tiles
 * tile 41         = well frame (steel grey)
 * tile 42         = empty well floor (dim — so the well reads as recessed)
 * tile 43         = solid HUD bar (colour 4) — the split seam hides in it */
#define FONT_BASE  1
#define BG_GEM_BASE 38                 /* +0/+1/+2 = gem colours 1/2/3        */
#define BG_FRAME   41
#define BG_FLOOR   42
#define BG_HUDBAR  43

/* 1bpp font (same glyph set as the NES/SMS/GB examples — 0-9, A-Z, '-').
 * Stored 8 bytes/glyph; expanded to the VDP's 32-byte 4bpp tiles at upload
 * (see load_font below), so the ROM carries 296 bytes instead of 1184. */
static const uint8_t font8[37][8] = {
  /* 0-9 */
  {0x3C,0x66,0x6E,0x76,0x66,0x66,0x3C,0x00}, {0x18,0x38,0x18,0x18,0x18,0x18,0x7E,0x00},
  {0x3C,0x66,0x06,0x0C,0x18,0x30,0x7E,0x00}, {0x3C,0x66,0x06,0x1C,0x06,0x66,0x3C,0x00},
  {0x0C,0x1C,0x3C,0x6C,0x7E,0x0C,0x0C,0x00}, {0x7E,0x60,0x7C,0x06,0x06,0x66,0x3C,0x00},
  {0x1C,0x30,0x60,0x7C,0x66,0x66,0x3C,0x00}, {0x7E,0x06,0x0C,0x18,0x30,0x30,0x30,0x00},
  {0x3C,0x66,0x66,0x3C,0x66,0x66,0x3C,0x00}, {0x3C,0x66,0x66,0x3E,0x06,0x0C,0x38,0x00},
  /* A-Z */
  {0x18,0x3C,0x66,0x66,0x7E,0x66,0x66,0x00}, {0x7C,0x66,0x66,0x7C,0x66,0x66,0x7C,0x00},
  {0x3C,0x66,0x60,0x60,0x60,0x66,0x3C,0x00}, {0x78,0x6C,0x66,0x66,0x66,0x6C,0x78,0x00},
  {0x7E,0x60,0x60,0x7C,0x60,0x60,0x7E,0x00}, {0x7E,0x60,0x60,0x7C,0x60,0x60,0x60,0x00},
  {0x3C,0x66,0x60,0x6E,0x66,0x66,0x3E,0x00}, {0x66,0x66,0x66,0x7E,0x66,0x66,0x66,0x00},
  {0x7E,0x18,0x18,0x18,0x18,0x18,0x7E,0x00}, {0x06,0x06,0x06,0x06,0x66,0x66,0x3C,0x00},
  {0x66,0x6C,0x78,0x70,0x78,0x6C,0x66,0x00}, {0x60,0x60,0x60,0x60,0x60,0x60,0x7E,0x00},
  {0x63,0x77,0x7F,0x6B,0x63,0x63,0x63,0x00}, {0x66,0x76,0x7E,0x7E,0x6E,0x66,0x66,0x00},
  {0x3C,0x66,0x66,0x66,0x66,0x66,0x3C,0x00}, {0x7C,0x66,0x66,0x7C,0x60,0x60,0x60,0x00},
  {0x3C,0x66,0x66,0x66,0x6A,0x6C,0x36,0x00}, {0x7C,0x66,0x66,0x7C,0x6C,0x66,0x66,0x00},
  {0x3C,0x66,0x60,0x3C,0x06,0x66,0x3C,0x00}, {0x7E,0x18,0x18,0x18,0x18,0x18,0x18,0x00},
  {0x66,0x66,0x66,0x66,0x66,0x66,0x3C,0x00}, {0x66,0x66,0x66,0x66,0x66,0x3C,0x18,0x00},
  {0x63,0x63,0x63,0x6B,0x7F,0x77,0x63,0x00}, {0x66,0x66,0x3C,0x18,0x3C,0x66,0x66,0x00},
  {0x66,0x66,0x66,0x3C,0x18,0x18,0x18,0x00}, {0x7E,0x06,0x0C,0x18,0x30,0x60,0x7E,0x00},
  /* '-' */
  {0x00,0x00,0x00,0x7E,0x00,0x00,0x00,0x00},
};

/* Expand 1bpp glyphs into 4bpp tiles as colour 3 (planes 0+1 set → white).
 * GG/SMS tile rows are 4 bytes: plane0, plane1, plane2, plane3. */
static void load_font(void) {
  uint8_t g, r, bits;
  gg_vdp_set_addr((uint16_t)(FONT_BASE * 32), VDP_VRAM_WRITE);
  for (g = 0; g < 37; g++) {
    for (r = 0; r < 8; r++) {
      bits = font8[g][r];
      PORT_VDP_DATA = bits;   /* plane 0 */
      PORT_VDP_DATA = bits;   /* plane 1 → colour index 3 (white) */
      PORT_VDP_DATA = 0;      /* plane 2 */
      PORT_VDP_DATA = 0;      /* plane 3 */
    }
  }
}

/* ── GAME LOGIC (clay) — gem + furniture tiles (4bpp, 32 bytes each).
 * KEY TRICK: the three gem tiles are the SAME rounded shape on different
 * colour planes — a cell changes colour by changing its TILE index, no
 * re-upload. Colour 1 = plane 0 only, colour 2 = plane 1 only, colour 3 =
 * planes 0+1. A bright corner pixel (colour 3 = planes 0+1) gives each gem a
 * glint so they don't read as flat squares. */
static const uint8_t gem_furniture[32 * 6] = {
  /* BG_GEM_BASE+0 — ruby (colour 1 fill, white glint top-left) */
  0x3C,0x3C,0x00,0x00, 0x7E,0x42,0x00,0x00, 0xFF,0x81,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0x7E,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00,
  /* BG_GEM_BASE+1 — emerald (colour 2 fill = plane 1, glint colour 3) */
  0x00,0x3C,0x00,0x00, 0x00,0x7E,0x00,0x00, 0x18,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00, 0x00,0x7E,0x00,0x00, 0x00,0x3C,0x00,0x00,
  /* BG_GEM_BASE+2 — sapphire (colour 3 fill = planes 0+1, plus a bright glint) */
  0x3C,0x3C,0x00,0x00, 0x42,0x7E,0x00,0x00, 0x81,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00, 0x00,0x7E,0x00,0x00, 0x00,0x3C,0x00,0x00,
  /* BG_FRAME — solid colour 6 (well-frame grey = planes 1+2) */
  0x00,0xFF,0xFF,0x00, 0x00,0xFF,0xFF,0x00, 0x00,0xFF,0xFF,0x00, 0x00,0xFF,0xFF,0x00,
  0x00,0xFF,0xFF,0x00, 0x00,0xFF,0xFF,0x00, 0x00,0xFF,0xFF,0x00, 0x00,0xFF,0xFF,0x00,
  /* BG_FLOOR — empty well floor: colour 7 (planes 0+1+2) with a faint speck */
  0xFF,0xFF,0xFF,0x00, 0xFF,0xFF,0xFF,0x00, 0xFF,0xFF,0xFF,0x00, 0xEF,0xFF,0xFF,0x00,
  0xFF,0xFF,0xFF,0x00, 0xFF,0xFF,0xFF,0x00, 0xFF,0xFF,0xFF,0x00, 0xFF,0xFF,0xFF,0x00,
  /* BG_HUDBAR — solid colour 4 (binary 100 → plane 2 only); seam hides here */
  0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00,
  0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00,
};

/* Sprite tiles (sprite bank $2000 — vdp_init's R6=0xFF baseline reads
 * sprite patterns from $2000, so upload there, not $0000). The falling trio's
 * cells are SPRITES (they move every frame); locked gems are BG tiles. Same
 * three colours as the BG gems above (sprite palette indices 1/2/3). */
static const uint8_t sprite_tiles[32 * 3] = {
  /* T_SPR+0 — ruby (colour 1) */
  0x3C,0x3C,0x00,0x00, 0x7E,0x42,0x00,0x00, 0xFF,0x81,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0x7E,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00,
  /* T_SPR+1 — emerald (colour 2 = plane 1) */
  0x00,0x3C,0x00,0x00, 0x00,0x7E,0x00,0x00, 0x18,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00, 0x00,0x7E,0x00,0x00, 0x00,0x3C,0x00,0x00,
  /* T_SPR+2 — sapphire (colour 3 = planes 0+1; sprite palette index 3) */
  0x3C,0x3C,0x00,0x00, 0x42,0x7E,0x00,0x00, 0x81,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00,
  0x00,0xFF,0x00,0x00, 0x00,0xFF,0x00,0x00, 0x00,0x7E,0x00,0x00, 0x00,0x3C,0x00,0x00,
};
#define T_SPR 0                        /* sprite tile of gem colour 1         */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Board geometry, ALL in WINDOW coordinates (0..19 cols / 0..17 rows) and
 * converted to full-frame at the call via VROW/VCOL. Cells are 8×8 (one BG
 * tile). GRID_W = 5 (the GG-window adaptation — see the WELL-WIDTH note in the
 * file header): a single well is 7 cols (frame + 5 + frame), so TWO wells fit
 * side by side inside the 20-col window with a 5-col centre gutter for the 2P
 * split board. Playfield WINDOW rows 4..15 sit below the 3-row HUD strip. */
#define GRID_W   5
#define GRID_H   12
#define WELL_TY  4                      /* top WINDOW row of the well interior */
#define WELL_1P_TX 7                    /* 1P: single centred well interior    */
#define WELL_VS_P1  1                   /* 2P: P1 interior cols 1-5 ...         */
#define WELL_VS_P2 13                   /*     P2 interior cols 13-17 (split)   */
#define EMPTY 0                         /* cell colours 1..3 = ruby/em/sapph   */

/* HUD layout (WINDOW rows): row 0 = text, row 1 = blank, row 2 = solid bar.
 * The bar row is both the visual divider AND where the split seam hides. */
#define HUD_ROWS 3
#define HUD_PX   (HUD_ROWS * 8)

#define VS_FALL_DELAY 24                /* 2P: fixed gravity (frames per row)  */
#define GARBAGE_CAP   4                 /* max garbage rows per attack         */

/* ── GAME LOGIC (clay) — game state.
 * The hot ones are deliberately NON-static: they then appear in the sdld map
 * (build symbols) at $Cxxx in work RAM, so a headless agent can resolve them
 * by name and read/poke live state (parse the map → system_ram offset =
 * addr-0xC000). The GG has 8KB of work RAM ($C000-$DFFF), so these plain
 * arrays cost nothing — no NES scratch-page gymnastics. */
uint8_t  grid[2][GRID_H][GRID_W];       /* the two wells (P2's unused in 1P)  */
int8_t   piece_x[2];                    /* falling trio: column 0..GRID_W-1   */
int8_t   piece_y[2];                    /* row of its TOP cell (<0 above rim) */
uint8_t  piece_col[2][3];               /* trio colours, top to bottom        */
uint16_t score[2];
uint16_t hiscore;
uint8_t  level;                         /* 1P: 1..9, speeds up the fall       */
uint8_t  state;                         /* ST_TITLE / ST_PLAY / ST_OVER       */
uint8_t  two_player;

static uint8_t  matched[GRID_H][GRID_W];
static uint8_t  well_tx[2];             /* left interior WINDOW column per well */
static uint8_t  fall_t[2];              /* frames until next gravity step      */
static uint8_t  prev_pad[2];            /* for edge-triggered input            */
static uint16_t cleared_total;          /* 1P: gems cleared, drives the level  */
static uint8_t  board_dirty[2];         /* well needs a full repaint this frame*/
static uint8_t  hud_dirty;              /* score/level/layout changed → redraw */
static uint8_t  loser;                  /* who topped out (2P: 0=P1, 1=P2)     */
static uint8_t  over_step;              /* results text, one piece per vblank  */
static uint16_t rng = 0xACE1;

#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2

/* ── GAME LOGIC (clay) — xorshift16 PRNG (~tens of cycles per call) ── */
static uint8_t random8(void) {
  uint16_t r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (uint8_t)r;
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * LINE-INTERRUPT SPLIT — the GG/SMS VDP's signature trick (fixed status bar
 * over the playfield, palette splits, water effects). The VDP has ONE scroll
 * register pair for the whole frame; to keep the HUD strip pinned at the top
 * while the wells render below it, we DON'T scroll here (a puzzle board doesn't
 * move) — but we still take the line IRQ at the bar so the idiom is wired and
 * ready, and so the per-frame timing (vblank → line IRQ → game logic) matches
 * the GG platformer/shmup exactly. Where the NES needs the sprite-0-hit HACK
 * (park a sprite, busy-poll a status bit, burn scanlines spinning), this VDP
 * has a real, PROGRAMMABLE line interrupt:
 *
 *   R10 = N        line counter: a down-counter reloaded with N every line
 *                  outside the active area; underflow → IRQ at scanline N.
 *   R0 bit 4 (IE1) line-IRQ enable (already set in vdp_init's 0x36 baseline).
 *   R1 bit 5 (IE0) frame(vblank)-IRQ enable (set by gg_vdp_display_on's 0xE0).
 *
 * GG WINDOW CONTRAST (the part SMS habits get wrong): R10 counts FULL-FRAME
 * scanlines — line 0 is the top of the 192-line active area, which is 24
 * lines ABOVE the LCD. The HUD strip starts at the window top (scanline
 * VIS_Y0 = 24) and its last line is VIS_Y0 + HUD_PX - 1 = 47, so SPLIT_LINE
 * is 47 — NOT 23 as it would be on an SMS with the same 3-row HUD. Lines
 * 0..23 are rendered and never shown; they ride along with the HUD's region.
 *
 * Both IRQs land on the Z80's IM-1 vector at $0038. The crt0's handler does
 * the canonical minimal handshake:  push af / in a,($BF) / pop af / ei / reti
 * — reading the status port ACKS the VDP (clears BOTH pending flags; skip the
 * read and the IRQ line stays asserted = interrupt storm), and EI must
 * precede RETI or interrupts stay off forever after the first one.
 *
 * Because the handler does no work, the MAIN loop synchronizes with HALT: the
 * Z80 sleeps until the next interrupt, then reads the V-counter (port $7E) to
 * learn WHICH one woke us — line IRQs fire during the active area (V < 0xC0),
 * the frame IRQ fires at vblank (V ≥ 0xC0).
 *
 *   wait_vblank():  sleep until the frame IRQ → do per-frame VRAM work.
 *   wait_split():   sleep until the line IRQ at scanline 47 (the last bar
 *                   line) → past it, the wells render. (If you ADD a scrolling
 *                   background under the wells, this is where you'd write R8 —
 *                   see the GG platformer/shmup templates for the R8 write.)
 *
 * FOOTGUN — you cannot poll once IRQs are on: a status-port poll spins on the
 * same port the ISR reads. The ISR always wins the race, eats the flag, and
 * the poll loop hangs forever. HALT + V-counter is the IRQ-era replacement.
 *
 * Requires: R10 programmed, IE1 + IE0 enabled, EI executed once after
 * display-on, the crt0's ack-only ISR, and wait_vblank/wait_split called
 * EVERY frame in this order. R10 reloads after each underflow, so the line
 * IRQ re-fires every HUD_PX+VIS_Y0 lines down the frame (47, 95, 143, 191) —
 * the later wakes harmlessly interrupt game logic (the ISR acks them) and we
 * re-halt inside the NEXT wait_vblank(). */
#define SPLIT_LINE (VIS_Y0 + HUD_PX - 1)

static void wait_vblank(void) {
  /* check-first: if game logic overran into vblank, don't sleep a frame */
  while (PORT_V_COUNTER < 0xC0) { __asm__("halt"); }
}

static void wait_split(void) {
  /* halt-first: vblank work always ends inside vblank (V ≥ 0xC0), and the
   * first wake at V < 0xC0 is the line IRQ at SPLIT_LINE */
  do { __asm__("halt"); } while (PORT_V_COUNTER >= 0xC0);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * hi-score in Sega-mapper cart RAM. Same cartridge mapper as the SMS. The
 * control register at $FFFC: bit 3 maps the cart's 8KB battery RAM into
 * $8000-$BFFF (bank slot 2). Map → copy → unmap; keep the window short so
 * stray pointer bugs can't shred the save. The block is magic + value +
 * checksum so a never-written cart (all $FF) reads back as "no save" instead
 * of a garbage hi-score.
 *
 * NOTE the $FFFC address: it's IN the WRAM mirror ($C000-$DFFF mirrors at
 * $E000-$FFFF), so this write also lands in WRAM at $DFFC — the mapper just
 * snoops the bus. That's why the crt0 parks SP at $DFF0: the bytes above it
 * ($DFFC-$FFFF) belong to the mapper registers' shadow.
 *
 * HONESTY (verified 2026-06-10 against the bundled gpgx core, same finding as
 * the GG sports/platformer): gpgx only instantiates the Sega mapper for ROMs
 * LARGER than 48KB, and this build pipeline emits 32KB ROMs — so in-emulator
 * the $8000 window stays open-bus (reads $FF), the magic check fails, and the
 * game falls back to the WRAM hi-score (in-session only). The code below is
 * still the correct real-hardware idiom and lights up unchanged on a >48KB
 * build or a cart with battery RAM: the load path is self-falsifying, never
 * wrong. (The verify harness pads this ROM to 64KB to exercise the cart-RAM
 * path for real, including across power-cycle.) */
#define MAPPER_CTRL (*(volatile uint8_t *)0xFFFC)
#define CART_RAM    ((volatile uint8_t *)0x8000)

static void hiscore_save(uint16_t v) {
  uint8_t lo = (uint8_t)(v & 0xFF), hi = (uint8_t)(v >> 8);
  MAPPER_CTRL = 0x08;               /* map cart RAM at $8000 */
  CART_RAM[0] = 0x48;               /* 'H' */
  CART_RAM[1] = 0x53;               /* 'S' */
  CART_RAM[2] = lo;
  CART_RAM[3] = hi;
  CART_RAM[4] = (uint8_t)(lo ^ hi ^ 0xA5);
  MAPPER_CTRL = 0x00;               /* back to ROM in slot 2 */
}

static uint16_t hiscore_load(void) {
  uint16_t v = 0;
  MAPPER_CTRL = 0x08;
  if (CART_RAM[0] == 0x48 && CART_RAM[1] == 0x53 &&
      CART_RAM[4] == (uint8_t)(CART_RAM[2] ^ CART_RAM[3] ^ 0xA5)) {
    v = (uint16_t)(CART_RAM[2] | ((uint16_t)CART_RAM[3] << 8));
  }
  MAPPER_CTRL = 0x00;
  return v;
}

/* ── GAME LOGIC (clay) — text via the font tiles ─────────────────────────────
 * These write the name table directly, so call them only during vblank (or
 * with the display off): VRAM access during active display races the VDP's
 * own fetches and drops/garbles bytes on real hardware. Rows/cols here are
 * WINDOW coordinates (0..17 / 0..19) — VROW/VCOL add the border offset, so
 * text can never accidentally land in the unseen 256×192 margin. */
static uint8_t font_tile(char ch) {
  if (ch >= '0' && ch <= '9') return (uint8_t)(FONT_BASE + (ch - '0'));
  if (ch >= 'A' && ch <= 'Z') return (uint8_t)(FONT_BASE + 10 + (ch - 'A'));
  if (ch == '-') return (uint8_t)(FONT_BASE + 36);
  return 0;                         /* space → blank tile */
}

static void text_draw(uint8_t vrow, uint8_t vcol, const char *s) {
  uint8_t col = VCOL(vcol);
  while (*s) gg_set_tilemap_cell(VROW(vrow), col++, font_tile(*s++), 0);
}

static void draw_u16(uint8_t vrow, uint8_t vcol, uint16_t v) {
  uint8_t d[5], i;
  for (i = 0; i < 5; i++) { d[i] = (uint8_t)(v % 10); v /= 10; }
  for (i = 0; i < 5; i++)
    gg_set_tilemap_cell(VROW(vrow), (uint8_t)(VCOL(vcol) + i),
                        (uint8_t)(FONT_BASE + d[4 - i]), 0);
}

/* draw a 3-digit number at a window cell (caps at 999 — used for the tight
 * 2P split HUD where two 5-digit scores + labels won't fit 20 cols). */
static void draw_u3(uint8_t vrow, uint8_t vcol, uint16_t v) {
  if (v > 999) v = 999;
  gg_set_tilemap_cell(VROW(vrow), (uint8_t)(VCOL(vcol) + 0), (uint8_t)(FONT_BASE + (v / 100) % 10), 0);
  gg_set_tilemap_cell(VROW(vrow), (uint8_t)(VCOL(vcol) + 1), (uint8_t)(FONT_BASE + (v / 10) % 10), 0);
  gg_set_tilemap_cell(VROW(vrow), (uint8_t)(VCOL(vcol) + 2), (uint8_t)(FONT_BASE + v % 10), 0);
}

/* ── GAME LOGIC (clay) — HUD on WINDOW row 0 (only 20 cols, so it's tight).
 * Title:  HI hhhhh centred.   1P:  SC sssss .... LV n.   2P:  P1 sss .. P2 sss
 * (versus scores cap at 3 digits — plenty for a versus board; the marathon 1P
 * mode keeps the full 5-digit score). The play layouts stay inside cols 0..19. */
static void draw_hud(void) {
  uint8_t c;
  for (c = 0; c < VIS_COLS; c++) gg_set_tilemap_cell(VROW(0), VCOL(c), 0, 0);   /* clear row */
  if (state == ST_TITLE) {
    text_draw(0, 7, "HI");
    draw_u16(0, 10, hiscore);
    return;
  }
  if (two_player) {
    text_draw(0, 0, "P1"); draw_u3(0, 2, score[0]);   /* cols 0..4   */
    text_draw(0, 14, "P2"); draw_u3(0, 16, score[1]); /* cols 14..18 */
  } else {
    text_draw(0, 0, "SC"); draw_u16(0, 3, score[0]);  /* cols 0..7   */
    text_draw(0, 14, "LV");                            /* cols 14..17 */
    gg_set_tilemap_cell(VROW(0), VCOL(17), (uint8_t)(FONT_BASE + level), 0);
  }
}

/* ── GAME LOGIC (clay) — cell colour → BG tile (empty shows the dim floor). */
static uint8_t bg_tile_for(uint8_t col) {
  return col ? (uint8_t)(BG_GEM_BASE - 1 + col) : BG_FLOOR;
}

/* ── HARDWARE IDIOM (load-bearing) — whole-well repaint. Each dirtied well is
 * repainted ENTIRELY in the next vblank: 12 rows × 5 cells = 60 cell writes,
 * trivially inside a vblank's VRAM budget (the per-cell PERF FOOTGUN the shmup
 * found applies to FULL-SCREEN repaints, not a 60-cell well — and these only
 * fire on a lock/clear, not every frame). Contrast the NES version, which
 * must drip ONE board row per frame through a 16-entry queue. ── */
static void repaint_well(uint8_t p) {
  uint8_t r, c, tx = well_tx[p];
  for (r = 0; r < GRID_H; r++)
    for (c = 0; c < GRID_W; c++)
      gg_set_tilemap_cell(VROW((uint8_t)(WELL_TY + r)), VCOL((uint8_t)(tx + c)),
                          bg_tile_for(grid[p][r][c]), 0);
}

/* ── GAME LOGIC (clay) — screen painters (DISPLAY OFF: free VRAM access, clean
 * cut). While the display is off the frame IRQ doesn't fire — so no halt-based
 * waits in here, or you hang forever.
 *
 * IRQ-RACE FOOTGUN (cost the GG shmup a letter of its own title): repaints
 * also run with INTERRUPTS OFF — the di/ei bracket in paint_title/paint_play.
 * Display-off stops the FRAME IRQ but NOT the LINE IRQ (R0's IE1 stays set; the
 * line counter runs every scanline regardless of blanking). The crt0's ISR acks
 * by READING the control port ($BF) — and that read also resets the VDP's
 * two-byte address-latch state machine. If the line IRQ fires between the two
 * bytes of a gg_vdp_set_addr() control-port pair, the second byte is taken as a
 * new first byte, the VRAM address de-syncs, and one cell of your repaint lands
 * somewhere else. Per-frame writes inside wait_vblank don't need the bracket:
 * vblank has no line IRQs and the frame IRQ was already consumed by the halt
 * that woke us. */
static void paint_frame_chrome(uint8_t p) {
  uint8_t r, tx = well_tx[p];
  /* top + bottom frame rows */
  for (r = 0; r < GRID_W + 2; r++) {
    gg_set_tilemap_cell(VROW((uint8_t)(WELL_TY - 1)), VCOL((uint8_t)(tx - 1 + r)), BG_FRAME, 0);
    gg_set_tilemap_cell(VROW((uint8_t)(WELL_TY + GRID_H)), VCOL((uint8_t)(tx - 1 + r)), BG_FRAME, 0);
  }
  /* left + right frame columns */
  for (r = 0; r < GRID_H; r++) {
    gg_set_tilemap_cell(VROW((uint8_t)(WELL_TY + r)), VCOL((uint8_t)(tx - 1)), BG_FRAME, 0);
    gg_set_tilemap_cell(VROW((uint8_t)(WELL_TY + r)), VCOL((uint8_t)(tx + GRID_W)), BG_FRAME, 0);
  }
}

/* PERF FOOTGUN (inherited from the GG shmup/SMS puzzle, found the slow way):
 * per-cell gg_set_tilemap_cell redoes the 4-OUT address setup for every cell —
 * over a full screen that's seconds of black. Set the VRAM address ONCE per
 * row (the data port autoincrements through the row's 64 bytes) and stream.
 * window row 2 (HW row VIS_ROW0+2) gets the HUD bar; the rest blank. */
static void paint_blank_field(void) {
  uint8_t r, c;
  for (r = 0; r < 24; r++) {
    gg_vdp_set_addr((uint16_t)(0x3800 + (uint16_t)r * 64), VDP_VRAM_WRITE);
    for (c = 0; c < 32; c++) {
      uint8_t t = (r == (uint8_t)(VIS_ROW0 + 2)) ? BG_HUDBAR : 0;
      PORT_VDP_DATA = t;                      /* name-table entry low byte    */
      PORT_VDP_DATA = 0;                      /* high byte: flips/pal/priority */
    }
  }
}

static void paint_title(void) {
  __asm__("di");                    /* see IRQ-RACE FOOTGUN above */
  gg_vdp_display_off();
  paint_blank_field();
  text_draw(5, (uint8_t)((VIS_COLS - (sizeof(GAME_TITLE) - 1)) / 2), GAME_TITLE);
  text_draw(9, 4, "1P START - 1");
  text_draw(11, 4, "2P VERSUS - 2");
  text_draw(14, 2, "1 ROTATE 2 DROP");
  text_draw(16, 0, "CHAINS BESIEGE RIVAL");
  draw_hud();
  gg_sprite_init();                 /* park every sprite off-screen */
  gg_sat_upload();
  gg_vdp_display_on();              /* re-enables the frame IRQ too */
  __asm__("ei");                    /* interrupts back on LAST — regs are set */
}

static void paint_play(void) {
  __asm__("di");                    /* see IRQ-RACE FOOTGUN above */
  gg_vdp_display_off();
  paint_blank_field();
  paint_frame_chrome(0);
  repaint_well(0);
  if (two_player) {
    paint_frame_chrome(1);
    repaint_well(1);
    text_draw(10, 9, "VS");
  }
  draw_hud();
  gg_sprite_init();
  gg_sat_upload();
  gg_vdp_display_on();
  __asm__("ei");
}

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Match scan: mark every straight run of 3+ same-coloured gems in all 4
 * directions (a cell can belong to several runs — the mask de-dupes), and
 * return how many cells matched. Runs flat-out on the Z80 over 60 cells — no
 * need to smear it across frames like the cc65 NES version. */
static const int8_t DIRS4[4][2] = { {0,1}, {1,0}, {1,1}, {1,-1} };

static uint8_t mark_and_count(uint8_t p) {
  uint8_t r, c, d, len, k, cnt, col;
  int8_t dr, dc;
  int sr, sc;
  cnt = 0;
  for (r = 0; r < GRID_H; r++)
    for (c = 0; c < GRID_W; c++) matched[r][c] = 0;
  for (r = 0; r < GRID_H; r++) {
    for (c = 0; c < GRID_W; c++) {
      col = grid[p][r][c];
      if (col == EMPTY) continue;
      for (d = 0; d < 4; d++) {
        dr = DIRS4[d][0]; dc = DIRS4[d][1];
        sr = (int)r - dr; sc = (int)c - dc;
        if (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
            && grid[p][sr][sc] == col) continue;    /* not the run's start */
        len = 1;
        sr = (int)r + dr; sc = (int)c + dc;
        while (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
               && grid[p][sr][sc] == col) { len++; sr += dr; sc += dc; }
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

/* Collapse each column so survivors rest on the floor (walk from the bottom,
 * copying gems down to a write cursor, then zero everything above it). */
static void apply_gravity(uint8_t p) {
  uint8_t c;
  int8_t r, w;
  for (c = 0; c < GRID_W; c++) {
    w = GRID_H - 1;
    for (r = GRID_H - 1; r >= 0; r--) {
      if (grid[p][r][c] != EMPTY) { grid[p][w][c] = grid[p][r][c]; w--; }
    }
    for (; w >= 0; w--) grid[p][w][c] = EMPTY;
  }
}

/* Forward decls — game_over/garbage_insert/spawn_piece reference each other. */
static void game_over(void);

/* ── GAME LOGIC (clay) — clear matches, drop survivors, chain cascades.
 * Returns the chain depth (0 = the lock matched nothing). */
static uint8_t resolve_board(uint8_t p) {
  uint8_t n, r, c, chain;
  uint16_t amt;
  chain = 0;
  for (;;) {
    n = mark_and_count(p);
    if (n == 0) break;
    ++chain;
    for (r = 0; r < GRID_H; r++)
      for (c = 0; c < GRID_W; c++)
        if (matched[r][c]) grid[p][r][c] = EMPTY;
    amt = (uint16_t)n * 10;
    if (chain > 1) amt *= chain;             /* cascades pay multiplied */
    if (score[p] < 65000) score[p] += amt;
    /* clear chime — pitch rises with chain depth (smaller divider = higher
     * note on the PSG). Voice 0 doubles as an sfx voice over the music. */
    sfx_tone(0, (uint16_t)(360 - ((uint16_t)chain << 5)), 10);
    apply_gravity(p);
    board_dirty[p] = 1;
    hud_dirty = 1;
    if (!two_player) {
      cleared_total += n;
      while (level < 9 && cleared_total >= (uint16_t)level * 10) ++level;
    }
  }
  return chain;
}

/* ── GAME LOGIC (clay) — VERSUS attack: garbage rows rise from the bottom of
 * the victim's well (random gems with one gap — matchable, so a skilled
 * victim digs out). The victim's stack rising means the falling trio shifts
 * up one to stay board-aligned; if the top row is already occupied, the
 * victim tops out and loses. ── */
static void garbage_insert(uint8_t v, uint8_t nrows) {
  uint8_t k, c, gap;
  int8_t r;
  sfx_noise(8);                                /* incoming-garbage thud */
  for (k = 0; k < nrows; k++) {
    for (c = 0; c < GRID_W; c++) {
      if (grid[v][0][c] != EMPTY) { loser = v; game_over(); return; }
    }
    for (r = 0; r < GRID_H - 1; r++)
      for (c = 0; c < GRID_W; c++)
        grid[v][r][c] = grid[v][r + 1][c];
    gap = random8() % GRID_W;
    for (c = 0; c < GRID_W; c++)
      grid[v][GRID_H - 1][c] = (c == gap) ? EMPTY : (uint8_t)(1 + random8() % 3);
    if (piece_y[v] > -3) --piece_y[v];         /* keep the trio aligned */
  }
  board_dirty[v] = 1;
}

/* Can the trio occupy column x, rows y..y+2? Cells above the rim are fine
 * (pieces enter from above); below the floor or on a gem is not. */
static uint8_t can_place(uint8_t p, int8_t x, int8_t y) {
  int8_t i, cy;
  if (x < 0 || x >= GRID_W) return 0;
  for (i = 0; i < 3; i++) {
    cy = (int8_t)(y + i);
    if (cy < 0) continue;
    if (cy >= GRID_H) return 0;
    if (grid[p][cy][x] != EMPTY) return 0;
  }
  return 1;
}

static void spawn_piece(uint8_t p) {
  piece_x[p] = GRID_W / 2;
  piece_y[p] = -2;
  piece_col[p][0] = (uint8_t)(1 + random8() % 3);
  piece_col[p][1] = (uint8_t)(1 + random8() % 3);
  piece_col[p][2] = (uint8_t)(1 + random8() % 3);
  if (!can_place(p, piece_x[p], piece_y[p])) { loser = p; game_over(); }
}

/* ── GAME LOGIC (clay) — land the trio, resolve, attack, respawn. ── */
static void lock_piece(uint8_t p) {
  int8_t i, y;
  uint8_t chain;
  for (i = 0; i < 3; i++) {
    y = (int8_t)(piece_y[p] + i);
    if (y >= 0) grid[p][y][piece_x[p]] = piece_col[p][i];
  }
  board_dirty[p] = 1;
  sfx_tone(1, 200, 4);                         /* lock thunk (low note) */
  if (piece_y[p] < 0) { loser = p; game_over(); return; } /* locked above rim */
  chain = resolve_board(p);
  if (state != ST_PLAY) return;
  if (chain && two_player) {
    garbage_insert(p ^ 1, chain > GARBAGE_CAP ? GARBAGE_CAP : chain);
    if (state != ST_PLAY) return;              /* garbage topped them out */
  }
  spawn_piece(p);
}

/* ── GAME LOGIC (clay) — per-player input + gravity. Edge-triggered moves
 * (one cell per press), held DOWN soft-drops, button 1 cycles the trio's
 * colours (the classic trio "rotate"), button 2 hard-drops. P2 reads PORT B. ── */
static void update_player(uint8_t p) {
  uint8_t pad, fresh, t, fd;
  pad = p ? gg_joypad_read_p2() : gg_joypad_read();
  fresh = (uint8_t)(pad & ~prev_pad[p]);
  prev_pad[p] = pad;
  if ((fresh & JOY_LEFT) && can_place(p, (int8_t)(piece_x[p] - 1), piece_y[p]))
    --piece_x[p];
  if ((fresh & JOY_RIGHT) && can_place(p, (int8_t)(piece_x[p] + 1), piece_y[p]))
    ++piece_x[p];
  if (fresh & JOY_B1) {                         /* cycle colours downward */
    t = piece_col[p][2];
    piece_col[p][2] = piece_col[p][1];
    piece_col[p][1] = piece_col[p][0];
    piece_col[p][0] = t;
    sfx_tone(1, 320, 3);
  }
  if (fresh & JOY_B2) {                         /* hard drop */
    while (can_place(p, piece_x[p], (int8_t)(piece_y[p] + 1))) ++piece_y[p];
    lock_piece(p);                              /* may end the game */
    return;
  }
  if (pad & JOY_DOWN) fall_t[p] += 4;           /* soft drop */
  ++fall_t[p];
  fd = two_player ? VS_FALL_DELAY
                  : (uint8_t)(32 - ((level << 1) + level));      /* 29..5 */
  if (fall_t[p] >= fd) {
    fall_t[p] = 0;
    if (can_place(p, piece_x[p], (int8_t)(piece_y[p] + 1)))
      ++piece_y[p];
    else
      lock_piece(p);                            /* may end the game */
  }
}

/* ── GAME LOGIC (clay) — stage this frame's sprites. Only the falling trios
 * are sprites (locked gems are BG tiles): 3 SAT slots per player. Cells above
 * the rim aren't drawn — they'd poke out from under the HUD strip. The sprite
 * X/Y are FULL-FRAME hardware pixels: the window cell is converted by VCOL/VROW
 * (which add the VIS_* border) and then shifted ×8 to pixels — so the trio
 * lands EXACTLY on its BG-tile cell inside the LCD window.
 * Slot map: 0-2 = P1 trio, 3-5 = P2 trio. Inactive slots park at Y=$E0 (below
 * the 192-line area AND below the LCD window). NEVER park at Y=$D0 — that's the
 * SAT terminator: the VDP stops scanning at the first $D0 and every later slot
 * vanishes. ── */
static void stage_sprites(void) {
  uint8_t p, i, slot;
  for (p = 0; p < 2; p++) {
    uint8_t active = (state == ST_PLAY) && (p == 0 || two_player);
    for (i = 0; i < 3; i++) {
      int8_t r = (int8_t)(piece_y[p] + (int8_t)i);
      uint8_t col = piece_col[p][i] ? piece_col[p][i] : 1;
      slot = (uint8_t)(p * 3 + i);
      if (active && r >= 0)
        gg_sprite_set(slot,
                      (uint8_t)(VCOL((uint8_t)(well_tx[p] + piece_x[p])) << 3),
                      (uint8_t)(VROW((uint8_t)(WELL_TY + r)) << 3),
                      (uint8_t)(T_SPR + col - 1));
      else
        gg_sprite_set(slot, 0, 0xE0, T_SPR);    /* parked below the screen */
    }
  }
}

/* ── GAME LOGIC (clay) — end of game (top-out). `loser` topped out. ── */
static void game_over(void) {
  uint16_t best = score[0];
  if (two_player && score[1] > best) best = score[1];
  if (best > hiscore) {
    hiscore = best;
    hiscore_save(hiscore);  /* cart RAM (real hardware); WRAM copy is live */
  }
  sfx_noise(20);                                /* game-over rumble */
  state = ST_OVER;
  board_dirty[0] = board_dirty[1] = 0;          /* play field is frozen now */
  prev_pad[0] = prev_pad[1] = 0xFF;             /* require a fresh press */
  over_step = 4;                                /* results text, one per vblank
                                                 * (each draw_u16 is 5 software
                                                 * divisions — see the BUDGET
                                                 * FOOTGUN at the main loop) */
}

/* ── GAME LOGIC (clay) — start a run ── */
static void start_game(uint8_t versus) {
  uint8_t p, r, c;
  two_player = versus;
  well_tx[0] = versus ? WELL_VS_P1 : WELL_1P_TX;
  well_tx[1] = WELL_VS_P2;
  /* Stir the PRNG with time-spent-on-title so runs differ. */
  rng ^= (uint16_t)((uint16_t)PORT_V_COUNTER << 3);
  if (rng == 0) rng = 0xACE1;
  for (p = 0; p < 2; p++) {
    for (r = 0; r < GRID_H; r++)
      for (c = 0; c < GRID_W; c++) grid[p][r][c] = EMPTY;
    fall_t[p] = 0;
    score[p] = 0;
    prev_pad[p] = 0xFF;            /* the button that started the game
                                   * shouldn't also rotate the first trio */
  }
  cleared_total = 0;
  level = 1;
  state = ST_PLAY;
  paint_play();
  spawn_piece(0);
  if (versus) spawn_piece(1);
  sfx_tone(0, 200, 10);                         /* start jingle */
}

void main(void) {
  uint8_t pad, fresh;

  /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
   * Init order: VDP regs (display off) → palette → tiles → name table → SAT →
   * R10 → display on (which also enables the frame IRQ) → EI. The one hard
   * rule: EI comes LAST, after every register is in place — the crt0 boots
   * with DI and the FIRST halt would hang forever if interrupts were never
   * enabled. (paint_title's trailing __asm__("ei") IS that final step here.) */
  gg_vdp_init();                     /* R0=0x36 already has IE1 (line IRQ) set */
  gg_load_palette(palette);
  load_font();
  gg_load_tiles((uint16_t)(BG_GEM_BASE * 32), gem_furniture, 32 * 6);
  gg_load_tiles(0x2000, sprite_tiles, 32 * 3);
  gg_sprite_init();
  sfx_init();
  music_init();
  music_play(0);

  /* R10 = SPLIT_LINE arms the line counter: IRQ at the last bar line —
   * scanline 47 in FULL-FRAME terms (window top 24 + HUD 24 - 1). Set
   * once — it reloads itself every underflow. */
  gg_vdp_write_reg(10, SPLIT_LINE);

  hiscore = hiscore_load();          /* cart RAM if present — else 0 */
  state = ST_TITLE;
  prev_pad[0] = prev_pad[1] = 0xFF;
  paint_title();                     /* …ends with EI: interrupts live now */

  for (;;) {
    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: button 1 = 1P, button 2 = 2P versus ── */
      wait_vblank();
      sfx_update();
      music_update();
      wait_split();
      pad = gg_joypad_read();
      fresh = (uint8_t)(pad & ~prev_pad[0]);
      prev_pad[0] = pad;
      if (fresh & JOY_B1) start_game(0);
      else if (fresh & JOY_B2) start_game(1);
      continue;
    }

    if (state == ST_OVER) {
      /* Freeze the boards; button 1 or 2 returns to the title. */
      wait_vblank();
      if (over_step) {                 /* deferred draws — one per vblank */
        if (over_step == 4)
          text_draw(7, 6, two_player ? (loser ? "P1 WINS" : "P2 WINS") : "GAME OVER");
        else if (over_step == 3) { text_draw(10, 4, "P1"); draw_u16(10, 8, score[0]); }
        else if (over_step == 2) { if (two_player) { text_draw(12, 4, "P2"); draw_u16(12, 8, score[1]); } }
        else { text_draw(14, 4, "HI"); draw_u16(14, 8, hiscore); }
        over_step--;
      }
      wait_split();
      sfx_update();
      music_update();
      pad = gg_joypad_read();
      fresh = (uint8_t)(pad & ~prev_pad[0]);
      prev_pad[0] = pad;
      if (fresh & (JOY_B1 | JOY_B2)) {
        state = ST_TITLE;
        prev_pad[0] = prev_pad[1] = 0xFF;
        paint_title();
      }
      continue;
    }

    /* ── ST_PLAY ─────────────────────────────────────────────────────────
     * Frame shape: [vblank: SAT + dirty-well repaints + HUD writes] → [line
     * IRQ at the bar] → [rest of frame: game logic]. VRAM traffic stays
     * inside vblank; logic runs while the VDP draws the field.
     *
     * BUDGET FOOTGUN (inherited from the GG shmup, which found it the hard
     * way): everything between wait_vblank() and wait_split() must finish
     * before the line IRQ at scanline 47 — vblank (70 lines) + the 47 lines
     * above the split ≈ 27k cycles (BIGGER than the SMS's: the 24 never-shown
     * border lines are free). The SAT upload eats ~7k of that. An
     * unconditional HUD redraw (software 16-bit divisions for the digits)
     * blows the budget when it lands the SAME frame as a 60-cell well repaint.
     * So we GATE both behind dirty flags — HUD redraws only when the
     * score/level changed, wells repaint only when a lock/clear dirtied them —
     * and they rarely coincide. */
    wait_vblank();
    gg_sat_upload();                 /* shadow SAT staged at end of last frame */
    if (board_dirty[0]) { board_dirty[0] = 0; repaint_well(0); }
    if (two_player && board_dirty[1]) { board_dirty[1] = 0; repaint_well(1); }
    if (hud_dirty) { hud_dirty = 0; draw_hud(); }
    sfx_update();
    music_update();
    wait_split();                    /* the line-interrupt split — every frame */

    /* ── GAME LOGIC (clay — reshape freely) — both players update EVERY frame
     * (simultaneous versus, not alternating turns). Any update can end the
     * game, so re-check state between them. */
    update_player(0);
    if (two_player && state == ST_PLAY) update_player(1);

    /* Stage the SAT shadow NOW (RAM only — cheap, any time); the actual VRAM
     * upload waits for the next vblank at the top of the loop. */
    stage_sprites();
  }
}
