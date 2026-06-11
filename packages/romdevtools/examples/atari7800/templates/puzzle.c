/* ── puzzle.c — Atari 7800 falling-trio match puzzle (complete example) ───────
 *
 * PIVOT PURGE — a COMPLETE, working game: title screen, 1P marathon (levels +
 * cascade chains) and 2P SIMULTANEOUS VERSUS (split boards, garbage attacks,
 * both wells falling at once on the two joystick ports), in-session hi-score,
 * music + SFX, full teaching markers — and the 7800's signature constraint
 * worked the OTHER way from the shmup: where the dense shooter spreads 30
 * objects so only ~3 ever share a scanline, a puzzle WELL is the worst case
 * for MARIA — a whole ROW of 6 gems lands on the same 8 scanlines at once,
 * which is 6 objects per line, double the 3-per-line DMA budget. The fix is
 * the load-bearing idiom of this file: each well row is drawn as ONE wide
 * DL object built from a RAM canvas (the same canvas-as-a-drawable trick the
 * text path uses), so a 6-wide row costs ONE object per line, not six. That
 * is what makes 2P (two wells = TWO objects per line) fit at all.
 *
 * The game: a falling-trio match. A trio of coloured cells drops into a 6x12
 * well; LEFT/RIGHT move it, the fire button (port joystick) CYCLES its three
 * colours (the 7800 pad has one button — cycle replaces the NES A/B rotate),
 * DOWN soft-drops. When the trio lands, any straight run of 3+ same-coloured
 * cells (horizontal, vertical, or diagonal) clears; survivors fall and
 * cascades chain for multiplied score.
 *
 * 2P VERSUS design (simultaneous, split board): two 6x12 wells side by side —
 * P1 left on joystick port 0, P2 right on joystick port 1 — both falling at
 * once. Clears ATTACK: each chain step sends one garbage row (random cells
 * with one gap, capped at 4 per attack) rising from the bottom of the
 * opponent's well. First player whose stack reaches the rim loses. Both wells
 * update each frame; the whole thing fits the MARIA budget because each well
 * row is ONE canvas-backed DL object (see the idiom above) — two wells = at
 * most two objects per scanline, inside the 3-per-line ceiling.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented 7800/MARIA footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — match rules, garbage, tuning, art: reshape freely.
 *
 * What depends on what:
 *   atari7800_sfx.{h,c} — TIA one-shot effects (we give it voice 1; the
 *     inline music player below owns voice 0 — TIA only HAS two voices).
 *   cc65's atari7800 target crt0 + atari7800.cfg — boot, BSS in RAM1
 *     ($1800-$203F), C parameter stack at the TOP of RAM3 growing DOWN
 *     ($2800 →). This game claims the BOTTOM of RAM3 ($2200-$25FD) for its
 *     display-list pool / title canvases — see the RAM MAP below.
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
 * Frame budget (NTSC): steady state is tiny — input + one gravity step per
 * well + the few canvas rows that changed. The spike is resolve_board() at
 * lock time (the full 4-direction match scan over 72 cells in cc65 code): it
 * can spill a frame or two past vblank. That's fine — MARIA keeps re-walking
 * the same display lists at 60Hz, so a slow CPU tick shows as (at most) a
 * one-frame hitch on the falling trio, never corruption. That budget only
 * holds because of the #pragma optimize(on) right below — read its comment
 * before deleting it.
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
 * the gravity delay, the ready-pause, the lock thunk — all ~4.5x too slow, so
 * pieces crawled and the game "looked broken". But the DLL, the zone
 * pointers, and every canvas were byte-perfect when read back from RAM. The
 * footgun generalizes: on a 1.79MHz 6502 the C optimizer is not a nicety, it
 * IS the frame budget, and a too-slow loop shows up as broken GAME RULES
 * (stretched timers, missed 1-frame input edges), not as a slow-looking
 * screen — MARIA keeps repainting the same display lists at a rock-steady
 * 60Hz no matter how far behind the CPU falls. If your fork feels like
 * molasses or "ignores" short button taps, check this pragma is still here
 * before debugging the display lists. */
#pragma optimize(on)

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "PIVOT PURGE"

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
 * 2P versus uses BOTH ports: player 0 reads the high nibble + INPT4 fire,
 * player 1 the low nibble + INPT5 fire. */
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
 *   $2200-$275D  RAM3 bottom — OUR display-list pool / title-canvas arena
 *                  (POOLB): raw pointer, invisible to the linker, 1358 bytes
 *                  (97 pool lines; the wells need more BSS so more pool lives
 *                  here than in the shmup — see THE DISPLAY-LIST POOL)
 *   $275E-$27FF  RAM3 top — cc65 C parameter stack (crt0 starts it at $2800
 *                  growing DOWN; ~162 bytes is plenty for these call depths,
 *                  but if you add deep recursion, shrink the boards/canvases
 *                  before growing pool_a back into BSS)
 * ════════════════════════════════════════════════════════════════════════ */
#define POOLB ((uint8_t*)0x2200)

/* ── Screen layout (243 NTSC zone-lines; the visible frame is ~lines 9-232) ──
 *   lines   0- 15  blank (top overscan)            1 DLL entry, 16 tall
 *   lines  16- 23  HUD text row (RAM canvas)       8 entries, 1 tall each
 *   lines  24- 25  divider band                    1 entry, 2 tall
 *   lines  26-145  THE WELLS — 120 one-line zones  120 entries (the pool)
 *   lines 146-147  base band (well floor surface)  1 entry, 2 tall
 *   lines 148-242  decor stripes (cabinet glow)    12 entries, 8/7 tall
 * Total: 143 DLL entries = 429 bytes (vs 729 for the naive all-1-line DLL —
 * mixed zone heights are how real 7800 games keep the DLL small).
 * The WELL pool holds the two wells' row objects, the well frames, AND the
 * falling trios — every one of them is a display-list object (no tilemap). */
