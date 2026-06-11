/* ── racing.c — Atari 7800 top-down road racer (complete example game) ────────
 *
 * PISTON PINCH — a COMPLETE, working game: title screen, 1P endless race with
 * speed control, and 2P SIMULTANEOUS split-lane VERSUS (both cars on the same
 * road at once, P2 on JOYSTICK PORT 1), a vertically-"scrolling" road, dense
 * descending traffic, crash/lives rules, in-session best distance, TIA music +
 * SFX, and the 7800's signature feature: MARIA OBJECT QUANTITY. The player
 * car(s) + up to 10 traffic cars are all just display-list entries MARIA DMAs
 * per scanline — a thick stream of traffic no 2600 (5 hardware objects) draws
 * comfortably. On the 7800 there is no sprite table; every car IS a DL entry,
 * and quantity is the whole point of the chip.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented 7800/MARIA footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — traffic patterns, speeds, tuning, art: reshape freely.
 *
 * What depends on what:
 *   atari7800_sfx.{h,c} — TIA one-shot effects (we give it voice 1; the
 *     inline music player below owns voice 0 — TIA only HAS two voices).
 *   cc65's atari7800 target crt0 + atari7800.cfg — boot, BSS in RAM1
 *     ($1800-$203F), C parameter stack at the TOP of RAM3 growing DOWN
 *     ($2800 →). This game claims the BOTTOM of RAM3 ($2200-$25FD) for its
 *     display-list pool — see the RAM MAP below before moving anything.
 *
 * ════════════════════════════════════════════════════════════════════════
 * NO HARDWARE SCROLL — the load-bearing design fact of a 7800 racer. MARIA
 * has NO scroll register (unlike the NES racer's BG Y-scroll, the SMS/GG
 * VDP, or the Genesis VSRAM). The road cannot be scrolled; it can only be
 * REDRAWN. A top-down racer therefore FAKES vertical road motion two ways,
 * both used here:
 *   1. The lane DASHES march downward — each frame the dash pattern's phase
 *      advances, so the on-off rhythm of the centre/lane lines slides toward
 *      the player. This is the whole illusion of "the road is moving"; it is
 *      a CHEAP per-frame swap of which dash-drawable each road zone points at
 *      (no DLL teardown — see the dash-bank idiom), NOT a scroll.
 *   2. The TRAFFIC descends — cars are display-list objects with their own Y,
 *      moving down the screen at road speed (they read as slower cars you are
 *      overtaking). This is where the MARIA object-quantity signature lives:
 *      a thick stream of independent traffic objects.
 * The asphalt itself (the solid road band + roadside grass) is STATIC — it is
 * a single colour either way, so redrawing it would buy nothing. Documented
 * honestly so a fork doesn't go hunting for a scroll register that isn't there.
 * ════════════════════════════════════════════════════════════════════════
 *
 * PERSISTENCE — honest note: the canonical 7800 save path is the High Score
 * Cart (HSC): a pass-through cartridge with 2KB battery RAM at $1000-$17FF
 * plus a directory ROM. The bundled prosystem core does NOT implement HSC
 * (probed 2026-06: retro_get_memory(SAVE_RAM) size = 0, and the core binary
 * has no HSC code at all), so this game keeps BEST DISTANCE IN-SESSION ONLY
 * (it survives play → title → play, dies on power-off). Do not fake
 * persistence the hardware path can't back — if a future core round adds
 * HSC, wire best into $1000-$17FF and it becomes real.
 *
 * Frame budget (NTSC): the per-tick update (steer + speed + ≤10 traffic ×
 * ≤2 cars AABB + the dash phase step + HUD redraw) fits in one 60Hz frame,
 * dipping to two on heavy frames — vblank_wait() paces the sim, the classic
 * 8-bit pattern. MARIA does not care — it re-walks the same DLs every frame,
 * so a slow CPU loop never blanks or tears the whole screen. That budget only
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
 * the crash-blink grace, the spawn cadence, the marching-dash phase — all
 * ~4.5x too slow, so the road "scroll" crawled and traffic oozed down. That
 * presents as "broken game feel / sprite vanishing" (a synchronized blink
 * keeps an object off screen for ~600ms at a time) — but the DLL, the zone
 * pointers, and every pool slot were byte-perfect when read back from RAM.
 * The footgun generalizes: on a 1.79MHz 6502 the C optimizer is not a nicety,
 * it IS the frame budget, and a too-slow loop shows up as broken GAME RULES
 * (stretched timers, missed 1-frame input edges), not as a slow-looking
 * screen — MARIA keeps repainting the same display lists at a rock-steady
 * 60Hz no matter how far behind the CPU falls. If your fork feels like
 * molasses or "ignores" short button taps, check this pragma is still here
 * before debugging the display lists. */
