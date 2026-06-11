/* ── platformer.c — Atari 7800 single-screen platformer (complete example) ───
 *
 * STRATA STRIDE — a COMPLETE, working game: title screen, 1P mode and 2P
 * ALTERNATING-TURNS mode (arcade-classic: players swap on death; each player
 * has their own score and own lives, P2 plays on JOYSTICK PORT 2), gravity +
 * sub-pixel jump physics over a multi-tier arena of one-way ledges, coins to
 * collect, spikes + a lethal floor-pit to avoid, in-session hi-score, music +
 * SFX, and the 7800's signature feature: MARIA OBJECT QUANTITY. The hero +
 * up to 6 coins + 5 spikes + every ledge band are all just display-list
 * entries MARIA DMAs per scanline — a populated single screen of independent
 * objects no 2600 (5 hardware objects) draws comfortably. On the 7800 there
 * is no tilemap and no hardware scroll; "the level" IS a stack of display
 * lists, and quantity is the whole point of the chip.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented 7800/MARIA footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — ledge layout, physics tuning, scoring, art: reshape
 *     freely.
 *
 * What depends on what:
 *   atari7800_sfx.{h,c} — TIA one-shot effects (we give it voice 1; the
 *     inline music player below owns voice 0 — TIA only HAS two voices).
 *   cc65's atari7800 target crt0 + atari7800.cfg — boot, BSS in RAM1
 *     ($1800-$203F), C parameter stack at the TOP of RAM3 growing DOWN
 *     ($2800 →). This game claims the BOTTOM of RAM3 ($2200-$25FD) for its
 *     display-list pool — see the RAM MAP below before moving anything.
 *
 * NO HARDWARE SCROLL — honest note: MARIA has no scroll register; a scrolling
 * platformer rebuilds/repoints the display lists every frame (expensive on a
 * 1.79MHz 6502). This example is a FIXED single-screen arena (the form most
 * 7800 platformers actually shipped in). To scroll, you would re-emit the
 * ledge bands at shifted Y/X each frame under the same pool — see the
 * "scrolling a 7800 field" note in TROUBLESHOOTING.
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
 * Frame budget (NTSC): the per-tick update (player physics + a handful of
 * AABB checks + HUD redraw) fits in one 60Hz frame, dipping to two on heavy
 * frames — vblank_wait() paces the sim, the classic 8-bit pattern. MARIA does
 * not care — it re-walks the same DLs every frame, so a slow CPU loop never
 * blanks or tears the whole screen. That budget only holds because of the
 * #pragma optimize(on) right below — read its comment before deleting it.
 */

#include <stdint.h>
#include <string.h>
#include "atari7800_sfx.h"

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * cc65 SHIPS WITH ITS OPTIMIZER OFF, and this toolchain does not pass -O —
 * each translation unit must opt in. Without this pragma the unoptimized
 * emit pass made the main loop take ~9 frames per sim tick instead of 1-2
 * (measured on the 7800 shmup: 8.8 → 1.7 frames/tick on prosystem), and
 * every TICK-DENOMINATED timer silently stretched 4-5x in wall-clock terms:
 * the turn-change blink, the jump arc, the spike timers — all ~4.5x too slow.
 * That presents as "broken game rules / sprite vanishing" (a synchronized
 * blink keeps an object off screen for ~600ms at a time) — but the DLL, the
 * zone pointers, and every pool slot were byte-perfect when read back from
 * RAM. The footgun generalizes: on a 1.79MHz 6502 the C optimizer is not a
 * nicety, it IS the frame budget, and a too-slow loop shows up as broken GAME
 * RULES (stretched timers, missed 1-frame input edges), not as a slow-looking
 * screen — MARIA keeps repainting the same display lists at a rock-steady
 * 60Hz no matter how far behind the CPU falls. If your fork feels like
 * molasses or "ignores" short button taps, check this pragma is still here
 * before debugging the display lists. */
