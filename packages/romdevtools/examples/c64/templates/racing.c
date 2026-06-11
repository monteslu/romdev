/* ── racing.c — C64 top-down vertical road racer (complete example game) ──────
 *
 * VAPOR VECTOR — a COMPLETE, working game: title screen, 1P endless race with
 * speed control, 2P simultaneous SPLIT-LANE VERSUS (both cars on screen at
 * once — player 2 on CONTROL PORT 1), a vertically-scrolling road done the
 * C64 way (VIC-II fine $D011 Y-scroll + a software COARSE row shift), a fixed
 * HUD held over the moving road by the C64's signature raster-IRQ split, best
 * distance in-session behind the gated-persistence seam, 2-voice SID music
 * with the C64's filter sweep + SFX. The player's car is a VIC-II HARDWARE
 * SPRITE; the road, lane lines and scenery are CHARACTERS that scroll.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented C64 footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — traffic patterns, speeds, tuning, art: reshape freely.
 *
 * What depends on what:
 *   c64_registers.h — VIC-II / SID / CIA symbolic addresses (header only).
 *   c64_sfx.{h,c}   — one-shot SID sound effects on voice 2.
 *   The BASIC stub + crt0 come from cc65's c64 target: the .prg loads at
 *     $0801, a tiny BASIC line does SYS into the C runtime, and the KERNAL
 *     stays banked in (we lean on that for the IRQ vector — see below).
 *
 * Memory map this file assumes (VIC bank 0 = $0000-$3FFF):
 *   $0400  screen RAM (40×25 chars)        $D800 color RAM (static texture)
 *   $0801  this program (code+data grow up from here)
 *   $3F00  sprite images (1 × 64 bytes)    — NOT $0800, which collides with
 *          the .prg load address, and NOT $1000-$1FFF, where the VIC sees
 *          the character ROM instead of RAM (a classic invisible-sprite trap).
 *   Keep the program under ~14 KB so it stays below $3F00.
 *
 * THE SCROLL — the platformer template (TALUS TROT) scrolls HORIZONTALLY via
 * $D016 + a column shift; this game scrolls VERTICALLY via $D011's YSCROLL +
 * a ROW shift. Same two-layer plan: the VIC-II fine-scrolls only 0-7 px in
 * hardware (YSCROLL, $D011 low 3 bits); past that you COARSE-scroll in
 * software by shifting the visible char ROWS and stamping one fresh row of
 * road at the top from the world. Both halves run here — see scroll_field and
 * the raster split. (C64 MENTAL_MODEL.md → "Scrolling".)
 */

#include "c64_registers.h"
#include "c64_sfx.h"
#include <stdint.h>

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "VAPOR VECTOR"

#define POKE(addr, val) (*(volatile uint8_t*)(addr) = (val))
#define PEEK(addr)      (*(volatile uint8_t*)(addr))

#define SCREEN ((volatile uint8_t*)0x0400)
#define COLORS ((volatile uint8_t*)0xD800)
#define SPRITE_POINTERS ((volatile uint8_t*)0x07F8) /* last 8 bytes of screen RAM */

/* ── Screen layout (the raster split divides bar from the scrolling road) ────
 *   char row 0  — score bar text: DST / BEST / CR / mode         (FIXED)
 *   char row 1  — solid divider line                             (FIXED)
 *   char row 2  — blank spacer: the split lands mid-row HERE, where a few
 *                 raster lines of IRQ jitter (and the YSCROLL row-smear) are
 *                 invisible (uniform color)
 *   char rows 3-24 — the vertically-scrolling road
 * PAL raster geometry: with YSCROLL=3 (the power-on default) text row r
 * occupies raster lines 51+8r .. 58+8r. So the spacer row 2 = lines 67-74,
 * and the playfield's first row 3 starts at line 75. */
#define FIELD_TOP    3
#define SPLIT_LINE   68   /* inside spacer row 2 (67-74): jitter-proof */
#define BOTTOM_LINE  251  /* first line below the 25-row text window (ends 250) */
/* $D011 values for the two halves of the frame. Keep DEN (bit4, screen on),
 * RSEL (bit3, 25 rows) set and bit7 (raster compare bit 8) CLEAR (both split
 * lines < 256); the low 3 bits are the fine Y-scroll 0-7. */
#define D011_KEEP    0x18          /* DEN + RSEL, bit7=0 — the constant part */
#define D011_BAR     0x1B          /* fine Y = 3 (power-on) — the fixed bar */

/* ── GAME LOGIC (clay — reshape freely) — sprite art (24×21, 3 bytes/row) ──
 * Two VIC-II hardware sprites: P1's car and P2's car (versus). The road,
 * lane lines, shoulders and traffic are all CHARACTERS in screen RAM (the
 * scroll shifts them), so they cost no sprite slots. */
#define SLOT_P1   0
#define SLOT_P2   1
#define SPR_DATA(img)   (0x3F00 + (img) * 64)
#define SPR_PTR(img)    (uint8_t)(SPR_DATA(img) / 64)   /* $3F00/64 = $FC */
#define IMG_CAR   0

