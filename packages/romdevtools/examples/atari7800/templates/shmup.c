/* ── shmup.c — Atari 7800 dense-field shooter (complete example game) ────────
 *
 * A COMPLETE, working game — title screen, 1P and 2P co-op modes, lives,
 * score + session hi-score, music + SFX, and the 7800's signature feature:
 * MARIA SPRITE QUANTITY. 24 meteors + 2 ships + 4 shots = 30 independent
 * moving objects on screen at once — a field no 2600 (5 hardware objects)
 * and no stock NES (8-sprites-per-scanline flicker) draws this comfortably.
 * On the 7800 every object is just a 4-byte display-list entry that MARIA
 * DMAs each scanline; quantity is the whole point of the chip.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented 7800/MARIA footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — meteor patterns, scoring, tuning, art: reshape freely.
 *
 * What depends on what:
 *   atari7800_sfx.{h,c} — TIA one-shot effects (we give it voice 1; the
 *     inline music player below owns voice 0 — TIA only HAS two voices).
 *   cc65's atari7800 target crt0 + atari7800.cfg — boot, BSS in RAM1
 *     ($1800-$203F), C parameter stack at the TOP of RAM3 growing DOWN
 *     ($2800 →). This game claims the BOTTOM of RAM3 ($2200-$25FD) for its
 *     display-list pool — see the RAM MAP below before moving anything.
 *
 * PERSISTENCE — honest note: the canonical 7800 save path is the High Score
 * Cart (HSC): a pass-through cartridge with 2KB battery RAM at $1000-$17FF
 * plus a directory ROM. The bundled prosystem core does NOT implement HSC
 * (probed 2026-06: retro_get_memory(SAVE_RAM) size = 0, and the core binary
 * has no HSC code at all), so this game keeps the hi-score IN-SESSION ONLY
 * (it survives play → title → play, dies on power-off). Do not fake
 * persistence the hardware path can't back — if a future core round adds
 * HSC, wire hiscore into $1000-$17FF and it becomes real.
 *
 * Frame budget (NTSC): with ~125 emitted object-rows/frame this update is
 * deliberately ALLOWED to take two 60Hz frames (the game simulates at a
 * rock-steady 30Hz). MARIA does not care — it re-walks the same DLs every
 * frame, so a slow CPU loop never blanks or tears the whole screen. That
 * trade (object quantity vs sim rate) is THE 7800 design dial; see the
 * DMA-budget comment at the display-list pool.
 */

#include <stdint.h>
#include <string.h>
#include "atari7800_sfx.h"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "METEOR SWARM"

/* ── MARIA + TIA + RIOT registers (full list in MENTAL_MODEL.md) ── */
#define BACKGRND  (*(volatile uint8_t*)0x20)
#define P0C1      (*(volatile uint8_t*)0x21)
#define P0C2      (*(volatile uint8_t*)0x22)
#define P0C3      (*(volatile uint8_t*)0x23)
#define P1C1      (*(volatile uint8_t*)0x25)
#define P1C2      (*(volatile uint8_t*)0x26)
#define P1C3      (*(volatile uint8_t*)0x27)
#define MSTAT     (*(volatile uint8_t*)0x28)
#define P2C1      (*(volatile uint8_t*)0x29)
#define P2C2      (*(volatile uint8_t*)0x2A)
#define P2C3      (*(volatile uint8_t*)0x2B)
#define DPPH      (*(volatile uint8_t*)0x2C)
#define P3C1      (*(volatile uint8_t*)0x2D)
#define P3C2      (*(volatile uint8_t*)0x2E)
#define P3C3      (*(volatile uint8_t*)0x2F)
#define DPPL      (*(volatile uint8_t*)0x30)
#define P4C1      (*(volatile uint8_t*)0x31)
#define P4C3      (*(volatile uint8_t*)0x33)
#define CHARBASE  (*(volatile uint8_t*)0x34)
#define P5C1      (*(volatile uint8_t*)0x35)
#define OFFSET    (*(volatile uint8_t*)0x38)
#define P6C1      (*(volatile uint8_t*)0x39)
#define CTRL      (*(volatile uint8_t*)0x3C)
#define P7C1      (*(volatile uint8_t*)0x3D)

/* TIA audio (shared with the music player below; atari7800_sfx.c has the
 * same defines — the chip is tiny enough that duplicating 6 lines beats a
 * header dependency the fork machinery would have to carry). */
#define AUDC0  (*(volatile uint8_t*)0x15)
#define AUDC1  (*(volatile uint8_t*)0x16)
#define AUDF0  (*(volatile uint8_t*)0x17)
#define AUDF1  (*(volatile uint8_t*)0x18)
#define AUDV0  (*(volatile uint8_t*)0x19)
#define AUDV1  (*(volatile uint8_t*)0x1A)

#define SWCHA  (*(volatile uint8_t*)0x280)
#define INPT4  (*(volatile uint8_t*)0x0C)   /* P1 fire, active low (bit 7) */
#define INPT5  (*(volatile uint8_t*)0x0D)   /* P2 fire, active low (bit 7) */

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * SWCHA joystick bit order — the #1 7800 input footgun. After the ~SWCHA
 * invert, port 0 (left jack) lives in the HIGH nibble as
 * Right($80) Left($40) Down($20) Up($10), and port 1 (right jack) in the
 * LOW nibble as Right($08) Left($04) Down($02) Up($01). Writing the masks
 * in "natural reading order" (UP=0x80…) is exactly REVERSED and makes the
 * stick's vertical axis steer horizontally — a bug weird enough to
 * misdiagnose as a core problem. Verified bit-by-bit against prosystem. */