#pragma optimize(on)

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "PISTON PINCH"

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
 *   lines  26-145  THE ROAD — 120 one-line zones   120 entries (the pool)
 *   lines 146-147  guard band                      1 entry, 2 tall
 *   lines 148-242  decor stripes (horizon glow)    12 entries, 8/7 tall
 * Total: 143 DLL entries = 429 bytes (vs 729 for the naive all-1-line DLL —
 * mixed zone heights are how real 7800 games keep the DLL small).
 * The ROAD pool holds every moving object: both player cars AND the descending
 * traffic. The asphalt + roadside grass + marching dashes are STANDING road
 * drawables the field zones point at when no car is on that line.            */
#define FIELD_LINES   120
#define FIELD_DLL_OFF 30          /* byte offset of road entry 0 in dll[] */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Object art. 160A mode: 1 byte = 4 pixels of 2 bits each; pixel value
 * 1/2/3 = colour 1/2/3 of the palette the DL entry names, 0 = transparent.
 * Rows are stored top-down, consecutive (the 1-scanline-zone pattern below
 * means NO page-alignment dance — see "offset addressing quirk" in
 * MENTAL_MODEL.md for what multi-line zones would demand instead). */

/* Player car, 12px wide (3 bytes) x 10 rows — nose up. Colours: 1 body,
 * 2 window/shade, 3 highlight. Drawn with palette 1 (P1) or 2 (P2). */
static const uint8_t GFX_CAR[10 * 3] = {
  0x01, 0x55, 0x40,    /*   1111111   (roof)  */
  0x05, 0x55, 0x50,    /*  111111111          */
  0x06, 0xAA, 0x90,    /*  1222222 1  (glass) */
  0x06, 0xAA, 0x90,    /*  1222222 1          */
  0x15, 0x55, 0x54,    /* 11111111111 (hood)  */
  0x15, 0x55, 0x54,    /* 11111111111         */
  0x36, 0xAA, 0x9C,    /* 31222222 13 (mirrr) */
  0x05, 0x55, 0x50,    /*  111111111          */
  0x05, 0x55, 0x50,    /*  111111111          */
  0x14, 0x00, 0x14,    /* 11       11 (wheels)*/
};

/* Traffic car, 12px wide (3 bytes) x 8 rows — tail up (you overtake it).
 * Drawn with palette 3 (rival red). */
static const uint8_t GFX_TRAFFIC[8 * 3] = {
  0x14, 0x00, 0x14,    /* 11       11 (wheels)*/
  0x05, 0x55, 0x50,    /*  111111111          */
  0x36, 0xAA, 0x9C,    /* 31222222 13         */
  0x15, 0x55, 0x54,    /* 11111111111 (hood)  */
  0x15, 0x55, 0x54,    /* 11111111111         */
  0x06, 0xAA, 0x90,    /*  1222222 1  (glass) */
  0x05, 0x55, 0x50,    /*  111111111          */
  0x01, 0x55, 0x40,    /*   1111111   (tail)  */
};

/* DL mode bytes for the 4-byte (direct) entry form: palette in bits 5-7,
 * width as (32 - width_bytes) in bits 0-4 (must be non-zero — a zero low
 * 5 bits would make MARIA parse a 5-byte entry instead). */
