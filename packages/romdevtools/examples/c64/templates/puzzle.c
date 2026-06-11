/* ── puzzle.c — C64 falling-trio versus puzzle (complete example game) ────────
 *
 * MAGMA MATCH — a COMPLETE, working game: title screen, 1P MARATHON mode
 * (levels speed the fall as you clear) and 2P SIMULTANEOUS VERSUS mode —
 * two 6x12 wells side by side, P1 on CONTROL PORT 2, P2 on CONTROL PORT 1,
 * both falling at once, where every cascade chain you score erupts garbage
 * rows up from the bottom of your rival's well. Score + in-session hi-score
 * behind the gated persistence seam, 2-voice SID music with the C64's
 * signature filter sweep + SFX, and the C64's signature raster-IRQ split:
 * a fixed HUD bar over the wells.
 *
 * The game: a falling-trio match-3. A vertical trio of blocks drops into a
 * well; LEFT/RIGHT move it, UP cycles its three colours, FIRE hard-drops,
 * DOWN soft-drops. When it lands, any straight run of 3+ same-coloured
 * blocks (horizontal, vertical, or diagonal) clears; survivors fall and
 * cascades chain for multiplied score. First stack to reach the rim loses.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented C64 footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — match rules, garbage, tuning, art: reshape freely.
 *
 * What depends on what:
 *   c64_registers.h — VIC-II / SID / CIA symbolic addresses (header only).
 *   c64_sfx.{h,c}   — one-shot SID sound effects on voice 2.
 *   The BASIC stub + crt0 come from cc65's c64 target: the .prg loads at
 *     $0801, a tiny BASIC line does SYS into the C runtime, and the KERNAL
 *     stays banked in (we lean on that for the IRQ vector — see below).
 *
 * Memory map this file assumes (VIC bank 0 = $0000-$3FFF):
 *   $0400  screen RAM (40×25 chars)        $D800 color RAM (per-cell color)
 *   $0801  this program (code+data grow up from here)
 *   Keep the program under ~14 KB. (No hardware sprites here — the whole
 *   board is screen-RAM CHARACTERS, so the classic $0800 / $1000 sprite-data
 *   trap doesn't even come up. The falling trio is drawn as chars too.)
 *
 * Frame budget (PAL, 50fps) — and a TEACHING POINT vs the NES version of
 * this game (examples/nes/templates/puzzle.c): on the NES, board repaints
 * squeeze through a ~16-entry vblank queue, so a full-board repaint is
 * BUDGETED across 12 frames of dirty-row bitmask tricks. The C64 has NO
 * VRAM port — screen RAM is plain memory, writable any time, mid-frame.
 * But the C64's famine is CPU, not bandwidth: a full 880-cell repaint of
 * cc65-generated C costs ~50 frames (a frozen second). So this game NEVER
 * repaints the whole screen during play — it tracks the cells that actually
 * changed and repaints ONLY those (see the cell-diff idiom). Same genre,
 * a different scarcity to design around — fork accordingly.
 */

#include "c64_registers.h"
#include "c64_sfx.h"
#include <stdint.h>

/* cc65 KERNAL disk-I/O prototypes. We DON'T #include <cbm.h> — it drags in
 * <c64.h>, whose VIC/SID/JOY macros collide with this project's
 * c64_registers.h (cc65 errors "macro redefinition is not identical"). These
 * four are the stable cc65 ABI; declaring them directly avoids the clash. */
unsigned char __fastcall__ cbm_open(unsigned char lfn, unsigned char device,
                                    unsigned char sec_addr, const char *name);
void __fastcall__ cbm_close(unsigned char lfn);
int __fastcall__ cbm_read(unsigned char lfn, void *buffer, unsigned int size);
int __fastcall__ cbm_write(unsigned char lfn, const void *buffer, unsigned int size);

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "MAGMA MATCH"

#define POKE(addr, val) (*(volatile uint8_t*)(addr) = (val))
#define PEEK(addr)      (*(volatile uint8_t*)(addr))

#define SCREEN ((volatile uint8_t*)0x0400)
#define COLORS ((volatile uint8_t*)0xD800)

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Board geometry. Each cell is ONE 40×25 character. Wells are 6 wide × 12
 * tall. In 1P a single well is centred; in 2P two wells split the screen.
 *   char row 0  — HUD text: SC / HI / LV / P2 score  (FIXED, the raster split)
 *   char row 1  — solid divider line                 (FIXED)
 *   char row 2  — blank spacer: the split lands mid-row HERE (jitter-proof)
 *   char rows 3.. — the wells (frame at WELL_TOP-1 / WELL_TOP+GRID_H) */
