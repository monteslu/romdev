/* ── racing.c — SNES Mode 7 racer (complete example game) ────────────────────
 *
 * A COMPLETE, working game — title screen with a live rotating-attract road,
 * 1P time trial and 2P relay duel, lap timing, persistent best time (battery
 * SRAM), music + SFX, and the SNES's signature hardware feature done for
 * real: a ROTATING PERSPECTIVE Mode 7 ground plane. Steering yaws the
 * camera and the whole world swings around the car, F-Zero style.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented SNES footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — track shape, physics, scoring, tuning, art: reshape
 *     freely.
 *
 * What depends on what:
 *   data.asm — font + car sprite tiles, the Mode 7 HDMA tables (WRAM bank
 *     $7E — see why over there), the m7_build hardware-multiply table
 *     builder, and sram_read16/write16. Load-bearing.
 *   hdr.asm — THIS PROJECT OVERRIDES the stock header to declare battery
 *     SRAM (CARTRIDGETYPE $02 + SRAMSIZE $01). Delete that file and saves
 *     silently stop existing — the build still succeeds.
 *   snes_sfx.{h,c} + snes_sfx_data.asm + apu_blob.bin — the SPC700 sound
 *     driver (music + 2 one-shot samples). #include'd, not separately built.
 *
 * ── HOW THE MODE 7 CAMERA WORKS (read this before touching any of it) ──────
 * Mode 7 is nothing but a 2x2 matrix + a center: for each screen pixel the
 * PPU computes
 *     mapX = A*(SX + HOFS - CX) + B*(SY + VOFS - CY) + CX
 *     mapY = C*(SX + HOFS - CX) + D*(SY + VOFS - CY) + CY
 * and samples the 1024x1024px map there. One matrix per frame = a flat
 * rotated/zoomed plane. The racer look needs a DIFFERENT zoom per scanline
 * (far rows zoomed out, near rows zoomed in), so we rewrite the matrix
 * EVERY 2 SCANLINES with HDMA — zero CPU during the frame.
 *
 * Per scanline band we want camera yaw θ and zoom λ(line):
 *     A = λcosθ    B = -λsinθ      ← a plain 2D rotation, scaled
 *     C = λsinθ    D =  λcosθ
 * With  HOFS = camX-128  (so SX+HOFS-CX ≡ SX-128, screen-centered)
 * and   VOFS = camY-line-FOCALF (so SY+VOFS-CY ≡ -FOCALF, a constant), each
 * line shows the map rotated by θ about (camX,camY), pushed FOCALF*λ(line)
 * "forward", spread λ(line) wide. λ(line) = SCALE_NUM/(line-FOCAL) is the
 * classic perspective hyperbola: line 56 (horizon) sees 5.75x zoomed-out
 * shimmer, line 223 (your bumper) sees 0.5x (2x magnified) asphalt.
 *
 * Why VOFS is per-line too: VOFS = camY-line-FOCALF changes by -1 each
 * line — a second tiny HDMA table. And HOFS/VOFS double as BG1's MODE 1
 * scroll for the HUD strip, which is why both tables hold 0 for lines 0-55
 * (scrolled HUD text is the classic bug here).
 *
 * Per frame the CPU does exactly this (m7_stage → data.asm's m7_build):
 * 168 hardware multiplies to refill the back-buffer tables, then 4 register
 * writes + 2 table patches at vblank (m7_commit). ~30% of a frame, all in.
 *
 * VRAM BUDGET (Mode 7 owns words $0000-$3FFF — it has NO base register):
 *   $0000-$3FFF low bytes  = the 128x128 Mode 7 tilemap
 *   $0000-$017F high bytes = 6 ground tiles (8bpp linear, 64 bytes each)
 *   $4000- OBJ tiles, $5000- HUD font, $6800- HUD text map
 *   Anything you add below word $4000 lands ON the road map — don't.
 */

#include <snes.h>
#include "snes_sfx.c"

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "EMBER CIRCUIT"

extern char tilfont, palfont;          /* HUD font + text palette (data.asm)   */
extern char tilsprite, palsprite;      /* car sprite page + OBJ palette        */

/* consoleVblank() copies the dirty text tilemap to VRAM during VBlank.
 * No public prototype in console.h, so declare it; call once per frame. */
extern void consoleVblank(void);

/* data.asm exports — the Mode 7 machinery + SRAM helpers. The tables live in
 * a WRAM bank-$7E RAMSECTION (tcc puts C globals in $7F; HDMA needs a bank
 * byte we control). See the HARDWARE IDIOM blocks in data.asm. */
extern void m7_build(void);
extern u16 sram_read16(u16 offset);
extern void sram_write16(u16 offset, u16 value);
extern u8 m7_ab0[], m7_cd0[], m7_ab1[], m7_cd1[];   /* matrix HDMA tables x2 */
extern u8 m7_vo0[], m7_vo1[];                       /* M7VOFS tables x2      */
extern u8 lam8_tab[];                               /* per-band zoom, λ>>3   */
extern u8 hdma_mode_tab[], hdma_hofs_tab[];
extern s8 m7_cos, m7_sin;                           /* m7_build inputs       */
extern u16 m7_dst, m7_vdst, m7_vstart;
extern u8 telem[];                                  /* headless-test block   */

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * The screen split. Lines 0..HORIZON-1 are a Mode 1 strip (BG1 = the text
 * HUD, backdrop colour = sky); from line HORIZON down, HDMA flips BGMODE to
 * 7 and the SAME BG1 becomes the perspective ground. One BG, two
 * personalities, zero CPU. HORIZON must be a multiple of 8 so whole text
 * rows sit above it (56 = rows 0-6 usable for HUD text). */