#define MODE_CAR1    ((1u << 5) | (32 - 3))   /* palette 1, 3 bytes wide */
#define MODE_CAR2    ((2u << 5) | (32 - 3))   /* palette 2 */
#define MODE_TRAFFIC ((3u << 5) | (32 - 3))   /* palette 3, 3 bytes wide */

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
 * Solid band drawable for multi-line zones AND the static asphalt. Inside a
 * zone of height H, MARIA fetches scanline l's pixels from ADDR + (H-1-l)*256
 * — the "offset addressing quirk". A multi-line drawable therefore needs valid
 * data at the SAME low-byte offset across H consecutive 256-byte pages. For
 * solid colour bands we sidestep alignment entirely: a 2KB ROM run of 0x55
 * means ANY address inside the first page works for zones up to 8 tall (8
 * pages × 256). Costs 2KB of a 32KB cart — ROM is the cheap resource here. The
 * road's grass + asphalt rails reuse SOLID8: each is a wide colour-1 object
 * drawn into the one-line road zones it spans (1-line zones ⇒ the quirk
 * vanishes, any SOLID8 address works). */
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
 * THE ROAD as STANDING drawables + the MARCHING-DASH "scroll" — the 7800
 * answer to "there is no scroll register".
 *
 * MARIA hierarchy refresher: DPP → DLL (one entry per ZONE: height + DL
 * pointer) → DL (one 4/5-byte entry per OBJECT crossing that zone) → pixel
 * bytes. There is no sprite table; "an object" IS a DL entry.
 *
 * The road is 120 one-scanline zones. Each zone's STANDING image is a short
 * pre-built DL (road_dl[bank][...]) holding: a wide grey asphalt band, the two
 * white shoulder rails, the solid centre divider, and — on the lines a lane
 * DASH falls — a short white dash object. Every zone points at one of two
 * pre-built DASH BANKS that differ only in WHERE the dash on-segments sit:
 *
 *   MARCHING DASH (the fake scroll) — we don't move pixels, we re-point each
 *   road zone at the dash bank whose on/off phase matches that line's current
 *   offset. Advancing a single global `dash_phase` each frame slides the dash
 *   rhythm DOWNWARD with zero per-pixel work — just 120 one-byte DLL writes
 *   choosing bank A vs B per line. Cheap enough to do every frame inside the
 *   budget; reads as the road rushing toward you. The asphalt + rails are the
 *   SAME in both banks, so only the dashes appear to move.
 *
 * The per-line DL slot is the 14-byte road pool: the standing road object(s)
 * are built ONCE per bank, and each frame we only repoint the DLL zone at the
 * right bank — UNLESS a car sits on that line, in which case we emit the car
 * INTO that line's pool slot after the standing road bytes (cars-as-objects).
 *
 * WHY ≤3 OBJECTS PER LINE — the MARIA DMA budget, the dial this game turns:
 * MARIA steals the bus per scanline (~113 DMA cycles before a line runs out).
 * The standing road is at most 2 wide band objects + 1 dash; we keep cars to
 * ≤1 extra per line by spacing traffic vertically, so even a busy road line
 * stays inside budget. When a 4th object-row would land on a line we DROP it
 * for that frame — a one-line flicker, the artifact real dense 7800 games show.
 *
 * Rebuild-vs-patch doctrine (MENTAL_MODEL.md): the DLL is built ONCE and only
 * its 3-byte road entries are repointed (dash phase + cars), with car emits
 * writing only bytes INSIDE existing 14-byte slots. Tearing down the DLL
 * itself mid-game races MARIA's walker — the classic "works one frame then the
 * screen falls apart" 7800 bug.
 * ════════════════════════════════════════════════════════════════════════ */
/* Per-line DL slot is 14 bytes (same as the shmup). The standing road is two
 * 4-byte DIRECT objects (asphalt + dash = 8 bytes), then room for ONE 4-byte
 * car entry, then the terminator — 8+4+1 = 13 ≤ 14. (Asphalt fits the 4-byte
 * direct form because its 16-byte width encodes as a non-zero low-5-bits 32-16;
 * the 5-byte extended form is only needed for the full-32-byte bands.)
 * LINE_FULL gates car emits so the terminator never spills into the next slot. */
#define LINE_BYTES   14
#define LINE_FULL    12          /* stop emitting cars once a line is this full */
#define POOLA_LINES  47          /* 47 lines in BSS; the rest in RAM3 (POOLB) */
static uint8_t  pool_a[POOLA_LINES * LINE_BYTES];
static uint8_t* line_dl[FIELD_LINES];
static uint8_t  line_used[FIELD_LINES];

static uint8_t dll[143 * 3];
static uint8_t hud_canvas[8 * 32];      /* 16-char text row, lives in BSS */
static uint8_t hud_dls[8 * 7];          /* one 5-byte DL + term per row   */

/* ── HARDWARE IDIOM (load-bearing) — the ROAD BANKS. Two pre-built standing
 * road DLs: bank 0 draws the lane dashes on a line, bank 1 leaves the dash
 * gap. A road zone alternates banks every DASH_RUN lines, and the marching
 * "scroll" shifts which lines are on which bank by `dash_phase`. The asphalt
 * band + shoulder rails + centre divider are identical in both banks (only the
 * dash differs), so the road never appears to change except for the dashes
 * sliding downward. Each bank DL is at most: asphalt(5) + dash(4) + term(1) =
 * 10 bytes ≤ 14. We build it into a tiny per-bank ROM-pointing RAM DL once. */