#define GRID_W   6
#define GRID_H   12
#define WELL_TOP 5            /* top char ROW of a well's interior          */
#define WELL_1P_X  17         /* 1P: single centred well (cols 17-22)        */
#define WELL_VS_P1 6          /* 2P: P1 interior cols 6-11 ...               */
#define WELL_VS_P2 28         /*     P2 interior cols 28-33 (split board)    */

#define EMPTY 0               /* cell colours 1..3 = magma / ember / ash     */

/* Char codes + colours for the board cells. A filled cell is a reverse-space
 * solid block tinted by its colour; an empty cell is a faint speck so the
 * well reads as a recessed playfield instead of a black void. */
#define CH_BLOCK 0xA0         /* reverse-space solid block (the trio/locked) */
#define CH_DOT   0x2E         /* '.' faint speck = empty well cell           */
#define CH_FRAME 0xE6         /* checkered frame glyph = well border         */
#define CH_BLANK 0x20
/* colour 1..3 → a C64 colour code (magma reds/oranges + ash grey). */
static const uint8_t cell_color[4] = {
  COLOR_DARK_GRAY,   /* 0 = empty speck (dim)            */
  COLOR_LIGHT_RED,   /* 1 = magma                        */
  COLOR_ORANGE,      /* 2 = ember                        */
  COLOR_LIGHT_GRAY,  /* 3 = ash                          */
};

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * THE RASTER-IRQ SPLIT — the C64's classic "fixed status bar over a moving
 * world" trick (and the gateway drug to all raster effects). Here it pins a
 * HUD bar at the top while the wells live below it. The VIC-II has ONE
 * $D016 fine-scroll for the whole frame; we don't scroll the wells (a puzzle
 * board holds still), but the split is STILL the idiomatic way to guarantee
 * the HUD's first rows render in a known, fixed scroll state regardless of
 * what the rest of the frame does — and it gives you the per-frame heartbeat
 * the main loop paces on. Two IRQs ping-pong per frame:
 *
 *   line 68 (inside the blank spacer row 2): assert the board's $D016
 *           → everything below the split renders in the board's scroll state
 *   line 251 (just past the text window):    assert the bar's $D016
 *           → next frame's HUD rows render fixed; this IRQ is also the
 *             game's frame heartbeat (increments frame_count)
 *
 * The handshake, register by register:
 *   $D012      raster compare line (low 8 bits)
 *   $D011 b7   raster compare bit 8 — MUST be 0 here (both lines < 256).
 *              Forgetting this bit is the classic "my IRQ fires on the
 *              wrong line / twice" bug when lines ≥ 256 get involved.
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
 * JITTER: an IRQ only starts after the current instruction finishes, so the
 * handler begins 0-7 cycles late, plus the KERNAL thunk (~35 cycles) — the
 * $D016 write lands one-to-two raster lines after SPLIT_LINE. We hide that
 * by splitting inside a UNIFORM blank row, where shifting the (invisible)
 * pixels mid-line changes nothing. Splits next to visible detail need
 * cycle-exact stabilization (double-IRQ trick) — don't go there until you do.
 *
 * The handler is ASSEMBLY-IN-C on purpose: cc65's generated C uses shared
 * zero-page scratch registers, so a C-level IRQ body would corrupt whatever
 * the main loop was computing. These asm lines touch only A + the flags
 * (which the KERNAL thunk already saved). requires: KERNAL banked in,
 * frame_count file-scope NON-static (asm %v needs the symbol). */
#define SPLIT_LINE   68   /* inside spacer row 2 (67-74): jitter-proof */
#define BOTTOM_LINE  251  /* first line below the 25-row text window */
#define D016_BAR     0xC0 /* fine X = 0, 38-col mode for both halves */

volatile uint8_t frame_count;  /* bumped by the bottom IRQ — frame heartbeat */