static const uint8_t car_sprite[64] = {   /* a little top-down car, nose up */
  0x00,0x00,0x00, 0x03,0xC0,0x00, 0x07,0xE0,0x00, 0x07,0xE0,0x00,
  0x3F,0xFC,0x00, 0x7F,0xFE,0x00, 0x7F,0xFE,0x00, 0x66,0x66,0x00,
  0x66,0x66,0x00, 0x7F,0xFE,0x00, 0x7F,0xFE,0x00, 0x7F,0xFE,0x00,
  0x66,0x66,0x00, 0x66,0x66,0x00, 0x7F,0xFE,0x00, 0x7F,0xFE,0x00,
  0x3F,0xFC,0x00, 0x18,0x18,0x00, 0x18,0x18,0x00, 0,0,0, 0,0,0, 0,
};

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * THE RASTER-IRQ SPLIT — the C64's classic "fixed status bar over a moving
 * world" trick (and the gateway drug to all raster effects). The VIC-II has
 * ONE $D011 fine Y-scroll for the whole frame; to scroll the road while the
 * score bar stays put, you change $D011's YSCROLL MID-FRAME, at an exact
 * raster line, from an interrupt. Two IRQs ping-pong per frame:
 *
 *   line 68 (inside the blank spacer row): $D011 = road fine-Y scroll
 *           → everything drawn below this line scrolls
 *   line 251 (just past the text window):  $D011 = bar Y-scroll (3)
 *           → next frame's bar rows render fixed; this IRQ is also the
 *             game's frame heartbeat (increments frame_count)
 *
 * The handshake, register by register:
 *   $D012      raster compare line (low 8 bits)
 *   $D011 b7   raster compare bit 8 — MUST be 0 here (both lines < 256).
 *              We rewrite $D011 every split with bit7 left clear; forgetting
 *              it is the classic "my IRQ fires on the wrong line / twice"
 *              bug once lines ≥ 256 get involved.
 *   $D01A b0   raster IRQ enable
 *   $D019      IRQ latch. ACK by WRITING THE BITS BACK (write-1-to-clear).
 *              THE LOAD-BEARING LINE: skip the ack and the IRQ re-fires the
 *              instant it returns, forever — the main loop starves and the
 *              machine looks hung.
 *   $0314/15   the KERNAL's IRQ indirection. The hardware vector ($FFFE)
 *              points into KERNAL ROM, which saves A/X/Y and jumps through
 *              $0314 — so with the KERNAL banked in (cc65 default) we just
 *              repoint $0314. Exit via jmp $EA81 (KERNAL: restore regs +
 *              rti), SKIPPING $EA31's jiffy-clock/keyboard scan.
 *   $DC0D      CIA1 interrupt control. The KERNAL leaves a 60Hz CIA timer
 *              IRQ running (the jiffy clock); disable it ($7F = clear all
 *              sources) and ack it (read $DC0D) or it shares the IRQ line
 *              with the raster and fires our handler at random lines.
 *
 * Y-SCROLL SMEAR + JITTER: changing YSCROLL mid-frame makes the VIC repeat or
 * drop a few pixel rows at the split line, and the IRQ itself starts 0-7
 * cycles late plus the KERNAL thunk (~35 cycles) — so the $D011 write lands
 * one-to-two raster lines after SPLIT_LINE. We hide BOTH by splitting inside a
 * UNIFORM blank spacer row, where a smeared/shifted blank row changes nothing.
 * Splits next to visible detail need cycle-exact stabilization (double-IRQ
 * trick) — don't go there until you need to.
 *
 * The handler is ASSEMBLY-IN-C on purpose: cc65's generated C uses shared
 * zero-page scratch registers, so a C-level IRQ body would corrupt whatever
 * the main loop was computing. These asm lines touch only A + the flags
 * (which the KERNAL thunk already saved). requires: KERNAL banked in,
 * frame_count/field_d011 file-scope NON-static (asm %v needs the symbol). */
volatile uint8_t frame_count;  /* bumped by the bottom IRQ — frame heartbeat */
volatile uint8_t field_d011;   /* road $D011 value, precomputed by main */

void raster_irq(void) {
  asm("lda $d019");          /* read VIC IRQ latch...                       */
  asm("sta $d019");          /* ...write it back = ACK (write-1-to-clear).
                              * THE line you must not lose (see above).     */
  asm("lda $d012");          /* which raster line woke us? (self-correcting
                              * dispatch — no phase variable to desync)     */
  asm("cmp #150");
  asm("bcs %g", at_bottom);  /* ≥150 → we're at BOTTOM_LINE                 */
  /* — split point (line ~68, inside the blank spacer row) — */
  asm("lda %v", field_d011);
  asm("sta $d011");          /* road fine-Y from here down                  */
  asm("lda #251");           /* = BOTTOM_LINE (cc65's asm %b only takes     */
  asm("sta $d012");          /* signed bytes, so these are literals — the   */
  asm("jmp $ea81");          /* #if below keeps them honest)                */
at_bottom:
  asm("lda #$1B");           /* = D011_BAR                                  */
  asm("sta $d011");          /* bar Y-scroll for the top of the NEXT frame  */
  asm("inc %v", frame_count);/* frame heartbeat for the main loop           */
  asm("lda #%b", SPLIT_LINE);
  asm("sta $d012");          /* next stop: the split line                   */
  asm("jmp $ea81");          /* KERNAL: pla/tay/pla/tax/pla/rti             */
}
#if BOTTOM_LINE != 251 || D011_BAR != 0x1B
#error raster_irq's asm immediates are out of sync with BOTTOM_LINE / D011_BAR
#endif

static void install_raster_irq(void) {
  asm("sei");                       /* no IRQs while we rewire them */
  POKE(CIA1_PRA + 0x0D, 0x7F);      /* $DC0D: disable ALL CIA1 IRQ sources
                                     * (kills the KERNAL jiffy/keyboard IRQ
                                     * — we read the sticks ourselves) */
  (void)PEEK(CIA1_PRA + 0x0D);      /* reading $DC0D acks anything pending */
  POKE(0x0314, (uint8_t)((unsigned)raster_irq & 0xFF));
  POKE(0x0315, (uint8_t)((unsigned)raster_irq >> 8));
  POKE(VIC_CTRL1, D011_BAR);        /* $D011: screen on, 25 rows, YSCROLL=3,
                                     * bit7 (raster compare bit8) = 0 — both
                                     * our lines are < 256 */
  POKE(VIC_RASTER, SPLIT_LINE);     /* first stop */
  POKE(VIC_IRQ_ENA, 0x01);          /* raster IRQ on */
  POKE(VIC_IRQ, 0xFF);              /* clear any stale latch bits */
  asm("cli");
}

/* Wait for the bottom IRQ's heartbeat. Replaces the usual poll-$D012 loop —
 * the IRQ owns the raster now, the main loop just paces itself on it. */
static void wait_frame(void) {
  uint8_t f = frame_count;
  while (frame_count == f) { }
}