#define FIELD_LINES   120
#define FIELD_DLL_OFF 30          /* byte offset of well-area entry 0 in dll[] */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Board geometry. A 6-wide, 12-tall well; cell colours 1..3, 0 = empty.
 * Each cell is CELL_PX pixels (8 wide × 8 tall), so a well is 48px wide and
 * 96 zone-lines tall. WELL_LINE0 is the well's top zone-line in the pool. */
#define GRID_W      6
#define GRID_H      12
#define CELL_PX     8
#define WELL_LINES  (GRID_H * CELL_PX)     /* 96 zone-lines */
#define WELL_LINE0  12                     /* well top at pool line 12 */
#define EMPTY       0

/* Well X (left pixel) per layout: 1P single centred well, 2P split board. */
#define WELL_1P_X   56
#define WELL_VS_P0  24
#define WELL_VS_P1  88

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Cell art. 160A mode: 1 byte = 4 pixels of 2 bits each; pixel value 1/2/3 =
 * colour 1/2/3 of the palette the DL entry names, 0 = transparent. The settled
 * well cells are NOT kept as three coloured bitmaps: a well row is composited
 * into a RAM CANVAS (see the idiom below) where a cell's colour is the 2-bit
 * VALUE stamped in, all sharing ONE well palette — that's what lets ONE wide
 * object show all three colours of a row at once. The falling TRIO is drawn by
 * stamping its cells' colour values straight into the same canvas (overlay_trio
 * below); there are no separate trio bitmaps or objects. */
/* settled-well rows AND the falling trio use palette 4 (one shared well palette,
 * three lumas keyed by the 2-bit value). The well frame is BAKED into the row
 * canvas at value 3 (see the WELL CANVAS note), so it shares the same palette. */
#define WELL_PAL    4

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
 * Solid band drawable for multi-line zones AND the well frames. Inside a zone
 * of height H, MARIA fetches scanline l's pixels from ADDR + (H-1-l)*256 — the
 * "offset addressing quirk". A multi-line drawable therefore needs valid data
 * at the SAME low-byte offset across H consecutive 256-byte pages. For solid
 * colour bands we sidestep alignment entirely: a 2KB ROM run of 0x55 means ANY
 * address inside the first page works for zones up to 8 tall (8 pages × 256).
 * Costs 2KB of a 32KB cart — ROM is the cheap resource here. The well frames
 * reuse SOLID8: a frame rail is a thin colour-1 object drawn into the one-line
 * well zones it spans (1-line zones ⇒ the quirk vanishes, any SOLID8 address
 * works). */
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
MK_BAND(dl_base, 5);                   /* the well floor surface band */
static uint8_t dl_empty[2] = { 0, 0 };

/* ════════════════════════════════════════════════════════════════════════
 * ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * THE DISPLAY-LIST POOL — how the wells get drawn (the 7800's signature, here
 * applied to its WORST case). Same machinery the dense 7800 shmup uses for its
 * swarm; here it draws the well frames, the falling trios, and — through the
 * canvas trick below — the settled wells.
 *
 * MARIA hierarchy refresher: DPP → DLL (one entry per ZONE: height + DL
 * pointer) → DL (one 4/5-byte entry per OBJECT crossing that zone) → pixel
 * bytes. There is no sprite table; "an object" IS a DL entry.
 *
 * The well area is 120 one-scanline zones. Each has a fixed 14-byte DL slot:
 * room for TWO wide 5-byte object entries (one row per well in 2P) + the
 * terminator byte (MARIA reads the NEXT entry's mode byte after each entry; a
 * 0 there ends the line — forget the terminator and MARIA walks into garbage
 * and the screen dies). 5+5 = 10, terminator at 11 ≤ 14: comfortable.
 *
 * WHY ONE OBJECT PER WELL-ROW — the MARIA DMA budget, the dial this whole game
 * turns: MARIA steals the bus from the CPU to fetch each line's DL + pixels
 * (~113 DMA cycles per scanline before the line visibly runs out). A puzzle
 * WELL is the WORST case: a full row of 6 cells lands on the same 8 scanlines
 * — 6 objects per line, double the ~3-per-line budget; the back half would
 * flicker out every frame. So THE WELL ROW IS NOT DRAWN AS 6 OBJECTS. Each
 * well row is composited into a 14-byte RAM canvas (frame column + 6 cells +
 * frame column = 56px) and shown as ONE wide 5-byte DL object per scanline —
 * 1 object per line, not 6. Two wells (2P) = 2 objects per line. The falling
 * TRIO is NOT a separate object either: it's overlaid straight into the canvas
 * (see the trio-overlay note), so even a trio scanline stays at ≤2 objects.
 *
 * The pool is SPLIT across two RAM regions because no single linker region
 * fits 1680 bytes + the DLL + the canvases (see RAM MAP). We push MORE of it
 * into raw RAM3 than the shmup does (which kept 47 lines in BSS) because the
 * boards + match mask + well canvases also need BSS — so only 23 lines live in
 * BSS and the rest (97) in POOLB:
 *   lines 0-22   → pool_a[]  (BSS, RAM1)        23 * 14 = 322 bytes
 *   lines 23-119 → POOLB ($2200, raw RAM3)      97 * 14 = 1358 bytes
 * POOLB then ends at $275E, leaving ~$A2 (162 bytes) for the cc65 C stack
 * growing down from $2800 — enough for this game's shallow call depth, but if
 * you add deep recursion, shrink the boards/canvases before growing pool_a.
 * line_dl() resolves a well-area line to its slot; nothing else knows the split.
 *
 * Rebuild-vs-patch doctrine (MENTAL_MODEL.md): the DLL is built ONCE and only
 * its 3-byte well-area entries are repointed at state changes (with DMA off);
 * per-frame work only rewrites bytes INSIDE existing 14-byte slots and inside
 * the well canvases. Tearing down the DLL itself mid-game races MARIA's walker
 * — the classic "works one frame then the screen falls apart" 7800 bug.
 * ════════════════════════════════════════════════════════════════════════ */
