/* ── shmup.c — C64 horizontal shooter (complete example game) ─────────────────
 *
 * A COMPLETE, working game — title screen, 1P and 2P co-op modes, lives,
 * score + hi-score, SID music with the C64's signature filter sweep, SFX,
 * and the C64's signature raster-IRQ split (a fixed score bar over a
 * scrolling starfield).
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented C64 footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — enemy patterns, scoring, tuning, art: reshape freely.
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
 *   $3F00  sprite images (3 × 64 bytes)    — NOT $0800, which collides with
 *          the .prg load address, and NOT $1000-$1FFF, where the VIC sees
 *          the character ROM instead of RAM (a classic invisible-sprite trap).
 *   Keep the program under ~14 KB so it stays below $3F00.
 *
 * Frame budget (PAL, 50fps, ~19656 CPU cycles/frame): the coarse starfield
 * shift (22 rows × 39 bytes, every 8th frame) is the big-ticket item at
 * ~13k cycles; it's scheduled right after the bottom-of-frame IRQ so it
 * outruns the raster beam (see scroll_field_left). Everything else fits.
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
#define GAME_TITLE "ION SQUALL"

#define POKE(addr, val) (*(volatile uint8_t*)(addr) = (val))
#define PEEK(addr)      (*(volatile uint8_t*)(addr))

#define SCREEN ((volatile uint8_t*)0x0400)
#define COLORS ((volatile uint8_t*)0xD800)
#define SPRITE_POINTERS ((volatile uint8_t*)0x07F8) /* last 8 bytes of screen RAM */

/* ── Screen layout (the raster split divides bar from field) ────────────────
 *   char row 0  — score bar text: SC / HI / LV / mode      (FIXED, never scrolls)
 *   char row 1  — solid divider line                       (FIXED)
 *   char row 2  — blank spacer: the split lands mid-row HERE, where a few
 *                 raster lines of IRQ jitter are invisible (uniform color)
 *   char rows 3-24 — the scrolling starfield playfield
 * PAL raster geometry: with YSCROLL=3 (the power-on default) text row r
 * occupies raster lines 51+8r .. 58+8r. So the spacer row 2 = lines 67-74,
 * and the playfield's first row 3 starts at line 75. */
#define FIELD_TOP    3
#define SPLIT_LINE   68   /* inside spacer row 2 (67-74): jitter-proof */
#define BOTTOM_LINE  251  /* first line below the 25-row text window (ends 250) */
/* $D016 values for the two halves of the frame. Bit 3 CLEAR = 38-column mode
 * (masks the garbage column fine-X scrolling exposes at the edges — keep all
 * text inside columns 1-38). Low 3 bits = fine X scroll 0-7. */
#define D016_BAR     0xC0          /* fine X = 0, 38 cols — the fixed bar */

/* ── GAME LOGIC (clay — reshape freely) ── object pools, no heap ── */
#define MAX_BULLETS  2   /* one VIC sprite each — see the slot map below */
#define MAX_ENEMIES  4
#define START_LIVES  3

/* 8 VIC-II hardware sprite slots — ALL of them, the C64's full budget:
 *   0 = P1 ship   1 = P2 ship   2-3 = bullets   4-7 = enemies
 * (More objects than 8 needs raster-time sprite multiplexing — a deep
 * rabbit hole; this game designs its gameplay inside the budget instead.) */
#define SLOT_P1      0
#define SLOT_P2      1
#define SLOT_BULLET0 2
#define SLOT_ENEMY0  4

/* Sprite images live at $3F00 (top of VIC bank 0). Pointer byte = addr/64. */
#define SPR_DATA(img)   (0x3F00 + (img) * 64)
#define SPR_PTR(img)    (uint8_t)(SPR_DATA(img) / 64)   /* $3F00/64 = $FC */
#define IMG_SHIP   0
#define IMG_BULLET 1
#define IMG_ENEMY  2