#define J1_RIGHT 0x80
#define J1_LEFT  0x40
#define J1_DOWN  0x20
#define J1_UP    0x10
#define J2_RIGHT 0x08
#define J2_LEFT  0x04
#define J2_DOWN  0x02
#define J2_UP    0x01

/* ════════════════════════════════════════════════════════════════════════
 * RAM MAP — the 7800 gives you 4KB ($1800-$27FF) and the stock cc65 config
 * only hands the linker the first 2112 bytes of it:
 *
 *   $1800-$203F  RAM1  — cc65 DATA + BSS (everything `static` below)
 *   $2040-$20FF  (gap the cc65 cfg skips — unused here)
 *   $2100-$213F  RAM2  — unused here
 *   $2200-$25FD  RAM3 bottom — OUR display-list pool/canvas arena (POOLB):
 *                  raw pointer, invisible to the linker, 1022 bytes
 *   $25FE-$27FF  RAM3 top — cc65 C parameter stack (crt0 starts it at $2800
 *                  growing DOWN; ~510 bytes is plenty for these call depths,
 *                  but if you add deep recursion, shrink POOLB_LINES first)
 * ════════════════════════════════════════════════════════════════════════ */
#define POOLB ((uint8_t*)0x2200)

/* ── Screen layout (243 NTSC zone-lines; the visible frame is ~lines 9-232) ──
 *   lines   0- 15  blank (top overscan)            1 DLL entry, 16 tall
 *   lines  16- 23  HUD text row (RAM canvas)       8 entries, 1 tall each
 *   lines  24- 25  divider band                    1 entry, 2 tall
 *   lines  26-145  THE FIELD — 120 one-line zones  120 entries (the pool)
 *   lines 146-147  divider band                    1 entry, 2 tall
 *   lines 148-242  decor stripes (planet glow)     12 entries, 8/7 tall
 * Total: 143 DLL entries = 429 bytes (vs 729 for the naive all-1-line DLL —
 * mixed zone heights are how real 7800 games keep the DLL small).          */
#define FIELD_LINES   120
#define FIELD_DLL_OFF 30          /* byte offset of field entry 0 in dll[] */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Object art. 160A mode: 1 byte = 4 pixels of 2 bits each; pixel value
 * 1/2/3 = colour 1/2/3 of the palette the DL entry names, 0 = transparent.
 * Rows are stored top-down, consecutive (the 1-scanline-zone pattern below
 * means NO page-alignment dance — see "offset addressing quirk" in
 * MENTAL_MODEL.md for what multi-line zones would demand instead). */

/* Player ship, 12px wide (3 bytes) x 8 rows. Colours: 1 hull, 2 canopy,
 * 3 highlight. Drawn with palette 1 (P1 ship) or 2 (P2 ship). */
static const uint8_t GFX_SHIP[8 * 3] = {
  0x00, 0x0C, 0x00,    /*      33       */
  0x00, 0x2D, 0x80,    /*     2331      */
  0x00, 0x69, 0x60,    /*    12 21 1    */
  0x01, 0x69, 0x64,    /*   112 21 11   */
  0x05, 0x69, 0x65,    /*  1112 21 111  */
  0x16, 0xAA, 0x95,    /* 11222222 2111 */
  0x55, 0x55, 0x55,    /* 111111111111  */
  0x10, 0x41, 0x04,    /* 1   1    1    */
};

/* Meteor, 8px wide (2 bytes) x 4 rows. Colour 1 core / 2 rim / 3 flash. */
static const uint8_t GFX_METEOR[4 * 2] = {
  0x29, 0x60,          /*  2 31 2   */
  0xA5, 0x58,          /* 2211 112  */
  0x96, 0x5A,          /* 2112 1122 */
  0x29, 0xA0,          /*  2 1 22   */
};

/* Shot, 4px wide (1 byte) x 3 rows — a thin colour-1 streak. */
static const uint8_t GFX_SHOT[3] = { 0x14, 0x14, 0x14 };

/* DL mode bytes for the 4-byte (direct) entry form: palette in bits 5-7,
 * width as (32 - width_bytes) in bits 0-4 (must be non-zero — a zero low
 * 5 bits would make MARIA parse a 5-byte entry instead). */
#define MODE_SHIP1  ((1u << 5) | (32 - 3))   /* palette 1, 3 bytes wide */
#define MODE_SHIP2  ((2u << 5) | (32 - 3))   /* palette 2 */
#define MODE_METEOR ((3u << 5) | (32 - 2))   /* palette 3, 2 bytes wide */
#define MODE_SHOT   ((4u << 5) | (32 - 1))   /* palette 4, 1 byte wide  */

/* ── GAME LOGIC (clay) — 8x8 text font, 1 bit per pixel, 7px glyphs.
 * The 7800 has NO text mode and no tilemap; text is just more objects.
 * The text path here: expand glyphs into a 32-byte-wide RAM canvas
 * (= 128px, 16 characters), then show the canvas with ONE wide DL entry
 * per scanline. One drawable per line beats one-DL-entry-per-character
 * by 16x in MARIA DMA time. Index order: 0-9 A-Z dash space. */