/* ── HARDWARE IDIOM (load-bearing — see TROUBLESHOOTING) ── reading BOTH
 * joystick ports. CIA1 port A ($DC00) = control port 2, port B ($DC01) =
 * control port 1. Active-low: a pressed switch reads 0, so invert and mask
 * to bits 0-4 (up/down/left/right/fire).
 *
 * THE PORT-1 GOTCHA: $DC01 is ALSO the keyboard row register — the matrix
 * hangs off the same CIA lines. Writing $FF to $DC00 first deselects every
 * keyboard column, so held keys can't pull $DC01 rows low and ghost into
 * the port-1 stick. That's also why "port 2 is the C64 game port": P1 lives
 * there by convention, and this game puts the SECOND player on port 1.
 * requires: install_raster_irq already disabled the KERNAL's keyboard scan,
 * so nothing else rewrites $DC00. */
static uint8_t read_stick_port2(void) {     /* player 1 */
  POKE(CIA1_PRA, 0xFF);
  return (uint8_t)(~PEEK(CIA1_PRA) & 0x1F);
}
static uint8_t read_stick_port1(void) {     /* player 2 */
  POKE(CIA1_PRA, 0xFF);
  return (uint8_t)(~PEEK(CIA1_PRB) & 0x1F);
}
#define JOY_UP    0x01
#define JOY_DOWN  0x02
#define JOY_LEFT  0x04
#define JOY_RIGHT 0x08
#define JOY_FIRE  0x10

/* ── HARDWARE IDIOM (load-bearing) — best-distance persistence seam ──────────
 * HONEST NO-OPS, deliberately. The current VICE core build exposes no
 * SAVE_RAM region and no 1541 disk write-back, so NOTHING a .prg writes can
 * survive a power cycle yet (a planned core round adds the save path; see
 * the C64 MENTAL_MODEL "Disk images" section for where it will land).
 * These two functions are the STABLE SEAM: the game already calls them in
 * the right places — load at boot, save on a new record. When the core
 * round ships, implement them (d64 file write or cartridge RAM) WITHOUT
 * touching any caller. Until then the best lives for the session only, and
 * this comment is the honest reason why. */
static uint16_t best_load(void) { return 0; }
static void best_save(uint16_t v) { (void)v; }

/* ── GAME LOGIC (clay) — SID music: 2 voices + THE filter sweep ─────────────
 * Voice 0 = melody (pulse), voice 1 = bass (sawtooth THROUGH THE FILTER),
 * voice 2 is reserved for sound effects (c64_sfx). Each voice walks a
 * (freq, frames) note table once per frame; end wraps → continuous loop.
 *
 * THE SID FILTER — the C64's sonic signature, and the part most "music
 * drivers ported from other chips" miss. One analog-modeled filter, shared
 * by all voices, four registers:
 *   $D415  cutoff low 3 bits   $D416  cutoff high 8 bits (11-bit total)
 *   $D417  high nibble = resonance 0-15; low 3 bits ROUTE voices into the
 *          filter (bit0=voice0, bit1=voice1, bit2=voice2)
 *   $D418  bit4=lowpass bit5=bandpass bit6=highpass — AND master volume in
 *          bits 0-3. Volume and filter mode share a register: any "set
 *          volume" helper that writes plain $0F silently turns the filter
 *          OFF (c64_sfx's sfx_init does exactly that, so music_init runs
 *          AFTER it and re-asserts the mode bits).
 *          FOOTGUN: bit 7 of $D418 is "3OFF" — it MUTES voice 3 entirely.
 *          Set it by accident and all your sound effects vanish.
 * The sweep: a triangle LFO walks the cutoff up and down each frame over
 * the resonant lowpass — the bass goes from muffled to snarling and back,
 * the "wah" that screams Commodore. Hear it change: that IS the chip. */
#define N_A2 0x0F3Cu
#define N_C3 0x1199u
#define N_D3 0x13EEu
#define N_E3 0x1666u
#define N_F3 0x1798u
#define N_G3 0x1AE6u
#define N_A3 0x1E78u
#define N_B3 0x2253u
#define N_C4 0x2333u
#define N_D4 0x27DDu
#define N_E4 0x2CCCu
#define N_F4 0x2F30u
#define N_G4 0x35CCu
#define N_A4 0x3CF1u
#define N_B4 0x44A7u
#define N_C5 0x4666u
#define N_D5 0x4FBAu
#define N_E5 0x5998u
#define N_G5 0x6B99u
#define N_REST 0u
#define STEP 8            /* frames per melodic eighth-note (~155 BPM PAL) */

typedef struct { uint16_t freq; uint8_t len; } Note;

/* The table IS the song — edit these to rescore your fork. A driving riff
 * over a pumping bass; the road never stops, neither does the loop. */
static const Note melody[] = {
  { N_E4, STEP }, { N_G4, STEP }, { N_A4, STEP*2 }, { N_G4, STEP }, { N_E4, STEP }, { N_A4, STEP*2 },
  { N_E4, STEP }, { N_G4, STEP }, { N_C5, STEP*2 }, { N_B4, STEP }, { N_A4, STEP }, { N_G4, STEP*2 },
  { N_D4, STEP }, { N_F4, STEP }, { N_A4, STEP*2 }, { N_F4, STEP }, { N_D4, STEP }, { N_A4, STEP*2 },
  { N_E4, STEP }, { N_G4, STEP }, { N_B4, STEP }, { N_D5, STEP }, { N_C5, STEP*2 }, { N_REST, STEP },
  { N_A4, STEP }, { N_C5, STEP }, { N_E5, STEP*2 }, { N_C5, STEP }, { N_A4, STEP*2 }, { N_G4, STEP },
  { N_E4, STEP }, { N_G4, STEP }, { N_A4, STEP }, { N_B4, STEP }, { N_A4, STEP*2 }, { N_G4, STEP*2 },
};
static const Note bassline[] = {
  /* Octave-pumping bass — the filter sweep chews on this. */
  { N_A2, STEP*3 }, { N_A3, STEP }, { N_A2, STEP*2 }, { N_E3, STEP*2 },
  { N_C3, STEP*3 }, { N_C4, STEP }, { N_C3, STEP*2 }, { N_G3, STEP*2 },
  { N_D3, STEP*3 }, { N_D4, STEP }, { N_D3, STEP*2 }, { N_A3, STEP*2 },
  { N_E3, STEP*3 }, { N_B3, STEP }, { N_E3, STEP*2 }, { N_G3, STEP*2 },
};
#define MELODY_LEN  (sizeof(melody) / sizeof(melody[0]))
#define BASS_LEN    (sizeof(bassline) / sizeof(bassline[0]))

