/* ── shmup.c — SMS vertical shooter (complete example game) ──────────────────
 *
 * A COMPLETE, working game — title screen, 1P and 2P co-op modes, lives,
 * score + hi-score (cart-RAM save code included — see the honesty note at
 * hiscore_save), music + SFX, and the SMS's signature LINE INTERRUPT split:
 * a fixed HUD strip over a drifting starfield, with the scroll change timed
 * by the VDP's programmable line counter.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented SMS footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — enemy patterns, scoring, tuning, art: reshape freely.
 *
 * What depends on what:
 *   sms_hw.h / vdp_init.c / load_tiles.c / load_palette.c / sprite_table.c /
 *     joypad_read.c — the bundled VDP + input runtime (this file's externs).
 *   sms_sfx.{h,c} + sms_music.{h,c} — SN76489 PSG sound layers.
 *   sms_crt0.s — boot + vector table. Its $0038 IM-1 handler is the OTHER
 *     HALF of the line-interrupt idiom below: it acks the VDP (one status
 *     read clears BOTH the frame and line IRQ flags) and returns with
 *     ei/reti. Load-bearing; edit with TROUBLESHOOTING open.
 *
 * Frame budget (NTSC, 60fps): SAT upload (192 OUTs) + HUD redraw fit easily
 * in vblank (70 lines); the whole update (2 ships × 6 bullets × 6 enemies
 * AABB ≈ 72 checks worst case) fits in one frame with room to spare.
 */
#include "sms_hw.h"
#include "sms_sfx.h"
#include "sms_music.h"
#include <stdint.h>

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "VOID PATROL"

extern void    sms_vdp_init(void);
extern void    sms_vdp_write_reg(uint8_t reg, uint8_t value);
extern void    sms_vdp_display_on(void);
extern void    sms_vdp_display_off(void);
extern void    sms_vdp_set_addr(uint16_t addr, uint8_t prefix);
extern void    sms_load_palette(const uint8_t *palette);
extern void    sms_load_tiles(uint16_t vram_dest, const uint8_t *src, uint16_t byte_count);
extern void    sms_set_tilemap_cell(uint8_t row, uint8_t col, uint8_t tile_idx, uint8_t attr);
extern uint8_t sms_joypad_read(void);
extern uint8_t sms_joypad_read_p2(void);
extern void    sms_sprite_init(void);
extern void    sms_sprite_set(uint8_t slot, uint8_t x, uint8_t y, uint8_t tile);
extern void    sms_sat_upload(void);

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Palettes. SMS CRAM is 2-2-2 BGR (--BBGGRR): R bits 0-1, G bits 2-3,
 * B bits 4-5. White = 0x3F. BG colour 0 doubles as the backdrop/border. */
static const uint8_t palette[32] = {
  /* BG: 0 = space black, 1 = HUD-bar blue, 2 = dim star, 3 = white (text),
   * 4 = deep-navy nebula band */
  0x00, 0x20, 0x2A, 0x3F, 0x10, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  /* Sprites: 1 = white (P1 ship), 2 = yellow (bullet), 3 = red (enemy),
   * 4 = green (P2 ship). One shared sprite palette on SMS — per-"sprite"
   * colour means per-TILE colour indices, not per-sprite palettes. */
  0x00, 0x3F, 0x0F, 0x03, 0x0C, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};

/* ── GAME LOGIC (clay) — BG tile inventory (BG bank $0000) ───────────────────
 * tile 0          = blank space (colour 0)
 * tiles 1..37     = font: digits 0-9, A-Z, '-'  (uploaded 1bpp→4bpp below)
 * tile 38         = dim star   (one colour-2 pixel)
 * tile 39         = bright star(one colour-3 pixel + glow)
 * tile 40         = solid HUD bar (colour 1) — the split seam hides in it
 * tile 41         = nebula band (solid colour 4) — keeps the screen from
 *                   reading as one flat colour (render-health floor) */
#define FONT_BASE  1
#define BG_STAR    38
#define BG_BRITE   39
#define BG_HUDBAR  40
#define BG_BAND    41

/* 1bpp font (same glyph set as the NES/GB examples — 0-9, A-Z, '-').
 * Stored 8 bytes/glyph; expanded to the SMS's 32-byte 4bpp tiles at upload
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

/* Expand 1bpp glyphs into 4bpp SMS tiles as colour 3 (planes 0+1 set).
 * SMS tile rows are 4 bytes: plane0, plane1, plane2, plane3. */