static const uint8_t FONT[38 * 8] = {
  0x70,0x88,0x98,0xA8,0xC8,0x88,0x70,0x00,  /* 0 */
  0x20,0x60,0x20,0x20,0x20,0x20,0x70,0x00,  /* 1 */
  0x70,0x88,0x08,0x30,0x40,0x80,0xF8,0x00,  /* 2 */
  0x70,0x88,0x08,0x30,0x08,0x88,0x70,0x00,  /* 3 */
  0x10,0x30,0x50,0x90,0xF8,0x10,0x10,0x00,  /* 4 */
  0xF8,0x80,0xF0,0x08,0x08,0x88,0x70,0x00,  /* 5 */
  0x30,0x40,0x80,0xF0,0x88,0x88,0x70,0x00,  /* 6 */
  0xF8,0x08,0x10,0x20,0x40,0x40,0x40,0x00,  /* 7 */
  0x70,0x88,0x88,0x70,0x88,0x88,0x70,0x00,  /* 8 */
  0x70,0x88,0x88,0x78,0x08,0x10,0x60,0x00,  /* 9 */
  0x20,0x50,0x88,0x88,0xF8,0x88,0x88,0x00,  /* A */
  0xF0,0x88,0x88,0xF0,0x88,0x88,0xF0,0x00,  /* B */
  0x70,0x88,0x80,0x80,0x80,0x88,0x70,0x00,  /* C */
  0xF0,0x88,0x88,0x88,0x88,0x88,0xF0,0x00,  /* D */
  0xF8,0x80,0x80,0xF0,0x80,0x80,0xF8,0x00,  /* E */
  0xF8,0x80,0x80,0xF0,0x80,0x80,0x80,0x00,  /* F */
  0x70,0x88,0x80,0xB8,0x88,0x88,0x70,0x00,  /* G */
  0x88,0x88,0x88,0xF8,0x88,0x88,0x88,0x00,  /* H */
  0x70,0x20,0x20,0x20,0x20,0x20,0x70,0x00,  /* I */
  0x38,0x10,0x10,0x10,0x10,0x90,0x60,0x00,  /* J */
  0x88,0x90,0xA0,0xC0,0xA0,0x90,0x88,0x00,  /* K */
  0x80,0x80,0x80,0x80,0x80,0x80,0xF8,0x00,  /* L */
  0x88,0xD8,0xA8,0xA8,0x88,0x88,0x88,0x00,  /* M */
  0x88,0xC8,0xA8,0x98,0x88,0x88,0x88,0x00,  /* N */
  0x70,0x88,0x88,0x88,0x88,0x88,0x70,0x00,  /* O */
  0xF0,0x88,0x88,0xF0,0x80,0x80,0x80,0x00,  /* P */
  0x70,0x88,0x88,0x88,0xA8,0x90,0x68,0x00,  /* Q */
  0xF0,0x88,0x88,0xF0,0xA0,0x90,0x88,0x00,  /* R */
  0x78,0x80,0x80,0x70,0x08,0x08,0xF0,0x00,  /* S */
  0xF8,0x20,0x20,0x20,0x20,0x20,0x20,0x00,  /* T */
  0x88,0x88,0x88,0x88,0x88,0x88,0x70,0x00,  /* U */
  0x88,0x88,0x88,0x88,0x88,0x50,0x20,0x00,  /* V */
  0x88,0x88,0x88,0xA8,0xA8,0xD8,0x88,0x00,  /* W */
  0x88,0x88,0x50,0x20,0x50,0x88,0x88,0x00,  /* X */
  0x88,0x88,0x50,0x20,0x20,0x20,0x20,0x00,  /* Y */
  0xF8,0x08,0x10,0x20,0x40,0x80,0xF8,0x00,  /* Z */
  0x00,0x00,0x00,0x78,0x00,0x00,0x00,0x00,  /* - */
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,  /* space */
};
/* nibble → 2bpp expansion: each 1 bit becomes pixel value 1 (palette c1) */
static const uint8_t NIB2[16] = {
  0x00,0x01,0x04,0x05,0x10,0x11,0x14,0x15,
  0x40,0x41,0x44,0x45,0x50,0x51,0x54,0x55,
};

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Solid band drawable for multi-line zones. Inside a zone of height H,
 * MARIA fetches scanline l's pixels from ADDR + (H-1-l)*256 — the "offset
 * addressing quirk". A multi-line drawable therefore needs valid data at
 * the SAME low-byte offset across H consecutive 256-byte pages. For solid
 * colour bands we sidestep alignment entirely: a 2KB ROM run of 0x55 means
 * ANY address inside the first page works for zones up to 8 tall (8 pages
 * x 256). Costs 2KB of a 32KB cart — ROM is the cheap resource here.
 * (Real games use this page layout for big multi-line sprites too; our
 * moving objects instead live in 1-line zones where the quirk vanishes.) */
#define S16 0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55,0x55
#define S256 S16,S16,S16,S16,S16,S16,S16,S16,S16,S16,S16,S16,S16,S16,S16,S16
static const uint8_t SOLID8[2048] = { S256,S256,S256,S256,S256,S256,S256,S256 };

/* Full-width band DL: a DL drawable is at most 32 bytes (128px), so a
 * 160px line takes TWO 5-byte entries + terminator = 11 bytes. 5-byte
 * form: lo, $40 (extended, write-mode 0 = 160A), hi, palette|width, X.
 * Width 32 encodes as 0 in the low 5 bits — legal ONLY in 5-byte form. */
#define MK_BAND(name, pal) static uint8_t name[11] = { \
  0, 0x40, 0, ((pal) << 5) | 0,  0,    /* 128px @ x=0   */ \
  0, 0x40, 0, ((pal) << 5) | 24, 128,  /* 32px  @ x=128 */ \
  0 }
MK_BAND(dl_band_a, 6);
MK_BAND(dl_band_b, 7);
static uint8_t dl_empty[2] = { 0, 0 };