static uint8_t  m_pos[2], m_left[2];
static uint16_t filter_cut;     /* 11-bit cutoff, 0-2047 */
static uint8_t  filter_up;

static void music_trigger(uint8_t v, uint16_t freq, uint8_t wave) {
  if (freq == N_REST) {
    POKE(SID_CTRL(v), wave);              /* gate off: release tail plays */
    return;
  }
  POKE(SID_FREQ_LO(v), (uint8_t)(freq & 0xFF));
  POKE(SID_FREQ_HI(v), (uint8_t)(freq >> 8));
  POKE(SID_CTRL(v), wave);                /* gate OFF then ON — the 6581/8580 */
  POKE(SID_CTRL(v), wave | SID_GATE);     /* envelope only retriggers on the
                                           * 0→1 gate edge */
}

static void music_init(void) {
  /* Melody: pulse at 50% duty, snappy envelope. */
  POKE(SID_PW_LO(0), 0x00); POKE(SID_PW_HI(0), 0x08);
  POKE(SID_AD(0), 0x07);    /* attack 0, decay 7 */
  POKE(SID_SR(0), 0x84);    /* sustain 8, release 4 */
  /* Bass: sawtooth (harmonically rich — gives the filter teeth to chew). */
  POKE(SID_AD(1), 0x06);
  POKE(SID_SR(1), 0xA5);
  /* Filter: route VOICE 1 ONLY into it (bit 1 of $D417), resonance 13/15. */
  POKE(SID_RES_FILT, 0xD2);
  /* Lowpass mode + master volume 15. NOTE bits shared with volume, and bit
   * 7 (3OFF) stays 0 or voice-2 sound effects go silent — see block doc. */
  POKE(SID_VOL_MODE, 0x1F);
  filter_cut = 0x180; filter_up = 1;
  m_pos[0] = m_pos[1] = 0;
  m_left[0] = m_left[1] = 1;    /* triggers both voices on the next update */
}

static void music_update(void) {
  /* Note sequencing, one table per voice. */
  if (--m_left[0] == 0) {
    music_trigger(0, melody[m_pos[0]].freq, SID_PULSE);
    m_left[0] = melody[m_pos[0]].len;
    if (++m_pos[0] >= MELODY_LEN) m_pos[0] = 0;
  }
  if (--m_left[1] == 0) {
    music_trigger(1, bassline[m_pos[1]].freq, SID_SAWTOOTH);
    m_left[1] = bassline[m_pos[1]].len;
    if (++m_pos[1] >= BASS_LEN) m_pos[1] = 0;
  }
  /* THE FILTER SWEEP — triangle LFO on the cutoff, ~10s round trip.
   * 11-bit value split across two registers: low 3 bits in $D415,
   * high 8 in $D416. */
  if (filter_up) { filter_cut += 6; if (filter_cut >= 0x700) filter_up = 0; }
  else           { filter_cut -= 6; if (filter_cut <= 0x180) filter_up = 1; }
  POKE(SID_FILTER_LO, (uint8_t)(filter_cut & 0x07));
  POKE(SID_FILTER_HI, (uint8_t)(filter_cut >> 3));
}

/* ── GAME LOGIC (clay) — screen text. The C64 has NO VRAM port: screen RAM
 * is plain memory, writable any time, mid-frame, no vblank dance. The only
 * translation is ASCII → SCREEN CODES (not PETSCII!): A-Z land at 1-26;
 * space through '?' (incl. digits) keep their ASCII values. ── */
static void draw_text(uint8_t row, uint8_t col, const char *s) {
  uint16_t off = (uint16_t)row * 40 + col;
  uint8_t ch;
  while ((ch = (uint8_t)*s++) != 0) {
    if (ch >= 'A' && ch <= 'Z') ch -= 64;       /* A-Z → screen codes 1-26 */
    SCREEN[off] = ch;                            /* 32-63 map straight through */
    COLORS[off] = COLOR_WHITE;
    ++off;
  }
}

static void draw_u16(uint8_t row, uint8_t col, uint16_t v) {
  uint8_t i, d[5];
  uint16_t off = (uint16_t)row * 40 + col;
  for (i = 0; i < 5; i++) { d[i] = v % 10; v /= 10; }
  for (i = 0; i < 5; i++) {
    SCREEN[off + i] = (uint8_t)('0' + d[4 - i]); /* digit screen code = ASCII */
    COLORS[off + i] = COLOR_WHITE;
  }
}

/* ── GAME LOGIC (clay) — xorshift-style PRNG (cheap, period 255) ── */
static uint8_t rng_state = 0x4D;
static uint8_t rand8(void) {
  uint8_t lsb = (uint8_t)(rng_state & 1);
  rng_state >>= 1;
  if (lsb) rng_state ^= 0xB8;
  return rng_state;
}

/* ── GAME LOGIC (clay) — THE ROAD ────────────────────────────────────────────
 * The playfield is a top-down road that scrolls DOWN past cars parked near
 * the bottom. Chars 3..24 are the road; the layout per char column:
 *   0..ROAD_L-1            grass (left berm)
 *   ROAD_L                 solid shoulder line
 *   ROAD_L+1 .. ROAD_R-1   asphalt, with dashed lane lines and the double
 *                          center divider at CENTER (the 2P territory border)
 *   ROAD_R                 solid shoulder line
 *   ROAD_R+1 .. 39         grass (right berm)
 * Four 4-cell lanes sit between the shoulders; lane centers in lane_col[]. */
#define ROAD_L     11         /* left shoulder column                       */
#define ROAD_R     28         /* right shoulder column                      */
#define CENTER     20         /* double-line center divider (2P border)     */
#define LANE_DASH1 14         /* dashed lane line between lanes 0 and 1      */
#define LANE_DASH2 25         /* dashed lane line between lanes 2 and 3      */
static const uint8_t lane_col[4] = { 12, 17, 22, 27 };  /* lane center cols  */

