/* ── sports.c — C64 head-to-head court sports (complete example game) ─────────
 *
 * DELTA DUEL — a COMPLETE, working game (Pong lineage): a title screen with
 * 1P vs a BEATABLE CPU and 2P SIMULTANEOUS VERSUS (both paddles live at once,
 * P1 on CONTROL PORT 2, P2 on CONTROL PORT 1), a first-to-5 match into a
 * result screen, in-session best 1P-vs-CPU win streak behind the gated
 * persistence seam, 2-voice SID music with the C64's signature filter sweep +
 * SFX, and the C64's signature raster-IRQ split: a fixed HUD bar over the
 * court. The two paddles and the ball are VIC-II HARDWARE SPRITES.
 *
 * The game: two paddles guard the left and right edges of a court; a ball
 * rallies between them. UP/DOWN slide your paddle; the ball deflects by where
 * it strikes (centre = flat, edges = steep) plus a ±1 PRNG "spin" so no two
 * rallies repeat — an idle match provably ENDS instead of looping forever.
 * Miss the ball past your edge and your rival scores. First to 5 wins.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented C64 footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — court art, ball physics, CPU skill, scoring rules:
 *     reshape freely.
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
 *   $3F00  sprite images (2 × 64 bytes)    — NOT $0800, which collides with
 *          the .prg load address, and NOT $1000-$1FFF, where the VIC sees
 *          the character ROM instead of RAM (a classic invisible-sprite trap).
 *   Keep the program under ~14 KB so it stays below $3F00.
 *
 * Frame budget (PAL, 50fps): 3 sprites + 2 paddle AABB tests + a couple of
 * HUD digits — a sliver of one frame even on the 1MHz 6510. The court is a
 * STATIC field of chars painted once at match start and never touched during
 * play (only the HUD digits change, and they live in the fixed bar), so the
 * C64's full-repaint famine (a whole-screen 880-cell repaint freezes ~50
 * frames; see the puzzle template's cell-diff note) never comes up here.
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
#define GAME_TITLE "DELTA DUEL"

#define POKE(addr, val) (*(volatile uint8_t*)(addr) = (val))
#define PEEK(addr)      (*(volatile uint8_t*)(addr))

#define SCREEN ((volatile uint8_t*)0x0400)
#define COLORS ((volatile uint8_t*)0xD800)
#define SPRITE_POINTERS ((volatile uint8_t*)0x07F8) /* last 8 bytes of screen RAM */

/* ── GAME LOGIC (clay — reshape freely) — sprite art (24×21, 3 bytes/row) ──
 * Three VIC-II hardware sprites: P1 paddle, P2/CPU paddle, the ball. The
 * court (rails + net + floor) is CHARACTERS in screen RAM, so it costs no
 * sprite slots — leaving the other 5 VIC sprites free for your fork. */
#define SLOT_P1    0
#define SLOT_P2    1
#define SLOT_BALL  2
#define SPR_DATA(img)   (0x3F00 + (img) * 64)
#define SPR_PTR(img)    (uint8_t)(SPR_DATA(img) / 64)   /* $3F00/64 = $FC */
#define IMG_PADDLE 0
#define IMG_BALL   1

/* A vertical bar ~6 px wide, 21 px tall — a paddle. (24×21 sprite; we light
 * the middle columns so a thin paddle reads cleanly at any Y.) */
static const uint8_t paddle_sprite[64] = {
  0x07,0xE0,0x00, 0x07,0xE0,0x00, 0x07,0xE0,0x00, 0x07,0xE0,0x00,
  0x07,0xE0,0x00, 0x07,0xE0,0x00, 0x07,0xE0,0x00, 0x07,0xE0,0x00,
  0x07,0xE0,0x00, 0x07,0xE0,0x00, 0x07,0xE0,0x00, 0x07,0xE0,0x00,
  0x07,0xE0,0x00, 0x07,0xE0,0x00, 0x07,0xE0,0x00, 0x07,0xE0,0x00,
  0x07,0xE0,0x00, 0x07,0xE0,0x00, 0x07,0xE0,0x00, 0x07,0xE0,0x00, 0x07,0xE0,0x00, 0,
};
static const uint8_t ball_sprite[64] = {   /* a small round-ish blob */
  0,0,0, 0,0,0, 0,0,0, 0x03,0xC0,0x00, 0x0F,0xF0,0x00,
  0x1F,0xF8,0x00, 0x1F,0xF8,0x00, 0x1F,0xF8,0x00, 0x1F,0xF8,0x00,
  0x0F,0xF0,0x00, 0x03,0xC0,0x00, 0,0,0, 0,0,0,
  0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,
};

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * THE RASTER-IRQ SPLIT — the C64's classic "fixed status bar over a moving
 * world" trick (and the gateway drug to all raster effects). Here it pins a
 * HUD bar at the top while the court lives below it. The VIC-II has ONE
 * $D016 fine-scroll for the whole frame; we don't scroll the court (a Pong
 * arena holds still), but the split is STILL the idiomatic way to guarantee
 * the HUD's first rows render in a known, fixed scroll state regardless of
 * what the rest of the frame does — and it gives you the per-frame heartbeat
 * the main loop paces on. Two IRQs ping-pong per frame:
 *
 *   line 68 (inside the blank spacer row 2): assert the court's $D016
 *           → everything below the split renders in the court's scroll state
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
  asm("lda #$C0");           /* = D016_BAR — court holds still, same scroll */
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