#pragma optimize(on)

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "STRATA STRIDE"

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
#define P4C2      (*(volatile uint8_t*)0x32)
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
 * misdiagnose as a core problem. Verified bit-by-bit against prosystem.
 * 2P alternating turns uses BOTH ports: player 1 reads the high nibble +
 * INPT4 fire, player 2 the low nibble + INPT5 fire. */
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
 *   lines  26-145  THE ARENA — 120 one-line zones  120 entries (the pool)
 *   lines 146-147  ground band (the floor surface) 1 entry, 2 tall
 *   lines 148-242  pit/decor stripes (below floor) 12 entries, 8/7 tall
 * Total: 143 DLL entries = 429 bytes (vs 729 for the naive all-1-line DLL —
 * mixed zone heights are how real 7800 games keep the DLL small).
 * The ARENA pool holds every moving/placed object: the hero, coins, spikes,
 * AND the one-way ledge bands (a ledge is just a wide colour-1 object drawn
 * across the lines it occupies). */
#define FIELD_LINES   120
#define FIELD_DLL_OFF 30          /* byte offset of arena entry 0 in dll[] */
#define ARENA_TOP     26          /* zone line of arena line 0 (for Y math) */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Object art. 160A mode: 1 byte = 4 pixels of 2 bits each; pixel value
 * 1/2/3 = colour 1/2/3 of the palette the DL entry names, 0 = transparent.
 * Rows are stored top-down, consecutive (the 1-scanline-zone pattern below
 * means NO page-alignment dance — see "offset addressing quirk" in
 * MENTAL_MODEL.md for what multi-line zones would demand instead). */

/* Hero, 8px wide (2 bytes) x 12 rows — a little climber. Colours: 1 body,
 * 2 shade, 3 highlight. Two poses: idle and jump (arms up). Drawn with
 * palette 1 (P1) or 2 (P2). */
static const uint8_t GFX_HERO_IDLE[12 * 2] = {
  0x05, 0x40,    /*  1   1   (head) */
  0x16, 0x90,    /* 11 21 1         */
  0x16, 0x90,    /* 11 21 1         */
  0x05, 0x40,    /*  1   1          */
  0x1A, 0xA4,    /* 122221 1 (body) */
  0x6A, 0xA9,    /*122222221        */
  0x6A, 0xA9,    /*122222221        */
  0x6A, 0xA9,    /*122222221        */
  0x1A, 0xA4,    /* 1222221         */
  0x14, 0x10,    /* 11  1   (legs)  */
  0x14, 0x10,    /* 11  1           */
  0x34, 0x30,    /* 31  31          */
};
static const uint8_t GFX_HERO_JUMP[12 * 2] = {
  0x40, 0x01,    /*1       1 (arms up) */
  0x50, 0x05,    /*11     11           */
  0x15, 0x40,    /* 11  11             */
  0x05, 0x40,    /*  1  1   (head)     */
  0x1A, 0xA4,    /* 122221             */
  0x6A, 0xA9,    /*122222221 (body)    */
  0x6A, 0xA9,    /*122222221           */
  0x1A, 0xA4,    /* 122221             */
  0x16, 0x90,    /* 11 21 1            */
  0x24, 0x12,    /* 2   1  2 (legs out)*/
  0x60, 0x06,    /*2       2           */
  0x40, 0x01,    /*3       3           */
};

/* Coin, 8px wide (2 bytes) x 6 rows — colour 3 disc, colour 2 emboss. */
static const uint8_t GFX_COIN[6 * 2] = {
  0x3C, 0xF0,    /*  333 33   */
  0xFB, 0xFC,    /* 3322333 3 */
  0xFB, 0xFC,    /* 3322333 3 */
  0xFB, 0xFC,    /* 3322333 3 */
  0x3F, 0xF0,    /*  333333   */
  0x0F, 0xC0,    /*   3333    */
};

/* Spike, 8px wide (2 bytes) x 5 rows — a colour-1 hazard with colour-3 tip. */
static const uint8_t GFX_SPIKE[5 * 2] = {
  0x00, 0x30,    /*     3     */
  0x03, 0x30,    /*   1 13    */
  0x0F, 0x3C,    /*  111 33   */
  0x3F, 0xFC,    /* 11111133  */
  0xFF, 0xFF,    /*1111111111 */
};