#define HORIZON   56
/* Perspective: λ(line) = SCALE_NUM / (line - FOCAL), 8.8 fixed point.
 * FOCAL is the virtual eye line (above HORIZON so the divisor never hits 0).
 * FOCALF is the constant forward push — together with λ it sets how far
 * ahead each row looks: row 56 sees 5.75*48 ≈ 276px ahead, row 223 ≈ 24px. */
#define FOCAL     40
#define SCALE_NUM 23552u
#define FOCALF    48

/* HDMA table geometry — MUST match the dsb sizes in data.asm. 84 entries x
 * 2 lines cover lines 56-223; entry stride 5 = count byte + 4 matrix bytes. */
#define AB_BYTES   426            /* 1+4 strip header + 84*5 + terminator    */
#define VO_BYTES   256            /* 1+2 strip header + 84*3 + terminator    */
#define N_BANDS    84

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Mode 7 ground tiles. LINEAR 8bpp: 64 bytes per tile, ONE BYTE PER PIXEL,
 * no bitplanes — the byte IS the CGRAM index (the one tile format on the
 * SNES you can author by typing numbers). Index 0 = transparent (backdrop
 * sky would leak through the ground) so ground pixels use 2..9; index 1 is
 * the text colour, indices 16+ would collide with nothing (free to grow). */
#define T_GRASSA 0
#define T_GRASSB 1
#define T_ROAD   2
#define T_DASH   3
#define T_KERB   4
#define T_FINISH 5
static const u8 m7_tiles[6 * 64] = {
  /* tile 0 — grass A (mid green, dark speckle) */
  3,2,2,2,2,2,2,2,  2,2,2,2,2,2,3,2,  2,3,2,2,2,2,2,2,  2,2,2,2,2,2,2,3,
  2,2,3,2,2,2,2,2,  2,2,2,2,2,2,2,2,  2,2,2,3,2,2,2,2,  2,2,2,2,2,2,2,2,
  /* tile 1 — grass B (dark green, mid speckle) */
  2,3,3,3,3,3,3,2,  3,3,3,2,3,3,3,3,  3,3,3,3,3,3,2,3,  3,3,2,3,3,3,3,3,
  3,3,3,3,3,2,3,3,  3,2,3,3,3,3,3,3,  3,3,3,3,2,3,3,3,  2,3,3,3,3,3,3,2,
  /* tile 2 — road (asphalt, light speckle) */
  5,4,4,4,4,4,4,4,  4,4,4,4,4,4,4,4,  4,4,4,5,4,4,4,4,  4,4,4,4,4,4,4,4,
  4,4,4,4,4,4,5,4,  4,5,4,4,4,4,4,4,  4,4,4,4,4,4,4,4,  4,4,4,4,5,4,4,4,
  /* tile 3 — road with centre-line dash (cols 3-4, yellow) */
  5,4,4,8,8,4,4,4,  4,4,4,8,8,4,4,4,  4,4,4,8,8,4,4,4,  4,4,4,8,8,4,4,4,
  4,4,4,8,8,4,5,4,  4,5,4,8,8,4,4,4,  4,4,4,8,8,4,4,4,  4,4,4,8,8,4,4,4,
  /* tile 4 — kerb (4x4 red/white checker — reads as rumble strip when
   * the perspective squeezes it) */
  6,6,6,6,7,7,7,7,  6,6,6,6,7,7,7,7,  6,6,6,6,7,7,7,7,  6,6,6,6,7,7,7,7,
  7,7,7,7,6,6,6,6,  7,7,7,7,6,6,6,6,  7,7,7,7,6,6,6,6,  7,7,7,7,6,6,6,6,
  /* tile 5 — finish checker (4px white/grey) */
  9,9,9,9,7,7,7,7,  9,9,9,9,7,7,7,7,  9,9,9,9,7,7,7,7,  9,9,9,9,7,7,7,7,
  7,7,7,7,9,9,9,9,  7,7,7,7,9,9,9,9,  7,7,7,7,9,9,9,9,  7,7,7,7,9,9,9,9,
};

/* ── GAME LOGIC (clay) — the circuit ─────────────────────────────────────────
 * The track is a ring road on the 1024x1024 map: centre (512,512), inner
 * radius R_IN, outer R_OUT. A ring needs no waypoints: "on the road" is two
 * compares against per-row half-width tables, and laps are quadrant
 * crossings (below). Reshape: ellipse, figure-8 (two rings + a flag),
 * waypointed splines — anything; only the tables + paint loop change. */
#define MAP_C    512
#define R_IN     320
#define R_OUT    416
#define R_MID    368
#define KERB_W   10            /* px of rumble strip each side of the road  */
#define LAPS     3
#define TIME_CAP 59999u        /* 999.98s — a DNF cap so idle runs end      */

#define SPD_MAX     0x0300     /* 3.0 px/frame, 8.8 fixed                   */
#define SPD_MAX_OFF 0x00C0     /* crawl cap in the grass                    */
#define ACCEL    6
#define DRAG     3
#define BRAKE    16
#define OFF_DRAG 14
#define TURN     0x00C0        /* heading change per frame held, 8.8 of a
                                * 256-unit circle. At full speed that turns
                                * a 163px-radius circle — over twice the
                                * authority the R_MID ring needs, so every
                                * inch of track is makeable flat out. */

#define CAR_X 120              /* 16x16 car, screen-centered near the bottom */
#define CAR_Y 188

/* SRAM layout: [0]=magic "EC", [2]=best time (frames), [4]=best ^ 0xA5C3.
 * Magic is written LAST in best_save so a torn write never validates. */
#define SRAM_MAGIC 0x4345u

/* Game states — the shell every example shares: title → play → result. */
#define ST_TITLE  0
#define ST_READY  1            /* "PLAYER n PRESS START" (the 2P relay handoff) */
#define ST_RACE   2
#define ST_RESULT 3