static void load_font(void) {
  uint8_t g, r, bits;
  sms_vdp_set_addr((uint16_t)(FONT_BASE * 32), VDP_VRAM_WRITE);
  for (g = 0; g < 37; g++) {
    for (r = 0; r < 8; r++) {
      bits = font8[g][r];
      PORT_VDP_DATA = bits;   /* plane 0 */
      PORT_VDP_DATA = bits;   /* plane 1 → colour index 3 */
      PORT_VDP_DATA = 0;      /* plane 2 */
      PORT_VDP_DATA = 0;      /* plane 3 */
    }
  }
}

/* Star + HUD-bar + band tiles (4bpp, 32 bytes each — rows of plane0..3). */
static const uint8_t deco_tiles[128] = {
  /* BG_STAR: one colour-2 pixel */
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x10,0x00,0x00, 0x00,0x00,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  /* BG_BRITE: colour-3 dot with colour-2 glow */
  0x00,0x00,0x00,0x00, 0x00,0x10,0x00,0x00, 0x10,0x28,0x10,0x00, 0x00,0x10,0x00,0x00,
  0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  /* BG_HUDBAR: solid colour 1 — the split seam lands inside this row */
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00,
  /* BG_BAND: solid colour 4 (binary 100 → plane 2 only) */
  0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00,
  0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xFF,0x00,
};

/* Sprite tiles (sprite bank $2000 — vdp_init's R6=0xFF baseline reads
 * sprite patterns from $2000, so upload there, not $0000). */
static const uint8_t sprite_tiles[32 * 4] = {
  /* T_SHIP1 — arrowhead, colour 1 (white) */
  0x18,0x00,0x00,0x00, 0x18,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00, 0x3C,0x00,0x00,0x00,
  0x7E,0x00,0x00,0x00, 0xFF,0x00,0x00,0x00, 0xDB,0x00,0x00,0x00, 0x81,0x00,0x00,0x00,
  /* T_SHIP2 — same hull, colour 4 = binary 100 → plane 2 only (green) */
  0x00,0x00,0x18,0x00, 0x00,0x00,0x18,0x00, 0x00,0x00,0x3C,0x00, 0x00,0x00,0x3C,0x00,
  0x00,0x00,0x7E,0x00, 0x00,0x00,0xFF,0x00, 0x00,0x00,0xDB,0x00, 0x00,0x00,0x81,0x00,
  /* T_BULLET — slug, colour 2 (yellow, plane 1) */
  0x00,0x18,0x00,0x00, 0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00,
  0x00,0x3C,0x00,0x00, 0x00,0x3C,0x00,0x00, 0x00,0x18,0x00,0x00, 0x00,0x00,0x00,0x00,
  /* T_ENEMY — X fighter, colour 3 (red, planes 0+1) */
  0x81,0x81,0x00,0x00, 0x42,0x42,0x00,0x00, 0x24,0x24,0x00,0x00, 0xFF,0xFF,0x00,0x00,
  0xFF,0xFF,0x00,0x00, 0x24,0x24,0x00,0x00, 0x42,0x42,0x00,0x00, 0x81,0x81,0x00,0x00,
};
#define T_SHIP1  0
#define T_SHIP2  1
#define T_BULLET 2
#define T_ENEMY  3

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Object pools — fixed slots, no allocation (3.58MHz Z80, 8KB WRAM: a heap
 * buys you nothing). SAT slot map: 0 = P1 ship, 1 = P2 ship, 2-7 bullets,
 * 8-13 enemies — 14 of 64 slots; mind the 8-sprites-PER-SCANLINE limit when
 * adding rows of objects (the 9th sprite on a line silently vanishes). */
#define MAX_BULLETS 6
#define MAX_ENEMIES 6
#define START_LIVES 3
/* HUD layout: row 0 = text (SC / HI / LV), row 1 = blank, row 2 = solid bar.
 * The bar row is both the visual divider AND where the split seam hides. */
#define HUD_ROWS    3
#define HUD_PX      (HUD_ROWS * 8)

static uint8_t bullet_active[MAX_BULLETS];
static uint8_t bullet_x[MAX_BULLETS];
static uint8_t bullet_y[MAX_BULLETS];
static uint8_t enemy_active[MAX_ENEMIES];
static uint8_t enemy_x[MAX_ENEMIES];
static uint8_t enemy_y[MAX_ENEMIES];