/* ── HARDWARE IDIOM (load-bearing) — best-streak persistence: DISK SAVE ──────
 * The C64 has no battery SRAM — the honest save medium is the FLOPPY. The game
 * persists by writing a file to drive 8; VICE commits it into the live 1541
 * disk image (true-drive GCR write-back), so a save survives a power cycle
 * exactly as on real hardware. REQUIRES THE GAME RUN FROM A DISK (build/load a
 * .d64); a bare .prg has no mounted disk, so the save is a silent no-op (still
 * honest — the record just stays in-session). Implemented in the load/save
 * functions below; these two are the STABLE SEAM (load at boot, save on a new
 * record) — reshape the record format freely, keep the signatures.
 *
 * Persistence choice (same as every platform's sports template): for a VERSUS
 * game a raw hi-score is meaningless (every match ends 5-x), so we persist the
 * LONGEST 1P-vs-CPU WIN STREAK — the stat a returning player actually chases.
 * 2P matches never touch it (humans beating each other isn't a record). */
/* ── HARDWARE IDIOM (load-bearing) — record persistence: DISK SAVE ─────────
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

/* The table IS the song — edit these to rescore your fork. A driving, bright
 * sporting march to keep a rally tense. */
static const Note melody[] = {
  { N_E4, STEP }, { N_G4, STEP }, { N_C5, STEP*2 }, { N_G4, STEP }, { N_E4, STEP*2 }, { N_G4, STEP },
  { N_A4, STEP }, { N_C5, STEP }, { N_E5, STEP*2 }, { N_C5, STEP }, { N_A4, STEP*2 }, { N_REST, STEP },
  { N_D4, STEP }, { N_F4, STEP }, { N_A4, STEP*2 }, { N_F4, STEP }, { N_D4, STEP*2 }, { N_A4, STEP },
  { N_G4, STEP }, { N_B4, STEP }, { N_D5, STEP*2 }, { N_B4, STEP }, { N_G4, STEP*2 }, { N_REST, STEP },
  { N_C5, STEP }, { N_B4, STEP }, { N_A4, STEP }, { N_G4, STEP }, { N_A4, STEP }, { N_B4, STEP }, { N_C5, STEP*2 },
  { N_E4, STEP }, { N_G4, STEP }, { N_C5, STEP }, { N_E5, STEP }, { N_C5, STEP*2 }, { N_G4, STEP*2 },
};
static const Note bassline[] = {
  /* Octave-pumping bass — the filter sweep chews on this. */
  { N_C3, STEP*3 }, { N_C4, STEP }, { N_C3, STEP*2 }, { N_G3, STEP*2 },
  { N_A3, STEP*3 }, { N_E3, STEP }, { N_A3, STEP*2 }, { N_C4, STEP*2 },
  { N_F3, STEP*3 }, { N_C3, STEP }, { N_F3, STEP*2 }, { N_A3, STEP*2 },
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
 * message text reads cleanly over whatever the court left behind. */
static void draw_text_band(uint8_t row, uint8_t col, const char *s) {
  uint8_t c;
  volatile uint8_t *p = SCREEN + (uint16_t)row * 40;
  for (c = 0; c < 40; c++) p[c] = 0x20;
  draw_text(row, col, s);
}

/* One digit, used for the score readouts (a single 0-9). */
static void draw_digit(uint8_t row, uint8_t col, uint8_t d) {
  uint16_t off = (uint16_t)row * 40 + col;
  SCREEN[off] = (uint8_t)('0' + (d % 10));        /* digit screen code = ASCII */
  COLORS[off] = COLOR_WHITE;
}
static void draw_u16(uint8_t row, uint8_t col, uint16_t v) {
  uint8_t i, dgt[5];
  uint16_t off = (uint16_t)row * 40 + col;
  for (i = 0; i < 5; i++) { dgt[i] = v % 10; v /= 10; }
  for (i = 0; i < 5; i++) {
    SCREEN[off + i] = (uint8_t)('0' + dgt[4 - i]);
    COLORS[off + i] = COLOR_WHITE;
  }
}

/* ── GAME LOGIC (clay) — xorshift16 PRNG (a few instructions) ────────────────
 * A versus game NEEDS this: the C64 is fully deterministic, so without a
 * noise source two fixed strategies lock into an infinite rally loop (the
 * exact same cycle, forever — an idle match would never end). random8() is
 * ticked once per play frame, and a ±1 "spin" rides every deflection, so
 * identical game states a few seconds apart diverge and the rally resolves. */
static uint16_t rng = 0xACE1;
static uint8_t random8(void) {
  uint16_t r = rng;
  r ^= r << 7;
  r ^= r >> 9;
  r ^= r << 8;
  rng = r;
  return (uint8_t)r;
}

/* ── GAME LOGIC (clay — reshape freely) — court geometry + match rules ───────
 * The court window is char rows 3..24 (the raster split fixes rows 0-2 as the
 * HUD bar). Paddles + ball are HARDWARE SPRITES positioned in VIC sprite-pixel
 * coordinates, NOT char cells. VIC visible area starts at sprite X≈24, Y≈50;
 * the 320×200 display spans X 24..343, Y 50..249. We keep the playfield inside
 * a top/bottom margin so the ball stays under the HUD bar. */
#define COURT_TOP   84            /* sprite-Y of the top rail (under the bar) */
#define COURT_BOT  240            /* sprite-Y just below the court floor      */
#define PADDLE_H    21            /* sprite is 21 px tall                     */
#define PADDLE_X1   40            /* P1 paddle X (left)                       */
#define PADDLE_X2  300            /* P2/CPU paddle X (right)                  */
#define BALL_LEFT   48            /* ball past here → P2 scores               */
#define BALL_RIGHT 296            /* ball past here → P1 scores               */
#define BALL_SZ      8            /* ball collision box                       */
#define WIN_SCORE    5            /* first to 5 takes the match               */
#define P_SPEED      2            /* human paddle px/frame                    */
#define CPU_SPEED    1            /* CPU px/frame — half speed: BEATABLE      */

static int16_t p1y, p2y;          /* paddle top Y (sprite px)              */
static int16_t bx, by;            /* ball position (sprite px)             */
static int8_t  bdx, bdy;          /* ball velocity (px/frame)              */
static uint8_t score1, score2;
static uint8_t serve_timer;       /* freeze frames between points          */
static uint8_t two_player;        /* title pick: 0 = vs CPU, 1 = 2P versus */
static uint8_t streak;            /* current 1P-vs-CPU win streak (RAM)    */
static uint16_t best_streak;      /* record — see end_match / the seam     */
static uint8_t new_record;        /* result screen shows NEW RECORD        */

/* Game states — the shell every example shares: title → play → result. */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;
static uint8_t prev0, prev1;      /* edge-triggered FIRE per port          */

/* ── HARDWARE IDIOM (load-bearing) — staging a sprite with the 9th X bit.
 * VIC sprite X is 9 bits: low 8 in $D000+2n, bit 8 for ALL sprites packed
 * into $D010. Forget $D010 and anything past X=255 wraps back to the left
 * edge — the classic "my sprite teleports at two-thirds screen" bug. The
 * right paddle at X=300 lives ENTIRELY past 255, so this is load-bearing
 * here, not optional. We accumulate the MSB bits while staging and commit
 * the byte once. ── */
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
static void stage_actors(void) {
  stage_begin();
  stage_sprite(SLOT_P1, PADDLE_X1, (uint8_t)p1y);
  stage_sprite(SLOT_P2, PADDLE_X2, (uint8_t)p2y);
  stage_sprite(SLOT_BALL, bx, (uint8_t)by);
  stage_commit();
}

/* ── GAME LOGIC (clay) — the HUD bar (rows 0-2, the fixed split) ────────────
 * Scores live on the bar — the ONLY thing that changes during play, and it's
 * one digit each. The court chars below never change mid-match, so play frames
 * touch only 3 sprite positions + (on a point) 1 digit. ── */
static void draw_bar_labels(void) {
  uint8_t c;
  for (c = 0; c < 40; c++) {              /* row 1: solid divider line */
    SCREEN[40 + c] = 0xA0;               /* reverse-space block */
    COLORS[40 + c] = COLOR_DARK_GRAY;
    SCREEN[80 + c] = 0x20;               /* row 2: the blank spacer the
                                          * raster split hides in */
    SCREEN[c] = 0x20;
  }
  draw_text(0, 1, "P1");
  draw_text(0, 31, two_player ? "P2" : "CPU");
}
static void draw_bar_stats(void) {
  draw_digit(0, 4, score1);
  draw_digit(0, 35, score2);
}

/* ── GAME LOGIC (clay) — court field chars (rows 3..24). Painted ONCE per
 * match start (a static screen — free to write directly), never during play.
 * Top + bottom rails frame the court; a dashed net runs down the centre; a
 * faint floor speckle so the arena reads as a court instead of a black void.
 * (Compare the puzzle template's cell-diff: a Pong court doesn't change during
 * play, so it needs NO per-frame repaint machinery at all.) ── */
#define CH_RAIL  0xA0   /* reverse-space solid block = rail */
#define CH_NET   0x5D   /* vertical-bar glyph = centre net */
#define CH_DOT   0x2E   /* '.' faint floor speckle         */
#define CH_BLANK 0x20
#define FIELD_TOP 3
#define NET_COL  19     /* centre column of the 40-col field */

static void paint_court(void) {
  uint8_t r, c;
  for (r = FIELD_TOP; r < 25; r++) {
    volatile uint8_t *srow = SCREEN + (uint16_t)r * 40;
    volatile uint8_t *crow = COLORS + (uint16_t)r * 40;
    for (c = 0; c < 40; c++) {
      uint8_t ch = CH_BLANK, col = COLOR_BLACK;
      if (r == FIELD_TOP || r == 24) { ch = CH_RAIL; col = COLOR_LIGHT_GRAY; }
      else if (c == NET_COL)         { ch = CH_NET;  col = COLOR_DARK_GRAY; }
      else if (((uint8_t)(c + (r << 2)) & 7) == 0) { ch = CH_DOT; col = COLOR_GREEN; }
      srow[c] = ch;
      crow[c] = col;
    }
  }
}

/* Clear the whole 25-row screen to blanks. Static-screen op — cheap once. */
static void clear_screen(void) {
  uint16_t i;
  for (i = 0; i < 1000; i++) { SCREEN[i] = CH_BLANK; COLORS[i] = COLOR_BLACK; }
}

/* ── GAME LOGIC (clay) — the title screen (static, free to repaint) ── */
static void paint_title(void) {
  clear_screen();
  two_player = 0;
  draw_bar_labels();
  draw_bar_stats();
  draw_text_band(8, (40 - (sizeof(GAME_TITLE) - 1)) / 2, GAME_TITLE);
  draw_text_band(12, 11, "PORT 2 FIRE - 1P VS CPU");
  draw_text_band(14, 11, "PORT 1 FIRE - 2P VERSUS");
  draw_text_band(16, 12, "UP DOWN - MOVE PADDLE");
  draw_text_band(18, 13, "FIRST TO 5 WINS");
  draw_text_band(21, 11, "BEST STREAK");
  draw_u16(21, 23, best_streak);
  POKE(VIC_SPR_ENA, 0);            /* no sprites on the title */
  state = ST_TITLE;
}

/* ── GAME LOGIC (clay) — serve: ball to centre, toward the chosen side ──
 * bx centre = 172 (midway between BALL_LEFT 48 and BALL_RIGHT 296). The serve
 * angle alternates so successive serves don't trace the same path. */
static void serve_ball(uint8_t to_left) {
  bx = 172;
  by = 160;
  bdx = to_left ? -2 : 2;
  bdy = ((score1 + score2) & 1) ? -1 : 1;
  serve_timer = 30;                            /* ~half-second breather */
}

/* ── GAME LOGIC (clay) — start a match ── */
static void start_match(uint8_t players) {
  two_player = players;
  p1y = 150; p2y = 150;
  score1 = 0; score2 = 0;
  new_record = 0;
  /* Stir the PRNG with time-spent-on-title so runs differ. */
  rng ^= (uint16_t)frame_count ^ ((uint16_t)frame_count << 7);
  if (rng == 0) rng = 0xACE1;
  clear_screen();
  draw_bar_labels();
  draw_bar_stats();
  paint_court();
  serve_ball(0);
  state = ST_PLAY;
  prev0 = prev1 = 0x1F;            /* swallow the FIRE that started the match */
  sfx_tone(2, 0x00, 0x20, 10);     /* start jingle */
}

/* ── GAME LOGIC (clay) — match over: result + record bookkeeping.
 * For a VERSUS sports game a raw hi-score is meaningless (every match ends
 * 5-x), so we persist the longest 1P-vs-CPU win streak — the stat a returning
 * player actually chases. 2P matches never touch it. ── */
static void end_match(void) {
  uint8_t p1_won = (score1 >= WIN_SCORE);
  clear_screen();
  draw_bar_labels();
  draw_bar_stats();
  if (two_player) {
    draw_text_band(8, 16, p1_won ? "P1 WINS" : "P2 WINS");
  } else if (p1_won) {
    draw_text_band(8, 16, "YOU WIN");
    ++streak;
    if (streak > best_streak) {
      best_streak = streak;
      new_record = 1;
      hiscore_save(best_streak);   /* the persistence seam — see its block doc */
    }
  } else {
    draw_text_band(8, 16, "CPU WINS");
    streak = 0;                    /* the streak dies with the loss */
  }
  draw_text_band(11, 13, "P1");
  draw_digit(11, 17, score1);
  draw_text_band(13, 13, two_player ? "P2" : "CPU");
  draw_digit(13, 18, score2);
  draw_text_band(16, 11, "BEST STREAK");
  draw_u16(16, 23, best_streak);
  if (new_record) draw_text_band(18, 15, "NEW RECORD");
  draw_text_band(21, 13, "FIRE - TITLE");
  POKE(VIC_SPR_ENA, 0);            /* sprites off on the result screen */
  sfx_noise(24);                   /* end-of-match whistle */
  state = ST_OVER;
  prev0 = prev1 = 0x1F;            /* swallow the held FIRE */
}

/* ── GAME LOGIC (clay) — one point scored ── */
static void score_point(uint8_t for_p1) {
  if (for_p1) ++score1; else ++score2;
  sfx_noise(6);
  draw_bar_stats();
  if (score1 >= WIN_SCORE || score2 >= WIN_SCORE) end_match();
  else serve_ball(for_p1);         /* loser of the point serves toward winner */
}

/* ── GAME LOGIC (clay) — paddle hit: deflect by where the ball struck.
 * Centre = flat-ish, edges = steep. Max |bdy| is 2 — the CPU moves at 1,
 * so an edge hit is exactly how a human beats it. A ±1 random "spin" on
 * every return keeps rallies from repeating (see the PRNG note above). ── */
static void deflect(int16_t paddle_y) {
  int16_t rel = (by + BALL_SZ / 2) - (paddle_y + PADDLE_H / 2);
  bdy = (int8_t)(rel >> 4);
  bdy += (int8_t)((random8() & 2) - 1);        /* spin: -1 or +1 */
  if (bdy > 2) bdy = 2;
  if (bdy < -2) bdy = -2;
  if (bdy == 0) bdy = (rel < 0) ? -1 : 1;      /* never return a flat ball */
  sfx_tone(2, 0x00, 0x30, 4);                  /* paddle ping */
}

/* ── GAME LOGIC (clay) — one player's paddle from a stick read ── */
static void move_paddle(int16_t *py, uint8_t pad) {
  if ((pad & JOY_UP)   && *py > COURT_TOP)             *py -= P_SPEED;
  if ((pad & JOY_DOWN) && *py < COURT_BOT - PADDLE_H)  *py += P_SPEED;
}

void main(void) {
  uint8_t pad0, pad1;
  uint8_t i;

  /* ── HARDWARE IDIOM (load-bearing) — boot order. VIC + SID config before
   * the IRQ goes live; sfx_init BEFORE music_init (sfx_init writes a plain
   * volume to $D418, music_init re-asserts the filter-mode bits on top). ── */
  POKE(VIC_SPR_ENA, 0);                    /* sprites off until staged */
  POKE(VIC_BORDER, COLOR_BLUE);            /* a coloured border keeps the
                                            * screen visibly alive (no single
                                            * colour dominates the pixel scan) */
  POKE(VIC_BG0, COLOR_BLACK);
  POKE(VIC_CTRL2, D016_BAR);               /* 38-col mode from the start */
  POKE(CIA1_DDRA, 0xFF);                   /* port A drives keyboard columns */
  POKE(CIA1_DDRB, 0x00);                   /* port B reads rows / stick 1 */

  /* Upload the two sprite images and point all three slots at them. */
  {
    volatile uint8_t *pd = (volatile uint8_t*)SPR_DATA(IMG_PADDLE);
    volatile uint8_t *bd = (volatile uint8_t*)SPR_DATA(IMG_BALL);
    for (i = 0; i < 64; i++) { pd[i] = paddle_sprite[i]; bd[i] = ball_sprite[i]; }
  }
  SPRITE_POINTERS[SLOT_P1]   = SPR_PTR(IMG_PADDLE);
  SPRITE_POINTERS[SLOT_P2]   = SPR_PTR(IMG_PADDLE);
  SPRITE_POINTERS[SLOT_BALL] = SPR_PTR(IMG_BALL);
  POKE(VIC_SPR_COL(SLOT_P1),   COLOR_CYAN);
  POKE(VIC_SPR_COL(SLOT_P2),   COLOR_LIGHT_RED);
  POKE(VIC_SPR_COL(SLOT_BALL), COLOR_YELLOW);

  sfx_init();
  music_init();
  best_streak = hiscore_load();            /* 0 until the core save round lands */
  streak = 0;

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
       * picks the mode — port 2 starts 1P vs CPU, port 1 starts 2P versus. */
      if ((pad0 & JOY_FIRE) && !(prev0 & JOY_FIRE)) start_match(0);
      else if ((pad1 & JOY_FIRE) && !(prev1 & JOY_FIRE)) start_match(1);
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
     * Both paddles update EVERY frame: P1 from port 2, and either P2 from
     * port 1 (2P) or the CPU (1P). Simultaneous versus, never alternating. */
    random8();                             /* tick the noise source per frame */
    move_paddle(&p1y, pad0);

    if (two_player) {
      move_paddle(&p2y, pad1);             /* P2 — control port 1 */
    } else {
      /* CPU — chases the ball centre at half player speed with a dead zone.
       * Beatable by design: a steep edge-deflection outruns it. */
      int16_t target = by + BALL_SZ / 2 - PADDLE_H / 2;
      if (p2y + 2 < target && p2y < COURT_BOT - PADDLE_H) p2y += CPU_SPEED;
      else if (p2y > target + 2 && p2y > COURT_TOP)       p2y -= CPU_SPEED;
    }
    prev0 = pad0; prev1 = pad1;

    /* Ball update (frozen during the post-point serve pause). */
    if (serve_timer > 0) { --serve_timer; stage_actors(); continue; }
    bx += bdx;
    by += bdy;

    /* Rail bounce (top/bottom of the court). */
    if (by < COURT_TOP)             { by = COURT_TOP;             bdy = -bdy; sfx_tone(2, 0x00, 0x20, 3); }
    if (by + BALL_SZ > COURT_BOT)   { by = COURT_BOT - BALL_SZ;   bdy = -bdy; sfx_tone(2, 0x00, 0x20, 3); }

    /* Paddle collisions (direction-gated so the ball can't double-hit). */
    if (bdx < 0
        && bx <= PADDLE_X1 + 8 && bx + BALL_SZ >= PADDLE_X1
        && by + BALL_SZ > p1y && by < p1y + PADDLE_H) {
      bdx = -bdx;
      bx = PADDLE_X1 + 8;
      deflect(p1y);
    }
    if (bdx > 0
        && bx + BALL_SZ >= PADDLE_X2 && bx <= PADDLE_X2 + 8
        && by + BALL_SZ > p2y && by < p2y + PADDLE_H) {
      bdx = -bdx;
      bx = PADDLE_X2 - BALL_SZ;
      deflect(p2y);
    }

    /* Off either side → point. (score_point may end the match.) */
    if (bx < BALL_LEFT)  { score_point(0); if (state != ST_PLAY) continue; }
    if (bx > BALL_RIGHT) { score_point(1); if (state != ST_PLAY) continue; }

    stage_actors();                        /* commit the 3 sprite positions */
  }
}