/* ════════════════════════════════════════════════════════════════════════
 * ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * THE DISPLAY-LIST POOL — how 30 objects get drawn (the 7800's signature).
 *
 * MARIA hierarchy refresher: DPP → DLL (one entry per ZONE: height + DL
 * pointer) → DL (one 4/5-byte entry per OBJECT crossing that zone) → pixel
 * bytes. There is no sprite table; "an object" IS a DL entry.
 *
 * The field is 120 one-scanline zones. Each has a fixed 14-byte DL slot:
 * room for THREE 4-byte object entries + the terminator byte (MARIA reads
 * the NEXT entry's mode byte after each entry; a 0 there ends the line —
 * forget the terminator and MARIA walks into garbage and the screen dies).
 *
 * Every frame, object-major (NOT line-major — a 120-line x 30-object scan
 * would be ~3600 checks; emitting 30 objects' ~125 rows is 30x cheaper):
 *   1. line_used[] = 0 for all 120 lines
 *   2. each object writes one 4-byte entry per row it covers into the
 *      lines it crosses (emit_object) — full lines just drop the row
 *   3. every line gets its terminator written after its last entry
 *
 * WHY 3 PER LINE — the MARIA DMA budget, the dial this whole game turns:
 * MARIA steals the bus from the CPU to fetch each line's DL + pixels
 * (~113 DMA cycles per scanline before the line visibly runs out). A
 * 4-byte header costs ~8 cycles + 3/pixel-byte, so three 2-byte-wide
 * objects ≈ 40 of 113 — comfortable. Eight would not be. When a 4th
 * object-row lands on one line we DROP it for that frame — a one-line
 * flicker on that object, exactly the artifact real dense 7800 games
 * show. More objects per line ⇒ bigger slots ⇒ more RAM ⇒ fewer lines;
 * quantity, width, and field height all trade against the same budget.
 *
 * The pool is SPLIT across two RAM regions because no single linker
 * region fits 1680 bytes + the DLL + the canvases (see RAM MAP):
 *   lines 0-46   → pool_a[]  (BSS, RAM1)        47 * 14 = 658 bytes
 *   lines 47-119 → POOLB ($2200, raw RAM3)      73 * 14 = 1022 bytes
 * line_dl[] resolves a field line to its slot; nothing else knows the split.
 *
 * Rebuild-vs-patch doctrine (MENTAL_MODEL.md): the DLL is built ONCE and
 * only its 3-byte field entries are repointed at state changes (with DMA
 * off); per-frame work only rewrites bytes INSIDE existing 14-byte slots.
 * Tearing down the DLL itself mid-game races MARIA's walker — the classic
 * "works one frame then the screen falls apart" 7800 bug.
 * ════════════════════════════════════════════════════════════════════════ */
#define LINE_BYTES   14
#define LINE_FULL    12          /* 3 entries * 4 bytes */
#define POOLA_LINES  47
static uint8_t  pool_a[POOLA_LINES * LINE_BYTES];
static uint8_t* line_dl[FIELD_LINES];
static uint8_t  line_used[FIELD_LINES];

static uint8_t dll[143 * 3];
static uint8_t hud_canvas[8 * 32];      /* 16-char text row, lives in BSS */
static uint8_t hud_dls[8 * 7];          /* one 5-byte DL + term per row   */

/* Emit one object: a 4-byte direct DL entry into every field line one of
 * its rows crosses. gfx rows are consecutive (stride = width in bytes).
 * Callers keep y in [0, FIELD_LINES - h] so no clipping is needed — keep
 * that invariant if you change movement code, or add clipping here. */
static void emit_object(uint8_t y, uint8_t h, const uint8_t* gfx,
                        uint8_t stride, uint8_t mode, uint8_t x) {
  uint8_t r, off;
  uint8_t* dl;
  for (r = 0; r < h; ++r) {
    off = line_used[y];
    if (off < LINE_FULL) {              /* line full ⇒ drop row (flicker) */
      dl = line_dl[y] + off;
      dl[0] = (uint8_t)((uint16_t)(uintptr_t)gfx & 0xFF);
      dl[1] = mode;
      dl[2] = (uint8_t)((uint16_t)(uintptr_t)gfx >> 8);
      dl[3] = x;
      line_used[y] = off + 4;
    }
    ++y;
    gfx += stride;
  }
}

static void field_open(void) {          /* step 1: forget last frame */
  memset(line_used, 0, FIELD_LINES);
}

static void field_close(void) {         /* step 3: terminate every line */
  uint8_t i;
  for (i = 0; i < FIELD_LINES; ++i)
    line_dl[i][line_used[i] + 1] = 0;   /* next entry's MODE byte = 0    */
}

/* ── HARDWARE IDIOM (load-bearing) — DLL construction + zone repointing.
 * Built once at boot; dll_zone appends one 3-byte entry (offset byte =
 * height-1; DLI/holey bits stay 0 — no NMI handler, no holey DMA here). */
static uint8_t* dllp;
static void dll_zone(uint8_t height, uint16_t dl) {
  dllp[0] = height - 1;
  dllp[1] = (uint8_t)(dl >> 8);
  dllp[2] = (uint8_t)(dl & 0xFF);
  dllp += 3;
}

/* Repoint ONE field line's DLL entry (title/menu/game-over text overlays
 * borrow field zones; play repoints them back at the pool slots). */
static void point_field_zone(uint8_t fline, uint16_t dl) {
  uint8_t* e = dll + FIELD_DLL_OFF + (uint16_t)fline * 3;
  e[0] = 0;
  e[1] = (uint8_t)(dl >> 8);
  e[2] = (uint8_t)(dl & 0xFF);
}

/* ── GAME LOGIC (clay) — text rendering into a 32-byte-wide RAM canvas ── */
static uint8_t glyph_index(char c) {
  if (c >= '0' && c <= '9') return (uint8_t)(c - '0');
  if (c >= 'A' && c <= 'Z') return (uint8_t)(10 + c - 'A');
  if (c == '-') return 36;
  return 37;                                   /* space */
}