/* Char codes for road cells. */
#define CH_GRASS   0x66    /* checker glyph = textured grass             */
#define CH_SHOULDER 0xA0   /* reverse-space solid = the white edge line  */
#define CH_ASPHALT 0x20    /* blank = open asphalt                       */
#define CH_DASH    0x5D    /* vertical bar glyph = lane dashes           */
#define CH_DIVIDE  0xA0    /* reverse-space solid = double center line   */
#define CH_TRAFFIC 0x51    /* filled circle glyph = rival traffic car    */
#define CH_BLANK   0x20

/* The STATIC color texture (paint_colors) never scrolls — the row shift moves
 * only the CHARS, and they pick up each cell's resident color for free. We
 * lay the road colors PER COLUMN (grass green, shoulders gray, asphalt dark),
 * uniform down every row, so the coarse shift costs half the byte-moves. ── */
static uint8_t col_color[40];
static void build_col_color(void) {
  uint8_t c;
  for (c = 0; c < 40; c++) {
    if (c < ROAD_L || c > ROAD_R)        col_color[c] = COLOR_GREEN;       /* grass */
    else if (c == ROAD_L || c == ROAD_R) col_color[c] = COLOR_LIGHT_GRAY;  /* shoulder */
    else if (c == CENTER)                col_color[c] = COLOR_YELLOW;      /* divider */
    else if (c == LANE_DASH1 || c == LANE_DASH2) col_color[c] = COLOR_LIGHT_GRAY;
    else                                 col_color[c] = COLOR_DARK_GRAY;   /* asphalt */
  }
}

/* Paint the STATIC color texture for the whole road window — ONCE, at boot. */
static void paint_colors(void) {
  uint8_t r, c;
  for (r = FIELD_TOP; r < 25; r++) {
    volatile uint8_t *crow = COLORS + (uint16_t)r * 40;
    for (c = 0; c < 40; c++) crow[c] = col_color[c];
  }
}

static uint8_t road_phase;       /* dashed-line animation phase, world row    */

/* Stamp ONE road row's CHARS into screen RAM at screen row `sr`. `phase`
 * walks the dashed-line pattern so the lane dashes animate as rows scroll.
 * The COARSE scroll calls this once per 8 px (for the freshly exposed TOP
 * edge), NOT per cell of the whole screen — a full 22-row repaint of cc65 C
 * is ~50 frames (a frozen second). Keep it lean. */
static void draw_road_row(uint8_t sr, uint8_t phase) {
  uint8_t c;
  uint8_t *s = (uint8_t*)(0x0400) + (uint16_t)sr * 40;  /* plain RAM (see scroll_field) */
  uint8_t dash = (uint8_t)((phase & 3) < 2);            /* 4-on/4-off dash    */
  for (c = 0; c < 40; c++) {
    uint8_t ch;
    if (c < ROAD_L || c > ROAD_R)        ch = CH_GRASS;
    else if (c == ROAD_L || c == ROAD_R) ch = CH_SHOULDER;
    else if (c == CENTER)                ch = CH_DIVIDE;
    else if ((c == LANE_DASH1 || c == LANE_DASH2) && dash) ch = CH_DASH;
    else                                 ch = CH_ASPHALT;
    *s++ = ch;
  }
}

/* Repaint the WHOLE visible road window's CHARS. Runs ONCE per race start
 * (not per frame). */
static void paint_road(void) {
  uint8_t sr;
  for (sr = FIELD_TOP; sr < 25; sr++) draw_road_row(sr, sr);
}

/* ── HARDWARE IDIOM (load-bearing) — the vertical COARSE scroll. The road
 * moves DOWN (toward the player), so we shift the 22 visible road rows one
 * char DOWN in SCREEN RAM and stamp a fresh row at the TOP. Color RAM is the
 * static texture (paint_colors), so this touches ONLY screen RAM — half the
 * byte-moves. Runs only on the frame the fine offset wraps (every 8 px).
 * SCHEDULING IS THE TRICK: called right after wait_frame() (i.e. just after
 * the line-251 IRQ). The beam won't draw road row 3 until line 75 of the NEXT
 * frame (~8500 cycles away) and then takes 504 cycles/row; this loop spends
 * ~600 cycles/row, so with that head start it stays ahead of the beam — no
 * tearing, no double buffer. We copy bottom-up so a row isn't overwritten
 * before it's read. (The grown-up alternative is page-flipping via $D018.) */
static void scroll_field(void) {
  uint8_t r;
  /* NON-volatile pointers on purpose: screen RAM is plain memory (not MMIO),
   * so cc65 keeps the running pointer in zero page and emits a tight indexed
   * copy. Marking it volatile (as the per-cell sprite writes do, for mid-frame
   * correctness) would force a reload per access and roughly DOUBLE this
   * loop's cost — and this loop is the scroll's whole frame budget. */
  for (r = 24; r > FIELD_TOP; r--) {
    uint8_t *dst = (uint8_t*)(0x0400) + (uint16_t)r * 40;
    uint8_t *src = dst - 40;
    uint8_t c;
    for (c = 0; c < 40; c++) dst[c] = src[c];
  }
  ++road_phase;
  draw_road_row(FIELD_TOP, road_phase);   /* fresh road enters at the top */
}

/* ── GAME LOGIC (clay) — game state ── */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;
static uint8_t two_player;
static uint8_t winner;                 /* versus result: 1 = P1 wins, 2 = P2 */

/* ── Players + traffic. The cars are VIC-II HARDWARE SPRITES (P1, P2); the
 * road, lane lines and rival traffic are CHARACTERS in the scrolling field. ──
 * 1P: all 4 lanes, UP/FIRE accelerates, DOWN brakes (speed 1..MAX_SPEED).
 * 2P versus: ONE screen = ONE road scroll, so both share a fixed speed and
 * only steer — P1 (port 2) owns the left 2 lanes, P2 (port 1) the right 2,
 * split at the center divider. Each starts with CRASHES_MAX crashes; first
 * to use them all LOSES. */