static u8 state;
static u8 mode_2p;             /* 0 = time trial, 1 = relay duel             */
static u8 run_player;          /* whose run is on track (0/1 = pad port)     */
static u16 run_time[2];        /* finished run times, in frames              */
static u16 best;               /* best 3-lap time ever (0 = none recorded)   */
static u8 sound_ok;

/* the camera IS the car: map position (8.8 sub-pixel) + yaw heading */
static s32 posX, posY;         /* map px in 8.8; wraps at 1024px (0x40000)   */
static u16 camX, camY;         /* integer px, derived each frame             */
static u16 heading;            /* 8.8 angle: top byte 0..255 = 0..360°, 0 =
                                * north (-Y), 64 = east — clockwise on map   */
static u16 spd;                /* forward speed, 8.8 px/frame                */
static u8 lap;
static u16 race_frames;
static u8 offroad, on_kerb;    /* surface flags (edge-detected for SFX)      */
static u8 quad, accum;         /* lap tracking: quadrant + signed progress   */
static u16 prev_pad0, prev_padR;
static char tbuf[8];           /* "SSS.HH" time formatter output             */

static u16 inner_px[128];      /* ring half-widths per map row (boot-built)  */
static u16 outer_px[128];

static u8 backbuf;             /* which HDMA table set m7_build fills next   */
static u16 front_ab, front_vo; /* fresh tables, committed at next vblank     */
static u16 ab_base[2], vo_base[2];  /* WRAM addresses of the two table sets  */

/* sin in s1.6 (64 = 1.0), 256 angle units per circle. cos(a)=sintab[a+64]. */
static const s8 sintab[256] = {
     0,    2,    3,    5,    6,    8,    9,   11,   12,   14,   16,   17,   19,   20,   22,   23,
    24,   26,   27,   29,   30,   32,   33,   34,   36,   37,   38,   39,   41,   42,   43,   44,
    45,   46,   47,   48,   49,   50,   51,   52,   53,   54,   55,   56,   56,   57,   58,   59,
    59,   60,   60,   61,   61,   62,   62,   62,   63,   63,   63,   64,   64,   64,   64,   64,
    64,   64,   64,   64,   64,   64,   63,   63,   63,   62,   62,   62,   61,   61,   60,   60,
    59,   59,   58,   57,   56,   56,   55,   54,   53,   52,   51,   50,   49,   48,   47,   46,
    45,   44,   43,   42,   41,   39,   38,   37,   36,   34,   33,   32,   30,   29,   27,   26,
    24,   23,   22,   20,   19,   17,   16,   14,   12,   11,    9,    8,    6,    5,    3,    2,
     0,   -2,   -3,   -5,   -6,   -8,   -9,  -11,  -12,  -14,  -16,  -17,  -19,  -20,  -22,  -23,
   -24,  -26,  -27,  -29,  -30,  -32,  -33,  -34,  -36,  -37,  -38,  -39,  -41,  -42,  -43,  -44,
   -45,  -46,  -47,  -48,  -49,  -50,  -51,  -52,  -53,  -54,  -55,  -56,  -56,  -57,  -58,  -59,
   -59,  -60,  -60,  -61,  -61,  -62,  -62,  -62,  -63,  -63,  -63,  -64,  -64,  -64,  -64,  -64,
   -64,  -64,  -64,  -64,  -64,  -64,  -63,  -63,  -63,  -62,  -62,  -62,  -61,  -61,  -60,  -60,
   -59,  -59,  -58,  -57,  -56,  -56,  -55,  -54,  -53,  -52,  -51,  -50,  -49,  -48,  -47,  -46,
   -45,  -44,  -43,  -42,  -41,  -39,  -38,  -37,  -36,  -34,  -33,  -32,  -30,  -29,  -27,  -26,
   -24,  -23,  -22,  -20,  -19,  -17,  -16,  -14,  -12,  -11,   -9,   -8,   -6,   -5,   -3,   -2,
};
#define COS8(a) (sintab[(u8)((a) + 64)])
#define SIN8(a) (sintab[(u8)(a)])

/* ── GAME LOGIC (clay) — integer sqrt for the ring tables (boot only) ───────
 * Classic shift-and-subtract: no multiplies, ~16 iterations, exact. */
static u16 isqrt32(u32 v) {
  u32 r = 0, bit = 0x40000000ul;
  while (bit > v) bit >>= 2;
  while (bit) {
    if (v >= r + bit) { v -= r + bit; r = (r >> 1) + bit; }
    else r >>= 1;
    bit >>= 2;
  }
  return (u16)r;
}

/* Per map row r: the ring's horizontal cross-section is
 *   inner_px[r] <= |x - 512| <= outer_px[r]
 * (inner hits 0 across the top/bottom straights — the road spans the middle
 * there). These tables are BOTH the tilemap painter's input and the entire
 * runtime collision model: "am I on the road" is two compares. */
static void build_ring_tables(void) {
  u16 r;
  s16 dy;
  u32 dy2;
  for (r = 0; r < 128; r++) {
    dy = (s16)(r * 8 + 4) - MAP_C;
    dy2 = (u32)((s32)dy * dy);
    outer_px[r] = (dy2 >= (u32)R_OUT * R_OUT) ? 0
                : isqrt32((u32)R_OUT * R_OUT - dy2);
    inner_px[r] = (dy2 >= (u32)R_IN * R_IN) ? 0
                : isqrt32((u32)R_IN * R_IN - dy2);
  }
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Mode 7 VRAM upload. Mode 7 interleaves map and tiles in the SAME words:
 * the LOW byte of each word is a tilemap entry, the HIGH byte is tile pixel
 * data. VMAIN picks which stream you're writing ($00 = step after $2118
 * low-byte writes, $80 = step after $2119 high-byte writes) and the DMA
 * B-address must match ($18 low / $19 high). Mismatch them and BOTH planes
 * come out as woven garbage (the classic Mode 7 bug) — dmaCopyVram7 exists
 * for exactly this pairing. PPU off (we run pre-setScreenOn) or vblank only.
 *
 * The map is composed in WRAM as SPANS (grass template, road span, then
 * kerb/dash/finish dabbed on top) and DMA'd in one burst — pushing 16K
 * tiles through a tcc-compiled `REG_VMDATAL = tile` loop costs ~4s of
 * boot; memcpy + DMA is a blink. The grass checker only depends on r&7,
 * so 8 templates cover the field.
 * Column math: tile x covers px 8x..8x+7, centre 8x+4; |8x+4-512| ≤ w
 * ⟺ x ∈ [(508-w+7)>>3, (508+w)>>3]. */