static void draw_text(uint8_t* canvas, uint8_t col, const char* s) {
  uint8_t r, b;
  const uint8_t* g;
  uint8_t* dst;
  while (*s && col < 16) {
    g = FONT + ((uint16_t)glyph_index(*s) << 3);
    dst = canvas + ((uint16_t)col << 1);
    for (r = 0; r < 8; ++r) {
      b = g[r];
      dst[0] = NIB2[b >> 4];
      dst[1] = NIB2[b & 0x0F];
      dst += 32;
    }
    ++s;
    ++col;
  }
}

static void digits5(char* d, uint16_t v) {
  uint8_t i;
  for (i = 0; i < 5; ++i) { d[4 - i] = (char)('0' + v % 10); v /= 10; }
}

/* Build the 8 one-line DLs that display an arbitrary RAM canvas at x=16
 * (centered 128px). pal picks the text colour palette. dls = 8*7 bytes. */
static void canvas_dls(uint8_t* dls, const uint8_t* canvas, uint8_t pal) {
  uint8_t r;
  uint16_t a;
  for (r = 0; r < 8; ++r) {
    a = (uint16_t)(uintptr_t)canvas + ((uint16_t)r << 5);
    dls[0] = (uint8_t)(a & 0xFF);
    dls[1] = 0x40;                       /* 5-byte form, 160A write mode  */
    dls[2] = (uint8_t)(a >> 8);
    dls[3] = (uint8_t)((pal << 5) | 0);  /* width 32 bytes encodes as 0   */
    dls[4] = 16;
    dls[5] = 0;
    dls[6] = 0;                          /* terminator for the next read  */
    dls += 7;
  }
}

/* ── GAME LOGIC (clay) — the music. Two-voice TIA tune loop. ─────────────────
 * The TIA's frequency divider is 5 bits — ~32 pitches TOTAL, none of them
 * in tune with each other. Don't fight it: write the melody IN the TIA's
 * crooked scale and it reads as "gritty 7800", fight it and it reads as
 * "wrong". The note tables ARE the song — edit them to recompose.
 * Voice 0 = melody (AUDC 4, square-ish). Voice 1 = bass (AUDC 6, deep
 * buzz) — and voice 1 is SHARED with sound effects (TIA has only two
 * voices): when the game fires an effect, sfx_hold mutes the bass for the
 * effect's length, then the bass re-enters on its next note. That
 * steal-and-return is the standard 2-voice arbitration trick. */
static const uint8_t MEL_F[16] = { 13,15,17,15, 13,13,10,255, 15,17,19,17, 20,17,15,255 };
static const uint8_t MEL_L[16] = {  8, 8, 8, 8,  8, 8,16, 8,  8, 8, 8, 8,  8, 8,16, 8 };
static const uint8_t BAS_F[8]  = { 29,25,27,29, 29,25,23,27 };
static uint8_t mel_i, mel_t, bas_i, bas_t, sfx_hold;

static void music_tick(void) {
  if (mel_t) --mel_t;
  if (mel_t == 0) {
    mel_i = (uint8_t)((mel_i + 1) & 15);
    mel_t = MEL_L[mel_i];
    if (MEL_F[mel_i] == 255) {
      AUDV0 = 0;                          /* 255 = rest                   */
    } else {
      AUDC0 = 4; AUDF0 = MEL_F[mel_i]; AUDV0 = 6;
    }
  }
  if (sfx_hold) {                         /* an effect owns voice 1       */
    --sfx_hold;
    if (sfx_hold == 0) bas_t = 1;         /* bass re-enters next tick     */
    return;
  }
  if (bas_t) --bas_t;
  if (bas_t == 0) {
    bas_i = (uint8_t)((bas_i + 1) & 7);
    bas_t = 16;
    AUDC1 = 6; AUDF1 = BAS_F[bas_i]; AUDV1 = 5;
  }
}

/* Effects (voice 1 via atari7800_sfx; sfx_hold keeps the bass out). */
static void fx_shot(void)  { sfx_tone(1, 4, 4);   sfx_hold = 5;  }
static void fx_boom(void)  { sfx_noise(8);        sfx_hold = 9;  }
static void fx_crash(void) { sfx_noise(22);       sfx_hold = 23; }
static void fx_start(void) { sfx_tone(1, 8, 6);   sfx_hold = 7;  }

/* ── GAME LOGIC (clay — reshape freely) — game state ─────────────────────────
 * Fixed object pools, no allocation (1.79MHz CPU, 4KB RAM — a heap is a
 * cost with no payer). 24 meteors are ALWAYS active; "destroyed" just
 * respawns one at the top, so the field never thins out. */
#define METEORS 24
#define SHOTS    4
#define LIVES_START 3
static uint8_t mx[METEORS], my[METEORS], macc[METEORS], mspd[METEORS];
static uint8_t sx[SHOTS], sy[SHOTS], sact[SHOTS];
static uint8_t shipx[2], shipy[2], alive[2], cool[2], inv[2];
static uint8_t two_p, lives, dirty, prev_fire, over_lock;
static uint16_t score, hiscore;
static uint16_t rng = 0xACE1;

#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;

static uint8_t random8(void) {            /* xorshift16 — cheap + fine    */
  uint16_t r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (uint8_t)r;
}

static void spawn_meteor(uint8_t i, uint8_t ytop) {
  uint8_t x = (uint8_t)((random8() & 0x7F) + (random8() & 0x1F));
  if (x > 150) x -= 80;                   /* keep x+7 ≤ 159 (field width) */
  mx[i] = (uint8_t)(x + 2);
  my[i] = ytop;
  macc[i] = 0;
  /* speed = pixels per 4 frames; faster meteors as the score climbs */
  mspd[i] = (uint8_t)(1 + (random8() & 3) + (score >= 200 ? 2 : score >= 80 ? 1 : 0));
}