/* Players: index 0 = P1 (port A), 1 = P2 (port B, 2P co-op only). */
static uint8_t ship_x[2], ship_y[2], ship_alive[2], fire_cd[2];
static uint8_t two_player;       /* mode chosen on the title screen */
static uint8_t lives;            /* shared pool in co-op (arcade style) */
static uint16_t score;
static uint16_t hiscore;
static uint8_t spawn_timer;
static uint8_t scroll_x;         /* starfield drift (split-scrolled below HUD) */
static uint8_t over_pending;     /* defer GAME OVER text to the next vblank */
static uint8_t hud_dirty;        /* score/lives changed → redraw next vblank */
static uint16_t rng = 0xACE1;

/* Game states — the shell every example shares: title → play → game over. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * LINE-INTERRUPT SPLIT SCROLL — the SMS's signature trick (fixed status bar
 * over a moving field, palette splits, water effects). The VDP has ONE
 * scroll register pair for the whole frame; to keep the HUD fixed while the
 * starfield drifts you change the scroll MID-FRAME. Where the NES needs the
 * sprite-0-hit HACK (park a sprite, busy-poll a status bit, burn scanlines
 * spinning), the SMS has a real, PROGRAMMABLE line interrupt:
 *
 *   R10 = N        line counter: a down-counter reloaded with N every line
 *                  outside the active area; underflow → IRQ at line N.
 *   R0 bit 4 (IE1) line-IRQ enable (already set in vdp_init's 0x36 baseline).
 *   R1 bit 5 (IE0) frame(vblank)-IRQ enable (set by sms_vdp_display_on's 0xE0).
 *
 * Both IRQs land on the Z80's IM-1 vector at $0038. The crt0's handler does
 * the canonical minimal handshake:  push af / in a,($BF) / pop af / ei / reti
 * — reading the status port ACKS the VDP (clears BOTH pending flags; skip
 * the read and the IRQ line stays asserted = interrupt storm), and EI must
 * precede RETI or interrupts stay off forever after the first one.
 *
 * Because the handler does no work, the MAIN loop synchronizes with HALT:
 * the Z80 sleeps until the next interrupt, then we read the V-counter (port
 * $7E) to learn WHICH one woke us — line IRQs only fire during the active
 * area (V < 0xC0 here), the frame IRQ fires at vblank (V ≥ 0xC0).
 *
 *   wait_vblank():  sleep until the frame IRQ  → do per-frame VRAM work,
 *                   write R8 = 0 so the HUD strip renders unscrolled.
 *   wait_split():   sleep until the line IRQ at line 23 (R10 = HUD_PX-1,
 *                   the last line of the solid bar row — any single-line
 *                   tear from the mid-row write hides inside solid colour)
 *                   → write R8 = scroll_x; everything below drifts.
 *
 * FOOTGUN — you cannot poll once IRQs are on: sms_vblank_wait() spins on
 * the same status port the ISR reads. The ISR always wins the race (the
 * IRQ fires the instant the flag sets), eats the flag, and the poll loop
 * hangs forever. HALT + V-counter is the IRQ-era replacement.
 *
 * FOOTGUN — why the field drifts HORIZONTALLY: the Y-scroll register (R9)
 * is LATCHED ONCE PER FRAME by the VDP; mid-frame R9 writes do nothing
 * until the next frame, so a "vertical scroll below the HUD" split is
 * impossible on this chip. X-scroll (R8) is sampled per line — that's the
 * one you can change mid-frame. (Vertical motion: animate the star tiles
 * or stream the name table instead.)
 *
 * Requires: R10 programmed, IE1 + IE0 enabled, EI executed once after
 * display-on, the crt0's ack-only ISR, and wait_vblank/wait_split called
 * EVERY frame in this order. R10 reloads after each underflow, so the line
 * IRQ re-fires every HUD_PX lines all the way down the frame — the later
 * wakes harmlessly interrupt game logic (the ISR acks them) and re-halt
 * inside the NEXT wait_vblank(). */
#define SPLIT_LINE (HUD_PX - 1)

static void wait_vblank(void) {
  /* check-first: if game logic overran into vblank, don't sleep a frame */
  while (PORT_V_COUNTER < 0xC0) { __asm__("halt"); }
  sms_vdp_write_reg(8, 0);          /* HUD strip renders with X scroll 0 */
}