#define MAX_TRAFFIC  4
#define CAR_ROW      20        /* both cars' fixed char row (near the bottom) */
#define CRASHES_MAX  3
#define SPAWN_PERIOD 38        /* frames between traffic spawns               */
#define SPEED_2P     2         /* fixed road speed in versus                  */
#define MAX_SPEED    5         /* px/frame — keep < 8 so the row streamer's   *
                               * one-row-per-8px restamp can't skip a row     */

static uint8_t  car_lane[2];           /* which of the 4 lanes (0..3)         */
static uint8_t  car_active[2];
static uint8_t  crashes_left[2];
static uint8_t  invuln[2];             /* post-crash blink/no-collide frames  */
static uint8_t  lane_min[2], lane_max[2];   /* 2P split territories           */

static uint8_t  traffic_alive[MAX_TRAFFIC];
static uint8_t  traffic_lane[MAX_TRAFFIC];
static int16_t  traffic_y[MAX_TRAFFIC];     /* world Y in px (top of road = 0) */
static uint8_t  traffic_col[MAX_TRAFFIC];   /* last screen column it was drawn */
static int16_t  traffic_prev_row[MAX_TRAFFIC];

static uint8_t  speed;                 /* road px/frame, 1..MAX_SPEED         */
static uint16_t dist;                  /* 1P distance, 1 unit = 16 px         */
static uint8_t  dist_frac;
static uint16_t best;                  /* persisted best 1P distance          */
static uint8_t  spawn_timer;
static uint16_t scroll_px;             /* total road px scrolled this run      */
static uint8_t  fine_prev;
static uint8_t  start_pause;           /* freeze frames at the green light    */
static uint8_t  prev0, prev1;          /* edge-detect held buttons            */

/* Sprite Y for a char row's top: a sprite at $D001 = 51 + 8*r appears at the
 * top of char row r (window row 0 sits at $D001≈50). Cars sit ON CAR_ROW. */
#define SPR_Y_FOR_ROW(r)  (uint8_t)(51 + 8 * (r))
/* Lane center → sprite X (24-px visible origin; lane cols are screen chars,
 * minus half the 24-px sprite to center it on the lane). */
#define LANE_X(lane)      (int16_t)((int16_t)lane_col[lane] * 8 + 24 - 12)

/* ── HARDWARE IDIOM (load-bearing) — staging a sprite with the 9th X bit.
 * VIC sprite X is 9 bits: low 8 in $D000+2n, bit 8 for ALL sprites packed
 * into $D010. Forget $D010 and anything past X=255 wraps back to the left
 * edge — the classic "my sprite teleports at two-thirds screen" bug. We
 * accumulate the MSB bits while staging and commit the byte once. ── */
static uint8_t spr_msb, spr_ena;
static void stage_begin(void) { spr_msb = 0; spr_ena = 0; }
static void stage_sprite(uint8_t slot, int16_t x, uint8_t y) {
  POKE(VIC_SPRITE_X(slot), (uint8_t)(x & 0xFF));
  POKE(VIC_SPRITE_Y(slot), y);
  if (x > 255) spr_msb |= (uint8_t)(1 << slot);
  spr_ena |= (uint8_t)(1 << slot);
}
static void stage_commit(void) {
  POKE(VIC_SPRITES_X8, spr_msb);
  POKE(VIC_SPR_ENA, spr_ena);   /* unstaged slots vanish — no stale sprites */
}

/* ── GAME LOGIC (clay) — score bar (rows 0-1) ── */
static void draw_bar_labels(void) {
  uint8_t c;
  for (c = 0; c < 40; c++) {              /* row 1: solid divider line */
    SCREEN[40 + c] = 0xA0;
    COLORS[40 + c] = COLOR_DARK_GRAY;
    SCREEN[80 + c] = CH_BLANK;            /* row 2: the blank spacer the
                                           * raster split hides in */
    SCREEN[c] = CH_BLANK;
  }
  draw_text(0, 0, "DST");
  draw_text(0, 11, "BEST");
  draw_text(0, 23, "CR");
  draw_text(0, 32, two_player ? "2P" : "1P");
}
static void draw_bar_stats(void) {
  draw_u16(0, 4, dist);
  draw_u16(0, 16, best);
  if (two_player) {
    /* versus: show each player's remaining crashes (P1-P2). */
    SCREEN[26] = (uint8_t)('0' + crashes_left[0]);
    SCREEN[27] = (uint8_t)('-');
    SCREEN[28] = (uint8_t)('0' + crashes_left[1]);
    COLORS[26] = COLOR_CYAN; COLORS[27] = COLOR_WHITE; COLORS[28] = COLOR_GREEN;
  } else {
    SCREEN[26] = (uint8_t)('0' + crashes_left[0]);
    COLORS[26] = COLOR_WHITE;
  }
}

/* ── GAME LOGIC (clay) — title / start / game over ──────────────────────────
 * Transition rule (see paint_road's note): never repaint the whole field on
 * a fire press. The title draws its text ON TOP of the parked road; start
 * repaints the road once (cheap enough at a state change, not per frame). */
static void draw_text_band(uint8_t row, uint8_t col, const char *s) {
  uint8_t c;
  volatile uint8_t *p = SCREEN + (uint16_t)row * 40;
  for (c = 0; c < 40; c++) p[c] = CH_BLANK;
  draw_text(row, col, s);
}

static void paint_title(void) {
  draw_bar_labels();
  draw_bar_stats();
  draw_text_band(7, (40 - (sizeof(GAME_TITLE) - 1)) / 2, GAME_TITLE);
  draw_text_band(11, 11, "PORT 2 FIRE - 1P");
  draw_text_band(13, 9, "PORT 1 FIRE - 2P VERSUS");
  draw_text_band(17, 15, "BEST");
  draw_u16(17, 20, best);
  field_d011 = D011_BAR;        /* title field holds still (text lives in it) */
  POKE(VIC_SPR_ENA, 0);
  state = ST_TITLE;
}

static void reset_traffic(void) {
  uint8_t i;
  for (i = 0; i < MAX_TRAFFIC; i++) {
    traffic_alive[i] = 0;
    traffic_prev_row[i] = -1;
  }
}