/* DL mode bytes for the 4-byte (direct) entry form: palette in bits 5-7,
 * width as (32 - width_bytes) in bits 0-4 (must be non-zero — a zero low
 * 5 bits would make MARIA parse a 5-byte entry instead). */
#define MODE_HERO1  ((1u << 5) | (32 - 2))   /* palette 1, 2 bytes wide */
#define MODE_HERO2  ((2u << 5) | (32 - 2))   /* palette 2 */
#define MODE_SPIKE  ((3u << 5) | (32 - 2))   /* palette 3, 2 bytes wide */
#define MODE_COIN   ((4u << 5) | (32 - 2))   /* palette 4, 2 bytes wide */

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
 * Solid band drawable for multi-line zones AND the one-way ledges. Inside a
 * zone of height H, MARIA fetches scanline l's pixels from ADDR + (H-1-l)*256
 * — the "offset addressing quirk". A multi-line drawable therefore needs
 * valid data at the SAME low-byte offset across H consecutive 256-byte pages.
 * For solid colour bands we sidestep alignment entirely: a 2KB ROM run of
 * 0x55 means ANY address inside the first page works for zones up to 8 tall
 * (8 pages x 256). Costs 2KB of a 32KB cart — ROM is the cheap resource here.
 * The arena ledges reuse SOLID8 too: a ledge is a wide colour-1 object drawn
 * into the one-line arena zones it spans (1-line zones ⇒ the quirk vanishes,
 * any SOLID8 address works). */
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
MK_BAND(dl_ground, 5);                 /* the floor surface band (HUD green) */
static uint8_t dl_empty[2] = { 0, 0 };

/* ════════════════════════════════════════════════════════════════════════
 * ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * THE DISPLAY-LIST POOL — how a populated arena gets drawn (the 7800's
 * signature). Same machinery the dense 7800 shmup uses for its swarm; here
 * it draws the hero, coins, spikes, AND the ledge bands.
 *
 * MARIA hierarchy refresher: DPP → DLL (one entry per ZONE: height + DL
 * pointer) → DL (one 4/5-byte entry per OBJECT crossing that zone) → pixel
 * bytes. There is no sprite table; "an object" IS a DL entry.
 *
 * The arena is 120 one-scanline zones. Each has a fixed 14-byte DL slot:
 * room for THREE 4-byte object entries + the terminator byte (MARIA reads
 * the NEXT entry's mode byte after each entry; a 0 there ends the line —
 * forget the terminator and MARIA walks into garbage and the screen dies).
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
 * line_dl[] resolves an arena line to its slot; nothing else knows the split.
 *
 * Rebuild-vs-patch doctrine (MENTAL_MODEL.md): the DLL is built ONCE and
 * only its 3-byte arena entries are repointed at state changes (with DMA
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

/* Emit one object: a 4-byte direct DL entry into every arena line one of
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

/* Emit a horizontal LEDGE: a 2-line-tall colour-1 band spanning [xl, xr].
 * It's the same emit path as a sprite, just pointed at SOLID8 (any address
 * in its first page works for a 1-line zone — the quirk note above). A single
 * DL object draws at most 32 bytes (128px); wider ledges (our long floor) are
 * tiled in ≤24-byte chunks so they never overrun a line's 3-object budget on
 * their own 2-line zone (nothing else is emitted on a ledge's lines). */