void raster_irq(void) {
  asm("lda $d019");          /* read VIC IRQ latch...                       */
  asm("sta $d019");          /* ...write it back = ACK (write-1-to-clear).
                              * THE line you must not lose (see above).     */
  asm("lda $d012");          /* which raster line woke us? (self-correcting
                              * dispatch — no phase variable to desync)     */
  asm("cmp #150");
  asm("bcs %g", at_bottom);  /* ≥150 → we're at BOTTOM_LINE                 */
  /* — split point (line ~68, inside the blank spacer row) — */
  asm("lda #$C0");           /* = D016_BAR — board holds still, same scroll */
  asm("sta $d016");
  asm("lda #251");           /* = BOTTOM_LINE (cc65's asm %b only takes     */
  asm("sta $d012");          /* signed bytes, so these are literals — the   */
  asm("jmp $ea81");          /* #if below keeps them honest)                */
at_bottom:
  asm("lda #$C0");           /* = D016_BAR                                  */
  asm("sta $d016");          /* bar scroll for the top of the NEXT frame    */
  asm("inc %v", frame_count);/* frame heartbeat for the main loop           */
  asm("lda #%b", SPLIT_LINE);
  asm("sta $d012");          /* next stop: the split line                   */
  asm("jmp $ea81");          /* KERNAL: pla/tay/pla/tax/pla/rti             */
}
#if BOTTOM_LINE != 251 || D016_BAR != 0xC0
#error raster_irq's asm immediates are out of sync with BOTTOM_LINE / D016_BAR
#endif