#define ROAD_W_BYTES  16          /* 64px asphalt centred on a 160px field */
#define ROAD_X        48          /* asphalt left edge (px) — 64px road */
#define DASH_RUN      8           /* dash on for 8 lines, off for 8       */
/* Every road line shares the SAME asphalt object and the SAME dash object
 * (the dash only differs in WHETHER it appears on a line, chosen by phase —
 * not in its bytes), so one template of each suffices (5-byte asphalt, 4-byte
 * dash). Per-line copies would waste ~2KB of the 2KB RAM1 budget for nothing. */
static uint8_t road_band[4];      /* the 64px asphalt object (4-byte direct) */
static uint8_t road_dash[4];      /* the 4px centre dash object (built once)*/
#define DASH_L_X      78          /* centre-of-road dash column (px)        */

/* Emit one object: a 4-byte direct DL entry into every road line one of its
 * rows crosses. gfx rows are consecutive (stride = width in bytes). Callers
 * keep y in [0, FIELD_LINES - h] so no clipping is needed — keep that
 * invariant if you change movement code, or add clipping here. */
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

static void field_close(void) {         /* terminate every line after emits */
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

/* Repoint ONE road line's DLL entry (title/menu/game-over text overlays
 * borrow road zones; play repoints them back at the pool slots). */
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
static const uint8_t MEL_F[16] = { 12,13,15,13, 12,15,17,255, 13,15,17,15, 13,12,10,255 };
static const uint8_t MEL_L[16] = {  8, 8, 8, 8,  8, 8,16, 8,  8, 8, 8, 8,  8, 8,16, 8 };
static const uint8_t BAS_F[8]  = { 25,25,29,29, 23,23,27,25 };
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
static void fx_lane(void)  { sfx_tone(1, 18, 3);  sfx_hold = 4;  }
static void fx_gas(void)   { sfx_tone(1, 10, 4);  sfx_hold = 5;  }
static void fx_brake(void) { sfx_tone(1, 24, 3);  sfx_hold = 4;  }
static void fx_pass(void)  { sfx_tone(1, 14, 2);  sfx_hold = 3;  }
static void fx_crash(void) { sfx_noise(22);       sfx_hold = 23; }
static void fx_start(void) { sfx_tone(1, 8, 6);   sfx_hold = 7;  }

/* ── GAME LOGIC (clay — reshape freely) — ROAD GEOMETRY ──────────────────────
 * Four lanes between the shoulders on a 64px-wide road. Lane centres (left
 * pixel of the 12px car). The centre divider sits between lane 1 and lane 2;
 * in 2P that line splits the territories (P1 lanes 0-1, P2 lanes 2-3). */
#define LANES 4
static const uint8_t LANE_X[LANES] = { 52, 66, 84, 98 };
#define CAR_Y       96            /* both players' fixed road-line Y      */
#define CAR_H       10
#define TRAFFIC_H    8
#define SPAWN_Y      2            /* traffic enters at the top road line  */
#define DESPAWN_Y  112            /* recycle past the bottom (keeps emit in-bounds) */

/* ── GAME LOGIC (clay) — traffic pool (fixed slots, no allocation). MORE
 * traffic than lanes so the MARIA object-quantity signature shows: a thick
 * descending stream. */
#define TRAFFIC  10
static uint8_t tr_lane[TRAFFIC], tr_y[TRAFFIC], tr_act[TRAFFIC];

/* ── GAME LOGIC (clay — reshape freely) — game state ─────────────────────────
 * Fixed object pools, no allocation (1.79MHz CPU, 4KB RAM — a heap is a cost
 * with no payer). Players: 0 = P1 (port 0), 1 = P2 (port 1, versus only). */
#define LIVES_START 3
static uint8_t car_lane[2], car_act[2], crashes[2], invuln[2];
static uint8_t lane_min[2], lane_max[2];   /* 2P split territories         */
static uint8_t two_p, winner;
static uint8_t speed;                       /* road px/8-per-tick, 1..4     */
static uint16_t dist, best;                 /* 1P distance + session best   */
static uint8_t dist_frac;
static uint8_t dash_phase;                  /* marching-dash scroll offset  */
static uint8_t dash_acc;                     /* sub-line dash accumulator    */
static uint8_t spawn_t;
static uint8_t dirty, over_lock;
static uint8_t prev_pad0, prev_pad1, pf0, pf1;
static uint16_t rng = 0xC0DE;

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

/* AABB on the road: both boxes ~12px wide, ~10 tall, in road-line space. */
static uint8_t hits(uint8_t ax, uint8_t ay, uint8_t bx, uint8_t by) {
  uint8_t dx = (ax > bx) ? (ax - bx) : (bx - ax);
  uint8_t dy = (ay > by) ? (ay - by) : (by - ay);
  return (dx < 11) && (dy < 9);
}

/* ── HARDWARE IDIOM (load-bearing) — build the STANDING road. For each road
 * line, road_band[] holds the asphalt band object (grey, 64px) + a centre
 * divider object; road_dash[] holds a short white dash object placed on the
 * lines where the marching pattern is "on". emit_road() points each line's
 * pool slot at its standing bytes; the dash on/off is chosen by the line's
 * phase. Called every frame (it's cheap: ~120 short memcpys) so the dash
 * march is just a changing phase — no DLL teardown. */
static void build_road_drawables(void) {
  uint16_t sa = (uint16_t)(uintptr_t)SOLID8;
  /* asphalt band: one 16-byte (64px) grey object @ ROAD_X (palette 5), 4-byte
   * DIRECT form [lo, mode, hi, x] — width 16 ⇒ mode low5 = 32-16 = 16 (≠0). */
  road_band[0] = (uint8_t)(sa & 0xFF);
  road_band[1] = (uint8_t)((5u << 5) | (32 - ROAD_W_BYTES));
  road_band[2] = (uint8_t)(sa >> 8);
  road_band[3] = ROAD_X;
  /* dash object: a 4px white tick @ the centre lane line (palette 6, 4-byte) */
  road_dash[0] = (uint8_t)(sa & 0xFF);
  road_dash[1] = (uint8_t)((6u << 5) | (32 - 1));   /* 1 byte = 4px */
  road_dash[2] = (uint8_t)(sa >> 8);
  road_dash[3] = DASH_L_X;
}

/* Compose every road line's pool slot: asphalt band, then (on dash-on lines)
 * the marching dash, then the terminator. dash_phase slides the pattern. */
static void compose_road(void) {
  uint8_t i, off, phase, on;
  for (i = 0; i < FIELD_LINES; ++i) {
    uint8_t* dl = line_dl[i];
    /* the 64px asphalt as a 4-byte direct standing object */
    dl[0] = road_band[0];
    dl[1] = road_band[1];
    dl[2] = road_band[2];
    dl[3] = road_band[3];
    off = 4;
    /* marching dash: on for DASH_RUN lines, off for DASH_RUN, sliding by
     * dash_phase so the rhythm scrolls DOWNWARD (the fake road motion). */
    phase = (uint8_t)((i + dash_phase) & ((DASH_RUN << 1) - 1));
    on = (phase < DASH_RUN) ? 1 : 0;
    if (on) {
      dl[off + 0] = road_dash[0];
      dl[off + 1] = road_dash[1];
      dl[off + 2] = road_dash[2];
      dl[off + 3] = road_dash[3];
      off += 4;
    }
    line_used[i] = off;                   /* cars emit AFTER the road bytes */
  }
}

/* ── GAME LOGIC (clay) — HUD: "DIST 00000 BEST 0" / "P1 0 - P2 0" composed ── */
static void draw_hud(void) {
  if (two_p) {
    static char vbuf[17] = "P1 3   VS   P2 3";
    vbuf[3]  = (char)('0' + crashes[0]);
    vbuf[15] = (char)('0' + crashes[1]);
    memset(hud_canvas, 0, sizeof(hud_canvas));
    draw_text(hud_canvas, 0, vbuf);
  } else {
    static char buf[17] = "D00000 B00000 C0";
    digits5(buf + 1, dist);
    digits5(buf + 8, best);
    buf[15] = (char)('0' + crashes[0]);
    memset(hud_canvas, 0, sizeof(hud_canvas));
    draw_text(hud_canvas, 0, buf);
  }
  dirty = 0;
}

static void draw_hud_title(void) {
  static char buf[9] = "BEST00000";
  digits5(buf + 4, best);
  memset(hud_canvas, 0, sizeof(hud_canvas));
  draw_text(hud_canvas, 3, buf);
}

/* ── HARDWARE IDIOM (load-bearing) — paint functions bracket structural
 * display-list changes with MARIA DMA OFF ($7F) / ON ($40), the 7800's
 * version of the NES "rendering off before nametable writes" rule: MARIA
 * may be mid-walk through the very lists being rewritten, and repointing
 * dozens of zones under it glitches (or with bad luck hangs) the frame.
 * CTRL $40 = DMA on, 160A read mode, colour burst on — forget to restore
 * it and the screen stays the flat BACKGRND colour forever. ── */

/* Title screen: borrow road zones for three text overlays composed in POOLB
 * (the pool isn't drawing the road on the title, so its RAM is free — 4KB
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
  draw_text(c1, 1, "1P - FIRE RACE");
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
 * the title), the rest of the road goes blank. */
static void paint_gameover(void) {
  uint8_t i;
  uint8_t* c0 = POOLB;
  uint8_t* c1 = POOLB + 256;
  uint8_t* td = POOLB + 768;
  static char buf[12] = "DIST 00000";
  CTRL = 0x7F;
  memset(POOLB, 0, 768);
  if (two_p) draw_text(c0, 4, winner ? "P2 WINS" : "P1 WINS");
  else       draw_text(c0, 3, "WRECKED");
  if (two_p) {
    draw_text(c1, 3, "RIVAL OUT");
  } else {
    digits5(buf + 5, dist);
    draw_text(c1, 3, buf);
  }
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

/* ── GAME LOGIC (clay) — spawn one traffic car in a free slot ── */
static void spawn_traffic(void) {
  uint8_t i;
  for (i = 0; i < TRAFFIC; ++i) {
    if (!tr_act[i]) {
      tr_act[i] = 1;
      tr_lane[i] = (uint8_t)(random8() & 3);
      tr_y[i] = SPAWN_Y;
      return;
    }
  }
}

/* ── GAME LOGIC (clay) — start a run ── */
static void start_game(uint8_t players) {
  uint8_t i;
  CTRL = 0x7F;
  two_p = players;
  for (i = 0; i < FIELD_LINES; ++i)       /* road zones → pool slots      */
    point_field_zone(i, (uint16_t)(uintptr_t)line_dl[i]);
  for (i = 0; i < TRAFFIC; ++i) tr_act[i] = 0;
  for (i = 0; i < 2; ++i) { crashes[i] = LIVES_START; invuln[i] = 0; }
  if (players) {
    car_act[0] = car_act[1] = 1;
    lane_min[0] = 0; lane_max[0] = 1; car_lane[0] = 0;   /* P1: left half  */
    lane_min[1] = 2; lane_max[1] = 3; car_lane[1] = 3;   /* P2: right half */
    speed = 2;                            /* shared road, fixed (one DLL)  */
  } else {
    car_act[0] = 1; car_act[1] = 0;
    lane_min[0] = 0; lane_max[0] = 3; car_lane[0] = 1;   /* whole road     */
    speed = 1;
  }
  dist = 0; dist_frac = 0; dash_phase = 0; spawn_t = 0; winner = 0;
  rng ^= (uint16_t)(best * 251) ^ 0x1234;
  compose_road();
  field_close();
  draw_hud();
  fx_start();
  state = ST_PLAY;
  CTRL = 0x40;
}

static void game_over(void) {
  if (!two_p && dist > best) {
    best = dist;
    /* HSC NOTE (see file header): on real hardware with a High Score Cart you
     * would write the record into HSC RAM ($1000-$17FF) here. The bundled
     * prosystem core has no HSC support and exposes no SAVE_RAM, so the record
     * honestly lives only as long as the session. */
  }
  paint_gameover();
}

static void crash(uint8_t p) {
  fx_crash();
  invuln[p] = 60;                         /* blink + no-collide grace      */
  if (!two_p) { speed = 1; }              /* a wreck kills your momentum   */
  if (crashes[p] > 0) --crashes[p];
  dirty = 1;
  if (crashes[p] == 0) {
    winner = (uint8_t)(p ^ 1);            /* versus: the OTHER player wins */
    game_over();
  }
}

/* ── GAME LOGIC (clay) — per-player input. LEFT/RIGHT steer between lanes
 * (edge-detected — held d-pad shouldn't machine-gun across the road). 1P
 * only: UP/A accelerate, DOWN/B brake (speed 1-4). ── */
static void update_player(uint8_t p, uint8_t fire, uint8_t pressed) {
  uint8_t lf, rt, up, dn;
  if (!car_act[p]) return;
  if (p == 0) { rt = pressed & J1_RIGHT; lf = pressed & J1_LEFT; up = pressed & J1_UP; dn = pressed & J1_DOWN; }
  else        { rt = pressed & J2_RIGHT; lf = pressed & J2_LEFT; up = pressed & J2_UP; dn = pressed & J2_DOWN; }
  if (lf && car_lane[p] > lane_min[p]) { --car_lane[p]; fx_lane(); }
  if (rt && car_lane[p] < lane_max[p]) { ++car_lane[p]; fx_lane(); }
  if (!two_p) {                           /* speed is shared — 1P only     */
    if ((up || fire) && speed < 4) { ++speed; fx_gas(); }
    if (dn && speed > 1)           { --speed; fx_brake(); }
  }
  if (invuln[p]) --invuln[p];
}

static void vblank_wait(void) {
  while (MSTAT & 0x80) { }                /* leave the current vblank     */
  while (!(MSTAT & 0x80)) { }             /* catch the next one starting  */
}

void main(void) {
  uint8_t i;
  uint16_t a;

  /* ── HARDWARE IDIOM (load-bearing) — boot order: build EVERYTHING the DLL
   * will reference, then point DPP at it, THEN enable DMA. Enabling DMA over
   * a half-built DLL is the 7800 black-screen classic. ── */

  /* Resolve the pool split: road line → 14-byte DL slot. */
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

  build_road_drawables();
  canvas_dls(hud_dls, hud_canvas, 5);

  /* The DLL — the screen layout, built once (see the layout table above).
   * 143 entries, mixed zone heights; only the 120 road entries are ever
   * repointed after this. */
  dllp = dll;
  dll_zone(16, (uint16_t)(uintptr_t)dl_empty);            /* lines 0-15   */
  for (i = 0; i < 8; ++i)                                 /* HUD 16-23    */
    dll_zone(1, (uint16_t)(uintptr_t)(hud_dls + i * 7));
  dll_zone(2, (uint16_t)(uintptr_t)dl_band_a);            /* divider      */
  for (i = 0; i < FIELD_LINES; ++i)                       /* road 26-145  */
    dll_zone(1, (uint16_t)(uintptr_t)line_dl[i]);
  dll_zone(2, (uint16_t)(uintptr_t)dl_band_a);            /* guard band   */
  /* Horizon decor stripes — also our anti-blank-screen ballast: with DMA
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
  BACKGRND = 0xC4;                        /* roadside grass green          */
  P0C1 = 0x0F;                            /* title text white              */
  P1C1 = 0x94; P1C2 = 0x0F; P1C3 = 0x9C;  /* P1 car blues                  */
  P2C1 = 0x46; P2C2 = 0x0F; P2C3 = 0x4C;  /* P2 car golds                  */
  P3C1 = 0x36; P3C2 = 0x0F; P3C3 = 0x3C;  /* traffic reds                  */
  P4C1 = 0x0F;                            /* (spare)                       */
  P5C1 = 0x06;                            /* road asphalt grey             */
  P6C1 = 0x0E;                            /* lane dash / HUD white-ish      */
  P7C1 = 0x0A;                            /* horizon decor band            */
  CHARBASE = 0;
  OFFSET = 0;                             /* must stay 0 (7800 standard)   */

  a = (uint16_t)(uintptr_t)dll;
  DPPL = (uint8_t)(a & 0xFF);
  DPPH = (uint8_t)(a >> 8);

  sfx_init();
  best = 0;                               /* in-session only — see header  */
  paint_title();                          /* …turns DMA on                 */

  for (;;) {
    uint8_t pad, f1, f2, pr0, pr1;
    vblank_wait();
    sfx_update();
    music_tick();

    pad = (uint8_t)~SWCHA;
    f1 = (uint8_t)(!(INPT4 & 0x80));
    f2 = (uint8_t)(!(INPT5 & 0x80));

    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: P1 fire = 1P race, P2 fire = 2P ── */
      if (f1 && !pf0) start_game(0);
      else if (f2 && !pf1) start_game(1);
      pf0 = f1; pf1 = f2;
      continue;
    }

    if (state == ST_OVER) {
      if (over_lock) { --over_lock; pf0 = f1; pf1 = f2; continue; }
      if ((f1 || f2) && !pf0 && !pf1) paint_title();
      pf0 = f1; pf1 = f2;
      continue;
    }

    /* ── ST_PLAY ───────────────────────────────────────────────────── */
    pr0 = (uint8_t)(pad & ~prev_pad0);    /* port-0 newly-pressed edges    */
    pr1 = (uint8_t)(pad & ~prev_pad1);    /* port-1 newly-pressed edges    */
    prev_pad0 = pad; prev_pad1 = pad;
    update_player(0, f1, pr0);
    if (two_p) update_player(1, f2, pr1);
    if (state != ST_PLAY) { pf0 = f1; pf1 = f2; continue; }   /* a crash ended it */

    /* ── HARDWARE IDIOM (load-bearing) — the marching-dash "scroll": advance
     * the phase by the road speed, then re-compose the road into the pool
     * slots. compose_road() points each road zone at the dash bank matching
     * its (line + dash_phase) — the dashes slide downward with no per-pixel
     * work. This IS the fake road motion (MARIA has no scroll register).
     * dash_acc accumulates speed so the march speeds up with the throttle but
     * never skips so far it strobes; the actual compose happens in the draw
     * pass below (compose_road), which reads dash_phase. ── */
    dash_acc = (uint8_t)(dash_acc + speed);
    while (dash_acc >= 2) { dash_acc -= 2; dash_phase = (uint8_t)(dash_phase + 1); }
    if (dash_phase >= (DASH_RUN << 1)) dash_phase -= (DASH_RUN << 1);

    /* ── GAME LOGIC (clay) — traffic flows DOWN at road speed (reads as cars
     * you overtake); recycle past the bottom with a little pass tick. ── */
    for (i = 0; i < TRAFFIC; ++i) {
      if (!tr_act[i]) continue;
      if (tr_y[i] >= (uint8_t)(DESPAWN_Y - speed)) {
        tr_act[i] = 0;
        fx_pass();
      } else {
        tr_y[i] = (uint8_t)(tr_y[i] + speed);
      }
    }
    if (++spawn_t >= (uint8_t)(40 - (speed << 2))) {   /* faster ⇒ denser */
      spawn_t = 0;
      spawn_traffic();
    }

    /* Distance (1P stat): 1 unit per 16 "scrolled" px. */
    if (!two_p) {
      dist_frac = (uint8_t)(dist_frac + speed);
      if (dist_frac >= 16) {
        dist_frac -= 16;
        if (dist < 65535u) ++dist;
        dirty = 1;
      }
    }

    /* ── GAME LOGIC (clay) — traffic × cars. Crash grace: a just-wrecked car
     * blinks and can't collide for 60 frames. ── */
    for (i = 0; i < TRAFFIC; ++i) {
      uint8_t p;
      if (!tr_act[i]) continue;
      for (p = 0; p < 2; ++p) {
        if (!car_act[p] || invuln[p]) continue;
        if (hits(LANE_X[tr_lane[i]], tr_y[i], LANE_X[car_lane[p]], CAR_Y)) {
          tr_act[i] = 0;
          crash(p);
          if (state != ST_PLAY) break;
        }
      }
      if (state != ST_PLAY) break;
    }
    if (state != ST_PLAY) { pf0 = f1; pf1 = f2; continue; }

    /* ── HARDWARE IDIOM (load-bearing) — the per-frame draw pass:
     * compose the road (sets line_used past the standing road bytes) → emit
     * every car INTO the remaining room of each line's slot → terminate.
     * Cars go last so the road is always present even if a line fills; a
     * dropped car-row is a one-line flicker, never a missing road. ── */
    compose_road();
    /* traffic first (so the player's own car wins the 3-object budget on a
     * shared line — the player car should never be the one that flickers). */
    for (i = 0; i < TRAFFIC; ++i)
      if (tr_act[i]) emit_object(tr_y[i], TRAFFIC_H, GFX_TRAFFIC, 3,
                                 MODE_TRAFFIC, LANE_X[tr_lane[i]]);
    for (i = 0; i < 2; ++i) {
      if (!car_act[i]) continue;
      /* crash blink = SHIMMER, never vanish: on blink ticks draw only the
       * car's bottom half instead of skipping it (a fully-skipped sprite
       * reads as "gone" in any single sampled frame — the spawn-blink
       * footgun from the gold round). */
      if (invuln[i] && (invuln[i] & 4))
        emit_object((uint8_t)(CAR_Y + 5), 5, GFX_CAR + 15, 3,
                    i ? MODE_CAR2 : MODE_CAR1, LANE_X[car_lane[i]]);
      else
        emit_object(CAR_Y, CAR_H, GFX_CAR, 3,
                    i ? MODE_CAR2 : MODE_CAR1, LANE_X[car_lane[i]]);
    }
    field_close();

    if (dirty) draw_hud();
    pf0 = f1; pf1 = f2;
  }
}