static void emit_ledge(uint8_t y, uint8_t xl, uint8_t xr, uint8_t mode_pal) {
  uint8_t x = xl;
  while (x <= xr) {
    uint8_t span = (uint8_t)(xr - x + 1);          /* pixels remaining     */
    uint8_t w = (uint8_t)((span + 3) >> 2);        /* round up to bytes    */
    uint8_t mode;
    if (w > 24) w = 24;                            /* 96px chunk max        */
    mode = (uint8_t)((mode_pal << 5) | (32 - w));
    emit_object(y, 2, SOLID8, 0, mode, x);
    x = (uint8_t)(x + (w << 2));
    if (w == 0) break;
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

/* Repoint ONE arena line's DLL entry (title/menu/game-over text overlays
 * borrow arena zones; play repoints them back at the pool slots). */
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
static const uint8_t MEL_F[16] = { 17,15,13,15, 17,17,20,255, 15,13,12,13, 15,17,15,255 };
static const uint8_t MEL_L[16] = {  8, 8, 8, 8,  8, 8,16, 8,  8, 8, 8, 8,  8, 8,16, 8 };
static const uint8_t BAS_F[8]  = { 29,29,25,25, 27,27,23,25 };
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
static void fx_jump(void)  { sfx_tone(1, 12, 5);  sfx_hold = 6;  }
static void fx_land(void)  { sfx_tone(1, 22, 3);  sfx_hold = 4;  }
static void fx_coin(void)  { sfx_tone(1, 6, 5);   sfx_hold = 6;  }
static void fx_die(void)   { sfx_noise(22);       sfx_hold = 23; }
static void fx_start(void) { sfx_tone(1, 8, 6);   sfx_hold = 7;  }

/* ── GAME LOGIC (clay — reshape freely) — THE LEVEL ──────────────────────────
 * A fixed single-screen arena, expressed as one-way LEDGES (the floor plus
 * floating slabs) in arena-line coordinates [0, FIELD_LINES). Each ledge:
 * { y_top, x_left, x_right }. The hero stands on a ledge's TOP edge; a pit
 * is simply the gap in the floor ledge (fall through it = death). Coins and
 * spikes are placed relative to these ledges in begin_turn().
 *
 * Arena line 0 = zone line 26; the floor band sits just below arena line
 * 119. Tweak this table freely — it's the whole level design surface. */
#define NUM_LEDGES 5
typedef struct { uint8_t yt, xl, xr; } Ledge;
static const Ledge LEDGES[NUM_LEDGES] = {
  /* the FLOOR is a long run with a lethal pit cut into the right side, so
   * the hero has plenty of room to walk before the gap. */
  {   112,   2, 116 },   /* floor left  (x 2..116)  */
  {   112, 140, 158 },   /* floor right (x 140..158) — pit is x 116..140 */
  {    84,  24,  72 },   /* low slab    */
  {    56, 100, 148 },   /* mid slab    */
  {    32,  40,  96 },   /* high slab   */
};
#define FLOOR_Y    112        /* the two floor ledges' top                  */
#define PIT_XL     116        /* lethal pit spans floor x [PIT_XL, PIT_XR]  */
#define PIT_XR     140

/* ── GAME LOGIC (clay) — coins + spikes, placed on the ledges. ── */
#define NUM_COINS  6
#define NUM_SPIKES 5
static const uint8_t COIN_X[NUM_COINS] = {  44,  48,  16, 120, 124,  60 };
static const uint8_t COIN_Y[NUM_COINS] = { 104,  76,  66,  48,  76,  24 };
/* coin 2 (x16,y66) hangs just above the spawn — a single floor jump grabs
 * it; coin 0 (x44,y104) is a short walk-right on the floor. The rest sit on
 * the slabs (jump-and-platform to reach), and gathering ALL pays a bonus. */
static uint8_t coin_live[NUM_COINS];
/* spikes sit ON ledge tops (y = ledge_top - 5 so the 5px spike rests on it).
 * Kept OFF the left spawn lane (hero starts at x≈12 on the left floor and can
 * walk right to ~x100 before the first floor spike — room to traverse). */
static const uint8_t SPIKE_X[NUM_SPIKES] = { 150,  56, 108, 132,  72 };
static const uint8_t SPIKE_Y[NUM_SPIKES] = { 107,  79, 107,  51,  51 };

/* ── GAME LOGIC (clay — reshape freely) — game state ─────────────────────────
 * Fixed object pools, no allocation (1.79MHz CPU, 4KB RAM — a heap is a
 * cost with no payer). */
#define LIVES_START 3
#define HERO_W      8         /* hero pixel width  */
#define HERO_H     12         /* hero pixel height */

/* Physics, all in quarter-pixels (Q.2 fixed point) for sub-pixel gravity:
 * gravity adds <1px/tick near the apex, so integer Y alone would jerk. */
#define GRAVITY_Q2     2      /* +0.5 px/tick/tick                         */
#define JUMP_VEL_Q2  (-26)    /* launch vy → ~6.5px first tick, ~40px apex */
#define MAX_VY_Q2     20      /* terminal fall 5px/tick (landing window 6) */
#define MOVE_SPEED     2      /* px/tick walk                              */

static uint8_t  hx;                    /* hero pixel x (left edge)         */
static uint16_t hy_q2;                 /* hero y, Q.2 (top edge)           */
static int8_t   vy_q2;
static uint8_t  on_ground;
static uint8_t  face_jump;             /* pose select                     */

/* Players: 0 = P1 (port 0), 1 = P2 (port 1 — alternating turns). Each has
 * own score + own lives; the HUD shows the CURRENT player's numbers. */
static uint8_t  two_p;
static uint8_t  cur_p;
static uint8_t  p_lives[2];
static uint16_t p_score[2];
static uint16_t hiscore;
static uint8_t  turn_pause;            /* freeze frames after a turn swap  */
static uint8_t  dirty, prev_fire, over_lock;
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

static uint8_t dist8(uint8_t a, uint8_t b) {
  return (a > b) ? (a - b) : (b - a);
}

/* ── GAME LOGIC (clay) — HUD: "P1 S00000 H00000 L3" composed into canvas ── */
static void draw_hud(void) {
  static char buf[17] = "P1 00000 00000 0";
  buf[1] = (char)('1' + cur_p);
  digits5(buf + 3, p_score[cur_p]);
  digits5(buf + 9, hiscore);
  buf[15] = (char)('0' + p_lives[cur_p]);
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

/* Title screen: borrow arena zones for three text overlays composed in
 * POOLB (the pool isn't drawing the arena on the title, so its RAM is free —
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
  draw_text(c1, 2, "1P - JUMP A");
  draw_text(c2, 0, "2P - PAD 2 TURNS");
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

/* Game over: the pool RAM becomes the message overlay (same reuse trick as
 * the title), the rest of the arena goes blank. */
static void paint_gameover(void) {
  uint8_t i;
  uint8_t* c0 = POOLB;
  uint8_t* c1 = POOLB + 256;
  uint8_t* c2 = POOLB + 512;
  uint8_t* td = POOLB + 768;
  static char buf[12] = "P1 00000";
  CTRL = 0x7F;
  memset(POOLB, 0, 768);
  draw_text(c0, 3, "GAME OVER");
  buf[1] = '1'; digits5(buf + 3, p_score[0]);
  draw_text(c1, 4, buf);
  if (two_p) {
    static char buf2[12] = "P2 00000";
    buf2[1] = '2'; digits5(buf2 + 3, p_score[1]);
    draw_text(c2, 4, buf2);
  }
  canvas_dls(td,       c0, 0);
  canvas_dls(td + 56,  c1, 5);
  canvas_dls(td + 112, c2, 5);
  for (i = 0; i < FIELD_LINES; ++i)
    point_field_zone(i, (uint16_t)(uintptr_t)dl_empty);
  for (i = 0; i < 8; ++i) {
    point_field_zone((uint8_t)(40 + i), (uint16_t)(uintptr_t)(td + i * 7));
    point_field_zone((uint8_t)(60 + i), (uint16_t)(uintptr_t)(td + 56 + i * 7));
    if (two_p)
      point_field_zone((uint8_t)(76 + i), (uint16_t)(uintptr_t)(td + 112 + i * 7));
  }
  over_lock = 30;                         /* swallow the held fire button */
  state = ST_OVER;
  CTRL = 0x40;
}

/* ── GAME LOGIC (clay) — landing probe: is feet on a ledge top? ──────────────
 * One-way platforms, classic style: only catch while FALLING (vy>=0) through
 * a 6px window at a ledge's top edge, and only if the hero's x overlaps the
 * ledge span. Returns the ledge top (arena line) to snap to, or 0xFF = none.
 * The window is feet-1 .. feet+4 so terminal velocity (5px) can't tunnel. */
static uint8_t land_top(uint8_t feet, uint8_t x) {
  uint8_t i, top;
  uint8_t xr = (uint8_t)(x + HERO_W - 1);
  for (i = 0; i < NUM_LEDGES; ++i) {
    top = LEDGES[i].yt;
    if ((uint8_t)(feet + 1) >= top && feet <= (uint8_t)(top + 4) &&
        xr >= LEDGES[i].xl && x <= LEDGES[i].xr) {
      /* the pit: the floor ledges already exclude x [PIT_XL,PIT_XR], so a
       * hero centered over the pit finds no ledge and keeps falling. */
      return top;
    }
  }
  return 0xFF;
}

/* ── GAME LOGIC (clay) — start one player's turn ── */
static void begin_turn(void) {
  uint8_t i;
  hx = 12;
  hy_q2 = (uint16_t)(FLOOR_Y - HERO_H) << 2;   /* stand on left floor      */
  vy_q2 = 0;
  on_ground = 1;
  face_jump = 0;
  for (i = 0; i < NUM_COINS; ++i) coin_live[i] = 1;
  turn_pause = 40;                             /* "ready" breather          */
  prev_fire = 0xFF;                            /* swallow held fire across   *
                                                * the turn change            */
  draw_hud();
}

static void start_game(uint8_t players) {
  uint8_t i;
  CTRL = 0x7F;
  two_p = players;
  cur_p = 0;
  p_score[0] = p_score[1] = 0;
  p_lives[0] = LIVES_START;
  p_lives[1] = players ? LIVES_START : 0;
  for (i = 0; i < FIELD_LINES; ++i)            /* arena zones → pool slots  */
    point_field_zone(i, (uint16_t)(uintptr_t)line_dl[i]);
  field_open();
  field_close();                               /* all lines empty + termed  */
  rng ^= (uint16_t)(hiscore * 251) ^ 0x1234;
  begin_turn();
  fx_start();
  state = ST_PLAY;
  CTRL = 0x40;
}

static void game_over(void) {
  uint16_t best = p_score[0];
  if (two_p && p_score[1] > best) best = p_score[1];
  if (best > hiscore) {
    hiscore = best;
    /* HSC NOTE (see file header): on real hardware with a High Score Cart
     * you would write the record into HSC RAM ($1000-$17FF) here. The
     * bundled prosystem core has no HSC support and exposes no SAVE_RAM,
     * so the record honestly lives only as long as the session. */
  }
  paint_gameover();
}

/* ── GAME LOGIC (clay) — death + alternating-turn handoff ── */
static void kill_player(void) {
  uint8_t other;
  fx_die();
  if (p_lives[cur_p] > 0) --p_lives[cur_p];
  if (two_p) {
    other = (uint8_t)(cur_p ^ 1);
    if (p_lives[other] > 0) cur_p = other;            /* swap turns         */
    else if (p_lives[cur_p] == 0) { game_over(); return; }
  } else if (p_lives[0] == 0) {
    game_over();
    return;
  }
  begin_turn();
}

/* ── GAME LOGIC (clay) — per-player movement + physics ── */
static void update_player(uint8_t pad, uint8_t fire) {
  uint8_t lf, rt, feet, top;
  if (cur_p == 0) { rt = pad & J1_RIGHT; lf = pad & J1_LEFT; }
  else            { rt = pad & J2_RIGHT; lf = pad & J2_LEFT; }

  if (lf && hx > 2)    hx -= MOVE_SPEED;
  if (rt && hx < 150)  hx += MOVE_SPEED;

  /* jump on the fire EDGE while grounded (the SWCHA-port fire button) */
  if (fire && !prev_fire && on_ground) {
    vy_q2 = JUMP_VEL_Q2;
    on_ground = 0;
    face_jump = 1;
    fx_jump();
  }

  /* gravity + sub-pixel Y */
  if (vy_q2 < MAX_VY_Q2) vy_q2 += GRAVITY_Q2;
  hy_q2 = (uint16_t)((int16_t)hy_q2 + vy_q2);
  {
    uint8_t y8 = (uint8_t)(hy_q2 >> 2);

    /* fell past the floor (into the pit / off the bottom) → lose the turn */
    if (y8 >= FIELD_LINES - HERO_H + 2) { kill_player(); return; }

    /* landing probe while falling */
    if (vy_q2 >= 0) {
      feet = (uint8_t)(y8 + HERO_H);
      top = land_top(feet, hx);
      if (top != 0xFF) {
        hy_q2 = (uint16_t)(top - HERO_H) << 2;
        vy_q2 = 0;
        if (!on_ground) fx_land();
        on_ground = 1;
        face_jump = 0;
      } else {
        on_ground = 0;                           /* walked off an edge      */
      }
    }
  }
}

static void vblank_wait(void) {
  while (MSTAT & 0x80) { }                /* leave the current vblank     */
  while (!(MSTAT & 0x80)) { }             /* catch the next one starting  */
}

void main(void) {
  uint8_t i;
  uint16_t a;

  /* ── HARDWARE IDIOM (load-bearing) — boot order: build EVERYTHING the
   * DLL will reference, then point DPP at it, THEN enable DMA. Enabling
   * DMA over a half-built DLL is the 7800 black-screen classic. ── */

  /* Resolve the pool split: arena line → 14-byte DL slot. */
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
  dl_ground[0] = dl_ground[5] = (uint8_t)(a & 0xFF);
  dl_ground[2] = dl_ground[7] = (uint8_t)(a >> 8);

  canvas_dls(hud_dls, hud_canvas, 5);

  /* The DLL — the screen layout, built once (see the layout table above).
   * 143 entries, mixed zone heights; only the 120 arena entries are ever
   * repointed after this. */
  dllp = dll;
  dll_zone(16, (uint16_t)(uintptr_t)dl_empty);            /* lines 0-15   */
  for (i = 0; i < 8; ++i)                                 /* HUD 16-23    */
    dll_zone(1, (uint16_t)(uintptr_t)(hud_dls + i * 7));
  dll_zone(2, (uint16_t)(uintptr_t)dl_band_a);            /* divider      */
  for (i = 0; i < FIELD_LINES; ++i)                       /* arena 26-145 */
    dll_zone(1, (uint16_t)(uintptr_t)line_dl[i]);
  dll_zone(2, (uint16_t)(uintptr_t)dl_ground);            /* floor surface*/
  /* Below-floor pit / decor stripes — also our anti-blank-screen ballast:
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
  BACKGRND = 0x00;                        /* cave black                   */
  P0C1 = 0x0F;                            /* title text white             */
  P1C1 = 0x96; P1C2 = 0x9C; P1C3 = 0x0F;  /* P1 hero blues                */
  P2C1 = 0x26; P2C2 = 0x2C; P2C3 = 0x0F;  /* P2 hero oranges              */
  P3C1 = 0x46; P3C2 = 0x0A; P3C3 = 0x0E;  /* spike red + tips             */
  P4C1 = 0x1A; P4C2 = 0x18; P4C3 = 0x1E;  /* coin gold                    */
  P5C1 = 0xC9;                            /* HUD green / ledges / floor    */
  P6C1 = 0x24;                            /* decor band deep red (lava-ish)*/
  P7C1 = 0x28;                            /* decor band brighter red       */
  CHARBASE = 0;
  OFFSET = 0;                             /* must stay 0 (7800 standard)  */

  a = (uint16_t)(uintptr_t)dll;
  DPPL = (uint8_t)(a & 0xFF);
  DPPH = (uint8_t)(a >> 8);

  sfx_init();
  hiscore = 0;                            /* in-session only — see header */
  paint_title();                          /* …turns DMA on                */

  for (;;) {
    uint8_t pad, f1, f2, fire;
    vblank_wait();
    sfx_update();
    music_tick();

    pad = (uint8_t)~SWCHA;
    f1 = (uint8_t)(!(INPT4 & 0x80));
    f2 = (uint8_t)(!(INPT5 & 0x80));

    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: P1 fire = 1P, P2 fire = 2P turns ── */
      if (f1 && !(prev_fire & 1)) start_game(0);
      else if (f2 && !(prev_fire & 2)) start_game(1);
      prev_fire = (uint8_t)(f1 | (f2 << 1));
      continue;
    }

    if (state == ST_OVER) {
      if (over_lock) { --over_lock; prev_fire = (uint8_t)(f1 | (f2 << 1)); continue; }
      if ((f1 || f2) && !prev_fire) paint_title();
      prev_fire = (uint8_t)(f1 | (f2 << 1));
      continue;
    }

    /* ── ST_PLAY ───────────────────────────────────────────────────── */
    fire = cur_p ? f2 : f1;

    if (turn_pause) {                      /* ready breather, frozen        */
      --turn_pause;
      prev_fire = fire;
    } else {
      update_player(pad, fire);
      prev_fire = fire;
      if (state != ST_PLAY) continue;      /* kill_player → game over       */
    }

    /* ── GAME LOGIC (clay) — coins (collect) + spikes (death). The hero's
     * AABB is (hx,y8)..(+8,+12); coins/spikes are 8px wide. ── */
    {
      uint8_t y8 = (uint8_t)(hy_q2 >> 2);
      uint8_t hcx = (uint8_t)(hx + 4), hcy = (uint8_t)(y8 + 6);
      for (i = 0; i < NUM_COINS; ++i) {
        if (!coin_live[i]) continue;
        if (dist8((uint8_t)(COIN_X[i] + 4), hcx) < 8 &&
            dist8((uint8_t)(COIN_Y[i] + 3), hcy) < 9) {
          coin_live[i] = 0;
          p_score[cur_p] += 10;
          if (p_score[cur_p] > 99999u) p_score[cur_p] = 99999u;
          fx_coin();
          dirty = 1;
        }
      }
      /* all coins gathered → bonus + reset the board (endless score climb) */
      {
        uint8_t any = 0;
        for (i = 0; i < NUM_COINS; ++i) any |= coin_live[i];
        if (!any) {
          p_score[cur_p] += 50;
          if (p_score[cur_p] > 99999u) p_score[cur_p] = 99999u;
          for (i = 0; i < NUM_COINS; ++i) coin_live[i] = 1;
          dirty = 1;
        }
      }
      if (turn_pause == 0) {
        for (i = 0; i < NUM_SPIKES; ++i) {
          if (dist8((uint8_t)(SPIKE_X[i] + 4), hcx) < 7 &&
              dist8((uint8_t)(SPIKE_Y[i] + 2), hcy) < 7) {
            kill_player();
            break;
          }
        }
        if (state != ST_PLAY) continue;
      }
    }

    /* ── HARDWARE IDIOM (load-bearing) — the per-frame draw pass:
     * open (clear counts) → emit the LEDGES + every object → close
     * (terminators). Emission order = draw order on shared scanlines, and
     * when a line is full the LAST emitters get dropped — so the HERO goes
     * LAST among small objects but the ledges (structural) go first; the
     * player's own object should never be the one that flickers out, so we
     * keep ≤3 objects per line by design (the arena is sparse vertically). ── */
    field_open();

    /* the ledges: structural geometry, emitted first */
    for (i = 0; i < NUM_LEDGES; ++i)
      emit_ledge(LEDGES[i].yt, LEDGES[i].xl, LEDGES[i].xr, 5);

    /* coins */
    for (i = 0; i < NUM_COINS; ++i)
      if (coin_live[i]) emit_object(COIN_Y[i], 6, GFX_COIN, 2, MODE_COIN, COIN_X[i]);

    /* spikes */
    for (i = 0; i < NUM_SPIKES; ++i)
      emit_object(SPIKE_Y[i], 5, GFX_SPIKE, 2, MODE_SPIKE, SPIKE_X[i]);

    /* the hero — blink during the turn-change breather (SHIMMER, never
     * vanish: on blink ticks draw only the bottom half so the object stays
     * accounted-for on every frame — a fully-skipped sprite reads as "gone"
     * in any single sampled frame, the spawn-blink footgun from the gold
     * round). */
    {
      uint8_t y8 = (uint8_t)(hy_q2 >> 2);
      const uint8_t* g = face_jump ? GFX_HERO_JUMP : GFX_HERO_IDLE;
      uint8_t mode = cur_p ? MODE_HERO2 : MODE_HERO1;
      if (turn_pause && (turn_pause & 4))
        emit_object((uint8_t)(y8 + 6), 6, g + 12, 2, mode, hx);
      else
        emit_object(y8, HERO_H, g, 2, mode, hx);
    }

    field_close();

    if (dirty) draw_hud();
  }
}