static void wait_split(void) {
  /* halt-first: vblank work always ends inside vblank (V ≥ 0xC0), and the
   * first wake at V < 0xC0 is the line IRQ at SPLIT_LINE */
  do { __asm__("halt"); } while (PORT_V_COUNTER >= 0xC0);
  sms_vdp_write_reg(8, scroll_x);   /* field below the bar drifts */
}

/* ── HARDWARE IDIOM (load-bearing) — hi-score in Sega-mapper cart RAM ────────
 * The Sega mapper's control register at $FFFC: bit 3 maps the cart's 8KB
 * battery RAM into $8000-$BFFF (bank slot 2). Map → copy → unmap; keep the
 * window short so stray pointer bugs can't shred the save. The block is
 * magic + value + checksum so a never-written cart (all $FF) reads back as
 * "no save" instead of a garbage hi-score.
 *
 * NOTE the $FFFC address: it's IN the WRAM mirror ($C000-$DFFF mirrors at
 * $E000-$FFFF), so this write also lands in WRAM at $DFFC — the mapper
 * just snoops the bus. That's why the crt0 parks SP at $DFF0: the bytes
 * above it ($DFFC-$FFFF) belong to the mapper registers' shadow.
 *
 * HONESTY (verified 2026-06-10 against the bundled gpgx core): gpgx only
 * instantiates the Sega mapper for ROMs LARGER than 48KB, and this build
 * pipeline emits 32KB ROMs — so in-emulator the $8000 window stays open-bus
 * (reads $FF), the magic check fails, and the game falls back to the WRAM
 * hi-score (in-session only). The code below is still the correct
 * real-hardware idiom and lights up unchanged on a >48KB build or a cart
 * with battery RAM: the load path is self-falsifying, never wrong. */
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

/* ── GAME LOGIC (clay) — xorshift16 PRNG (~tens of cycles per call) ── */
static uint8_t random8(void) {
  uint16_t r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (uint8_t)r;
}

/* ── GAME LOGIC (clay) — text via the font tiles ─────────────────────────────
 * These write the name table directly, so call them only during vblank (or
 * with the display off): VRAM access during active display races the VDP's
 * own fetches and drops/garbles bytes on real hardware. */
static uint8_t font_tile(char ch) {
  if (ch >= '0' && ch <= '9') return (uint8_t)(FONT_BASE + (ch - '0'));
  if (ch >= 'A' && ch <= 'Z') return (uint8_t)(FONT_BASE + 10 + (ch - 'A'));
  if (ch == '-') return (uint8_t)(FONT_BASE + 36);
  return 0;                         /* space → blank tile */
}

static void text_draw(uint8_t row, uint8_t col, const char *s) {
  while (*s) sms_set_tilemap_cell(row, col++, font_tile(*s++), 0);
}

static void draw_u16(uint8_t row, uint8_t col, uint16_t v) {
  uint8_t d[5], i;
  for (i = 0; i < 5; i++) { d[i] = (uint8_t)(v % 10); v /= 10; }
  for (i = 0; i < 5; i++)
    sms_set_tilemap_cell(row, (uint8_t)(col + i), (uint8_t)(FONT_BASE + d[4 - i]), 0);
}

/* ── GAME LOGIC (clay) — HUD: SC sssss  HI hhhhh  LV n on row 0 ── */
static void draw_hud_labels(void) {
  text_draw(0, 1, "SC");
  text_draw(0, 11, "HI");
  text_draw(0, 21, "LV");
}

static void draw_hud(void) {
  draw_u16(0, 4, score);
  draw_u16(0, 14, hiscore);
  sms_set_tilemap_cell(0, 24, (uint8_t)(FONT_BASE + (lives > 9 ? 9 : lives)), 0);
}

/* ── GAME LOGIC (clay) — screen painters ─────────────────────────────────────
 * Full-screen repaints happen with the DISPLAY OFF (free VRAM access, and a
 * clean cut instead of a visible wipe). While the display is off the frame
 * IRQ doesn't fire — so no halt-based waits in here, or you hang forever. */
/* PERF FOOTGUN (found the slow way): the obvious per-cell version of this —
 * sms_set_tilemap_cell(r, c, (r*7 + c*5) % 11 ? ... ) — costs ~35 FRAMES:
 * SDCC's 16-bit `%` is a software-division call and set_tilemap_cell redoes
 * the 4-OUT address setup for every cell; 672 cells of that is over 2M
 * cycles of "black screen" between title and game. So: set the VRAM address
 * ONCE per row (the data port autoincrements through the row's 64 bytes)
 * and keep the star pattern in add/compare counters. Paints in ~1 frame. */