/* ── GAME LOGIC (clay) — HUD: "S00000 H00000 L3" composed into the canvas ── */
static void draw_hud(void) {
  static char buf[17] = "S00000 H00000 L0";
  digits5(buf + 1, score);
  digits5(buf + 8, hiscore);
  buf[15] = (char)('0' + lives);
  memset(hud_canvas, 0, sizeof(hud_canvas));
  draw_text(hud_canvas, 0, buf);
  dirty = 0;
}

static void draw_hud_title(void) {
  static char buf[9] = "HI 00000";
  digits5(buf + 3, hiscore);
  memset(hud_canvas, 0, sizeof(hud_canvas));
  draw_text(hud_canvas, 4, buf);
}

/* ── HARDWARE IDIOM (load-bearing) — paint functions bracket structural
 * display-list changes with MARIA DMA OFF ($7F) / ON ($40), the 7800's
 * version of the NES "rendering off before nametable writes" rule: MARIA
 * may be mid-walk through the very lists being rewritten, and repointing
 * dozens of zones under it glitches (or with bad luck hangs) the frame.
 * CTRL $40 = DMA on, 160A read mode, colour burst on — forget to restore
 * it and the screen stays the flat BACKGRND colour forever. ── */

/* Title screen: borrow field zones for three text overlays composed in
 * POOLB (the pool isn't drawing meteors on the title, so its RAM is free —
 * 4KB machines make you reuse like this). Title is double-height by
 * pointing TWO consecutive 1-line zones at each canvas row — zero extra
 * RAM, pure DLL trickery. */
static void paint_title(void) {
  uint8_t i;
  uint8_t* c0 = POOLB;                    /* title canvas    (256 bytes)  */
  uint8_t* c1 = POOLB + 256;              /* menu line 1     (256 bytes)  */
  uint8_t* c2 = POOLB + 512;              /* menu line 2     (256 bytes)  */
  uint8_t* td = POOLB + 768;              /* 3 lines * 8 row-DLs * 7      */
  CTRL = 0x7F;                            /* DMA off                      */
  memset(POOLB, 0, 768);
  draw_text(c0, (uint8_t)((16 - (sizeof(GAME_TITLE) - 1)) / 2), GAME_TITLE);
  draw_text(c1, 3, "1P - FIRE");
  draw_text(c2, 0, "2P - PAD 2 FIRE");
  canvas_dls(td,       c0, 0);            /* white                        */
  canvas_dls(td + 56,  c1, 5);            /* HUD green                    */
  canvas_dls(td + 112, c2, 5);
  for (i = 0; i < FIELD_LINES; ++i)
    point_field_zone(i, (uint16_t)(uintptr_t)dl_empty);
  for (i = 0; i < 16; ++i)                /* double-height title rows     */
    point_field_zone((uint8_t)(8 + i),
                     (uint16_t)(uintptr_t)(td + ((i >> 1) * 7)));
  for (i = 0; i < 8; ++i) {
    point_field_zone((uint8_t)(56 + i), (uint16_t)(uintptr_t)(td + 56 + i * 7));
    point_field_zone((uint8_t)(76 + i), (uint16_t)(uintptr_t)(td + 112 + i * 7));
  }
  draw_hud_title();
  state = ST_TITLE;
  CTRL = 0x40;                            /* DMA back on                  */
}

/* Game over: freeze nothing — the pool RAM becomes the message overlay
 * (same reuse trick as the title), the rest of the field goes blank. */
static void paint_gameover(void) {
  uint8_t i;
  uint8_t* c0 = POOLB;
  uint8_t* c1 = POOLB + 256;
  uint8_t* td = POOLB + 768;
  static char buf[12] = "SCORE 00000";
  CTRL = 0x7F;
  memset(POOLB, 0, 512);
  draw_text(c0, 3, "GAME OVER");
  digits5(buf + 6, score);
  draw_text(c1, 2, buf);
  canvas_dls(td,      c0, 0);
  canvas_dls(td + 56, c1, 5);
  for (i = 0; i < FIELD_LINES; ++i)
    point_field_zone(i, (uint16_t)(uintptr_t)dl_empty);
  for (i = 0; i < 8; ++i) {
    point_field_zone((uint8_t)(40 + i), (uint16_t)(uintptr_t)(td + i * 7));
    point_field_zone((uint8_t)(60 + i), (uint16_t)(uintptr_t)(td + 56 + i * 7));
  }
  over_lock = 30;                         /* swallow the held fire button */
  state = ST_OVER;
  CTRL = 0x40;
}

/* ── GAME LOGIC (clay) — start a run ── */
static void start_game(uint8_t players) {
  uint8_t i;
  CTRL = 0x7F;
  two_p = players;
  for (i = 0; i < FIELD_LINES; ++i)       /* field zones → pool slots     */
    point_field_zone(i, (uint16_t)(uintptr_t)line_dl[i]);
  field_open();
  field_close();                          /* all lines empty + terminated */
  score = 0;                              /* before seeding — spawn speed */
                                          /* scales with score            */
  for (i = 0; i < METEORS; ++i)           /* seed the swarm SPREAD OUT —  */
    spawn_meteor(i, (uint8_t)(i * 4));    /* all-at-top would pile 24     */
                                          /* rows on the same scanlines   */
  for (i = 0; i < SHOTS; ++i) sact[i] = 0;
  shipx[0] = two_p ? 56 : 74;  shipy[0] = 104;  alive[0] = 1;
  shipx[1] = 92;               shipy[1] = 104;  alive[1] = two_p;
  cool[0] = cool[1] = 0;
  inv[0] = inv[1] = 60;                   /* spawn shield vs the swarm    */
  lives = LIVES_START;
  rng ^= (uint16_t)(my[0] * 251) ^ 0x1234;
  draw_hud();
  fx_start();
  state = ST_PLAY;
  CTRL = 0x40;
}