static u8 map_build[128 * 128];   /* boot-only staging buffer ($7F WRAM) */
static u8 grass_rows[8][128];     /* static: >255 bytes of locals overflows
                                   * tcc's 8-bit stack-relative addressing */

static void upload_m7_vram(void) {
  u16 r, x, in_, out, mid, x0, x1;
  s16 dy;
  u32 dy2;
  u8 *row;
  for (r = 0; r < 8; r++)
    for (x = 0; x < 128; x++)
      grass_rows[r][x] = (((r ^ x) & 7) != 0) ? T_GRASSA : T_GRASSB;
  for (r = 0; r < 128; r++) {
    in_ = inner_px[r];
    out = outer_px[r];
    dy = (s16)(r * 8 + 4) - MAP_C;
    dy2 = (u32)((s32)dy * dy);
    row = map_build + (r << 7);
    memcpy(row, grass_rows[r & 7], 128);
    if (out >= 8) {
      x0 = (u16)((508 - out + 7) >> 3);
      x1 = (u16)((508 + out) >> 3);
      for (x = x0; x <= x1; x++) row[x] = T_ROAD;
      /* centre-line dash ring (radius R_MID), dashed every other row pair */
      if (dy2 < (u32)R_MID * R_MID && (r & 2)) {
        mid = isqrt32((u32)R_MID * R_MID - dy2);
        row[(508 - mid) >> 3] = T_DASH;
        row[(508 + mid) >> 3] = T_DASH;
      }
      /* infield hole + its kerb ring */
      if (in_ >= 8) {
        x = (u16)((508 - in_ + 7) >> 3);
        x1 = (u16)((508 + in_) >> 3);
        row[x] = T_KERB; row[x1] = T_KERB;
        if (x1 > (u16)(x + 1))
          memcpy(row + x + 1, &grass_rows[r & 7][x + 1], (u16)(x1 - x - 1));
      } else if (dy < 0) {
        /* top straight: the start/finish stripe crosses the road at x≈512 */
        row[63] = T_FINISH; row[64] = T_FINISH;
      }
      row[x0] = T_KERB;
      row[(508 + out) >> 3] = T_KERB;
    }
  }
  dmaCopyVram7((u8 *)m7_tiles, 0x0000, sizeof(m7_tiles), 0x80, 0x1900);
  dmaCopyVram7(map_build, 0x0000, sizeof(map_build), 0x00, 0x1800);
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * One-time skeletons for the HDMA tables (the per-frame DATA comes from
 * m7_build in data.asm — read its header for the table grammar). Counts,
 * strip headers and terminators never change, so they're written once here;
 * the build loop then only touches the 4 (or 2) data bytes per entry. */
static void m7_tables_init(void) {
  u16 e, p, line;
  u8 *ab, *vo;
  u8 b;
  ab_base[0] = (u16)(m7_ab0);  vo_base[0] = (u16)(m7_vo0);
  ab_base[1] = (u16)(m7_ab1);  vo_base[1] = (u16)(m7_vo1);
  for (b = 0; b < 2; b++) {
    u8 *cd;
    ab = b ? m7_ab1 : m7_ab0;
    cd = b ? m7_cd1 : m7_cd0;
    vo = b ? m7_vo1 : m7_vo0;
    /* HUD strip: hold identity 56 lines (these lines are Mode 1 text) */
    ab[0] = HORIZON; ab[1] = 0x00; ab[2] = 0x01; ab[3] = 0; ab[4] = 0;
    cd[0] = HORIZON; cd[1] = 0; cd[2] = 0; cd[3] = 0x00; cd[4] = 0x01;
    vo[0] = HORIZON; vo[1] = 0; vo[2] = 0;
    p = 5;
    for (e = 0; e < N_BANDS; e++) { ab[p] = 2; cd[p] = 2; p += 5; }
    ab[p] = 0; cd[p] = 0;
    p = 3;
    for (e = 0; e < N_BANDS; e++) { vo[p] = 2; p += 3; }
    vo[p] = 0;
  }
  /* per-band zoom: λ(line)>>3 so it fits the 8x8 hardware multiplier.
   * Sampled at each band's second line (56+2e+1) — splits the 2-line error. */
  for (e = 0; e < N_BANDS; e++) {
    line = HORIZON + e * 2 + 1;
    lam8_tab[e] = (u8)((SCALE_NUM / (line - FOCAL)) >> 3);
  }
  /* BGMODE split: mode 1 for the HUD strip, then one write of mode 7 that
   * holds to the bottom (terminator keeps the last value). */
  hdma_mode_tab[0] = HORIZON; hdma_mode_tab[1] = 0x01;
  hdma_mode_tab[2] = 1;       hdma_mode_tab[3] = 0x07;
  hdma_mode_tab[4] = 0;
  /* M7HOFS: 0 through the HUD strip ($210D doubles as BG1's Mode-1 H scroll
   * — a camera value here scrolls your HUD text sideways), then the camera
   * value from HORIZON down. m7_commit patches bytes [4],[5] every frame —
   * hardware re-reads the table each frame, no re-arm needed. */
  hdma_hofs_tab[0] = HORIZON; hdma_hofs_tab[1] = 0; hdma_hofs_tab[2] = 0;
  hdma_hofs_tab[3] = 1;       hdma_hofs_tab[4] = 0; hdma_hofs_tab[5] = 0;
  hdma_hofs_tab[6] = 0;
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Wire the 5 HDMA channels — onto channels 2-6, and the CHOICE is
 * load-bearing: a channel cannot serve general-purpose DMA and HDMA in the
 * same frame, and PVSnesLib's runtime owns two channels for GP-DMA:
 *   ch0 — dmaCopyVram (console text upload, oamInitGfxSet, consoleVblank)
 *   ch7 — the VBlank ISR's OAM DMA (vblank.asm writes $4370-$4375 EVERY
 *         frame). Park HDMA on ch7 and the ISR silently rewrites the
 *         channel's params each NMI — your table stops landing and OAM gets
 *         fed table bytes instead. (Found the hard way; see TROUBLESHOOTING
 *         "HDMA channel fights the OAM DMA".)
 * So: 2=BGMODE, 3=M7A/M7B, 4=M7C/M7D, 5=M7HOFS, 6=M7VOFS.
 * DMAP transfer modes are the whole trick:
 *   mode 0 = 1 byte → reg          ($2105 BGMODE)
 *   mode 2 = 2 bytes → reg,reg     (write-twice regs: HOFS/VOFS lo,hi)
 *   mode 3 = 4 bytes → r,r,r+1,r+1 ($211B,$211B,$211C,$211C = A lo,hi,B lo,hi)
 * Mode 3 exists precisely FOR the Mode 7 matrix — 4 bytes feed two
 * write-twice registers per line. */
static void road_hdma_on(void) {
  REG_DMAP2 = 0x00; REG_BBAD2 = 0x05;            /* → $2105 BGMODE  */
  REG_A1T2LH = (u16)(hdma_mode_tab); REG_A1B2 = 0x7E;
  REG_DMAP3 = 0x03; REG_BBAD3 = 0x1B;            /* → $211B/C M7A,M7B */
  REG_A1T3LH = front_ab; REG_A1B3 = 0x7E;
  REG_DMAP4 = 0x03; REG_BBAD4 = 0x1D;            /* → $211D/E M7C,M7D */
  REG_A1T4LH = (u16)(front_ab + AB_BYTES); REG_A1B4 = 0x7E;
  REG_DMAP5 = 0x02; REG_BBAD5 = 0x0D;            /* → $210D M7HOFS    */
  REG_A1T5LH = (u16)(hdma_hofs_tab); REG_A1B5 = 0x7E;
  REG_DMAP6 = 0x02; REG_BBAD6 = 0x0E;            /* → $210E M7VOFS    */
  REG_A1T6LH = front_vo; REG_A1B6 = 0x7E;
  REG_HDMAEN = 0x7C;                             /* channels 2-6 live */
}

static void road_hdma_off(void) {
  REG_HDMAEN = 0x00;
}

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * Per-frame Mode 7 work, two halves:
 *
 * m7_stage — runs DURING the frame, fills the BACK buffer: heading → cos/sin
 * (one table lookup), point m7_dst/m7_vdst at the buffer HDMA is NOT
 * reading, then m7_build (data.asm) does the 168 hardware multiplies.
 * Rebuilding the live table instead shears the ground mid-frame.
 *
 * m7_commit — MUST run inside vblank, right after WaitForVBlank: flip the
 * channels to the fresh tables (A1Tx is only re-read at the top of each
 * frame), write the write-twice center regs M7X/M7Y (lo then hi — a single
 * write half-latches and the ground leaps), and patch the camera into the
 * HOFS table. */
static void m7_stage(void) {
  u8 a = (u8)(heading >> 8);
  m7_cos = COS8(a);
  m7_sin = SIN8(a);
  m7_dst  = (u16)(ab_base[backbuf] + 5);   /* first entry's count byte */
  m7_vdst = (u16)(vo_base[backbuf] + 3);
  m7_vstart = (u16)(camY - HORIZON - FOCALF);
  m7_build();
  front_ab = ab_base[backbuf];
  front_vo = vo_base[backbuf];
  backbuf ^= 1;
}

static void m7_commit(void) {
  u16 hx = (u16)((camX - 128) & 0x1FFF);
  REG_A1T3LH = front_ab;
  REG_A1T4LH = (u16)(front_ab + AB_BYTES);
  REG_A1T6LH = front_vo;
  REG_M7X = (u8)camX; REG_M7X = (u8)(camX >> 8);   /* write-twice, lo→hi */
  REG_M7Y = (u8)camY; REG_M7Y = (u8)(camY >> 8);
  hdma_hofs_tab[4] = (u8)hx; hdma_hofs_tab[5] = (u8)(hx >> 8);
}

/* Leave the split: full-screen Mode 1 text (the result card). HDMA's last
 * BGMODE write said "mode 7" and the scroll regs hold camera values —
 * restore both or the text screen comes up as rotated garbage. */
static void full_text_screen(void) {
  road_hdma_off();
  REG_BGMODE = 0x01;
  REG_M7HOFS = 0; REG_M7HOFS = 0;   /* = BG1HOFS: write-twice, zero it */
  REG_M7VOFS = 0; REG_M7VOFS = 0;   /* = BG1VOFS                       */
}

/* ── GAME LOGIC (clay) — SRAM best time (see sram_* in data.asm) ──────────── */
static u16 best_load(void) {
  u16 v;
  if (sram_read16(0) != SRAM_MAGIC) return 0;
  v = sram_read16(2);
  if (sram_read16(4) != (u16)(v ^ 0xA5C3u)) return 0;
  return v;
}

static void best_save(u16 v) {
  sram_write16(2, v);
  sram_write16(4, (u16)(v ^ 0xA5C3u));
  sram_write16(0, SRAM_MAGIC);      /* magic LAST — torn write = no record */
}

/* ── GAME LOGIC (clay) — text helpers ──────────────────────────────────────── */
static void fmt_time(u16 f) {       /* frames → "SSS.HH" into tbuf */
  u16 s = f / 60;
  u16 hh = (u16)((f % 60) * 5 / 3); /* x100/60 without overflow */
  tbuf[0] = (char)('0' + (s / 100) % 10);
  tbuf[1] = (char)('0' + (s / 10) % 10);
  tbuf[2] = (char)('0' + s % 10);
  tbuf[3] = '.';
  tbuf[4] = (char)('0' + hh / 10);
  tbuf[5] = (char)('0' + hh % 10);
  tbuf[6] = 0;
}

static void draw_best(u16 x, u16 y) {
  if (best) { fmt_time(best); consoleDrawText(x, y, tbuf); }
  else      consoleDrawText(x, y, "---.--");
}

static void clear_row(u16 y) {
  consoleDrawText(0, y, "                                ");
}

static void clear_rows(u16 a, u16 b) {
  u16 y;
  for (y = a; y <= b; y++) clear_row(y);
}

/* ── GAME LOGIC (clay) — car placement + state entries ───────────────────────
 * Spawn: on the top straight just EAST of the finish line, heading east
 * (heading 64). The car drives clockwise by default but the lap counter is
 * direction-agnostic — run it backwards if you like. */
static void place_at_grid(void) {
  posX = (s32)(MAP_C + 24) << 8;
  posY = (s32)(MAP_C - R_MID) << 8;
  camX = MAP_C + 24;
  camY = MAP_C - R_MID;
  heading = 64u << 8;
  quad = 0;                          /* dx>0, dy<0 — see lap counter */
  accum = 0;
}

static void title_enter(void) {
  clear_rows(0, 27);
  consoleDrawText(9, 1, GAME_TITLE);
  consoleDrawText(9, 2, "BEST"); draw_best(15, 2);
  consoleDrawText(6, 4, "A - 1P TIME TRIAL");
  consoleDrawText(6, 5, "B - 2P RELAY DUEL");
  place_at_grid();
  spd = 0;
  m7_stage();                        /* fill a table set before HDMA reads */
  road_hdma_on();
  oamSet(0, CAR_X, CAR_Y, 3, 0, 0, 0, 0);
  oamSetEx(0, OBJ_LARGE, OBJ_SHOW);
  state = ST_TITLE;
}

static void run_reset(void) {
  place_at_grid();
  spd = 0;
  lap = 1;
  race_frames = 0;
  offroad = on_kerb = 0;
}

static void ready_enter(void) {
  run_reset();
  clear_rows(0, 6);
  consoleDrawText(1, 1, mode_2p ? (run_player ? "P2" : "P1") : "1P");
  consoleDrawText(4, 1, "TIME 000.00");
  consoleDrawText(17, 1, "LAP 1/3");
  consoleDrawText(4, 2, "BEST"); draw_best(9, 2);
  consoleDrawText(6, 4, run_player ? "PLAYER 2 TO THE GRID"
                       : (mode_2p ? "PLAYER 1 TO THE GRID" : "TO THE GRID"));
  consoleDrawText(10, 5, "PRESS START");
  prev_padR = 0xFFFF;   /* swallow the press that ENTERED this state — without
                         * this, the A that picked 1P on the title instantly
                         * green-lights the run (classic edge-detect reuse bug) */
  state = ST_READY;
}

static void race_enter(void) {
  clear_rows(4, 6);
  if (sound_ok) sfx_play(1);        /* green-light blip */
  state = ST_RACE;
}

static void result_enter(void) {
  u8 newbest = 0;
  u16 t1 = run_time[0], t2 = run_time[1];
  u16 winner_t = t1;
  if (mode_2p && t2 < winner_t) winner_t = t2;
  if (winner_t < best || best == 0) { best = winner_t; best_save(best); newbest = 1; }

  full_text_screen();
  oamSetVisible(0, OBJ_HIDE);
  clear_rows(0, 27);
  consoleDrawText(10, 6, mode_2p ? "DUEL  OVER" : "RUN COMPLETE");
  consoleDrawText(9, 10, mode_2p ? "P1" : "TIME");
  fmt_time(t1); consoleDrawText(15, 10, tbuf);
  if (mode_2p) {
    consoleDrawText(9, 12, "P2");
    fmt_time(t2); consoleDrawText(15, 12, tbuf);
    if (t1 < t2)      consoleDrawText(9, 15, "PLAYER 1 WINS");
    else if (t2 < t1) consoleDrawText(9, 15, "PLAYER 2 WINS");
    else              consoleDrawText(12, 15, "DEAD HEAT");
  }
  consoleDrawText(9, 18, "BEST"); draw_best(15, 18);
  if (newbest) consoleDrawText(8, 20, "NEW TRACK RECORD");
  consoleDrawText(10, 24, "PRESS START");
  if (sound_ok) sfx_play(2);        /* finish flourish */
  state = ST_RESULT;
}

/* ── GAME LOGIC (clay) — driving model ───────────────────────────────────────
 * Forward motion integrates the heading: dx = spd·sinθ, dy = -spd·cosθ
 * (heading 0 = north = -Y). The multiply stays in s16: (spd>>2) ≤ 192 times
 * |trig| ≤ 64 = 12288 — tcc's s16 multiply is fine at 2/frame, it's the 168
 * PER-LINE multiplies that needed data.asm's hardware multiplier. */
static void integrate_motion(u8 a) {
  posX += (s32)(((s16)(spd >> 2) * (s16)SIN8(a)) >> 4);
  posY -= (s32)(((s16)(spd >> 2) * (s16)COS8(a)) >> 4);
  posX &= 0x3FFFF;                  /* wrap at 1024px (the map wraps too)   */
  posY &= 0x3FFFF;
  camX = (u16)(posX >> 8);
  camY = (u16)(posY >> 8);
}

/* Surface at a map point, from the ring tables: 0 road, 1 kerb, 2 grass.
 * Sampled 24px AHEAD of the camera — that's where the car sprite's nose
 * sits on screen (see the camera math in the header: the bottom-centre
 * pixel shows cam + λ(223)·FOCALF ≈ 24px forward). */
static u8 surface_at(u8 a) {
  u16 sx = (u16)((camX + (((s16)SIN8(a) * 24) >> 6)) & 1023);
  u16 sy = (u16)((camY - (((s16)COS8(a) * 24) >> 6)) & 1023);
  u16 in_, out, adx;
  s16 dxs;
  u8 row = (u8)(sy >> 3);
  in_ = inner_px[row];
  out = outer_px[row];
  dxs = (s16)sx - MAP_C;
  adx = (u16)(dxs < 0 ? -dxs : dxs);
  if (out == 0) return 2;
  if (adx > out + KERB_W || (in_ > KERB_W && adx < in_ - KERB_W)) return 2;
  if (adx > out - KERB_W || (in_ > 0 && adx < in_ + KERB_W))      return 1;
  return 0;
}

/* ── GAME LOGIC (clay) — lap counting by quadrant walk ───────────────────────
 * The map centre splits the world into 4 quadrants; driving the ring visits
 * them in order. Each adjacent crossing nudges a signed counter (+1
 * clockwise, -1 counter-clockwise); ±4 = a full circle = a lap, counted
 * exactly at the finish-line quadrant boundary. Backtracking un-counts
 * itself — you can't farm laps by wiggling over the line. */
static void lap_check(void) {
  s16 dxs = (s16)camX - MAP_C, dys = (s16)camY - MAP_C;
  u8 q = (dys < 0) ? (dxs >= 0 ? 0 : 3) : (dxs >= 0 ? 1 : 2);
  u8 d;
  if (q == quad) return;
  d = (u8)((q - quad) & 3);
  if (d == 1) accum++;
  else if (d == 3) accum--;
  quad = q;
  if (accum == 4 || accum == (u8)-4) {
    accum = 0;
    lap++;
    if (lap > LAPS) {
      run_time[run_player] = race_frames;
      if (mode_2p && run_player == 0) { run_player = 1; ready_enter(); }
      else result_enter();
      return;
    }
    if (sound_ok) sfx_play(1);
    tbuf[0] = (char)('0' + lap); tbuf[1] = 0;
    consoleDrawText(21, 1, tbuf);
  }
}

static void race_update(void) {
  u16 pad = padsCurrent(run_player);
  u8 a = (u8)(heading >> 8);
  u8 surf;

  /* throttle / brake (8.8 speed) */
  if (pad & (KEY_A | KEY_B)) { if (spd < SPD_MAX) spd += ACCEL; }
  else if (spd > DRAG) spd -= DRAG; else spd = 0;
  if (pad & KEY_Y) { if (spd > BRAKE) spd -= BRAKE; else spd = 0; }

  /* steering = yaw. THE Mode 7 moment: this one += is what swings the
   * whole world around the car. */
  if (spd > 0x0010) {
    if (pad & KEY_LEFT)  heading -= TURN;
    if (pad & KEY_RIGHT) heading += TURN;
  }
  a = (u8)(heading >> 8);

  /* surface response */
  surf = surface_at(a);
  if (surf == 2) {                                   /* grass */
    if (!offroad && sound_ok) sfx_play(2);           /* one thump on exit  */
    offroad = 1;
    if (spd > SPD_MAX_OFF) spd = (u16)(spd - OFF_DRAG);
  } else {
    offroad = 0;
    if (surf == 1) {                                 /* kerb rumble strip  */
      if (!on_kerb && sound_ok) sfx_play(1);
      on_kerb = 1;
      if (spd > DRAG * 2) spd -= DRAG;               /* mild scrub         */
    } else on_kerb = 0;
  }

  integrate_motion(a);
  lap_check();
  if (state != ST_RACE) return;     /* lap_check may have ended the run */

  race_frames++;
  if (race_frames >= TIME_CAP) {    /* DNF cap — idle runs still end */
    run_time[run_player] = TIME_CAP;
    if (mode_2p && run_player == 0) { run_player = 1; ready_enter(); }
    else result_enter();
    return;
  }
  if ((race_frames & 7) == 0) {     /* HUD time, every 8 frames */
    fmt_time(race_frames);
    consoleDrawText(9, 1, tbuf);
  }
}

/* ── GAME LOGIC (clay) — title attract: the world pirouettes ─────────────────
 * The car parks on the grid and the camera yaws slowly — the cheapest
 * possible demo that rotation is real (and the first thing a fork breaks
 * if the matrix handedness gets flipped). */
static void attract_update(void) {
  heading += 0x0020;
}

/* Headless-test telemetry — written once per frame into the bank-$7E telem
 * block (data.asm). A test harness finds it by scanning WRAM for the
 * "EC"+0xBD signature, then steers the car from real game state instead of
 * parsing pixels. Costs 14 byte-writes per frame; delete freely. */
static void telem_update(void) {
  telem[0] = 'E'; telem[1] = 'C'; telem[2] = 0xBD;
  telem[3] = state;
  telem[4] = lap;
  telem[5] = (u8)(heading >> 8);
  telem[6] = (u8)((sound_ok << 7) | (mode_2p << 1) | run_player);
  telem[7] = (u8)camX; telem[8] = (u8)(camX >> 8);
  telem[9] = (u8)camY; telem[10] = (u8)(camY >> 8);
  telem[11] = (u8)spd; telem[12] = (u8)(spd >> 8);
  telem[13] = (u8)race_frames; telem[14] = (u8)(race_frames >> 8);
  telem[15] = accum;
}

int main(void) {
  u16 pad, padR;

  /* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ──
   * Init order: console text pointers FIRST (the font/map live ABOVE word
   * $4000 because Mode 7 owns $0000-$3FFF and has no base register to move
   * it), then mode, then VRAM uploads while the screen is still off. */
  consoleSetTextMapPtr(0x6800);
  consoleSetTextGfxPtr(0x5000);
  consoleSetTextOffset(0x0000);
  consoleInitText(0, 16 * 2, &tilfont, &palfont);
  setMode(BG_MODE1, 0);
  bgSetGfxPtr(0, 0x5000);
  bgSetMapPtr(0, 0x6800, SC_32x32);
  bgSetDisable(1);                  /* BG2/BG3 carry garbage in mode 1 —    */
  bgSetDisable(2);                  /* the road + HUD both live on BG1      */

  /* CGRAM: Mode 7 is 8bpp, the tile byte IS the palette index — so the
   * ground colours share the font palette's block. 0 = backdrop = the sky;
   * 1 stays white (text); 2..9 are the ground inks the tiles use. */
  setPaletteColor(0, RGB5(11, 18, 28));   /* sky                  */
  setPaletteColor(2, RGB5(6, 18, 6));     /* grass mid            */
  setPaletteColor(3, RGB5(4, 13, 4));     /* grass dark           */
  setPaletteColor(4, RGB5(11, 11, 12));   /* asphalt              */
  setPaletteColor(5, RGB5(15, 15, 16));   /* asphalt fleck        */
  setPaletteColor(6, RGB5(26, 5, 4));     /* kerb red             */
  setPaletteColor(7, RGB5(31, 31, 31));   /* kerb/finish white    */
  setPaletteColor(8, RGB5(30, 27, 6));    /* centre-line yellow   */
  setPaletteColor(9, RGB5(20, 20, 21));   /* finish grey          */

  build_ring_tables();
  upload_m7_vram();
  m7_tables_init();

  /* Mode 7 statics: M7SEL=0 wraps the 1024px map (the looping world!);
   * matrix gets sane vblank defaults, HDMA rewrites it every band anyway.
   * ALL of these are write-twice (lo then hi) — single writes half-latch. */
  REG_M7SEL = 0;
  REG_M7A = 0x00; REG_M7A = 0x01;
  REG_M7B = 0x00; REG_M7B = 0x00;
  REG_M7C = 0x00; REG_M7C = 0x00;
  REG_M7D = 0x00; REG_M7D = 0x01;

  /* OBJ: 16x16 car at VRAM $4000 (clear of the Mode 7 area). The car page
   * is laid out for large sprites: quadrants at page tiles 0,1,16,17. */
  oamInitGfxSet(&tilsprite, 1024, &palsprite, 32, 0, 0x4000, OBJ_SIZE8_L16);

  setScreenOn();

  /* ── HARDWARE IDIOM (load-bearing) — sfx_init AFTER setScreenOn, and CHECK
   * the return: a wedged SPC700 must not take the video down with it. ── */
  sound_ok = (sfx_init() == 0);
  /* ── HARDWARE IDIOM (load-bearing) — one frame between init and the first
   * command. sfx_init returns the instant the SPC echoes the jump command,
   * but the driver then spends ~50 port writes initialising the DSP BEFORE
   * it seeds its command edge-detector from $2140. Send a command in that
   * window and the seed swallows it — music silently never starts (found
   * via getAudioState: voice 1 pitch 0, ARAM prev_cmd already = 3). A
   * WaitForVBlank is thousands of SPC cycles — deterministic cure. ── */
  WaitForVBlank();
  if (sound_ok) sfx_music_play();

  best = best_load();               /* battery SRAM — 0 on first boot */
  prev_pad0 = prev_padR = 0;
  backbuf = 0;
  title_enter();

  while (1) {
    pad = padsCurrent(0);

    if (state == ST_TITLE) {
      attract_update();
      if ((pad & KEY_A && !(prev_pad0 & KEY_A)) ||
          (pad & KEY_START && !(prev_pad0 & KEY_START))) {
        mode_2p = 0; run_player = 0; ready_enter();
      } else if (pad & KEY_B && !(prev_pad0 & KEY_B)) {
        mode_2p = 1; run_player = 0; ready_enter();
      }
    } else if (state == ST_READY) {
      /* the handoff reads THE RUNNER'S pad — port 1 (controller 2) when
       * it's player 2's run. That's the whole 2P wiring: padsCurrent(1). */
      padR = padsCurrent(run_player);
      if ((padR & (KEY_START | KEY_A)) && !(prev_padR & (KEY_START | KEY_A)))
        race_enter();
      prev_padR = padR;
    } else if (state == ST_RACE) {
      race_update();
    } else { /* ST_RESULT */
      if (pad & KEY_START && !(prev_pad0 & KEY_START)) title_enter();
    }
    prev_pad0 = pad;
    telem_update();

    /* Build the back-buffer HDMA tables NOW (takes ~30% of the frame),
     * then commit them in the next vblank. Result screen = plain Mode 1,
     * nothing to build. */
    if (state != ST_RESULT) m7_stage();
    oamUpdate();

    WaitForVBlank();
    if (state != ST_RESULT) m7_commit();   /* vblank-only writes — first! */
    consoleVblank();
  }
  return 0;
}
