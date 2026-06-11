/* ── sports.c — Atari 7800 versus court game (complete example) ──────────────
 *
 * FLUX FENCE — a COMPLETE, working game: title screen, 1P vs a beatable CPU
 * and 2P SIMULTANEOUS VERSUS (P2 on JOYSTICK PORT 1), first-to-5 match flow
 * with a result screen, two-voice TIA music + SFX, and an in-session record
 * (longest win streak vs the CPU). It's the Pong lineage rebuilt on MARIA: the
 * two paddles, the ball, and the centre net are all just display-list OBJECTS
 * MARIA DMAs per scanline — the same per-line object pool the 7800 shmup uses
 * for a swarm, here spent on a sparse court (≤2 objects ever share a line, so
 * the whole frame sits comfortably inside the MARIA DMA budget).
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented 7800/MARIA footgun;
 *     reshape your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — court art, ball physics, CPU skill, scoring rules:
 *     reshape freely.
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
 * has no HSC code at all), so this game keeps its RECORD IN-SESSION ONLY (it
 * survives play → title → play, dies on power-off). For a VERSUS game a raw
 * hi-score is meaningless (every match ends 5-x), so the record we keep is the
 * longest 1P win streak vs the CPU — the stat a returning player chases. 2P
 * matches never touch it (humans beating each other isn't a record). Do not
 * fake persistence the hardware path can't back — if a future core round adds
 * HSC, wire best_streak into $1000-$17FF and it becomes real.
 *
 * Frame budget (NTSC): the per-tick update is tiny — two paddle moves + one
 * ball step + two AABB paddle tests + a couple of HUD digits. The per-frame
 * draw pass re-emits only the net, two paddles, and the ball (≤2 objects on
 * any one scanline), well inside one 60Hz frame. MARIA does not care how far
 * the CPU falls behind — it re-walks the same display lists at 60Hz — but that
 * budget only holds because of the #pragma optimize(on) right below: read its
 * comment before deleting it.
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
 * the serve pause, the result-screen lock, the ball speed — all ~4.5x too
 * slow, so the ball crawled and the game "looked broken". But the DLL, the
 * zone pointers, and every pool slot were byte-perfect when read back from
 * RAM. The footgun generalizes: on a 1.79MHz 6502 the C optimizer is not a
 * nicety, it IS the frame budget, and a too-slow loop shows up as broken GAME
 * RULES (a sluggish ball, missed 1-frame input edges), not as a slow-looking
 * screen — MARIA keeps repainting the same display lists at a rock-steady
 * 60Hz no matter how far behind the CPU falls. If your fork feels like
 * molasses or "ignores" short button taps, check this pragma is still here
 * before debugging the display lists. */
#pragma optimize(on)

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "FLUX FENCE"

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
 * 2P versus uses BOTH ports: player 0 (left paddle) reads the high nibble +
 * INPT4 fire, player 1 (right paddle) the low nibble + INPT5 fire. */
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
 *   lines  24- 25  TOP RAIL band (court boundary)  1 entry, 2 tall
 *   lines  26-145  THE COURT — 120 one-line zones  120 entries (the pool)
 *   lines 146-147  BOTTOM RAIL band (court bound.)  1 entry, 2 tall
 *   lines 148-242  decor stripes (cabinet glow)    12 entries, 8/7 tall
 * Total: 143 DLL entries = 429 bytes (vs 729 for the naive all-1-line DLL —
 * mixed zone heights are how real 7800 games keep the DLL small).
 * The COURT pool holds the moving objects: the centre net, the two paddles,
 * and the ball — every one of them a display-list object (no tilemap). The
 * top/bottom rails are fixed band zones the ball bounces between. */
#define FIELD_LINES   120
#define FIELD_DLL_OFF 30          /* byte offset of court entry 0 in dll[] */

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Object art. 160A mode: 1 byte = 4 pixels of 2 bits each; pixel value
 * 1/2/3 = colour 1/2/3 of the palette the DL entry names, 0 = transparent.
 * Rows are stored top-down, consecutive (the 1-scanline-zone pattern below
 * means NO page-alignment dance — see "offset addressing quirk" in
 * MENTAL_MODEL.md for what multi-line zones would demand instead). */

/* Paddle — a solid 8px-wide (2 bytes) colour-1 bar, PADDLE_H rows tall. Each
 * row is two value-1 nibble bytes (0x55 = four colour-1 pixels); drawn with
 * palette 1 (P1 blue) or 2 (P2 red). */