static void paint_starfield(uint8_t from_row) {
  uint8_t r, c, t, s, q;
  for (r = from_row; r < 24; r++) {
    sms_vdp_set_addr((uint16_t)(0x3800 + (uint16_t)r * 64), VDP_VRAM_WRITE);
    /* s = (r*7) mod 11, q = (r*3) mod 29 — then walk +5 mod 11 / +13 mod 29
     * across the columns (same field as the % expressions, no division). */
    s = (uint8_t)(r * 7); while (s >= 11) s -= 11;
    q = (uint8_t)(r * 3); while (q >= 29) q -= 29;
    for (c = 0; c < 32; c++) {
      t = ((r & 3) == 2) ? BG_BAND : 0;   /* nebula bands every 4th row */
      if (s == 0) t = BG_STAR;
      if (q == 0) t = BG_BRITE;
      PORT_VDP_DATA = t;                  /* name-table entry low byte: tile */
      PORT_VDP_DATA = 0;                  /* high byte: flips/palette/priority */
      s += 5;  if (s >= 11) s -= 11;
      q += 13; if (q >= 29) q -= 29;
    }
  }
}

static void paint_title(void) {
  sms_vdp_display_off();
  paint_starfield(0);
  text_draw(6, (uint8_t)((32 - (sizeof(GAME_TITLE) - 1)) / 2), GAME_TITLE);
  text_draw(11, 10, "1P START - 1");
  text_draw(13, 10, "2P CO-OP - 2");
  text_draw(17, 12, "HI");
  draw_u16(17, 15, hiscore);
  sms_sprite_init();                /* park every sprite off-screen */
  sms_sat_upload();
  sms_vdp_write_reg(8, 0);
  sms_vdp_display_on();             /* re-enables the frame IRQ too */
}

static void paint_field(void) {
  uint8_t c;
  sms_vdp_display_off();
  for (c = 0; c < 32; c++) {
    sms_set_tilemap_cell(0, c, 0, 0);          /* row 0: HUD text row */
    sms_set_tilemap_cell(1, c, 0, 0);          /* row 1: breathing room */
    sms_set_tilemap_cell(2, c, BG_HUDBAR, 0);  /* row 2: bar = divider + seam */
  }
  paint_starfield(HUD_ROWS);
  draw_hud_labels();
  draw_hud();
  sms_sprite_init();
  sms_sat_upload();
  sms_vdp_write_reg(8, 0);
  sms_vdp_display_on();
}

/* ── GAME LOGIC (clay) — pools ── */
static void fire_bullet(uint8_t p) {
  uint8_t i;
  for (i = 0; i < MAX_BULLETS; i++) {
    if (!bullet_active[i]) {
      bullet_active[i] = 1;
      bullet_x[i] = ship_x[p];
      bullet_y[i] = (uint8_t)(ship_y[p] - 8);
      /* Voice 2 doubles as the SFX channel: the blip steals the bass for a
       * few frames, then sfx_update() silences it and the tracker re-tones
       * it on its next step — classic "sfx wins over music" arbitration. */
      sfx_tone(2, 180, 3);
      return;
    }
  }
}

static void spawn_enemy(void) {
  uint8_t i;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemy_active[i]) {
      enemy_active[i] = 1;
      enemy_x[i] = (uint8_t)(16 + (random8() & 0x7F) + (random8() & 0x3F));
      enemy_y[i] = HUD_PX + 8;       /* spawn just below the HUD bar */
      return;
    }
  }
}

/* AABB, both boxes 8x8. */
static uint8_t hits(uint8_t ax, uint8_t ay, uint8_t bx, uint8_t by) {
  uint8_t dx = (ax > bx) ? (uint8_t)(ax - bx) : (uint8_t)(bx - ax);
  uint8_t dy = (ay > by) ? (uint8_t)(ay - by) : (uint8_t)(by - ay);
  return (uint8_t)((dx < 8) && (dy < 8));
}