static void install_raster_irq(void) {
  asm("sei");                       /* no IRQs while we rewire them */
  POKE(CIA1_PRA + 0x0D, 0x7F);      /* $DC0D: disable ALL CIA1 IRQ sources
                                     * (kills the KERNAL jiffy/keyboard IRQ
                                     * — we read the sticks ourselves) */
  (void)PEEK(CIA1_PRA + 0x0D);      /* reading $DC0D acks anything pending */
  POKE(0x0314, (uint8_t)((unsigned)raster_irq & 0xFF));
  POKE(0x0315, (uint8_t)((unsigned)raster_irq >> 8));
  POKE(VIC_CTRL1, 0x1B);            /* $D011 = power-on default: screen on,
                                     * 25 rows, YSCROLL=3, and bit 7 (raster
                                     * compare bit 8) = 0 — both lines < 256 */
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

/* ── HARDWARE IDIOM (load-bearing) — hi-score persistence: DISK SAVE ─────────
 * The C64 has no battery SRAM — the honest save medium is the FLOPPY. A game
 * persists by writing a file to drive 8; VICE commits it into the live 1541
 * disk image (true-drive GCR write-back), so a save survives a power cycle
 * exactly as it did on real hardware. (To capture it headlessly the host does
 * state({op:'exportDisk', path}); re-loading that .d64 restores the save.)
 *
 * REQUIRES THE GAME RUN FROM A DISK: build/package it as a .d64 and load THAT
 * (loadMedia autostarts it). A bare .prg injected straight into RAM has no
 * mounted disk to save to, so the save is a silent no-op — still honest (the
 * value just stays in-session), it simply has nowhere to persist.
 *
 * We keep a 2-byte record in a SEQ file "HI" on drive 8. These are the STABLE
 * SEAM: the game calls hiscore_load at boot and hiscore_save on a new record;
 * reshape the record format freely, just keep the two function signatures. */
#define SAVE_NAME  "@0:HI,S,W"   /* @ = replace-if-exists; S=SEQ, W=write     */
#define LOAD_NAME  "0:HI,S,R"

static uint16_t hiscore_load(void) {
    uint16_t v = 0;
    uint8_t  buf[2];
    if (cbm_open(2, 8, 2, LOAD_NAME) == 0) {
        if (cbm_read(2, buf, 2) == 2) v = (uint16_t)buf[0] | ((uint16_t)buf[1] << 8);
        cbm_close(2);
    }
    return v;   /* 0 if the file isn't there yet (first ever boot) */
}

static void hiscore_save(uint16_t v) {
    uint8_t buf[2];
    buf[0] = (uint8_t)(v & 0xFF);
    buf[1] = (uint8_t)(v >> 8);
    if (cbm_open(2, 8, 2, SAVE_NAME) == 0) {
        cbm_write(2, buf, 2);
        cbm_close(2);
    }
    /* No disk mounted (ran as a bare .prg) -> cbm_open fails -> silent no-op. */
}

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
#define N_REST 0u
#define STEP 9            /* frames per melodic eighth-note (~140 BPM PAL) */

typedef struct { uint16_t freq; uint8_t len; } Note;

/* The table IS the song — edit these to rescore your fork. A brooding minor
 * line that suits a magma well. */
static const Note melody[] = {
  { N_A4, STEP*2 }, { N_C5, STEP }, { N_B4, STEP }, { N_A4, STEP*2 }, { N_E4, STEP*2 },
  { N_F4, STEP*2 }, { N_A4, STEP }, { N_C5, STEP }, { N_A4, STEP*2 }, { N_REST, STEP },
  { N_G4, STEP }, { N_B4, STEP }, { N_D5, STEP*2 }, { N_B4, STEP }, { N_G4, STEP*2 }, { N_D5, STEP },
  { N_E5, STEP }, { N_D5, STEP }, { N_C5, STEP }, { N_B4, STEP }, { N_A4, STEP*2 }, { N_REST, STEP },
  { N_C5, STEP }, { N_B4, STEP }, { N_A4, STEP }, { N_G4, STEP }, { N_F4, STEP*2 }, { N_E4, STEP*2 },
  { N_A4, STEP }, { N_C5, STEP }, { N_E5, STEP*2 }, { N_C5, STEP }, { N_A4, STEP*2 }, { N_REST, STEP },
};
static const Note bassline[] = {
  /* Octave-pumping bass — the filter sweep chews on this. */
  { N_A3, STEP*3 }, { N_A3, STEP }, { N_E3, STEP*2 }, { N_A3, STEP*2 },
  { N_F3, STEP*3 }, { N_C3, STEP }, { N_F3, STEP*2 }, { N_C4, STEP*2 },
  { N_G3, STEP*3 }, { N_D3, STEP }, { N_G3, STEP*2 }, { N_B3, STEP*2 },
  { N_A3, STEP*3 }, { N_E3, STEP }, { N_A3, STEP*2 }, { N_C4, STEP*2 },
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
/* Blank the whole 40-col row, then draw `s` on it — a clean text BAND, so
 * message text reads cleanly over whatever the board left behind. */
static void draw_text_band(uint8_t row, uint8_t col, const char *s) {
  uint8_t c;
  volatile uint8_t *p = SCREEN + (uint16_t)row * 40;
  for (c = 0; c < 40; c++) p[c] = CH_BLANK;
  draw_text(row, col, s);
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

/* ── GAME LOGIC (clay) — xorshift16 PRNG (a few instructions) ── */
static uint16_t rng = 0xACE1;
static uint8_t random8(void) {
  uint16_t r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (uint8_t)r;
}

/* ── GAME LOGIC (clay — reshape freely) ── game state.
 * Boards are PLAIN STATIC ARRAYS — the C64 has 38 KB of BASIC RAM free, so
 * none of the NES version's absolute-address scratch-page gymnastics. The
 * hot ones are file-scope NON-static so they land in the cc65 link map
 * (build symbols) — a headless agent can resolve them by name and read/poke
 * live state. */
uint8_t  grid[2][GRID_H][GRID_W];  /* the two wells (P2's unused in 1P)  */
int8_t   piece_x[2];               /* falling trio: column 0..5          */
int8_t   piece_y[2];               /* row of its TOP cell (<0 above rim) */
uint8_t  piece_col[2][3];          /* trio colours, top to bottom        */
uint16_t score[2];
uint16_t hiscore;
uint8_t  level;                    /* 1P: 1..9, speeds up the fall       */
uint8_t  state;                    /* ST_TITLE / ST_PLAY / ST_OVER       */
uint8_t  two_player;

static uint8_t  matched[GRID_H][GRID_W];
static uint8_t  well_x[2];         /* left interior char column per well  */
static uint8_t  fall_t[2];         /* frames until next gravity step      */
static uint8_t  prev0, prev1;      /* edge-triggered input per port       */
static uint16_t cleared_total;     /* 1P: cells cleared, drives the level */

#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2

#define VS_FALL_DELAY 26           /* 2P: fixed gravity (frames per row) */
#define GARBAGE_CAP   4            /* max garbage rows per attack        */

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * THE CELL-DIFF REPAINT — the C64's "queued VRAM" equivalent, inverted.
 * Screen RAM is plain memory, so there's no vblank queue to budget against
 * (the NES version's whole drain_vram_budget machinery is moot). The C64's
 * scarcity is CPU: a naive "repaint the whole 6x12 well every frame" is 72
 * cells × (a colour write + a char write) of cc65 C, and a WHOLE-SCREEN
 * 880-cell repaint costs ~50 frames — a frozen second (the TALUS TROT
 * platformer hit exactly this; see its paint_level note).
 *
 * So we keep a SHADOW of what's on screen and repaint ONLY cells that
 * changed. set_cell() compares against shadow[] and writes screen+color RAM
 * only on a difference — most frames touch 0-3 cells (the trio that moved).
 * A full cascade dirties the whole well, but spread across the cells that
 * actually changed it's still a few dozen writes, not 880. THE RULE: never
 * blit the board wholesale during play; always go through set_cell so the
 * diff does the work. (Static screens — title, game-over — CAN repaint
 * freely; they're not in the per-frame path.) */
static uint8_t shadow[25][40];     /* mirror of screen RAM char codes      */
static uint8_t shadow_c[25][40];   /* mirror of color RAM (so a colour-only
                                    * change still repaints — empty cells share
                                    * CH_DOT with the backdrop but want their
                                    * own well colour) */

static void set_cell(uint8_t row, uint8_t col, uint8_t ch, uint8_t color) {
  if (shadow[row][col] == ch && shadow_c[row][col] == color) return; /* unchanged */
  shadow[row][col] = ch;
  shadow_c[row][col] = color;
  {
    uint16_t off = (uint16_t)row * 40 + col;
    SCREEN[off] = ch;
    COLORS[off] = color;
  }
}

/* Paint ONE board cell at (grid r,c) for player p, honoring the falling trio
 * overlaid on top of the locked grid. Empty = faint speck; filled = tinted
 * solid block. */
static void draw_board_cell(uint8_t p, uint8_t r, uint8_t c) {
  uint8_t v = grid[p][r][c];
  /* Is the falling trio occupying this cell? (only for the active well) */
  if ((p == 0 || two_player) && piece_x[p] == (int8_t)c) {
    int8_t rel = (int8_t)((int8_t)r - piece_y[p]);
    if (rel >= 0 && rel < 3) v = piece_col[p][rel];
  }
  if (v) set_cell((uint8_t)(WELL_TOP + r), (uint8_t)(well_x[p] + c),
                  CH_BLOCK, cell_color[v]);
  else   set_cell((uint8_t)(WELL_TOP + r), (uint8_t)(well_x[p] + c),
                  CH_DOT, cell_color[0]);
}

/* Repaint a whole well through the cell-diff (used on board changes — the
 * diff means only the cells that really moved cost anything). */
static void draw_well(uint8_t p) {
  uint8_t r, c;
  for (r = 0; r < GRID_H; r++)
    for (c = 0; c < GRID_W; c++) draw_board_cell(p, r, c);
}

/* ── GAME LOGIC (clay) — the HUD bar (rows 0-1, the fixed split) ── */
static void draw_bar_labels(void) {
  uint8_t c;
  for (c = 0; c < 40; c++) {              /* row 1: solid divider line */
    SCREEN[40 + c] = CH_BLOCK;
    COLORS[40 + c] = COLOR_DARK_GRAY;
    SCREEN[80 + c] = CH_BLANK;            /* row 2: the blank spacer the
                                           * raster split hides in */
    SCREEN[c] = CH_BLANK;
  }
  draw_text(0, 1, "SC");
  draw_text(0, 12, "HI");
  if (two_player) draw_text(0, 30, "P2");
  else            draw_text(0, 30, "LV");
}
static void draw_bar_stats(void) {
  draw_u16(0, 4, score[0]);
  draw_u16(0, 15, hiscore);
  if (two_player) draw_u16(0, 33, score[1]);
  else {
    SCREEN[33] = (uint8_t)('0' + level);
    COLORS[33] = COLOR_WHITE;
  }
}

/* ── GAME LOGIC (clay) — paint the well frame (one cell outside the interior).
 * Runs on state changes only (a static screen), so it may write directly. ── */
static void paint_frame(uint8_t p) {
  uint8_t r, c, x0 = well_x[p];
  for (c = (uint8_t)(x0 - 1); c <= (uint8_t)(x0 + GRID_W); c++) {
    set_cell(WELL_TOP - 1, c, CH_FRAME, COLOR_BROWN);
    set_cell((uint8_t)(WELL_TOP + GRID_H), c, CH_FRAME, COLOR_BROWN);
  }
  for (r = (uint8_t)(WELL_TOP - 1); r <= (uint8_t)(WELL_TOP + GRID_H); r++) {
    set_cell(r, (uint8_t)(x0 - 1), CH_FRAME, COLOR_BROWN);
    set_cell(r, (uint8_t)(x0 + GRID_W), CH_FRAME, COLOR_BROWN);
  }
}

/* Clear the whole 25-row screen to blanks (and sync the shadow). Used on
 * state changes — a static-screen operation, cheap enough once. */
static void clear_screen(void) {
  uint16_t i;
  for (i = 0; i < 1000; i++) { SCREEN[i] = CH_BLANK; COLORS[i] = COLOR_BLACK; }
  for (i = 0; i < 25 * 40; i++) { ((uint8_t*)shadow)[i] = CH_BLANK; ((uint8_t*)shadow_c)[i] = COLOR_BLACK; }
}

/* ── GAME LOGIC (clay) — a thin ember speck band along the screen edges for
 * the static screens (title / game-over). Just the top + bottom playfield
 * rows get a sparse colour texture — enough to read as "alive" without the
 * ~3-second full-screen 880-cell repaint freeze (the C64's documented
 * full-repaint footgun; see the cell-diff idiom). The coloured BORDER (set
 * once in main) does the heavy lifting for screen liveliness; this is garnish.
 * Static-screen only — never per frame. ── */
static void paint_edge_band(void) {
  uint8_t c;
  volatile uint8_t *top = SCREEN + 3 * 40, *bot = SCREEN + 24 * 40;
  volatile uint8_t *tcol = COLORS + 3 * 40, *bcol = COLORS + 24 * 40;
  for (c = 0; c < 40; c++) {
    uint8_t lit = (uint8_t)((c & 1) == 0);
    top[c] = bot[c] = lit ? CH_DOT : CH_BLANK;
    tcol[c] = bcol[c] = lit ? COLOR_BROWN : COLOR_DARK_GRAY;
    shadow[3][c] = shadow[24][c] = top[c];
    shadow_c[3][c] = shadow_c[24][c] = tcol[c];
  }
}

/* ── GAME LOGIC (clay) — the title screen (static, free to repaint) ── */
static void paint_title(void) {
  clear_screen();
  paint_edge_band();
  two_player = 0;
  draw_bar_labels();
  draw_bar_stats();
  draw_text_band(8, (40 - (sizeof(GAME_TITLE) - 1)) / 2, GAME_TITLE);
  draw_text_band(13, 12, "PORT 2 FIRE - 1P");
  draw_text_band(15, 9, "PORT 1 FIRE - 2P VERSUS");
  draw_text_band(18, 7, "UP ROTATE - FIRE DROP");
  draw_text_band(20, 6, "CHAINS ERUPT ON YOUR RIVAL");
  draw_text_band(23, 16, "HI");
  draw_u16(23, 19, hiscore);
  state = ST_TITLE;
}

/* ── GAME LOGIC (clay) — paint the playfield (wells + HUD), static. ── */
static void paint_play(void) {
  clear_screen();
  paint_edge_band();              /* thin ember edge garnish (static) */
  draw_bar_labels();
  draw_bar_stats();
  paint_frame(0);
  draw_well(0);
  if (two_player) {
    paint_frame(1);
    draw_well(1);
    draw_text(11, 19, "VS");
  }
}

/* ── GAME LOGIC (clay) — game-over / results (static screen). ── */
static void paint_over(uint8_t loser) {
  clear_screen();
  paint_edge_band();
  draw_bar_labels();
  if (two_player)
    draw_text_band(8, 16, loser ? "P1 WINS" : "P2 WINS");
  else
    draw_text_band(8, 15, "GAME OVER");
  draw_text_band(12, 13, "P1");
  draw_u16(12, 17, score[0]);
  if (two_player) {
    draw_text_band(14, 13, "P2");
    draw_u16(14, 17, score[1]);
  }
  draw_text_band(17, 13, "HI");
  draw_u16(17, 17, hiscore);
  draw_text_band(21, 12, "FIRE - TITLE");
}

/* ── GAME LOGIC (clay) — end of game (top-out). `loser` topped out. ── */
static void game_end(uint8_t loser) {
  uint16_t best = score[0];
  if (two_player && score[1] > best) best = score[1];
  if (best > hiscore) {
    hiscore = best;
    hiscore_save(hiscore);   /* the persistence seam — see its block doc   */
  }
  sfx_noise(24);                                 /* game-over rumble        */
  state = ST_OVER;
  prev0 = prev1 = 0x1F;                          /* swallow the held FIRE   */
  paint_over(loser);
}

/* ── GAME LOGIC (clay — reshape freely) ──────────────────────────────────────
 * Match scan: mark every straight run of 3+ same-coloured blocks in all 4
 * directions (a cell can belong to several runs — the mask de-dupes), and
 * return how many cells matched. Same routine as every other platform's
 * version of this game. */
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
            && grid[p][sr][sc] == col) continue;     /* not the run's start */
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
 * copying blocks down to a write cursor, then zero everything above it). */
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

/* ── GAME LOGIC (clay) — clear matches, drop survivors, chain cascades.
 * Returns the chain depth (0 = the lock matched nothing). Repaints go
 * through the cell-diff via draw_well. */
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
    if (chain > 1) amt *= chain;               /* cascades pay multiplied */
    if (score[p] < 65000) score[p] += amt;
    /* clear chime — pitch rises with chain depth (higher freq_hi byte). */
    sfx_tone(2, 0x00, (uint8_t)(0x30 + (chain << 2)), 8);
    apply_gravity(p);
    draw_well(p);
    if (!two_player) {
      cleared_total += n;
      while (level < 9 && cleared_total >= (uint16_t)level * 10) ++level;
    }
    draw_bar_stats();
  }
  return chain;
}

/* ── GAME LOGIC (clay) — VERSUS attack: garbage rows ERUPT up from the bottom
 * of the victim's well (random blocks with one gap — matchable, so a skilled
 * victim digs out). The victim's stack rising means the falling trio shifts
 * up one to stay board-aligned; if the top row is already occupied, the
 * victim tops out and loses. ── */
static void garbage_insert(uint8_t v, uint8_t nrows) {
  uint8_t k, c, gap;
  int8_t r;
  sfx_noise(8);                                  /* incoming-garbage thud  */
  for (k = 0; k < nrows; k++) {
    for (c = 0; c < GRID_W; c++)
      if (grid[v][0][c] != EMPTY) { game_end(v); return; }
    for (r = 0; r < GRID_H - 1; r++)
      for (c = 0; c < GRID_W; c++)
        grid[v][r][c] = grid[v][r + 1][c];
    gap = random8() % GRID_W;
    for (c = 0; c < GRID_W; c++)
      grid[v][GRID_H - 1][c] = (c == gap) ? EMPTY : (uint8_t)(1 + random8() % 3);
    if (piece_y[v] > -3) --piece_y[v];           /* keep the trio aligned  */
  }
  draw_well(v);
}

/* Can the trio occupy column x, rows y..y+2? Cells above the rim are fine
 * (pieces enter from above); below the floor or on a block is not. */
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
  if (!can_place(p, piece_x[p], piece_y[p])) game_end(p);
}