static void start_game(uint8_t players) {
  two_player = players;
  winner = 0;
  car_lane[0] = 1; car_lane[1] = 2;
  car_active[0] = 1; car_active[1] = players;
  crashes_left[0] = CRASHES_MAX;
  crashes_left[1] = players ? CRASHES_MAX : 0;
  invuln[0] = invuln[1] = 0;
  if (players) {                       /* split the road at the divider */
    lane_min[0] = 0; lane_max[0] = 1;  /* P1 owns lanes 0-1 (left)  */
    lane_min[1] = 2; lane_max[1] = 3;  /* P2 owns lanes 2-3 (right) */
  } else {
    lane_min[0] = 0; lane_max[0] = 3;  /* 1P: all four lanes */
  }
  speed = players ? SPEED_2P : 2;
  dist = 0; dist_frac = 0;
  spawn_timer = 0;
  scroll_px = 0; fine_prev = 0;
  road_phase = 0;
  start_pause = 40;                    /* "green light" breather */
  prev0 = prev1 = 0x1F;               /* swallow the start FIRE held */
  reset_traffic();
  field_d011 = D011_BAR;
  paint_road();                        /* repaint the road once for this run */
  draw_bar_labels();
  draw_bar_stats();
  sfx_tone(2, 0x40, 0x20, 6);          /* start chirp */
  state = ST_PLAY;
}

static void game_over(void) {
  POKE(VIC_SPR_ENA, 0);                /* sprites off before the message paints */
  field_d011 = D011_BAR;
  if (!two_player && dist > best) {
    best = dist;
    best_save(best);                   /* the persistence seam — see its doc */
  }
  if (two_player) {
    draw_text_band(11, 16, winner == 1 ? "P1 WINS" : "P2 WINS");
  } else {
    draw_text_band(11, 15, "GAME OVER");
  }
  draw_text_band(13, 13, "FIRE - TITLE");
  draw_bar_stats();
  sfx_noise(24);
  state = ST_OVER;
}

/* ── GAME LOGIC (clay) — a crash: lose one of this player's lives ──────────
 * 1P: out of crashes → game over. 2P versus: the FIRST player to exhaust
 * their crashes loses; the other wins on the spot. */
static void crash_player(uint8_t p) {
  sfx_noise(16);
  if (crashes_left[p]) --crashes_left[p];
  invuln[p] = 90;                      /* mercy frames + blink */
  draw_bar_stats();
  if (two_player) {
    if (crashes_left[p] == 0) { winner = (uint8_t)(p == 0 ? 2 : 1); game_over(); }
  } else if (crashes_left[0] == 0) {
    game_over();
  }
}

static void spawn_traffic(void) {
  uint8_t i;
  for (i = 0; i < MAX_TRAFFIC; i++) {
    if (!traffic_alive[i]) {
      traffic_alive[i] = 1;
      traffic_lane[i] = (uint8_t)(rand8() & 3);
      traffic_y[i] = -8;               /* just above the top of the road */
      traffic_prev_row[i] = -1;
      return;
    }
  }
}

/* Erase a traffic car's old char (restore the road cell under it) before it
 * moves — otherwise it leaves a trail. Redraw the affected cell from the road
 * template (lane center cells are dash-line or asphalt; never a shoulder). */
static void clear_traffic_cell(uint8_t row, uint8_t col) {
  uint8_t ch;
  if (row < FIELD_TOP || row > 24) return;
  if (col == CENTER) ch = CH_DIVIDE;
  else if (col == LANE_DASH1 || col == LANE_DASH2)
    ch = ((uint8_t)(((row + road_phase) & 3) < 2)) ? CH_DASH : CH_ASPHALT;
  else ch = CH_ASPHALT;
  SCREEN[(uint16_t)row * 40 + col] = ch;
  COLORS[(uint16_t)row * 40 + col] = col_color[col];
}

static void copy_sprite_image(uint8_t img, const uint8_t *src) {
  uint8_t i;
  volatile uint8_t *dst = (volatile uint8_t*)SPR_DATA(img);
  for (i = 0; i < 64; i++) dst[i] = src[i];
}