/* ── GAME LOGIC (clay) — start a run / end a run ── */
static void start_game(uint8_t players) {
  uint8_t i;
  two_player = players;
  for (i = 0; i < MAX_BULLETS; i++) bullet_active[i] = 0;
  for (i = 0; i < MAX_ENEMIES; i++) enemy_active[i] = 0;
  ship_x[0] = two_player ? 96 : 124; ship_y[0] = 160; ship_alive[0] = 1; fire_cd[0] = 0;
  ship_x[1] = 152;                   ship_y[1] = 160; ship_alive[1] = two_player; fire_cd[1] = 0;
  lives = START_LIVES;
  score = 0;
  spawn_timer = 0;
  scroll_x = 0;
  over_pending = 0;
  paint_field();
  state = ST_PLAY;
}

static void game_over(void) {
  if (score > hiscore) {
    hiscore = score;
    hiscore_save(hiscore);  /* cart RAM (real hardware); WRAM copy is live */
  }
  sfx_noise(20);
  state = ST_OVER;
  over_pending = 1;          /* text is drawn next vblank — not mid-frame */
}

/* ── GAME LOGIC (clay) — per-player update ── */
static void update_ship(uint8_t p, uint8_t pad) {
  if (!ship_alive[p]) return;
  if ((pad & JOY_LEFT)  && ship_x[p] > 8)            ship_x[p] = (uint8_t)(ship_x[p] - 2);
  if ((pad & JOY_RIGHT) && ship_x[p] < 240)          ship_x[p] = (uint8_t)(ship_x[p] + 2);
  if ((pad & JOY_UP)    && ship_y[p] > (HUD_PX + 8)) ship_y[p] = (uint8_t)(ship_y[p] - 2);
  if ((pad & JOY_DOWN)  && ship_y[p] < 182)          ship_y[p] = (uint8_t)(ship_y[p] + 2);
  if ((pad & JOY_B1) && fire_cd[p] == 0) {
    fire_bullet(p);
    fire_cd[p] = 8;
  }
  if (fire_cd[p] > 0) fire_cd[p]--;
}

/* Stage the SAT shadow for this frame. Inactive slots park at Y=$E0 (below
 * the 192-line area). NEVER park at Y=$D0 — that's the SAT terminator: the
 * VDP stops scanning at the first $D0 and every later slot vanishes. */
static void stage_sprites(void) {
  uint8_t i;
  sms_sprite_set(0, ship_x[0], ship_alive[0] ? ship_y[0] : 0xE0, T_SHIP1);
  sms_sprite_set(1, ship_x[1], ship_alive[1] ? ship_y[1] : 0xE0, T_SHIP2);
  for (i = 0; i < MAX_BULLETS; i++)
    sms_sprite_set((uint8_t)(2 + i), bullet_x[i], bullet_active[i] ? bullet_y[i] : 0xE0, T_BULLET);
  for (i = 0; i < MAX_ENEMIES; i++)
    sms_sprite_set((uint8_t)(8 + i), enemy_x[i], enemy_active[i] ? enemy_y[i] : 0xE0, T_ENEMY);
}