/* ── GAME LOGIC (clay) — land the trio, resolve, attack, respawn. ── */
static void lock_piece(uint8_t p) {
  int8_t i, y;
  uint8_t chain;
  for (i = 0; i < 3; i++) {
    y = (int8_t)(piece_y[p] + i);
    if (y >= 0) grid[p][y][piece_x[p]] = piece_col[p][i];
  }
  sfx_tone(2, 0x00, 0x18, 4);                    /* lock thunk             */
  draw_well(p);
  if (piece_y[p] < 0) { game_end(p); return; }   /* locked above the rim   */
  chain = resolve_board(p);
  if (state != ST_PLAY) return;
  if (chain && two_player) {
    garbage_insert((uint8_t)(p ^ 1), chain > GARBAGE_CAP ? GARBAGE_CAP : chain);
    if (state != ST_PLAY) return;                /* garbage topped them out */
  }
  spawn_piece(p);
}

/* ── GAME LOGIC (clay) — per-player input + gravity. Edge-triggered moves
 * (one cell per press), held DOWN soft-drops, UP cycles the trio's colours
 * (the classic trio "rotate"), FIRE hard-drops. P2 reads control PORT 1. ──
 * The board cells the trio used to occupy are repainted via draw_board_cell
 * before/after the move, so the cell-diff erases its trail and stamps its
 * new spot — never a whole-well blit. */