void main(void) {
  uint8_t pad0, pad1, p, i;

  /* ── HARDWARE IDIOM (load-bearing) — boot order. VIC + SID config before
   * the IRQ goes live; sfx_init BEFORE music_init (sfx_init writes a plain
   * volume to $D418, music_init re-asserts the filter-mode bits on top). ── */
  POKE(VIC_SPR_ENA, 0);
  POKE(VIC_BORDER, COLOR_BLACK);
  POKE(VIC_BG0, COLOR_BLACK);
  copy_sprite_image(IMG_CAR, car_sprite);
  SPRITE_POINTERS[SLOT_P1] = SPR_PTR(IMG_CAR);
  SPRITE_POINTERS[SLOT_P2] = SPR_PTR(IMG_CAR);
  POKE(VIC_SPR_COL(SLOT_P1), COLOR_CYAN);
  POKE(VIC_SPR_COL(SLOT_P2), COLOR_GREEN);
  POKE(CIA1_DDRA, 0xFF);                  /* port A drives keyboard columns */
  POKE(CIA1_DDRB, 0x00);                  /* port B reads rows / stick 1 */

  build_col_color();
  sfx_init();
  music_init();
  best = best_load();                     /* 0 until the core save round lands */

  field_d011 = D011_BAR;
  paint_colors();                         /* STATIC color texture — once, ever */
  paint_road();                           /* the ONE full-field char paint (boot) */
  install_raster_irq();                   /* the split + heartbeat go live */
  paint_title();

  for (;;) {
    wait_frame();                         /* the line-251 IRQ paces everything */

    music_update();
    sfx_update();
    pad0 = read_stick_port2();            /* P1 — control port 2 (convention) */
    pad1 = read_stick_port1();            /* P2 — control port 1 */

    if (state == ST_TITLE) {
      /* Mode select doubles as a controls demo: the stick that presses FIRE
       * picks the mode — port 2 starts 1P, port 1 starts 2P versus. */
      if ((pad0 & JOY_FIRE) && !(prev0 & JOY_FIRE)) start_game(0);
      else if ((pad1 & JOY_FIRE) && !(prev1 & JOY_FIRE)) start_game(1);
      prev0 = pad0; prev1 = pad1;
      continue;
    }

    if (state == ST_OVER) {
      if (((pad0 & JOY_FIRE) && !(prev0 & JOY_FIRE)) ||
          ((pad1 & JOY_FIRE) && !(prev1 & JOY_FIRE))) paint_title();
      prev0 = pad0; prev1 = pad1;
      continue;
    }

    /* ── ST_PLAY ─────────────────────────────────────────────────────────
     * Set field_d011 EARLY — it must be settled long before the beam reaches
     * SPLIT_LINE — and run the coarse shift right after the heartbeat. */
    if (start_pause) {
      --start_pause;
      stage_begin();
      stage_sprite(SLOT_P1, LANE_X(car_lane[0]), SPR_Y_FOR_ROW(CAR_ROW));
      if (two_player) stage_sprite(SLOT_P2, LANE_X(car_lane[1]), SPR_Y_FOR_ROW(CAR_ROW));
      stage_commit();
      continue;
    }

    /* 1P speed control: UP / FIRE accelerate, DOWN brakes (edge-triggered). */
    if (!two_player) {
      if ((pad0 & (JOY_UP | JOY_FIRE)) && !(prev0 & (JOY_UP | JOY_FIRE)) && speed < MAX_SPEED) {
        ++speed; sfx_tone(2, 0x80, 0x18, 3);
      }
      if ((pad0 & JOY_DOWN) && !(prev0 & JOY_DOWN) && speed > 1) {
        --speed; sfx_tone(2, 0x30, 0x10, 3);
      }
    }

    /* Steering: LEFT/RIGHT change lane (edge-triggered, clamped to territory).
     * P1 reads port 2, P2 reads port 1. */
    for (p = 0; p < (two_player ? 2 : 1); p++) {
      uint8_t pp = p ? pad1 : pad0;
      uint8_t prevp = p ? prev1 : prev0;
      if (!car_active[p]) continue;
      if ((pp & JOY_LEFT) && !(prevp & JOY_LEFT) && car_lane[p] > lane_min[p]) {
        --car_lane[p]; sfx_tone(2, 0x50, 0x14, 2);
      }
      if ((pp & JOY_RIGHT) && !(prevp & JOY_RIGHT) && car_lane[p] < lane_max[p]) {
        ++car_lane[p]; sfx_tone(2, 0x50, 0x14, 2);
      }
      if (invuln[p]) --invuln[p];
    }
    prev0 = pad0; prev1 = pad1;

    /* ── FINE + COARSE vertical scroll. The road moves DOWN: field_d011 low
     * 3 bits = the fine Y offset (counts UP 0..7 as the road advances). When
     * it wraps past a char boundary, COARSE-shift the rows down and stamp a
     * fresh road row at the top. ── */
    scroll_px += speed;
    {
      uint8_t fine = (uint8_t)(scroll_px & 7);
      field_d011 = (uint8_t)(D011_KEEP | fine);
      if (fine < fine_prev) scroll_field();   /* wrapped past 7→0 → coarse step */
      fine_prev = fine;
    }

    /* Distance: 16 scrolled px = 1 unit (≈ one car length). */
    dist_frac += speed;
    while (dist_frac >= 16) { dist_frac -= 16; ++dist; draw_bar_stats(); }

    /* Traffic: rival cars drift DOWN the road a touch faster than the scroll
     * so the player overtakes them. Erase the old cell, advance, redraw as a
     * char in its lane-center column. */
    ++spawn_timer;
    if (spawn_timer >= SPAWN_PERIOD) { spawn_timer = 0; spawn_traffic(); }
    for (i = 0; i < MAX_TRAFFIC; i++) {
      int16_t prow;
      uint8_t col, srow;
      if (!traffic_alive[i]) continue;
      if (traffic_prev_row[i] >= 0)         /* erase previous cell */
        clear_traffic_cell((uint8_t)traffic_prev_row[i], traffic_col[i]);
      traffic_y[i] += speed + 1;            /* a touch faster than scroll */
      if (traffic_y[i] >= (int16_t)((25 - FIELD_TOP) * 8)) {
        traffic_alive[i] = 0;               /* slipped past the bottom */
        traffic_prev_row[i] = -1;
        continue;
      }
      prow = (int16_t)(FIELD_TOP + (traffic_y[i] >> 3));
      col = lane_col[traffic_lane[i]];
      srow = (uint8_t)prow;
      if (srow >= FIELD_TOP && srow <= 24) {
        SCREEN[(uint16_t)srow * 40 + col] = CH_TRAFFIC;
        COLORS[(uint16_t)srow * 40 + col] = COLOR_LIGHT_RED;
        traffic_prev_row[i] = prow;
        traffic_col[i] = col;
      } else {
        traffic_prev_row[i] = -1;
      }
    }

    /* Collisions: a player crashes if a live traffic car shares its lane AND
     * is within one char row of CAR_ROW. */
    for (p = 0; p < (two_player ? 2 : 1); p++) {
      if (!car_active[p] || invuln[p]) continue;
      for (i = 0; i < MAX_TRAFFIC; i++) {
        if (!traffic_alive[i]) continue;
        if (traffic_lane[i] != car_lane[p]) continue;
        if (traffic_prev_row[i] >= (int16_t)(CAR_ROW - 1) &&
            traffic_prev_row[i] <= (int16_t)(CAR_ROW + 1)) {
          clear_traffic_cell((uint8_t)traffic_prev_row[i], traffic_col[i]);
          traffic_alive[i] = 0;
          traffic_prev_row[i] = -1;
          crash_player(p);
          break;
        }
      }
      if (state != ST_PLAY) break;
    }
    if (state != ST_PLAY) continue;

    /* Stage the car sprites, then commit enable + X-MSB once. Invulnerable
     * cars blink by skipping their slot every few frames. */
    stage_begin();
    for (p = 0; p < 2; p++) {
      if (!car_active[p]) continue;
      if (invuln[p] & 4) continue;               /* blink */
      stage_sprite(p ? SLOT_P2 : SLOT_P1, LANE_X(car_lane[p]), SPR_Y_FOR_ROW(CAR_ROW));
    }
    stage_commit();
  }
}