#define PADDLE_H 16
static const uint8_t GFX_PADDLE[PADDLE_H * 2] = {
  0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55,
  0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55,
  0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55,
  0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55,
};

/* Ball — a 4px-wide (1 byte) colour-3 pip, BALL_H rows tall, palette 3. */
#define BALL_H 4
static const uint8_t GFX_BALL[BALL_H] = { 0x55, 0x55, 0x55, 0x55 };

/* DL mode bytes for the 4-byte (direct) entry form: palette in bits 5-7,
 * width as (32 - width_bytes) in bits 0-4 (must be non-zero — a zero low
 * 5 bits would make MARIA parse a 5-byte entry instead). */
#define MODE_PADDLE1 ((1u << 5) | (32 - 2))   /* palette 1, 2 bytes wide */
#define MODE_PADDLE2 ((2u << 5) | (32 - 2))   /* palette 2 */
#define MODE_BALL    ((3u << 5) | (32 - 1))   /* palette 3, 1 byte wide  */
#define MODE_NET     ((5u << 5) | (32 - 1))   /* HUD-green, 1 byte wide  */

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
 * Solid band drawable for multi-line zones (the rails + decor stripes) AND
 * the net. Inside a zone of height H, MARIA fetches scanline l's pixels from
 * ADDR + (H-1-l)*256 — the "offset addressing quirk". A multi-line drawable
 * therefore needs valid data at the SAME low-byte offset across H consecutive
 * 256-byte pages. For solid colour bands we sidestep alignment entirely: a
 * 2KB ROM run of 0x55 means ANY address inside the first page works for zones
 * up to 8 tall (8 pages x 256). Costs 2KB of a 32KB cart — ROM is the cheap
 * resource here. The net reuses SOLID8 too: it's a thin colour object drawn
 * into the one-line court zones it spans (1-line zones ⇒ the quirk vanishes,
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
MK_BAND(dl_rail, 5);                    /* the top/bottom court rails (green) */
static uint8_t dl_empty[2] = { 0, 0 };

/* ════════════════════════════════════════════════════════════════════════
 * ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * THE DISPLAY-LIST POOL — how the court's moving objects get drawn (the
 * 7800's signature). Same machinery the dense 7800 shmup uses for its swarm;
 * here it draws the net, the two paddles, and the ball.
 *
 * MARIA hierarchy refresher: DPP → DLL (one entry per ZONE: height + DL
 * pointer) → DL (one 4/5-byte entry per OBJECT crossing that zone) → pixel
 * bytes. There is no sprite table; "an object" IS a DL entry.
 *
 * The court is 120 one-scanline zones. Each has a fixed 14-byte DL slot:
 * room for THREE 4-byte object entries + the terminator byte (MARIA reads
 * the NEXT entry's mode byte after each entry; a 0 there ends the line —
 * forget the terminator and MARIA walks into garbage and the screen dies).
 * A court game is the EASY case for this budget — the net + at most one
 * paddle + the ball ever share a scanline (2-3 objects), miles under the
 * ~3-per-line DMA ceiling. We keep the same 3-slot machinery the shmup uses
 * so a fork that adds more objects (a second ball, power-ups) inherits the
 * flicker-drop safety valve for free.
 *
 * The pool is SPLIT across two RAM regions because no single linker region
 * fits 1680 bytes + the DLL + the canvases (see RAM MAP):
 *   lines 0-46   → pool_a[]  (BSS, RAM1)        47 * 14 = 658 bytes
 *   lines 47-119 → POOLB ($2200, raw RAM3)      73 * 14 = 1022 bytes
 * line_dl[] resolves a court line to its slot; nothing else knows the split.
 *
 * Rebuild-vs-patch doctrine (MENTAL_MODEL.md): the DLL is built ONCE and
 * only its 3-byte court entries are repointed at state changes (with DMA
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

/* Emit one object: a 4-byte direct DL entry into every court line one of
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

/* Repoint ONE court line's DLL entry (title/result text overlays borrow
 * court zones; play repoints them back at the pool slots). */
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
static const uint8_t MEL_F[16] = { 15,17,19,17, 15,19,22,255, 17,19,21,19, 17,15,17,255 };
static const uint8_t MEL_L[16] = {  8, 8, 8, 8,  8, 8,16, 8,  8, 8, 8, 8,  8, 8,16, 8 };
static const uint8_t BAS_F[8]  = { 25,25,29,29, 27,27,23,27 };
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
static void fx_hit(void)   { sfx_tone(1, 14, 4);  sfx_hold = 5;  }
static void fx_wall(void)  { sfx_tone(1, 20, 3);  sfx_hold = 4;  }
static void fx_score(void) { sfx_noise(8);        sfx_hold = 9;  }
static void fx_win(void)   { sfx_tone(1, 8, 8);   sfx_hold = 9;  }
static void fx_start(void) { sfx_tone(1, 10, 6);  sfx_hold = 7;  }

/* ── GAME LOGIC (clay — reshape freely) — court geometry + match rules ────────
 * The court is the 120-line field between the two rails. Y is in COURT LINES
 * [0, FIELD_LINES); X is in 7800 pixels [0, 160). Paddles ride the left/right
 * edges and slide vertically; the ball bounces between the rails and is scored
 * when it passes a paddle. */
#define PADDLE_X1   8             /* left paddle (P1)  */
#define PADDLE_X2   148           /* right paddle (P2 / CPU) */
#define NET_X       79            /* centre net column */
#define BALL_W      4
#define COURT_T     2             /* first court line the ball may occupy   */
#define COURT_B     (FIELD_LINES - BALL_H - 2)
#define PADDLE_TOP_MAX  (FIELD_LINES - PADDLE_H)
#define WIN_SCORE   5             /* first to 5 takes the match */
#define PADDLE_SPEED 3
#define CPU_SPEED    2            /* < player speed → beatable by steep angles */

/* Ball position/velocity in COURT-LINE / PIXEL units (signed for the math). */
static int16_t bx, by;
static int8_t  bdx, bdy;
static uint8_t pad_y[2];          /* paddle TOP, court lines (0 = P1, 1 = P2) */
static uint8_t score[2];
static uint8_t serve_timer;       /* freeze frames between points          */
static uint8_t two_p;             /* 0 = 1P vs CPU, 1 = 2P versus           */
static uint8_t streak;            /* current 1P-vs-CPU win streak (RAM)     */
static uint16_t best_streak;      /* in-session record — see header         */
static uint8_t new_record;        /* result screen flags a NEW RECORD       */
static uint8_t winner;            /* result: 0 = left/P1, 1 = right/P2/CPU   */
static uint8_t over_lock;         /* swallow the held fire on the result    */
static uint8_t dirty;
static uint16_t rng = 0xACE1;

#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;

/* ── GAME LOGIC (clay) — xorshift16 PRNG. A versus game NEEDS this: the 7800
 * is fully deterministic, so without a noise source two fixed strategies lock
 * into an infinite rally loop (the exact same cycle, forever). random8() is
 * ticked once per play frame AND spins the serve/return angle so an idle
 * match — CPU vs a still paddle — still drifts off true and ENDS rather than
 * rallying without limit. */
static uint8_t random8(void) {
  uint16_t r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (uint8_t)r;
}

/* ── GAME LOGIC (clay) — serve: ball to centre, toward the chosen side, with
 * a PRNG-spun vertical angle so no two serves trace the same path (the
 * idle-match-must-end guarantee). ── */
static void serve_ball(uint8_t to_left) {
  bx = NET_X - 1;
  by = FIELD_LINES / 2;
  bdx = to_left ? -2 : 2;
  bdy = (int8_t)((random8() & 2) - 1);         /* -1 or +1 */
  if (bdy == 0) bdy = 1;
  serve_timer = 30;                            /* half-second breather */
}

/* ── GAME LOGIC (clay) — HUD: "P1 s        s CP" score line (s = digit). ── */
static void draw_hud(void) {
  static char buf[17] = "P1 0        0 CP";
  buf[3] = (char)('0' + (score[0] > 9 ? 9 : score[0]));
  buf[12] = (char)('0' + (score[1] > 9 ? 9 : score[1]));
  buf[14] = two_p ? 'P' : 'C';
  buf[15] = two_p ? '2' : 'P';
  memset(hud_canvas, 0, sizeof(hud_canvas));
  draw_text(hud_canvas, 0, buf);
  dirty = 0;
}

static void draw_hud_title(void) {
  static char buf[12] = "BEST 00000";
  digits5(buf + 5, best_streak);
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

/* Title screen: borrow court zones for three text overlays composed in
 * POOLB (the pool isn't drawing the court on the title, so its RAM is free —
 * 4KB machines make you reuse like this). Title is double-height by pointing
 * TWO consecutive 1-line zones at each canvas row — zero extra RAM, pure DLL
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
  draw_text(c1, 1, "1P FIRE VS CPU");
  draw_text(c2, 1, "2P PAD2 RIVAL");
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

/* Result screen: the pool RAM becomes the message overlay (same reuse trick
 * as the title), the rest of the court goes blank. */
static void paint_result(void) {
  uint8_t i;
  uint8_t* c0 = POOLB;
  uint8_t* c1 = POOLB + 256;
  uint8_t* c2 = POOLB + 512;
  uint8_t* td = POOLB + 768;
  static char buf[8] = "0 - 0";
  CTRL = 0x7F;
  memset(POOLB, 0, 768);
  if (two_p) draw_text(c0, 4, winner ? "P2 WINS" : "P1 WINS");
  else       draw_text(c0, 3, winner ? "CPU WINS" : "P1 WINS");
  buf[0] = (char)('0' + score[0]);
  buf[4] = (char)('0' + score[1]);
  draw_text(c1, 6, buf);
  if (new_record) draw_text(c2, 3, "NEW RECORD");
  else            draw_text(c2, 2, "FIRE - TITLE");
  canvas_dls(td,       c0, 0);
  canvas_dls(td + 56,  c1, 5);
  canvas_dls(td + 112, c2, 5);
  for (i = 0; i < FIELD_LINES; ++i)
    point_field_zone(i, (uint16_t)(uintptr_t)dl_empty);
  for (i = 0; i < 8; ++i) {
    point_field_zone((uint8_t)(36 + i), (uint16_t)(uintptr_t)(td + i * 7));
    point_field_zone((uint8_t)(56 + i), (uint16_t)(uintptr_t)(td + 56 + i * 7));
    point_field_zone((uint8_t)(76 + i), (uint16_t)(uintptr_t)(td + 112 + i * 7));
  }
  over_lock = 30;                         /* swallow the held fire button */
  state = ST_OVER;
  CTRL = 0x40;
}

/* ── GAME LOGIC (clay) — match over: result + record bookkeeping (see header
 * for why the record is the longest 1P-vs-CPU win streak, in-session only). ── */
static void end_match(void) {
  new_record = 0;
  if (score[0] >= WIN_SCORE) {            /* P1 won                       */
    winner = 0;
    if (!two_p) {                         /* vs CPU: extend + record streak */
      ++streak;
      if (streak > best_streak) {
        best_streak = streak;
        new_record = 1;
        /* HSC NOTE (see file header): on real hardware with a High Score
         * Cart you would write the record into HSC RAM ($1000-$17FF) here.
         * The bundled prosystem core has no HSC support and exposes no
         * SAVE_RAM, so the record honestly lives only as long as the session. */
      }
    }
  } else {                               /* P2 / CPU won                  */
    winner = 1;
    if (!two_p) streak = 0;              /* the streak dies with the loss */
  }
  fx_win();
  paint_result();
}

/* ── GAME LOGIC (clay) — one point scored ── */
static void score_point(uint8_t for_left) {
  if (for_left) ++score[0]; else ++score[1];
  fx_score();
  dirty = 1;
  if (score[0] >= WIN_SCORE || score[1] >= WIN_SCORE) end_match();
  else serve_ball((uint8_t)(for_left ? 0 : 1)); /* loser of the point is served at */
}

/* ── GAME LOGIC (clay) — paddle hit: deflect by where the ball struck.
 * Centre = flat-ish, edges = steep. Max |bdy| is 2; the CPU moves at
 * CPU_SPEED (< player) so an edge hit is exactly how a human beats it. A ±1
 * random spin on every return keeps rallies from repeating (PRNG note). ── */
static void deflect(uint8_t paddle_top) {
  int16_t rel = (by + BALL_H / 2) - (int16_t)(paddle_top + PADDLE_H / 2);
  bdy = (int8_t)(rel >> 3);
  bdy += (int8_t)((random8() & 2) - 1);     /* spin: -1 or +1 */
  if (bdy > 2) bdy = 2;
  if (bdy < -2) bdy = -2;
  if (bdy == 0) bdy = (rel < 0) ? -1 : 1;   /* never return a flat ball */
  fx_hit();
}

/* ── GAME LOGIC (clay) — start a match ── */
static void start_match(uint8_t players) {
  uint8_t i;
  CTRL = 0x7F;
  two_p = players;
  pad_y[0] = (FIELD_LINES - PADDLE_H) / 2;
  pad_y[1] = (FIELD_LINES - PADDLE_H) / 2;
  score[0] = 0; score[1] = 0;
  new_record = 0;
  winner = 0;
  for (i = 0; i < FIELD_LINES; ++i)            /* court zones → pool slots  */
    point_field_zone(i, (uint16_t)(uintptr_t)line_dl[i]);
  field_open();
  field_close();                               /* all lines empty + termed  */
  rng ^= (uint16_t)(best_streak * 251) ^ 0x1234;
  serve_ball(0);
  draw_hud();
  fx_start();
  state = ST_PLAY;
  CTRL = 0x40;
}

static void vblank_wait(void) {
  while (MSTAT & 0x80) { }                /* leave the current vblank     */
  while (!(MSTAT & 0x80)) { }             /* catch the next one starting  */
}

/* ── GAME LOGIC (clay) — per-player paddle move from a joystick port. ── */
static void move_paddle(uint8_t p, uint8_t pad) {
  uint8_t up, dn;
  if (p == 0) { up = (uint8_t)(pad & J1_UP); dn = (uint8_t)(pad & J1_DOWN); }
  else        { up = (uint8_t)(pad & J2_UP); dn = (uint8_t)(pad & J2_DOWN); }
  if (up && pad_y[p] >= PADDLE_SPEED)                 pad_y[p] -= PADDLE_SPEED;
  if (dn && pad_y[p] <= PADDLE_TOP_MAX - PADDLE_SPEED) pad_y[p] += PADDLE_SPEED;
}

/* ── GAME LOGIC (clay) — CPU paddle: chase the ball's centre at CPU_SPEED
 * (< player) with a small dead zone. Beatable by design: steep deflections
 * outrun it, and the PRNG spin keeps it from ever locking into a perfect
 * rally — an unattended match therefore always ENDS. ── */
static void move_cpu(void) {
  int16_t target = by + BALL_H / 2 - PADDLE_H / 2;
  if ((int16_t)pad_y[1] + 2 < target && pad_y[1] <= PADDLE_TOP_MAX - CPU_SPEED)
    pad_y[1] += CPU_SPEED;
  else if ((int16_t)pad_y[1] > target + 2 && pad_y[1] >= CPU_SPEED)
    pad_y[1] -= CPU_SPEED;
}

void main(void) {
  uint8_t i;
  uint16_t a;

  /* ── HARDWARE IDIOM (load-bearing) — boot order: build EVERYTHING the
   * DLL will reference, then point DPP at it, THEN enable DMA. Enabling
   * DMA over a half-built DLL is the 7800 black-screen classic. ── */

  /* Resolve the pool split: court line → 14-byte DL slot. */
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
  dl_rail[0] = dl_rail[5] = (uint8_t)(a & 0xFF);
  dl_rail[2] = dl_rail[7] = (uint8_t)(a >> 8);

  canvas_dls(hud_dls, hud_canvas, 5);

  /* The DLL — the screen layout, built once (see the layout table above).
   * 143 entries, mixed zone heights; only the 120 court entries are ever
   * repointed after this. */
  dllp = dll;
  dll_zone(16, (uint16_t)(uintptr_t)dl_empty);            /* lines 0-15   */
  for (i = 0; i < 8; ++i)                                 /* HUD 16-23    */
    dll_zone(1, (uint16_t)(uintptr_t)(hud_dls + i * 7));
  dll_zone(2, (uint16_t)(uintptr_t)dl_rail);              /* top rail     */
  for (i = 0; i < FIELD_LINES; ++i)                       /* court 26-145 */
    dll_zone(1, (uint16_t)(uintptr_t)line_dl[i]);
  dll_zone(2, (uint16_t)(uintptr_t)dl_rail);              /* bottom rail  */
  /* Below-court decor stripes — also our anti-blank-screen ballast: with DMA
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
  BACKGRND = 0x00;                        /* court black                  */
  P0C1 = 0x0F;                            /* title text white             */
  P1C1 = 0x96;                            /* P1 paddle blue               */
  P2C1 = 0x46;                            /* P2 / CPU paddle red          */
  P3C1 = 0x0E;                            /* ball white                   */
  P4C1 = 0x1A;                            /* (spare)                      */
  P5C1 = 0xC9;                            /* HUD green / rails / net      */
  P6C1 = 0x84;                            /* decor band deep teal         */
  P7C1 = 0x88;                            /* decor band brighter teal     */
  CHARBASE = 0;
  OFFSET = 0;                             /* must stay 0 (7800 standard)  */

  a = (uint16_t)(uintptr_t)dll;
  DPPL = (uint8_t)(a & 0xFF);
  DPPH = (uint8_t)(a >> 8);

  sfx_init();
  best_streak = 0;                        /* in-session only — see header */
  streak = 0;
  paint_title();                          /* …turns DMA on                */

  for (;;) {
    uint8_t pad, f1, f2;
    static uint8_t pf;                    /* fire edge across title/result */
    vblank_wait();
    sfx_update();
    music_tick();

    pad = (uint8_t)~SWCHA;
    f1 = (uint8_t)(!(INPT4 & 0x80));
    f2 = (uint8_t)(!(INPT5 & 0x80));

    if (state == ST_TITLE) {
      /* ── GAME LOGIC (clay) — title: P1 fire = 1P vs CPU, P2 fire = 2P ── */
      if (f1 && !(pf & 1)) start_match(0);
      else if (f2 && !(pf & 2)) start_match(1);
      pf = (uint8_t)(f1 | (f2 << 1));
      continue;
    }

    if (state == ST_OVER) {
      if (over_lock) { --over_lock; pf = (uint8_t)(f1 | (f2 << 1)); continue; }
      if ((f1 || f2) && !pf) paint_title();
      pf = (uint8_t)(f1 | (f2 << 1));
      continue;
    }

    /* ── ST_PLAY ───────────────────────────────────────────────────── */
    random8();                              /* tick the noise every frame  */

    move_paddle(0, pad);                    /* P1 — port 0                 */
    if (two_p) move_paddle(1, pad);         /* P2 — port 1                 */
    else       move_cpu();                  /* CPU drives the right paddle */

    /* Ball update (frozen during the post-point serve pause). */
    if (serve_timer > 0) {
      --serve_timer;
    } else {
      bx += bdx;
      by += bdy;

      /* Rail bounce (top/bottom court boundaries). */
      if (by < COURT_T)  { by = COURT_T; bdy = (int8_t)(-bdy); fx_wall(); }
      if (by > COURT_B)  { by = COURT_B; bdy = (int8_t)(-bdy); fx_wall(); }

      /* Paddle collisions (direction-gated so the ball can't double-hit). */
      if (bdx < 0
          && bx <= PADDLE_X1 + 8 && bx + BALL_W >= PADDLE_X1
          && by + BALL_H > pad_y[0] && by < pad_y[0] + PADDLE_H) {
        bdx = (int8_t)(-bdx);
        bx = PADDLE_X1 + 8;
        deflect(pad_y[0]);
      }
      if (bdx > 0
          && bx + BALL_W >= PADDLE_X2 && bx <= PADDLE_X2 + 8
          && by + BALL_H > pad_y[1] && by < pad_y[1] + PADDLE_H) {
        bdx = (int8_t)(-bdx);
        bx = PADDLE_X2 - BALL_W;
        deflect(pad_y[1]);
      }

      /* Off either side → a point for the opposite player. */
      if (bx < 2)            score_point(0);   /* past P1 → right side scores */
      else if (bx > 160 - 2) score_point(1);   /* past P2 → left side scores  */
      if (state != ST_PLAY) continue;          /* end_match → result          */
    }

    /* ── HARDWARE IDIOM (load-bearing) — the per-frame draw pass:
     * open (clear counts) → emit the net + both paddles + the ball → close
     * (terminators). Emission order = draw order on shared scanlines; a court
     * game never fills a line (≤2-3 objects), so nothing flickers — but the
     * BALL goes LAST so that if a future fork DOES crowd a line, the player's
     * paddles win the slot and only the ball blinks. ── */
    field_open();
    /* the centre net: a dashed thin colour-5 column, 4-on/4-off down the
     * court (the structural court landmark, emitted first). */
    for (i = 0; i + 4 <= FIELD_LINES; i += 8)
      emit_object(i, 4, SOLID8, 0, MODE_NET, NET_X);
    /* paddles */
    emit_object(pad_y[0], PADDLE_H, GFX_PADDLE, 2, MODE_PADDLE1, PADDLE_X1);
    emit_object(pad_y[1], PADDLE_H, GFX_PADDLE, 2, MODE_PADDLE2, PADDLE_X2);
    /* the ball — clamped into the court so emit never runs past the pool */
    {
      uint8_t byl = (uint8_t)(by < 0 ? 0 : (by > FIELD_LINES - BALL_H ? FIELD_LINES - BALL_H : by));
      uint8_t bxl = (uint8_t)(bx < 0 ? 0 : (bx > 159 ? 159 : bx));
      emit_object(byl, BALL_H, GFX_BALL, 1, MODE_BALL, bxl);
    }
    field_close();

    if (dirty) draw_hud();
  }
}