static void erase_trio(uint8_t p) {
  int8_t i, y;
  for (i = 0; i < 3; i++) {
    y = (int8_t)(piece_y[p] + i);
    if (y >= 0 && y < GRID_H) draw_board_cell(p, (uint8_t)y, (uint8_t)piece_x[p]);
  }
}

static void stamp_trio(uint8_t p) {
  int8_t i, y;
  for (i = 0; i < 3; i++) {
    y = (int8_t)(piece_y[p] + i);
    if (y >= 0 && y < GRID_H) draw_board_cell(p, (uint8_t)y, (uint8_t)piece_x[p]);
  }
}

static void update_player(uint8_t p, uint8_t pad, uint8_t prev) {
  uint8_t fresh = (uint8_t)(pad & ~prev);
  uint8_t t, fd;
  erase_trio(p);                                 /* lift the trio off the board */
  if ((fresh & JOY_LEFT) && can_place(p, (int8_t)(piece_x[p] - 1), piece_y[p]))
    --piece_x[p];
  if ((fresh & JOY_RIGHT) && can_place(p, (int8_t)(piece_x[p] + 1), piece_y[p]))
    ++piece_x[p];
  if (fresh & JOY_UP) {                          /* cycle colours downward  */
    t = piece_col[p][2];
    piece_col[p][2] = piece_col[p][1];
    piece_col[p][1] = piece_col[p][0];
    piece_col[p][0] = t;
    sfx_tone(2, 0x00, 0x28, 3);
  }
  if (fresh & JOY_FIRE) {                         /* hard drop               */
    while (can_place(p, piece_x[p], (int8_t)(piece_y[p] + 1))) ++piece_y[p];
    lock_piece(p);                               /* may end the game        */
    return;
  }
  if (pad & JOY_DOWN) fall_t[p] += 4;            /* soft drop               */
  ++fall_t[p];
  fd = two_player ? VS_FALL_DELAY
                  : (uint8_t)(34 - ((level << 1) + level));      /* 31..7   */
  if (fall_t[p] >= fd) {
    fall_t[p] = 0;
    if (can_place(p, piece_x[p], (int8_t)(piece_y[p] + 1)))
      ++piece_y[p];
    else { lock_piece(p); return; }              /* may end the game        */
  }
  if (state == ST_PLAY) stamp_trio(p);           /* re-stamp the trio's new spot */
}