/* ── GAME LOGIC (clay) — sprite art (24×21, 3 bytes/row, 64-byte blocks) ── */
static const uint8_t ship_sprite[64] = {
  0x60,0x00,0x00, 0x78,0x00,0x00, 0x7E,0x00,0x00, 0x1F,0x80,0x00,
  0x1F,0xE0,0x00, 0x3F,0xF8,0x00, 0x7F,0xFE,0x00, 0xFF,0xFF,0x80,
  0xFF,0xFF,0xE0, 0xFF,0xFF,0x80, 0x7F,0xFE,0x00, 0x3F,0xF8,0x00,
  0x1F,0xE0,0x00, 0x1F,0x80,0x00, 0x7E,0x00,0x00, 0x78,0x00,0x00,
  0x60,0x00,0x00, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,
};
static const uint8_t bullet_sprite[64] = {
  0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0,
  0x3F,0xC0,0x00, 0x7F,0xE0,0x00, 0x3F,0xC0,0x00,
  0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,
};
static const uint8_t enemy_sprite[64] = {
  0x03,0xC0,0x00, 0x0F,0xF0,0x00, 0x3C,0x3C,0x00, 0x73,0xCE,0x00,
  0xE7,0xE7,0x00, 0xFF,0xFF,0x00, 0xE7,0xE7,0x00, 0x73,0xCE,0x00,
  0x3C,0x3C,0x00, 0x0F,0xF0,0x00, 0x03,0xC0,0x00,
  0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,
};

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * THE RASTER-IRQ SPLIT — the C64's classic "fixed status bar over a moving
 * world" trick (and the gateway drug to all raster effects). The VIC-II has
 * ONE $D016 fine-scroll for the whole frame; to scroll the playfield while
 * the score bar stays put, you change $D016 MID-FRAME, at an exact raster
 * line, from an interrupt. Two IRQs ping-pong per frame:
 *
 *   line 68 (inside the blank spacer row): $D016 = playfield scroll
 *           → everything drawn below this line scrolls
 *   line 251 (just past the text window):  $D016 = 0 scroll
 *           → next frame's bar rows render fixed; this IRQ is also the
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
 *              rti), SKIPPING $EA31's jiffy-clock/keyboard scan. If you
 *              ever bank the KERNAL out, you own $FFFE and the register
 *              save/restore yourself.
 *   $DC0D      CIA1 interrupt control. The KERNAL leaves a 60Hz CIA timer
 *              IRQ running (the jiffy clock); disable it ($7F = clear all
 *              sources) and ack it (read $DC0D) or it shares the IRQ line
 *              with the raster and fires our handler at random lines.
 *
 * JITTER: an IRQ only starts after the current instruction finishes, so the
 * handler begins 0-7 cycles late, plus the KERNAL thunk (~35 cycles) — the
 * $D016 write lands one-to-two raster lines after SPLIT_LINE, at an
 * unpredictable X position. We hide that by splitting inside a UNIFORM
 * blank row, where shifting the (invisible) pixels mid-line changes
 * nothing. Splits next to visible detail need cycle-exact stabilization
 * (double-IRQ trick) — don't go there until you need to.
 *
 * The handler is ASSEMBLY-IN-C on purpose: cc65's generated C uses shared
 * zero-page scratch registers, so a C-level IRQ body would corrupt whatever
 * the main loop was computing. These asm lines touch only A + the flags
 * (which the KERNAL thunk already saved). requires: KERNAL banked in,
 * frame_count/field_d016 file-scope NON-static (asm %v needs the symbol). */
volatile uint8_t frame_count;  /* bumped by the bottom IRQ — frame heartbeat */
volatile uint8_t field_d016;   /* playfield $D016 value, precomputed by main */

void raster_irq(void) {
  asm("lda $d019");          /* read VIC IRQ latch...                       */
  asm("sta $d019");          /* ...write it back = ACK (write-1-to-clear).
                              * THE line you must not lose (see above).     */
  asm("lda $d012");          /* which raster line woke us? (self-correcting
                              * dispatch — no phase variable to desync)     */
  asm("cmp #150");
  asm("bcs %g", at_bottom);  /* ≥150 → we're at BOTTOM_LINE                 */
  /* — split point (line ~68, inside the blank spacer row) — */
  asm("lda %v", field_d016);
  asm("sta $d016");          /* playfield fine-X from here down             */
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
                                     * compare bit 8) = 0 — both our lines
                                     * are < 256 */
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
 * the port-1 stick. (The reverse ghost still exists on real hardware:
 * port-2 stick presses pull $DC00 columns low and can fake keypresses /
 * bleed into port 1 while keys are held. That's the real reason "port 2 is
 * the C64 game port" — P1 lives there by convention, and this game puts
 * the SECOND player on port 1.) requires: install_raster_irq already
 * disabled the KERNAL's keyboard scan, so nothing else rewrites $DC00. */
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
 * hi-score just stays in-session), it simply has nowhere to persist.
 *
 * We keep a 2-byte record in a SEQ file "HI" on drive 8. cbm_open/read/close
 * for load; cbm_save (KERNAL SAVE) for the write — SAVE is the simplest path
 * that VICE's true-drive emulation commits to the image. These are the STABLE
 * SEAM: the game calls hiscore_load at boot and hiscore_save on a new record;
 * reshape the record format freely, just keep the two function signatures. */