#define LINE_BYTES   14          /* per-line DL slot: 2 wide row entries (5B
                                  * each, one per well in 2P) + terminator      */
#define POOLA_LINES  23
static uint8_t  pool_a[POOLA_LINES * LINE_BYTES];
static uint8_t  line_used[FIELD_LINES];

/* line_dl(i): the 14-byte DL slot for well-area line i. Computed inline (no
 * cached pointer array) — on a 4KB machine the 240-byte pointer table is a
 * luxury we spend on RAM the canvases need instead. Lines 0..22 live in
 * pool_a (BSS); 23..119 in POOLB (raw RAM3). */
static uint8_t* line_dl(uint8_t i) {
  return (i < POOLA_LINES)
    ? pool_a + (uint16_t)i * LINE_BYTES
    : POOLB + (uint16_t)(i - POOLA_LINES) * LINE_BYTES;
}

static uint8_t dll[143 * 3];
static uint8_t hud_canvas[8 * 32];      /* 16-char text row, lives in BSS */
static uint8_t hud_dls[8 * 7];          /* one 5-byte DL + term per row   */

/* ── HARDWARE IDIOM (load-bearing) — the WELL CANVASES, and why ONE object per
 * well line. A 14-byte (56px) canvas per BOARD ROW per well: byte 0 = the
 * left frame column, bytes 1..12 = the 6 cells (48px), byte 13 = the right
 * frame column. 12 rows × 14 bytes × 2 wells = 336 bytes in BSS. The frame is
 * BAKED INTO the canvas (drawn with WELL_PAL value 3) rather than emitted as
 * its own side-rail objects — because the per-line DL SLOT is only 14 bytes
 * (room for the terminator after one 5-byte wide entry + one 4-byte trio
 * entry = 9 bytes used, terminator at 10). Two separate 4-byte rail objects
 * PLUS the 5-byte row would be 13 bytes and the terminator would spill into
 * the NEXT line's slot — the classic off-by-one that walks MARIA into garbage.
 * So the frame rides inside the single wide row object; each well line costs
 * exactly ONE wide object (+ the trio where it overlaps). The same 14-byte
 * image shows on all CELL_PX scanlines of the row (1-line zones ⇒ the
 * offset-addressing quirk vanishes). composite_row() rebuilds a row only when
 * that board changed (lock/clear/garbage), so the per-frame emit just points
 * at the standing canvases. */
#define CANVAS_ROW_BYTES (1 + GRID_W * 2 + 1)   /* 14 bytes = 56px (frame+cells) */
#define FRAME_V          3                        /* frame uses WELL_PAL value 3 */
static uint8_t well_canvas[2][GRID_H * CANVAS_ROW_BYTES];

/* ── HARDWARE IDIOM (load-bearing) — emit a WELL ROW as ONE wide 5-byte object
 * per scanline. canvas = the row's 14-byte (56px) image; the SAME image is
 * shown on all CELL_PX scanlines of the row. This is the move that turns a
 * 6-objects-per-line row into a 1-object-per-line row. We hand-write the
 * 5-byte direct entry; width 56px = 14 bytes encodes as (32 - 14). */
static void emit_well_row(uint8_t y, const uint8_t* canvas, uint8_t x) {
  uint8_t r, off;
  uint8_t* dl;
  uint16_t a = (uint16_t)(uintptr_t)canvas;
  for (r = 0; r < CELL_PX; ++r) {
    off = line_used[y];
    if (off + 5 <= LINE_BYTES - 1) {     /* room for a 5-byte entry + term */
      dl = line_dl(y) + off;
      dl[0] = (uint8_t)(a & 0xFF);
      dl[1] = 0x40;                      /* 5-byte form, 160A write mode   */
      dl[2] = (uint8_t)(a >> 8);
      dl[3] = (uint8_t)((WELL_PAL << 5) | (32 - CANVAS_ROW_BYTES));
      dl[4] = x;
      line_used[y] = off + 5;
    }
    ++y;
  }
}

/* ── HARDWARE IDIOM (load-bearing — the per-frame budget, the 7800 lesson of
 * this file) — REBUILD-vs-PATCH, applied to the per-frame loop itself. A naive
 * version re-emits all 12 well rows × 8 lines × 2 wells (≈1500 byte writes)
 * EVERY frame; on a 1.79MHz 6502 that overran one 60Hz frame so badly the sim
 * effectively ran at ~3Hz and every timer stretched ~19x — the exact
 * "stretched timers look like broken rules" footgun the #pragma comment warns
 * about, here caused by per-frame WORK, not the missing optimizer. The fix:
 * the wells only change on a lock/clear/garbage, so we write their DL entries
 * ONCE (build_wells) and leave them STANDING in the slots. Per frame we only
 * overlay the falling trio into the canvas the entries already point at (see
 * the trio-overlay note) — a few dozen byte writes, no DL traffic at all. */