/* ── GAME LOGIC (clay) — start a run ── */
static void start_game(uint8_t versus) {
  uint8_t p, r, c;
  two_player = versus;
  well_x[0] = versus ? WELL_VS_P1 : WELL_1P_X;
  well_x[1] = WELL_VS_P2;
  /* Stir the PRNG with time-spent-on-title so runs differ. */
  rng ^= (uint16_t)frame_count ^ ((uint16_t)frame_count << 7);
  if (rng == 0) rng = 0xACE1;
  for (p = 0; p < 2; p++) {
    for (r = 0; r < GRID_H; r++)
      for (c = 0; c < GRID_W; c++) grid[p][r][c] = EMPTY;
    fall_t[p] = 0;
    score[p] = 0;
  }
  cleared_total = 0;
  level = 1;
  state = ST_PLAY;
  prev0 = prev1 = 0x1F;          /* the button that started the game
                                  * shouldn't also rotate the first trio */
  paint_play();
  spawn_piece(0);
  if (versus) spawn_piece(1);
  draw_well(0);
  if (versus) draw_well(1);
  sfx_tone(2, 0x00, 0x20, 10);                   /* start jingle           */
}

void main(void) {
  uint8_t pad0, pad1;

  /* ── HARDWARE IDIOM (load-bearing) — boot order. VIC + SID config before
   * the IRQ goes live; sfx_init BEFORE music_init (sfx_init writes a plain
   * volume to $D418, music_init re-asserts the filter-mode bits on top). ── */
  POKE(VIC_SPR_ENA, 0);                    /* no hardware sprites — board is chars */
  /* A coloured BORDER (one register, zero per-frame cost) keeps the screen
   * visibly alive even though the board itself is small over a black BG —
   * the border is ~40% of the framebuffer, so no single colour dominates the
   * render-health pixel scan. (Compare the platformer/shmup, which instead
   * fill the field with a scrolling starfield; a puzzle board doesn't.) */
  POKE(VIC_BORDER, COLOR_BROWN);
  POKE(VIC_BG0, COLOR_BLACK);
  POKE(VIC_CTRL2, D016_BAR);               /* 38-col mode from the start */
  POKE(CIA1_DDRA, 0xFF);                   /* port A drives keyboard columns */
  POKE(CIA1_DDRB, 0x00);                   /* port B reads rows / stick 1 */

  sfx_init();
  music_init();
  hiscore = hiscore_load();                /* 0 until the core save round lands */

  clear_screen();
  install_raster_irq();                    /* the split + heartbeat go live */
  paint_title();

  for (;;) {
    wait_frame();                          /* the line-251 IRQ paces everything */

    music_update();
    sfx_update();
    pad0 = read_stick_port2();             /* P1 — control port 2 (convention) */
    pad1 = read_stick_port1();             /* P2 — control port 1 */

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
     * Both players update EVERY frame (simultaneous versus, not alternating
     * turns). Any update can end the game, so re-check state between them. */
    update_player(0, pad0, prev0);
    if (two_player && state == ST_PLAY) update_player(1, pad1, prev1);
    prev0 = pad0; prev1 = pad1;
  }
}