#define SAVE_NAME  "@0:HI,S,W"   /* @ = replace-if-exists; S=SEQ, W=write     */
#define LOAD_NAME  "0:HI,S,R"

static uint16_t hiscore_load(void) {
    uint16_t v = 0;
    uint8_t  buf[2];
    /* logical file 2, drive 8, secondary 2 (a data channel, not load-addr). */
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
    /* If no disk is mounted (ran as a bare .prg), cbm_open fails and this is a
     * silent no-op — the hi-score simply stays in-session. */
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
#define STEP 9            /* frames per melodic eighth-note (~140 BPM PAL) */

typedef struct { uint16_t freq; uint8_t len; } Note;

/* The table IS the song — edit these to rescore your fork. Am F C G loop. */
static const Note melody[] = {
  { N_A4, STEP*2 }, { N_C5, STEP }, { N_E5, STEP }, { N_C5, STEP*2 }, { N_E5, STEP*2 },
  { N_F4, STEP*2 }, { N_A4, STEP }, { N_C5, STEP }, { N_A4, STEP*2 }, { N_REST, STEP*2 },
  { N_C5, STEP*2 }, { N_E5, STEP }, { N_G5, STEP }, { N_E5, STEP*2 }, { N_C5, STEP*2 },
  { N_G4, STEP*2 }, { N_B4, STEP }, { N_D5, STEP }, { N_B4, STEP*2 }, { N_REST, STEP*2 },
  { N_A4, STEP }, { N_E4, STEP }, { N_A4, STEP }, { N_C5, STEP }, { N_E5, STEP*2 }, { N_D5, STEP }, { N_C5, STEP },
  { N_F4, STEP }, { N_C4, STEP }, { N_F4, STEP }, { N_A4, STEP }, { N_C5, STEP*2 }, { N_B4, STEP }, { N_A4, STEP },
  { N_E4, STEP }, { N_G4, STEP }, { N_C5, STEP }, { N_E5, STEP*2 }, { N_G5, STEP*2 }, { N_E5, STEP },
  { N_D5, STEP }, { N_B4, STEP }, { N_G4, STEP }, { N_D4, STEP*2 }, { N_B3, STEP*2 }, { N_REST, STEP },
};
static const Note bassline[] = {
  /* Octave-pumping bass — the filter sweep chews on this. */
  { N_A2, STEP*3 }, { N_A3, STEP }, { N_A2, STEP*2 }, { N_A3, STEP*2 },
  { N_F3, STEP*3 }, { N_C3, STEP }, { N_F3, STEP*2 }, { N_C4, STEP*2 },
  { N_C3, STEP*3 }, { N_G3, STEP }, { N_C3, STEP*2 }, { N_E3, STEP*2 },
  { N_G3, STEP*3 }, { N_D3, STEP }, { N_G3, STEP*2 }, { N_B3, STEP*2 },
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
 * is plain memory, writable any time, mid-frame, no vblank dance (compare
 * the NES's $2007 choreography). The only translation is ASCII → SCREEN
 * CODES (not PETSCII!): A-Z land at 1-26; space through '?' (incl. digits)
 * keep their ASCII values. ── */
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
/* Blank the whole 40-col row, then draw `s` on it — a clean text BAND.
 * Menu/message text sits over the starfield; drawing it raw leaves the
 * surrounding star chars ('.' and reverse-space nebula) crowding the words.
 * A blanked band reads cleanly on screen AND decodes cleanly from screen RAM. */
static void draw_text_band(uint8_t row, uint8_t col, const char *s) {
  uint8_t c;
  volatile uint8_t *p = SCREEN + (uint16_t)row * 40;
  for (c = 0; c < 40; c++) p[c] = 0x20;
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

/* ── GAME LOGIC (clay) — xorshift-style PRNG (cheap, period 255) ── */
static uint8_t rng_state = 0xB7;
static uint8_t rand8(void) {
  uint8_t lsb = (uint8_t)(rng_state & 1);
  rng_state >>= 1;
  if (lsb) rng_state ^= 0xB8;
  return rng_state;
}

/* ── GAME LOGIC (clay) — the starfield ──────────────────────────────────────
 * Two-layer trick for one-layer hardware: screen RAM holds the MOVING chars
 * (stars '.' + nebula blocks), color RAM holds a STATIC color texture. The
 * coarse scroll shifts ONLY screen RAM (color RAM never moves — half the
 * copy cost), so drifting chars pick up each cell's resident color as they
 * pass: free twinkle, deliberately cheap. */
static uint8_t field_cell(void) {
  uint8_t v = (uint8_t)(rand8() & 0x0F);
  if (v < 5) return 0xA0;       /* reverse-space nebula block */
  if (v < 7) return 0x2E;       /* '.' star */
  return 0x20;                  /* empty space */
}

/* Refill ONE field row with fresh stars + its color-texture stripe. Used by
 * state transitions to erase a text band (see paint_field's budget note). */
static void repaint_field_row(uint8_t r) {
  static const uint8_t tex[8] = {
    COLOR_BLUE, COLOR_DARK_GRAY, COLOR_BLUE, COLOR_LIGHT_BLUE,
    COLOR_BLUE, COLOR_DARK_GRAY, COLOR_WHITE, COLOR_MED_GRAY,
  };
  uint8_t c, t = (uint8_t)(r * 3);
  volatile uint8_t *srow = SCREEN + (uint16_t)r * 40;
  volatile uint8_t *crow = COLORS + (uint16_t)r * 40;
  for (c = 0; c < 40; c++) {
    srow[c] = field_cell();
    crow[c] = tex[(uint8_t)(c + t) & 7];
  }
}

/* BUDGET NOTE — this full repaint runs ONCE, at boot. 880 cells of cc65-
 * generated C (function calls per cell) costs ~50 frames: a WHOLE SECOND of
 * frozen music and ignored input if you call it on every state change (this
 * game's original sin — the title screen ate joystick presses for ~1s).
 * Transitions instead repaint only the rows they wrote text on
 * (repaint_field_row), which keeps every transition inside a few frames. */
static void paint_field(void) {
  uint8_t r;
  for (r = FIELD_TOP; r < 25; r++) repaint_field_row(r);
}

/* Coarse scroll: shift the playfield one char left, spawn a fresh column at
 * the right edge. Runs on the frame the fine offset wraps (every 8th).
 * SCHEDULING IS THE TRICK: called immediately after wait_frame(), i.e. just
 * after the line-251 IRQ. The beam won't draw playfield row 3 until line 75
 * of the NEXT frame (~8500 cycles away) and then takes 504 cycles per row;
 * this loop spends ~600 cycles per row, so with that head start it stays
 * ahead of the beam the whole way down — no tearing, no double buffer.
 * (The grown-up alternative is page-flipping screen RAM via $D018.) */
static void scroll_field_left(void) {
  uint8_t r, c;
  volatile uint8_t *row = SCREEN + FIELD_TOP * 40;
  for (r = FIELD_TOP; r < 25; r++) {
    for (c = 0; c < 39; c++) row[c] = row[c + 1];
    row[39] = field_cell();
    row += 40;
  }
}

/* ── GAME LOGIC (clay) — game state ── */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;
static uint8_t two_player;
static uint8_t lives;
static uint16_t score, hiscore;
static uint8_t cam;            /* starfield scroll counter (low 3 bits = fine) */

static int16_t ship_x[2]; static uint8_t ship_y[2], ship_alive[2], ship_inv[2], fire_cd[2];
static int16_t bullet_x[MAX_BULLETS]; static uint8_t bullet_y[MAX_BULLETS], bullet_on[MAX_BULLETS];
static int16_t enemy_x[MAX_ENEMIES]; static uint8_t enemy_y[MAX_ENEMIES], enemy_on[MAX_ENEMIES];
static uint8_t spawn_timer;

/* Sprite coordinate limits (sprite coords: visible X 24-343, Y 50-249).
 * The playfield starts at raster line 75 → keep ships/enemies below the bar. */
#define Y_MIN 78
#define Y_MAX 225

/* ── HARDWARE IDIOM (load-bearing) — staging sprites with the 9th X bit.
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
    SCREEN[80 + c] = 0x20;                /* row 2: the blank spacer the
                                           * raster split hides in */
    SCREEN[c] = 0x20;
  }
  draw_text(0, 1, "SC");
  draw_text(0, 11, "HI");
  draw_text(0, 21, "LV");
  draw_text(0, 27, two_player ? "2P CO-OP" : "1P      ");
}
static void draw_bar_stats(void) {
  draw_u16(0, 4, score);
  draw_u16(0, 14, hiscore);
  SCREEN[24] = (uint8_t)('0' + lives);
  COLORS[24] = COLOR_WHITE;
}

/* ── GAME LOGIC (clay) — title / game start / game over ──────────────────────
 * Transition rule (see paint_field's budget note): never repaint the whole
 * field here. The title draws its text on blanked BANDS over whatever
 * starfield is already there; start_game erases exactly those bands back to
 * stars. Every transition stays a few frames — music never hiccups, and a
 * fire press is acted on (visibly) by the next frame or two. */
static void paint_title(void) {
  draw_bar_labels();
  draw_bar_stats();
  draw_text_band(7, (40 - (sizeof(GAME_TITLE) - 1)) / 2, GAME_TITLE);
  draw_text_band(11, 12, "PORT 2 FIRE - 1P");
  draw_text_band(13, 9, "PORT 1 FIRE - 2P CO-OP");
  draw_text_band(17, 16, "HI");
  draw_u16(17, 19, hiscore);
  field_d016 = D016_BAR;        /* title field holds still (text lives in it) */
  POKE(VIC_SPR_ENA, 0);
  state = ST_TITLE;
}

/* The four rows paint_title wrote text bands on (game_over's two are a
 * subset) — start_game turns them back into starfield. */
static void erase_text_bands(void) {
  repaint_field_row(7);
  repaint_field_row(11);
  repaint_field_row(13);
  repaint_field_row(17);
}

static void start_game(uint8_t players) {
  uint8_t i;
  two_player = players;
  for (i = 0; i < MAX_BULLETS; i++) bullet_on[i] = 0;
  for (i = 0; i < MAX_ENEMIES; i++) enemy_on[i] = 0;
  ship_x[0] = 50; ship_y[0] = two_player ? 110 : 150;
  ship_x[1] = 50; ship_y[1] = 190;
  ship_alive[0] = 1; ship_alive[1] = players;
  ship_inv[0] = ship_inv[1] = 0;
  fire_cd[0] = fire_cd[1] = 0;
  lives = START_LIVES;
  score = 0;
  spawn_timer = 0;
  cam = 0;
  erase_text_bands();           /* NOT paint_field — see its budget note */
  draw_bar_labels();
  draw_bar_stats();
  state = ST_PLAY;
}

static void game_over(void) {
  /* Sprites off FIRST — this runs mid-frame (right after the bottom IRQ),
   * and the beam redraws the screen while we're still writing the text
   * bands below. Killing $D015 before any visible change means the one
   * transition frame never shows sprites parked on top of the message. */
  POKE(VIC_SPR_ENA, 0);
  field_d016 = D016_BAR;        /* freeze the field under the message */
  if (score > hiscore) {
    hiscore = score;
    hiscore_save(hiscore);      /* the persistence seam — see its block doc */
    draw_bar_stats();
  }
  draw_text_band(11, 15, "GAME OVER");
  draw_text_band(13, 13, "FIRE - TITLE");
  sfx_noise(24);
  state = ST_OVER;
}

/* ── GAME LOGIC (clay) — combat ── */
static void fire_bullet(uint8_t p) {
  /* 1P mode: P1 owns both bullet slots. 2P: slot per player. */
  uint8_t i = two_player ? p : 0;
  uint8_t end = two_player ? (uint8_t)(p + 1) : MAX_BULLETS;
  for (; i < end; i++) {
    if (!bullet_on[i]) {
      bullet_on[i] = 1;
      bullet_x[i] = ship_x[p] + 20;
      bullet_y[i] = ship_y[p];
      sfx_tone(2, 0x60, 0x28, 4);   /* pew — voice 2 (music owns 0+1) */
      return;
    }
  }
}

static void spawn_enemy(void) {
  uint8_t i;
  for (i = 0; i < MAX_ENEMIES; i++) {
    if (!enemy_on[i]) {
      enemy_on[i] = 1;
      enemy_x[i] = 348;                                /* just off-screen right */
      enemy_y[i] = (uint8_t)(Y_MIN + (rand8() % (Y_MAX - Y_MIN)));
      return;
    }
  }
}

static uint8_t hits(int16_t ax, uint8_t ay, int16_t bx, uint8_t by) {
  int16_t dx = ax - bx;
  int8_t dy = (int8_t)(ay - by);
  if (dx < 0) dx = -dx;
  if (dy < 0) dy = -dy;
  return (dx < 20) && (dy < 14);
}

static void update_ship(uint8_t p, uint8_t pad) {
  if (!ship_alive[p]) return;
  if (ship_inv[p]) --ship_inv[p];
  if ((pad & JOY_LEFT)  && ship_x[p] > 26)    ship_x[p] -= 2;
  if ((pad & JOY_RIGHT) && ship_x[p] < 300)   ship_x[p] += 2;
  if ((pad & JOY_UP)    && ship_y[p] > Y_MIN) ship_y[p] -= 2;
  if ((pad & JOY_DOWN)  && ship_y[p] < Y_MAX) ship_y[p] += 2;
  if ((pad & JOY_FIRE) && fire_cd[p] == 0) { fire_bullet(p); fire_cd[p] = 10; }
  if (fire_cd[p]) --fire_cd[p];
}

static void copy_sprite_image(uint8_t img, const uint8_t *src) {
  uint8_t i;
  volatile uint8_t *dst = (volatile uint8_t*)SPR_DATA(img);
  for (i = 0; i < 64; i++) dst[i] = src[i];
}

void main(void) {
  uint8_t i, p, pad0, pad1, prev0 = 0, prev1 = 0;

  /* ── HARDWARE IDIOM (load-bearing) — boot order. VIC + SID config before
   * the IRQ goes live; sfx_init BEFORE music_init (sfx_init writes a plain
   * volume to $D418, music_init re-asserts the filter-mode bits on top). ── */
  POKE(VIC_SPR_ENA, 0);
  POKE(VIC_BORDER, COLOR_BLACK);
  POKE(VIC_BG0, COLOR_BLACK);
  POKE(VIC_CTRL2, D016_BAR);              /* 38-col mode from the start */
  copy_sprite_image(IMG_SHIP, ship_sprite);
  copy_sprite_image(IMG_BULLET, bullet_sprite);
  copy_sprite_image(IMG_ENEMY, enemy_sprite);
  SPRITE_POINTERS[SLOT_P1] = SPR_PTR(IMG_SHIP);
  SPRITE_POINTERS[SLOT_P2] = SPR_PTR(IMG_SHIP);
  for (i = 0; i < MAX_BULLETS; i++) SPRITE_POINTERS[SLOT_BULLET0 + i] = SPR_PTR(IMG_BULLET);
  for (i = 0; i < MAX_ENEMIES; i++) SPRITE_POINTERS[SLOT_ENEMY0 + i] = SPR_PTR(IMG_ENEMY);
  POKE(VIC_SPR_COL(SLOT_P1), COLOR_CYAN);
  POKE(VIC_SPR_COL(SLOT_P2), COLOR_YELLOW);
  for (i = 0; i < MAX_BULLETS; i++) POKE(VIC_SPR_COL(SLOT_BULLET0 + i), COLOR_WHITE);
  for (i = 0; i < MAX_ENEMIES; i++) POKE(VIC_SPR_COL(SLOT_ENEMY0 + i), COLOR_LIGHT_RED);
  POKE(CIA1_DDRA, 0xFF);                  /* port A drives keyboard columns */
  POKE(CIA1_DDRB, 0x00);                  /* port B reads rows / stick 1 */

  sfx_init();
  music_init();
  hiscore = hiscore_load();               /* 0 until the core save round lands */

  field_d016 = D016_BAR;
  paint_field();                          /* the ONE full-field paint (boot) */
  install_raster_irq();                   /* the split + heartbeat go live */
  paint_title();

  for (;;) {
    wait_frame();                         /* the line-251 IRQ paces everything */

    /* Scroll bookkeeping FIRST: field_d016 must be settled long before the
     * beam reaches SPLIT_LINE, and the coarse shift needs its head start on
     * the beam (see scroll_field_left). */
    if (state == ST_PLAY) {
      ++cam;
      field_d016 = (uint8_t)(D016_BAR | (7 - (cam & 7)));
      if ((cam & 7) == 0) scroll_field_left();
    }

    music_update();
    sfx_update();
    pad0 = read_stick_port2();            /* P1 — control port 2 (convention) */
    pad1 = read_stick_port1();            /* P2 — control port 1 */

    if (state == ST_TITLE) {
      /* Mode select doubles as a controls demo: the stick that presses
       * FIRE picks the mode — port 2 starts 1P, port 1 starts 2P co-op. */
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

    /* ── ST_PLAY — GAME LOGIC (clay) from here down ─────────────────── */
    update_ship(0, pad0);
    if (two_player) update_ship(1, pad1);
    prev0 = pad0; prev1 = pad1;

    for (i = 0; i < MAX_BULLETS; i++) {
      if (!bullet_on[i]) continue;
      bullet_x[i] += 6;
      if (bullet_x[i] > 344) bullet_on[i] = 0;
    }

    for (i = 0; i < MAX_ENEMIES; i++) {
      uint8_t ty;
      if (!enemy_on[i]) continue;
      enemy_x[i] -= 1 + (score >= 300) + (score >= 800);  /* speed up w/ score */
      /* Seek the (alive) P1's altitude every other frame — pressure that
       * also guarantees collisions actually happen. */
      ty = ship_alive[0] ? ship_y[0] : ship_y[1];
      if (frame_count & 1) {
        if (enemy_y[i] < ty) ++enemy_y[i];
        else if (enemy_y[i] > ty) --enemy_y[i];
      }
      if (enemy_x[i] < 4) enemy_on[i] = 0;                /* slipped past */
    }

    ++spawn_timer;
    if (spawn_timer >= 40) { spawn_timer = 0; spawn_enemy(); }

    /* Bullets ↔ enemies. */
    for (i = 0; i < MAX_BULLETS; i++) {
      uint8_t e;
      if (!bullet_on[i]) continue;
      for (e = 0; e < MAX_ENEMIES; e++) {
        if (!enemy_on[e]) continue;
        if (hits(bullet_x[i], bullet_y[i], enemy_x[e], enemy_y[e])) {
          bullet_on[i] = 0;
          enemy_on[e] = 0;
          score += 10;
          sfx_noise(6);                   /* boom */
          draw_bar_stats();
          break;
        }
      }
    }

    /* Enemies ↔ ships: shared life pool (arcade co-op). */
    for (i = 0; i < MAX_ENEMIES; i++) {
      if (!enemy_on[i]) continue;
      for (p = 0; p < 2; p++) {
        if (!ship_alive[p] || ship_inv[p]) continue;
        if (hits(enemy_x[i], enemy_y[i], ship_x[p], ship_y[p])) {
          enemy_on[i] = 0;
          sfx_noise(16);
          if (lives) --lives;
          draw_bar_stats();
          if (lives == 0) { game_over(); break; }
          ship_x[p] = 50;                 /* knockback respawn + mercy frames */
          ship_inv[p] = 90;
        }
      }
      if (state != ST_PLAY) break;
    }
    if (state != ST_PLAY) continue;

    /* Stage all 8 sprite slots, then commit enable + X-MSB in one go.
     * Invulnerable ships blink by skipping their slot every few frames. */
    stage_begin();
    for (p = 0; p < 2; p++)
      if (ship_alive[p] && !(ship_inv[p] & 4))
        stage_sprite(p ? SLOT_P2 : SLOT_P1, ship_x[p], ship_y[p]);
    for (i = 0; i < MAX_BULLETS; i++)
      if (bullet_on[i]) stage_sprite(SLOT_BULLET0 + i, bullet_x[i], bullet_y[i]);
    for (i = 0; i < MAX_ENEMIES; i++)
      if (enemy_on[i]) stage_sprite(SLOT_ENEMY0 + i, enemy_x[i], enemy_y[i]);
    stage_commit();
  }
}