static void wells_open(void) { memset(line_used, 0, FIELD_LINES); }

static void terminate_all(void) {       /* next entry's MODE byte = 0 each line */
  uint8_t i;
  for (i = 0; i < FIELD_LINES; ++i)
    line_dl(i)[line_used[i] + 1] = 0;
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

/* Repoint ONE well-area line's DLL entry (title/menu/game-over text overlays
 * borrow well zones; play repoints them back at the pool slots). */
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
static const uint8_t MEL_F[16] = { 19,17,15,17, 19,15,12,255, 17,15,13,15, 17,13,15,255 };
static const uint8_t MEL_L[16] = {  8, 8, 8, 8,  8, 8,16, 8,  8, 8, 8, 8,  8, 8,16, 8 };
static const uint8_t BAS_F[8]  = { 27,27,23,23, 25,25,29,25 };
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
static void fx_move(void)  { sfx_tone(1, 18, 3);  sfx_hold = 4;  }
static void fx_cycle(void) { sfx_tone(1, 10, 3);  sfx_hold = 4;  }
static void fx_lock(void)  { sfx_tone(1, 24, 4);  sfx_hold = 5;  }
static void fx_clear(void) { sfx_tone(1, 6, 6);   sfx_hold = 7;  }
static void fx_garb(void)  { sfx_noise(10);       sfx_hold = 11; }
static void fx_over(void)  { sfx_noise(22);       sfx_hold = 23; }
static void fx_start(void) { sfx_tone(1, 8, 6);   sfx_hold = 7;  }

/* ── GAME LOGIC (clay — reshape freely) — game state ─────────────────────────
 * Fixed object pools, no allocation (1.79MHz CPU, 4KB RAM — a heap is a cost
 * with no payer). Two 6×12 boards live in BSS (72 bytes each); a 72-byte
 * match mask too. */
static uint8_t board[2][GRID_H][GRID_W];
static uint8_t matched[GRID_H][GRID_W];

static uint8_t  two_p;                  /* 0 = 1P marathon, 1 = 2P versus */
static uint8_t  well_x[2];              /* left pixel of each well        */
static uint8_t  piece_x[2];             /* falling trio column 0..5       */
static int8_t   piece_y[2];            /* row of its TOP cell (<0 = above rim) */
static uint8_t  piece_col[2][3];       /* trio colours, top to bottom    */
static uint8_t  fall_t[2];             /* frames until next gravity step */
static uint8_t  prev_fire[2];          /* edge-trigger the cycle button  */
static uint8_t  prev_lr[2];            /* edge-trigger left/right         */
static uint16_t score[2];
static uint16_t hiscore;
static uint16_t cleared_total;         /* 1P: cells cleared, drives level */
static uint8_t  level;                 /* 1P: 1..9, speeds up the fall    */
static uint8_t  alive[2];              /* 2P: still in the game           */
static uint8_t  ready_pause;           /* freeze frames after spawn/start */
static uint8_t  dirty, over_lock;
static uint8_t  dirty_wells;            /* a board changed → rebuild well DLs  */
static int8_t   trio_rows[2][3];        /* canvas rows the trio overlaid last
                                         * frame, to wipe (-1 = none)          */
static uint16_t rng = 0xACE1;

#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;
static uint8_t winner;                  /* 2P: who won (for the over text) */

#define VS_FALL_DELAY 26               /* 2P: fixed gravity (frames/row)  */
#define GARBAGE_CAP   4                /* max garbage rows per attack     */

static uint8_t random8(void) {            /* xorshift16 — cheap + fine    */
  uint16_t r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (uint8_t)r;
}

/* ── HARDWARE IDIOM (load-bearing) — composite ONE board row into its 14-byte
 * canvas: a left frame column (value 3), then each of the 6 cells writes a
 * 2-byte (8px) 2bpp value at the cell's colour (1/2/3), then a right frame
 * column. Empty cells write 0 (transparent → the BACKGRND shows through,
 * reading as the recessed well). All cells AND the frame share the WELL_PAL
 * palette, so the colour comes from the 2-bit VALUE, not a palette switch —
 * which is the whole reason one wide object can show three colours at once. */
static void composite_row(uint8_t p, uint8_t row) {
  uint8_t c, col, v;
  uint8_t* dst = well_canvas[p] + (uint16_t)row * CANVAS_ROW_BYTES;
  dst[0] = (uint8_t)(FRAME_V * 0x55);         /* left frame column (4px)    */
  for (c = 0; c < GRID_W; ++c) {
    col = board[p][row][c];
    v = col ? (uint8_t)(col * 0x55) : 0;      /* fill all 4 px of the byte  */
    dst[1 + (uint16_t)c * 2]     = v;
    dst[1 + (uint16_t)c * 2 + 1] = v;
  }
  dst[CANVAS_ROW_BYTES - 1] = (uint8_t)(FRAME_V * 0x55);  /* right frame col */
}

static void composite_all(uint8_t p) {
  uint8_t r;
  for (r = 0; r < GRID_H; ++r) composite_row(p, r);
  dirty_wells = 1;                      /* the standing well DLs need rebuild */
}

/* ── GAME LOGIC (clay — reshape freely) — match scan: mark every straight run
 * of 3+ same-coloured cells in all 4 directions (a cell can belong to several
 * runs — the mask de-dupes), return how many cells matched. This is the
 * resolve-time spike the header's frame-budget note talks about. */
static const int8_t DIRS4[4][2] = { {0,1}, {1,0}, {1,1}, {1,-1} };

static uint8_t mark_and_count(uint8_t p) {
  uint8_t r, c, d, len, k, cnt, col;
  int8_t dr, dc;
  int sr, sc;
  cnt = 0;
  for (r = 0; r < GRID_H; ++r)
    for (c = 0; c < GRID_W; ++c) matched[r][c] = 0;
  for (r = 0; r < GRID_H; ++r) {
    for (c = 0; c < GRID_W; ++c) {
      col = board[p][r][c];
      if (col == EMPTY) continue;
      for (d = 0; d < 4; ++d) {
        dr = DIRS4[d][0]; dc = DIRS4[d][1];
        sr = (int)r - dr; sc = (int)c - dc;
        if (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
            && board[p][sr][sc] == col) continue;   /* not the run's start */
        len = 1;
        sr = (int)r + dr; sc = (int)c + dc;
        while (sr >= 0 && sr < GRID_H && sc >= 0 && sc < GRID_W
               && board[p][sr][sc] == col) { ++len; sr += dr; sc += dc; }
        if (len >= 3) {
          sr = r; sc = c;
          for (k = 0; k < len; ++k) {
            if (!matched[sr][sc]) { matched[sr][sc] = 1; ++cnt; }
            sr += dr; sc += dc;
          }
        }
      }
    }
  }
  return cnt;
}

/* Collapse each column so survivors rest on the floor. */
static void apply_gravity(uint8_t p) {
  uint8_t c;
  int8_t r, w;
  for (c = 0; c < GRID_W; ++c) {
    w = GRID_H - 1;
    for (r = GRID_H - 1; r >= 0; --r)
      if (board[p][r][c] != EMPTY) { board[p][w][c] = board[p][r][c]; --w; }
    for (; w >= 0; --w) board[p][w][c] = EMPTY;
  }
}

/* ── GAME LOGIC (clay) — game-over overlay (defined later; the lock path calls
 * it through this forward declaration). ── */
static void paint_gameover(void);

static void game_over(void) {
  uint16_t best = score[0];
  if (two_p && score[1] > best) best = score[1];
  if (best > hiscore) {
    hiscore = best;
    /* HSC NOTE (see file header): on real hardware with a High Score Cart you
     * would write the record into HSC RAM ($1000-$17FF) here. The bundled
     * prosystem core has no HSC support and exposes no SAVE_RAM, so the record
     * honestly lives only as long as the session. */
  }
  fx_over();
  paint_gameover();
}

/* ── GAME LOGIC (clay) — clear matches, drop survivors, chain cascades.
 * Returns the chain depth (0 = the lock matched nothing). ── */
static uint8_t resolve_board(uint8_t p) {
  uint8_t n, r, c, chain;
  uint16_t amt;
  chain = 0;
  for (;;) {
    n = mark_and_count(p);
    if (n == 0) break;
    ++chain;
    for (r = 0; r < GRID_H; ++r)
      for (c = 0; c < GRID_W; ++c)
        if (matched[r][c]) board[p][r][c] = EMPTY;
    amt = (uint16_t)n * 10;
    if (chain > 1) amt *= chain;             /* cascades pay multiplied   */
    score[p] += amt;
    if (score[p] > 99999u) score[p] = 99999u;
    dirty = 1;
    fx_clear();
    apply_gravity(p);
    if (!two_p) {
      cleared_total += n;
      while (level < 9 && cleared_total >= (uint16_t)level * 10) ++level;
    }
  }
  composite_all(p);
  return chain;
}

/* ── GAME LOGIC (clay) — VERSUS attack: garbage rows rise from the bottom of
 * the victim's well (random cells with one gap — matchable, so a skilled
 * victim digs out). If the rim row is already occupied when a garbage row
 * pushes up, the victim tops out and loses. ── */
static void garbage_insert(uint8_t v, uint8_t nrows) {
  uint8_t k, c, gap;
  int8_t r;
  fx_garb();
  for (k = 0; k < nrows; ++k) {
    for (c = 0; c < GRID_W; ++c)
      if (board[v][0][c] != EMPTY) { winner = (uint8_t)(v ^ 1); alive[v] = 0; game_over(); return; }
    for (r = 0; r < GRID_H - 1; ++r)
      for (c = 0; c < GRID_W; ++c)
        board[v][r][c] = board[v][r + 1][c];
    gap = random8() % GRID_W;
    for (c = 0; c < GRID_W; ++c)
      board[v][GRID_H - 1][c] = (c == gap) ? EMPTY : (uint8_t)(1 + random8() % 3);
    if (piece_y[v] > -3) --piece_y[v];        /* keep the trio board-relative */
  }
  composite_all(v);
  dirty = 1;
}

/* Can the trio occupy column x, rows y..y+2? Cells above the rim are fine
 * (pieces enter from above); below the floor or on a cell is not. */
static uint8_t can_place(uint8_t p, int8_t x, int8_t y) {
  int8_t i, cy;
  if (x < 0 || x >= GRID_W) return 0;
  for (i = 0; i < 3; ++i) {
    cy = (int8_t)(y + i);
    if (cy < 0) continue;
    if (cy >= GRID_H) return 0;
    if (board[p][cy][x] != EMPTY) return 0;
  }
  return 1;
}

static void spawn_piece(uint8_t p) {
  piece_x[p] = GRID_W / 2;
  piece_y[p] = 0;                 /* enter the trio FULLY inside the well (all
                                  * 3 cells visible at once) — the well is only
                                  * 12 rows, so an off-screen entry would flash
                                  * past; top-out is detected by a lock landing
                                  * with rows still ≤0 occupied. */
  piece_col[p][0] = (uint8_t)(1 + random8() % 3);
  piece_col[p][1] = (uint8_t)(1 + random8() % 3);
  piece_col[p][2] = (uint8_t)(1 + random8() % 3);
  if (!can_place(p, (int8_t)piece_x[p], piece_y[p])) {  /* this well topped out */
    if (two_p) { alive[p] = 0; winner = (uint8_t)(p ^ 1); }
    game_over();
  }
}

/* ── GAME LOGIC (clay) — land the trio, resolve, attack, respawn. ── */
static void lock_piece(uint8_t p) {
  int8_t i, y;
  uint8_t chain;
  for (i = 0; i < 3; ++i) {
    y = (int8_t)(piece_y[p] + i);
    if (y >= 0) board[p][y][piece_x[p]] = piece_col[p][i];
  }
  fx_lock();
  composite_all(p);
  dirty = 1;
  if (piece_y[p] < 0) {                       /* locked above the rim       */
    if (two_p) { alive[p] = 0; winner = (uint8_t)(p ^ 1); }
    game_over();
    return;
  }
  chain = resolve_board(p);
  if (state != ST_PLAY) return;
  if (chain && two_p) {
    garbage_insert(p ^ 1, chain > GARBAGE_CAP ? GARBAGE_CAP : chain);
    if (state != ST_PLAY) return;             /* garbage topped them out    */
  }
  spawn_piece(p);
}

/* ── GAME LOGIC (clay) — per-player input + gravity. Edge-triggered moves
 * (one cell per press), held DOWN soft-drops. The single fire button CYCLES
 * the trio's three colours (the 7800 pad has one button — this replaces the
 * NES A/B two-way rotate). ── */
static void update_player(uint8_t p, uint8_t pad, uint8_t fire) {
  uint8_t lf, rt, lr, t;
  if (p == 0) { rt = (uint8_t)(pad & J1_RIGHT); lf = (uint8_t)(pad & J1_LEFT); }
  else        { rt = (uint8_t)(pad & J2_RIGHT); lf = (uint8_t)(pad & J2_LEFT); }
  lr = (uint8_t)((lf ? 1 : 0) | (rt ? 2 : 0));

  if ((lr & 1) && !(prev_lr[p] & 1) &&
      can_place(p, (int8_t)(piece_x[p] - 1), piece_y[p])) { --piece_x[p]; fx_move(); }
  if ((lr & 2) && !(prev_lr[p] & 2) &&
      can_place(p, (int8_t)(piece_x[p] + 1), piece_y[p])) { ++piece_x[p]; fx_move(); }
  prev_lr[p] = lr;

  if (fire && !prev_fire[p]) {                 /* cycle colours downward     */
    t = piece_col[p][2];
    piece_col[p][2] = piece_col[p][1];
    piece_col[p][1] = piece_col[p][0];
    piece_col[p][0] = t;
    fx_cycle();
  }
  prev_fire[p] = fire;

  /* soft drop on held DOWN */
  if (p == 0) { if (pad & J1_DOWN) fall_t[p] += 4; }
  else        { if (pad & J2_DOWN) fall_t[p] += 4; }

  ++fall_t[p];
  {
    uint8_t fd = two_p ? VS_FALL_DELAY
                       : (uint8_t)(34 - ((level << 1) + level));   /* 31..7 */
    if (fall_t[p] >= fd) {
      fall_t[p] = 0;
      if (can_place(p, (int8_t)piece_x[p], (int8_t)(piece_y[p] + 1)))
        ++piece_y[p];
      else
        lock_piece(p);                         /* may end the game           */
    }
  }
}

/* ── GAME LOGIC (clay) — HUD: "S00000 H00000 L1" (1P) / "00000 V 00000" (2P)
 * composed into the canvas. ── */
static void draw_hud(void) {
  if (two_p) {
    static char vbuf[18] = "00000   V   00000";
    digits5(vbuf,      score[0]);
    digits5(vbuf + 12, score[1]);
    memset(hud_canvas, 0, sizeof(hud_canvas));
    draw_text(hud_canvas, 0, vbuf);
  } else {
    static char buf[17] = "S00000 H00000 L1";
    digits5(buf + 1, score[0]);
    digits5(buf + 8, hiscore);
    buf[15] = (char)('0' + level);
    memset(hud_canvas, 0, sizeof(hud_canvas));
    draw_text(hud_canvas, 0, buf);
  }
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

/* Title screen: borrow well zones for three text overlays composed in POOLB
 * (the pool isn't drawing wells on the title, so its RAM is free — 4KB
 * machines make you reuse like this). Title is double-height by pointing TWO
 * consecutive 1-line zones at each canvas row — zero extra RAM, pure DLL
 * trickery. */
static void paint_title(void) {
  uint8_t i;
  uint8_t* c0 = POOLB;                    /* title canvas    (256 bytes)  */
  uint8_t* c1 = POOLB + 256;              /* menu line 1     (256 bytes)  */
  uint8_t* c2 = POOLB + 512;              /* menu line 2     (256 bytes)  */
  uint8_t* td = POOLB + 768;              /* 3 lines * 8 row-DLs * 7      */
  CTRL = 0x7F;                            /* DMA off                      */
  memset(POOLB, 0, 768);
  draw_text(c0, (uint8_t)((16 - (sizeof(GAME_TITLE) - 1)) / 2), GAME_TITLE);
  draw_text(c1, 1, "1P - FIRE PLAY");
  draw_text(c2, 1, "2P PAD2 VERSUS");
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
 * the title), the rest of the well area goes blank. */
static void paint_gameover(void) {
  uint8_t i;
  uint8_t* c0 = POOLB;
  uint8_t* c1 = POOLB + 256;
  uint8_t* td = POOLB + 768;
  static char buf[12] = "SCORE 00000";
  CTRL = 0x7F;
  memset(POOLB, 0, 768);
  if (two_p) draw_text(c0, 4, winner ? "P2 WINS" : "P1 WINS");
  else       draw_text(c0, 3, "GAME OVER");
  digits5(buf + 6, two_p ? score[winner ? 1 : 0] : score[0]);
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
static void start_game(uint8_t versus) {
  uint8_t p, r, c, i;
  CTRL = 0x7F;
  two_p = versus;
  well_x[0] = versus ? WELL_VS_P0 : WELL_1P_X;
  well_x[1] = WELL_VS_P1;
  for (i = 0; i < FIELD_LINES; ++i)            /* well zones → pool slots   */
    point_field_zone(i, (uint16_t)(uintptr_t)line_dl(i));
  wells_open();
  terminate_all();                             /* all lines empty + termed  */
  for (p = 0; p < 2; ++p) {
    for (r = 0; r < GRID_H; ++r)
      for (c = 0; c < GRID_W; ++c) board[p][r][c] = EMPTY;
    composite_all(p);
    score[p] = 0;
    fall_t[p] = 0;
    prev_fire[p] = 1;                          /* the button that started   *
                                                * the run shouldn't cycle    */
    prev_lr[p] = 0;
    alive[p] = (uint8_t)((p == 0) || versus);
  }
  cleared_total = 0;
  level = 1;
  winner = 0;
  trio_rows[0][0] = trio_rows[0][1] = trio_rows[0][2] = -1;
  trio_rows[1][0] = trio_rows[1][1] = trio_rows[1][2] = -1;
  rng ^= (uint16_t)(hiscore * 251) ^ 0x1234;
  ready_pause = 40;                            /* a "ready" breather         */
  draw_hud();
  fx_start();
  state = ST_PLAY;
  spawn_piece(0);
  if (versus) spawn_piece(1);
  CTRL = 0x40;
}

static void vblank_wait(void) {
  while (MSTAT & 0x80) { }                /* leave the current vblank     */
  while (!(MSTAT & 0x80)) { }             /* catch the next one starting  */
}

/* ── HARDWARE IDIOM (load-bearing) — emit ONE well's STATIC part: per scanline
 * a SINGLE wide canvas object (the row image, frame baked in — see the WELL
 * CANVAS note). The 14px frame columns sit 4px outside the 48px cell area, so
 * the wide object is placed at well_x - 4 to keep cell column c at exactly
 * well_x + c*8 (where the collision math expects it). Called only on a board
 * change (build_wells), never per frame. */
static void build_well(uint8_t p) {
  uint8_t r;
  uint8_t ox = (uint8_t)(well_x[p] - 4);
  for (r = 0; r < GRID_H; ++r)
    emit_well_row((uint8_t)(WELL_LINE0 + (uint16_t)r * CELL_PX),
                  well_canvas[p] + (uint16_t)r * CANVAS_ROW_BYTES, ox);
}

/* Rebuild both wells' static DL entries + snapshot the per-line base length.
 * Call after any board change (start, lock, clear, garbage). DMA stays on —
 * we only rewrite bytes INSIDE existing slots, never the DLL zones. */
static void build_wells(void) {
  wells_open();
  build_well(0);
  if (two_p) build_well(1);
  terminate_all();
}

/* ── HARDWARE IDIOM (load-bearing) — the FALLING TRIO is drawn by OVERLAYING
 * its cells into the standing well canvas, NOT as extra DL objects. Why: in 2P
 * every well-scanline already carries TWO wide row objects (one per well, 5
 * bytes each = 10 of the 14-byte slot); a separate 4-byte trio object would be
 * 14 bytes with no room for the line terminator, spilling into the next line's
 * slot and walking MARIA into garbage (the off-by-one that blanks the screen).
 * Overlaying the trio into the canvas keeps it to ONE object per line, and —
 * because build_wells already pointed the DL at the canvas — costs only a few
 * canvas-byte writes, no DL rewrite. The previous frame's overlay is wiped by
 * recompositing the touched rows from the board (clear_trio_overlay). */
static void clear_trio_overlay(uint8_t p) {
  uint8_t i;
  for (i = 0; i < 3; ++i)
    if (trio_rows[p][i] >= 0) { composite_row(p, (uint8_t)trio_rows[p][i]); trio_rows[p][i] = -1; }
}

static void overlay_trio(uint8_t p) {
  uint8_t i, col, v;
  int8_t cy;
  for (i = 0; i < 3; ++i) {
    cy = (int8_t)(piece_y[p] + i);
    trio_rows[p][i] = -1;
    if (cy >= 0 && cy < GRID_H) {
      uint8_t* dst = well_canvas[p] + (uint16_t)cy * CANVAS_ROW_BYTES;
      col = piece_col[p][i];
      v = (uint8_t)(col * 0x55);
      dst[1 + (uint16_t)piece_x[p] * 2]     = v;   /* +1 skips left frame col  */
      dst[1 + (uint16_t)piece_x[p] * 2 + 1] = v;
      trio_rows[p][i] = cy;
    }
  }
}

void main(void) {
  uint8_t i;
  uint16_t a;

  /* ── HARDWARE IDIOM (load-bearing) — boot order: build EVERYTHING the DLL
   * will reference, then point DPP at it, THEN enable DMA. Enabling DMA over
   * a half-built DLL is the 7800 black-screen classic. ── */

  /* (pool split is resolved on demand by line_dl(); see its comment.) */

  /* Patch the ROM band drawables' data pointers (SOLID8). */
  a = (uint16_t)(uintptr_t)SOLID8;
  dl_band_a[0] = dl_band_a[5] = (uint8_t)(a & 0xFF);
  dl_band_a[2] = dl_band_a[7] = (uint8_t)(a >> 8);
  dl_band_b[0] = dl_band_b[5] = (uint8_t)(a & 0xFF);
  dl_band_b[2] = dl_band_b[7] = (uint8_t)(a >> 8);
  dl_base[0] = dl_base[5] = (uint8_t)(a & 0xFF);
  dl_base[2] = dl_base[7] = (uint8_t)(a >> 8);

  canvas_dls(hud_dls, hud_canvas, 5);

  /* The DLL — the screen layout, built once (see the layout table above).
   * 143 entries, mixed zone heights; only the 120 well-area entries are ever
   * repointed after this. */
  dllp = dll;
  dll_zone(16, (uint16_t)(uintptr_t)dl_empty);            /* lines 0-15   */
  for (i = 0; i < 8; ++i)                                 /* HUD 16-23    */
    dll_zone(1, (uint16_t)(uintptr_t)(hud_dls + i * 7));
  dll_zone(2, (uint16_t)(uintptr_t)dl_band_a);            /* divider      */
  for (i = 0; i < FIELD_LINES; ++i)                       /* wells 26-145 */
    dll_zone(1, (uint16_t)(uintptr_t)line_dl(i));
  dll_zone(2, (uint16_t)(uintptr_t)dl_base);              /* floor band   */
  /* Below-floor decor stripes — also our anti-blank-screen ballast: with DMA
   * fetching only objects, everything else is the single flat BACKGRND
   * colour, and a mostly-one-colour frame reads as "dead". */
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
  BACKGRND = 0x00;                        /* cabinet black                */
  P0C1 = 0x0F;                            /* title text white             */
  P1C1 = 0x3A;                            /* trio colour 1 (red/gold)     */
  P2C1 = 0xBA;                            /* trio colour 2 (green)        */
  P3C1 = 0x9A;                            /* trio colour 3 (blue)         */
  /* well palette: value 1 = red/gold, value 2 = green, value 3 = blue —
   * same hues as the trio so a locked cell matches the piece that placed it. */
  P4C1 = 0x36; P4C2 = 0xB6; P4C3 = 0x96;
  P5C1 = 0xC8;                            /* HUD green / frame / floor    */
  P6C1 = 0x54;                            /* decor band deep purple       */
  P7C1 = 0x58;                            /* decor band brighter purple   */
  CHARBASE = 0;
  OFFSET = 0;                             /* must stay 0 (7800 standard)  */

  a = (uint16_t)(uintptr_t)dll;
  DPPL = (uint8_t)(a & 0xFF);
  DPPH = (uint8_t)(a >> 8);

  sfx_init();
  hiscore = 0;                            /* in-session only — see header */
  paint_title();                          /* …turns DMA on                */

  for (;;) {
    uint8_t pad, f1, f2;
    vblank_wait();
    sfx_update();
    music_tick();

    pad = (uint8_t)~SWCHA;
    f1 = (uint8_t)(!(INPT4 & 0x80));
    f2 = (uint8_t)(!(INPT5 & 0x80));

    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: P1 fire = 1P, P2 fire = 2P versus ── */
      if (f1 && !prev_fire[0]) start_game(0);
      else if (f2 && !prev_fire[1]) start_game(1);
      prev_fire[0] = f1; prev_fire[1] = f2;
      continue;
    }

    if (state == ST_OVER) {
      if (over_lock) { --over_lock; prev_fire[0] = f1; prev_fire[1] = f2; continue; }
      if ((f1 || f2) && !prev_fire[0] && !prev_fire[1]) paint_title();
      prev_fire[0] = f1; prev_fire[1] = f2;
      continue;
    }

    /* ── ST_PLAY ───────────────────────────────────────────────────── */
    if (ready_pause) {                     /* ready breather, frozen        */
      --ready_pause;
      prev_fire[0] = f1; prev_fire[1] = f2;
    } else {
      update_player(0, pad, f1);
      if (state == ST_PLAY && two_p && alive[1]) update_player(1, pad, f2);
      if (state != ST_PLAY) continue;      /* a lock/garbage ended the game */
    }

    /* ── HARDWARE IDIOM (load-bearing) — the per-frame draw pass is now CHEAP
     * (see REBUILD-vs-PATCH + the trio-overlay note): the wells' DL entries are
     * already standing in the slots and point at the canvases, so per frame we
     * only WIPE last frame's trio (recomposite the touched rows from the board)
     * and OVERLAY this frame's trio into the canvas — a few dozen byte writes,
     * no DL traffic. The wells' DL entries are (re)built only on a board change
     * (a lock/clear/garbage flips dirty_wells via composite_all). ── */
    clear_trio_overlay(0);
    if (two_p) clear_trio_overlay(1);
    if (dirty_wells) { build_wells(); dirty_wells = 0; }
    overlay_trio(0);
    if (two_p) overlay_trio(1);

    if (dirty) draw_hud();
  }
}