static void game_over(void) {
  if (score > hiscore) {
    hiscore = score;
    /* HSC NOTE (see file header): on real hardware with a High Score Cart
     * you would write the record into HSC RAM ($1000-$17FF) here. The
     * bundled prosystem core has no HSC support and exposes no SAVE_RAM,
     * so the record honestly lives only as long as the session. */
  }
  paint_gameover();
}

/* ── GAME LOGIC (clay) — per-player update. p=0 reads SWCHA's high nibble
 * + INPT4, p=1 the low nibble + INPT5 (see the bit-order idiom up top). */
static void update_ship(uint8_t p, uint8_t pad, uint8_t fire) {
  uint8_t lf, rt, up, dn;
  if (!alive[p]) return;
  if (p == 0) { rt = pad & J1_RIGHT; lf = pad & J1_LEFT; dn = pad & J1_DOWN; up = pad & J1_UP; }
  else        { rt = pad & J2_RIGHT; lf = pad & J2_LEFT; dn = pad & J2_DOWN; up = pad & J2_UP; }
  if (lf && shipx[p] > 2)    shipx[p] -= 2;
  if (rt && shipx[p] < 146)  shipx[p] += 2;
  if (up && shipy[p] > 64)   --shipy[p];
  if (dn && shipy[p] < 111)  ++shipy[p];
  if (cool[p]) --cool[p];
  if (fire && cool[p] == 0) {
    uint8_t i;
    for (i = 0; i < SHOTS; ++i) {
      if (!sact[i]) {
        sact[i] = 1;
        sx[i] = (uint8_t)(shipx[p] + 4);  /* from the nose, centered      */
        sy[i] = (uint8_t)(shipy[p] - 3);
        cool[p] = 10;
        fx_shot();
        break;
      }
    }
  }
  if (inv[p]) --inv[p];
}

static void vblank_wait(void) {
  while (MSTAT & 0x80) { }                /* leave the current vblank     */
  while (!(MSTAT & 0x80)) { }             /* catch the next one starting  */
}