void main(void) {
  uint8_t i, pad, pad2, prev_pad = 0;

  /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
   * Init order: VDP regs (display off) → palette → tiles → name table →
   * SAT → R10 → display on (which also enables the frame IRQ) → EI. The
   * one hard rule: EI comes LAST, after every register is in place — the
   * crt0 boots with DI and the FIRST halt would hang forever if interrupts
   * were never enabled. */
  sms_vdp_init();                    /* R0=0x36 already has IE1 (line IRQ) set */
  sms_load_palette(palette);
  load_font();
  sms_load_tiles((uint16_t)(BG_STAR * 32), deco_tiles, 128);
  sms_load_tiles(0x2000, sprite_tiles, 32 * 4);
  sms_sprite_init();
  sfx_init();
  music_init();
  music_play(0);

  /* R10 = SPLIT_LINE arms the line counter: IRQ at the last bar line. Set
   * once — it reloads itself every underflow. */
  sms_vdp_write_reg(10, SPLIT_LINE);

  hiscore = hiscore_load();          /* cart RAM if present — else 0 */
  state = ST_TITLE;
  paint_title();
  __asm__("ei");                     /* interrupts live from here on */

  for (;;) {
    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: button 1 = 1P, button 2 = 2P co-op ── */
      wait_vblank();
      sfx_update();
      music_update();
      pad = sms_joypad_read();
      if ((pad & JOY_B1) && !(prev_pad & JOY_B1)) start_game(0);
      else if ((pad & JOY_B2) && !(prev_pad & JOY_B2)) start_game(1);
      prev_pad = pad;
      continue;
    }

    if (state == ST_OVER) {
      /* Freeze the final frame; button 1 or 2 returns to the title. */
      wait_vblank();
      if (over_pending) {            /* deferred draw — now we're in vblank */
        over_pending = 0;
        text_draw(11, 11, "GAME OVER");
        draw_hud();                  /* show the (possibly new) hi-score */
      }
      wait_split();                  /* keep the HUD/field split alive */
      sfx_update();
      music_update();
      pad = sms_joypad_read();
      if ((pad & (JOY_B1 | JOY_B2)) && !(prev_pad & (JOY_B1 | JOY_B2))) {
        state = ST_TITLE;
        paint_title();
      }
      prev_pad = pad;
      continue;
    }

    /* ── ST_PLAY ─────────────────────────────────────────────────────────
     * Frame shape: [vblank: SAT + HUD writes, R8=0] → [line IRQ at the bar:
     * R8=scroll] → [rest of frame: game logic]. VRAM traffic stays inside
     * vblank; logic runs while the VDP draws the field.
     *
     * BUDGET FOOTGUN: everything between wait_vblank() and wait_split()
     * must finish before the line IRQ at line 23 — vblank (70 lines) + the
     * HUD strip (23) ≈ 21k cycles. The SAT upload eats ~7k of that. An
     * unconditional draw_hud() here (10 software 16-bit divisions for the
     * digits) blew the budget EVERY frame: the seam slipped to a later
     * reload of the line counter and the top of the starfield rendered
     * unscrolled in jittery stripes. Hence the dirty flag — the HUD only
     * redraws on the frame after the score/lives actually changed. */
    wait_vblank();
    sms_sat_upload();                /* shadow SAT staged at end of last frame */
    if (hud_dirty) {
      hud_dirty = 0;
      draw_hud();
    }
    sfx_update();
    music_update();
    wait_split();                    /* the line-interrupt split — every frame */

    /* ── GAME LOGIC (clay) from here down ── */
    pad  = sms_joypad_read();
    pad2 = two_player ? sms_joypad_read_p2() : 0;
    update_ship(0, pad);
    if (two_player) update_ship(1, pad2);

    /* Starfield drift (the split keeps the HUD strip out of it). */
    spawn_timer++;
    if ((spawn_timer & 3) == 0) scroll_x++;

    for (i = 0; i < MAX_BULLETS; i++) {
      if (!bullet_active[i]) continue;
      if (bullet_y[i] < HUD_PX + 4) bullet_active[i] = 0;
      else bullet_y[i] = (uint8_t)(bullet_y[i] - 4);
    }

    for (i = 0; i < MAX_ENEMIES; i++) {
      if (!enemy_active[i]) continue;
      if (enemy_y[i] >= 190) enemy_active[i] = 0;
      else enemy_y[i]++;
    }

    /* Bullets ↔ enemies. */
    {
      uint8_t b, e;
      for (b = 0; b < MAX_BULLETS; b++) {
        if (!bullet_active[b]) continue;
        for (e = 0; e < MAX_ENEMIES; e++) {
          if (!enemy_active[e]) continue;
          if (hits(bullet_x[b], bullet_y[b], enemy_x[e], enemy_y[e])) {
            bullet_active[b] = 0;
            enemy_active[e] = 0;
            score++;
            hud_dirty = 1;
            sfx_noise(6);
            break;
          }
        }
      }
    }

    /* Enemies ↔ ships: shared life pool (arcade co-op). */
    {
      uint8_t e, p;
      for (e = 0; e < MAX_ENEMIES; e++) {
        if (!enemy_active[e]) continue;
        for (p = 0; p < 2; p++) {
          if (!ship_alive[p]) continue;
          if (hits(enemy_x[e], enemy_y[e], ship_x[p], ship_y[p])) {
            enemy_active[e] = 0;
            sfx_noise(14);
            if (lives > 0) lives--;
            hud_dirty = 1;
            if (lives == 0) {
              game_over();
            } else {
              /* respawn knockback */
              ship_y[p] = 160;
              ship_x[p] = p ? 152 : (two_player ? 96 : 124);
            }
          }
        }
      }
    }

    if (spawn_timer >= 32) {
      spawn_timer = 0;
      spawn_enemy();
    }

    /* Stage the SAT shadow NOW (RAM only — cheap, any time); the actual
     * VRAM upload waits for the next vblank at the top of the loop. */
    stage_sprites();
  }
}