void main(void) {
  uint8_t i, fires, f1, f2;
  uint16_t a;

  /* ── HARDWARE IDIOM (load-bearing) — boot order: build EVERYTHING the
   * DLL will reference, then point DPP at it, THEN enable DMA. Enabling
   * DMA over a half-built DLL is the 7800 black-screen classic. ── */

  /* Resolve the pool split: field line → 14-byte DL slot. */
  for (i = 0; i < POOLA_LINES; ++i)
    line_dl[i] = pool_a + (uint16_t)i * LINE_BYTES;
  for (i = POOLA_LINES; i < FIELD_LINES; ++i)
    line_dl[i] = POOLB + (uint16_t)(i - POOLA_LINES) * LINE_BYTES;

  /* Patch the ROM band drawables' data pointers (SOLID8). */
  a = (uint16_t)(uintptr_t)SOLID8;
  dl_band_a[0] = dl_band_a[5] = (uint8_t)(a & 0xFF);
  dl_band_a[2] = dl_band_a[7] = (uint8_t)(a >> 8);
  dl_band_b[0] = dl_band_b[5] = (uint8_t)(a & 0xFF);
  dl_band_b[2] = dl_band_b[7] = (uint8_t)(a >> 8);

  canvas_dls(hud_dls, hud_canvas, 5);

  /* The DLL — the screen layout, built once (see the layout table above).
   * 143 entries, mixed zone heights; only the 120 field entries are ever
   * repointed after this. */
  dllp = dll;
  dll_zone(16, (uint16_t)(uintptr_t)dl_empty);            /* lines 0-15   */
  for (i = 0; i < 8; ++i)                                 /* HUD 16-23    */
    dll_zone(1, (uint16_t)(uintptr_t)(hud_dls + i * 7));
  dll_zone(2, (uint16_t)(uintptr_t)dl_band_a);            /* divider      */
  for (i = 0; i < FIELD_LINES; ++i)                       /* field 26-145 */
    dll_zone(1, (uint16_t)(uintptr_t)line_dl[i]);
  dll_zone(2, (uint16_t)(uintptr_t)dl_band_a);            /* divider      */
  /* Decor stripes (planet glow) — also our anti-blank-screen ballast:
   * with DMA fetching only objects, everything else is the single flat
   * BACKGRND colour, and a mostly-one-colour frame reads as "dead". */
  dll_zone(8, (uint16_t)(uintptr_t)dl_band_a);
  dll_zone(8, (uint16_t)(uintptr_t)dl_empty);
  dll_zone(8, (uint16_t)(uintptr_t)dl_band_b);
  dll_zone(8, (uint16_t)(uintptr_t)dl_empty);
  dll_zone(8, (uint16_t)(uintptr_t)dl_band_a);
  dll_zone(8, (uint16_t)(uintptr_t)dl_empty);
  dll_zone(8, (uint16_t)(uintptr_t)dl_band_b);
  dll_zone(8, (uint16_t)(uintptr_t)dl_empty);
  dll_zone(8, (uint16_t)(uintptr_t)dl_band_a);
  dll_zone(8, (uint16_t)(uintptr_t)dl_empty);
  dll_zone(8, (uint16_t)(uintptr_t)dl_band_b);            /* …through 235 */
  dll_zone(7, (uint16_t)(uintptr_t)dl_empty);             /* 236-242      */

  /* Palettes (Atari colour byte = hue<<4 | luminance). */
  BACKGRND = 0x00;                        /* space black                  */
  P0C1 = 0x0F;                            /* title text white             */
  P1C1 = 0x95; P1C2 = 0x9C; P1C3 = 0x0F;  /* P1 ship blues                */
  P2C1 = 0x16; P2C2 = 0x1C; P2C3 = 0x0F;  /* P2 ship golds                */
  P3C1 = 0x43; P3C2 = 0x37; P3C3 = 0x0F;  /* meteor embers                */
  P4C1 = 0x1E; P4C3 = 0x0F;               /* shot streak                  */
  P5C1 = 0xC9;                            /* HUD green                    */
  P6C1 = 0x84;                            /* decor band deep blue         */
  P7C1 = 0x88;                            /* decor band brighter blue     */
  CHARBASE = 0;
  OFFSET = 0;                             /* must stay 0 (7800 standard)  */

  a = (uint16_t)(uintptr_t)dll;
  DPPL = (uint8_t)(a & 0xFF);
  DPPH = (uint8_t)(a >> 8);

  sfx_init();
  hiscore = 0;                            /* in-session only — see header */
  paint_title();                          /* …turns DMA on                */

  for (;;) {
    uint8_t pad;
    vblank_wait();
    sfx_update();
    music_tick();

    pad = (uint8_t)~SWCHA;
    f1 = (uint8_t)(!(INPT4 & 0x80));
    f2 = (uint8_t)(!(INPT5 & 0x80));
    fires = (uint8_t)(f1 | (f2 << 1));

    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: P1 fire = 1P, P2 fire = 2P co-op ── */
      if ((fires & 1) && !(prev_fire & 1)) start_game(0);
      else if ((fires & 2) && !(prev_fire & 2)) start_game(1);
      prev_fire = fires;
      continue;
    }

    if (state == ST_OVER) {
      if (over_lock) { --over_lock; prev_fire = fires; continue; }
      if (fires && !prev_fire) paint_title();
      prev_fire = fires;
      continue;
    }

    /* ── ST_PLAY ───────────────────────────────────────────────────── */
    update_ship(0, pad, f1);
    if (two_p) update_ship(1, pad, f2);

    /* ── GAME LOGIC (clay) — the swarm. Sub-pixel fall: macc accumulates
     * quarter-pixels so speeds 1..6 span 0.25-1.5 px per sim tick. */
    for (i = 0; i < METEORS; ++i) {
      macc[i] += mspd[i];
      if (macc[i] >= 4) {
        my[i] = (uint8_t)(my[i] + (macc[i] >> 2));
        macc[i] &= 3;
        /* recycle at FIELD_LINES-6: the fastest meteor steps 2px/tick, so
         * post-check y ≤ 113 and its 4 rows stay inside the field — the
         * emit invariant (no clipping) depends on this bound. */
        if (my[i] > FIELD_LINES - 6) spawn_meteor(i, 0);
      }
    }

    /* Shots rise 3px per tick. */
    for (i = 0; i < SHOTS; ++i) {
      if (!sact[i]) continue;
      if (sy[i] >= 3) sy[i] -= 3; else sact[i] = 0;
    }

    /* Shots × meteors. */
    {
      uint8_t s, m;
      for (s = 0; s < SHOTS; ++s) {
        if (!sact[s]) continue;
        for (m = 0; m < METEORS; ++m) {
          if (sy[s] + 2 >= my[m] && sy[s] <= my[m] + 3 &&
              sx[s] + 3 >= mx[m] && sx[s] <= mx[m] + 7) {
            sact[s] = 0;
            score += (uint16_t)(4 + mspd[m]);   /* fast rocks pay more    */
            if (score > 99999u) score = 99999u; /* 5-digit HUD            */
            spawn_meteor(m, 0);
            fx_boom();
            dirty = 1;
            break;
          }
        }
      }
    }

    /* Meteors × ships (shared life pool — arcade co-op). */
    {
      uint8_t m, p;
      for (m = 0; m < METEORS; ++m) {
        for (p = 0; p < 2; ++p) {
          if (!alive[p] || inv[p]) continue;
          if (mx[m] + 7 >= shipx[p] && mx[m] <= shipx[p] + 11 &&
              my[m] + 3 >= shipy[p] && my[m] <= shipy[p] + 7) {
            spawn_meteor(m, 0);
            fx_crash();
            if (lives) --lives;
            dirty = 1;
            if (lives == 0) { game_over(); break; }
            inv[p] = 90;                  /* respawn shield (blinks)      */
            shipy[p] = 104;
          }
        }
        if (state != ST_PLAY) break;
      }
    }
    if (state != ST_PLAY) { prev_fire = fires; continue; }

    /* ── HARDWARE IDIOM (load-bearing) — the per-frame draw pass:
     * open (clear counts) → emit every object → close (terminators).
     * Emission order = draw order on shared scanlines, and when a line
     * is full the LAST emitters get dropped — so ships go first (the
     * player's own object must never be the one that flickers out). ── */
    field_open();
    for (i = 0; i < 2; ++i)
      if (alive[i] && !(inv[i] & 4))      /* inv blink = skip 4-of-8      */
        emit_object(shipy[i], 8, GFX_SHIP, 3,
                    i ? MODE_SHIP2 : MODE_SHIP1, shipx[i]);
    for (i = 0; i < SHOTS; ++i)
      if (sact[i]) emit_object(sy[i], 3, GFX_SHOT, 1, MODE_SHOT, sx[i]);
    for (i = 0; i < METEORS; ++i)
      emit_object(my[i], 4, GFX_METEOR, 2, MODE_METEOR, mx[i]);
    field_close();

    if (dirty) draw_hud();
    prev_fire = fires;
  }
}
