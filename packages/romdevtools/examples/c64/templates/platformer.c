/* ── platformer.c — C64 side-scrolling platformer (complete example game) ─────
 *
 * TALUS TROT — a COMPLETE, working game: title screen, 1P mode and 2P
 * ALTERNATING-TURNS mode (arcade-classic: players swap on death; each player
 * has their own score and own 3 lives; player 2 plays on CONTROL PORT 1),
 * gravity/jump physics, one-way platforms, pits + spikes, coins + distance
 * scoring, in-session hi-score behind the gated-persistence seam, 2-voice SID
 * music with the C64's signature filter sweep + SFX, and the C64's signature
 * raster-IRQ split: a fixed score bar over a HARDWARE-scrolled level.
 *
 * THIS FILE IS MEANT TO BE FORKED AND MODIFIED into your own game — even a
 * very different one. The markers tell you what's what:
 *   HARDWARE IDIOM (load-bearing) — dodges a documented C64 footgun; reshape
 *     your gameplay around it (see TROUBLESHOOTING before changing).
 *   GAME LOGIC (clay) — level layout, physics tuning, scoring, art: reshape
 *     freely.
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
 * THE SCROLL — C64 horizontal scrolling is the fiddliest of all 14 platforms,
 * and this game does it for real. The VIC-II fine-scrolls only 0-7 px in
 * hardware ($D016 low 3 bits); past that you COARSE-scroll in software by
 * shifting the visible char columns and rendering one fresh column at the
 * edge from a world map. Both halves run here — see scroll_field and the
 * raster split. (C64 MENTAL_MODEL.md → "Horizontal scrolling".)
 */

#include "c64_registers.h"
#include "c64_sfx.h"
#include <stdint.h>

/* The title screen renders this — examples({op:'fork'}) stamps your game's
 * name here automatically. Keep it ≤16 chars of A-Z 0-9 space dash. */
#define GAME_TITLE "TALUS TROT"

#define POKE(addr, val) (*(volatile uint8_t*)(addr) = (val))
#define PEEK(addr)      (*(volatile uint8_t*)(addr))

#define SCREEN ((volatile uint8_t*)0x0400)
#define COLORS ((volatile uint8_t*)0xD800)
#define SPRITE_POINTERS ((volatile uint8_t*)0x07F8) /* last 8 bytes of screen RAM */

/* ── Screen layout (the raster split divides bar from scrolling level) ──────
 *   char row 0  — score bar text: SC / HI / LV / P# / mode    (FIXED)
 *   char row 1  — solid divider line                          (FIXED)
 *   char row 2  — blank spacer: the split lands mid-row HERE, where a few
 *                 raster lines of IRQ jitter are invisible (uniform color)
 *   char rows 3-24 — the scrolling level (ground, platforms, pits, sky)
 * PAL raster geometry: with YSCROLL=3 (the power-on default) text row r
 * occupies raster lines 51+8r .. 58+8r. So the spacer row 2 = lines 67-74,
 * and the playfield's first row 3 starts at line 75. */
#define FIELD_TOP    3
#define SPLIT_LINE   68   /* inside spacer row 2 (67-74): jitter-proof */
#define BOTTOM_LINE  251  /* first line below the 25-row text window (ends 250) */
/* $D016 values for the two halves of the frame. Bit 3 CLEAR = 38-column mode
 * (masks the garbage column fine-X scrolling exposes at the edges — keep all
 * bar text inside columns 1-38). Low 3 bits = fine X scroll 0-7. */
#define D016_BAR     0xC0          /* fine X = 0, 38 cols — the fixed bar */

/* ── GAME LOGIC (clay — reshape freely) — sprite art (24×21, 3 bytes/row) ──
 * Two VIC-II hardware sprites are used: the active player and one coin. The
 * world's ground/platforms/spikes are CHARACTERS in screen RAM (the scroll
 * shifts them), so they cost no sprite slots. */
#define SLOT_PLAYER  0
#define SLOT_COIN    1
#define SPR_DATA(img)   (0x3F00 + (img) * 64)
#define SPR_PTR(img)    (uint8_t)(SPR_DATA(img) / 64)   /* $3F00/64 = $FC */
#define IMG_PLAYER 0
#define IMG_COIN   1

static const uint8_t player_sprite[64] = {  /* a little hopping critter */
  0x00,0x00,0x00, 0x07,0xE0,0x00, 0x0F,0xF0,0x00, 0x1C,0x38,0x00,
  0x1B,0xD8,0x00, 0x1F,0xF8,0x00, 0x1F,0xF8,0x00, 0x0F,0xF0,0x00,
  0x07,0xE0,0x00, 0x07,0xE0,0x00, 0x0F,0xF0,0x00, 0x1E,0x78,0x00,
  0x3C,0x3C,0x00, 0x38,0x1C,0x00, 0x30,0x0C,0x00, 0x70,0x0E,0x00,
  0x60,0x06,0x00, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,
};
static const uint8_t coin_sprite[64] = {    /* a small spinning disc */
  0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0,
  0x03,0xC0,0x00, 0x0F,0xF0,0x00, 0x1E,0x78,0x00, 0x1C,0x38,0x00,
  0x1C,0x38,0x00, 0x1E,0x78,0x00, 0x0F,0xF0,0x00, 0x03,0xC0,0x00,
  0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,0,0, 0,
};

/* ── HARDWARE IDIOM (load-bearing — reshape gameplay around this; see TROUBLESHOOTING) ──
 * THE RASTER-IRQ SPLIT — the C64's classic "fixed status bar over a moving
 * world" trick (and the gateway drug to all raster effects). The VIC-II has
 * ONE $D016 fine-scroll for the whole frame; to scroll the level while the
 * score bar stays put, you change $D016 MID-FRAME, at an exact raster line,
 * from an interrupt. Two IRQs ping-pong per frame:
 *
 *   line 68 (inside the blank spacer row): $D016 = level fine-scroll
 *           → everything drawn below this line fine-scrolls
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
 * frame_count/field_d016 file-scope NON-static (asm %v needs the symbol). */
volatile uint8_t frame_count;  /* bumped by the bottom IRQ — frame heartbeat */
volatile uint8_t field_d016;   /* level $D016 value, precomputed by main */

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
  asm("sta $d016");          /* level fine-X from here down                 */
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

/* ── HARDWARE IDIOM (load-bearing) — hi-score persistence seam ──────────────
 * HONEST NO-OPS, deliberately. The current VICE core build exposes no
 * SAVE_RAM region and no 1541 disk write-back, so NOTHING a .prg writes can
 * survive a power cycle yet (a planned core round adds the save path; see
 * the C64 MENTAL_MODEL "Disk images" section for where it will land).
 * These two functions are the STABLE SEAM: the game already calls them in
 * the right places — load at boot, save on a new record. When the core
 * round ships, implement them (d64 file write or cartridge RAM) WITHOUT
 * touching any caller. Until then the hi-score lives for the session only,
 * and this comment is the honest reason why. */
static uint16_t hiscore_load(void) { return 0; }
static void hiscore_save(uint16_t v) { (void)v; }

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

/* The table IS the song — edit these to rescore your fork. A bouncy major run. */
static const Note melody[] = {
  { N_C4, STEP }, { N_E4, STEP }, { N_G4, STEP*2 }, { N_E4, STEP }, { N_C5, STEP*2 }, { N_G4, STEP },
  { N_F4, STEP }, { N_A4, STEP }, { N_C5, STEP*2 }, { N_A4, STEP }, { N_F4, STEP*2 }, { N_REST, STEP },
  { N_G4, STEP }, { N_B4, STEP }, { N_D5, STEP*2 }, { N_B4, STEP }, { N_G4, STEP*2 }, { N_D5, STEP },
  { N_E5, STEP }, { N_C5, STEP }, { N_G4, STEP }, { N_E4, STEP }, { N_C4, STEP*2 }, { N_REST, STEP },
  { N_C5, STEP }, { N_B4, STEP }, { N_A4, STEP }, { N_G4, STEP }, { N_A4, STEP }, { N_B4, STEP }, { N_C5, STEP*2 },
  { N_F4, STEP }, { N_G4, STEP }, { N_A4, STEP }, { N_F4, STEP }, { N_C5, STEP*2 }, { N_A4, STEP*2 },
};
static const Note bassline[] = {
  /* Octave-pumping bass — the filter sweep chews on this. */
  { N_C3, STEP*3 }, { N_C4, STEP }, { N_C3, STEP*2 }, { N_G3, STEP*2 },
  { N_F3, STEP*3 }, { N_C3, STEP }, { N_F3, STEP*2 }, { N_A3, STEP*2 },
  { N_G3, STEP*3 }, { N_D3, STEP }, { N_G3, STEP*2 }, { N_B3, STEP*2 },
  { N_C3, STEP*3 }, { N_E3, STEP }, { N_G3, STEP*2 }, { N_C4, STEP*2 },
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
static uint8_t rng_state = 0xB7;
static uint8_t rand8(void) {
  uint8_t lsb = (uint8_t)(rng_state & 1);
  rng_state >>= 1;
  if (lsb) rng_state ^= 0xB8;
  return rng_state;
}

/* ── GAME LOGIC (clay) — THE LEVEL ──────────────────────────────────────────
 * A LOOPING column map, MAP_COLS wide. Each visible screen column shows world
 * column (coarse + screen_col) mod MAP_COLS, so the camera runs forever and
 * the level wraps seamlessly. Per column:
 *   ground_row[c] — char row of the ground's surface, NO_GROUND = a pit
 *   plat_row[c]   — char row of a one-way floating platform, 0 = none
 *   spike[c]      — 1 = a lethal spike stands on this column's ground
 * Char rows are screen rows; playfield rows are FIELD_TOP..24, world y = row*8.
 * The bottom of the 25-row window is row 24 (ground sits at row 21). */
#define MAP_COLS  64          /* 64-cell loop = 512 px of distinct level */
#define NO_GROUND 0xFF
#define GROUND_ROW 21         /* the resting ground surface row */
static const uint8_t ground_row[MAP_COLS] = {
  21,21,21,21,21,21,21,21,                  /* start runway (player @ col 8) */
  21,21,21,21,21,21,21,21,                  /* ...generous lead-in runway   */
  21,21,21,21,21,21,21,21,                  /* ...still runway (death-free)  */
  21,21,21,21,NO_GROUND,NO_GROUND,21,21,     /* pit 1 (2 cols, jumpable)     */
  21,21,18,18,18,18,21,21,                  /* a raised mesa to hop onto    */
  21,21,21,NO_GROUND,NO_GROUND,21,21,21,     /* pit 2 (2 cols)               */
  21,21,21,21,21,21,21,21,                  /* runway                       */
  21,21,NO_GROUND,NO_GROUND,21,21,21,21,     /* pit 3 before the loop seam   */
};
static const uint8_t plat_row[MAP_COLS] = {
  0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,
  0,0,0,0,16,16,16,0,                       /* slab to grab some air        */
  0,0,0,0,0,0,0,0,
  0,0,0,15,15,15,0,0,                       /* mid slab over the mesa        */
  0,0,0,0,0,0,0,0,
  0,0,13,13,13,0,0,0,                       /* high slab                    */
  0,0,0,0,0,0,0,0,
};
static uint8_t spike[MAP_COLS];   /* generated at boot (see init_spikes) */

/* Char codes + colors for level cells (drawn into one column at a time). */
#define CH_SOLID  0xA0    /* reverse-space solid block */
#define CH_SPIKE  0x1E    /* up-arrow glyph = a spike */
#define CH_STAR   0x2E    /* '.' distant detail in the sky */
#define CH_BLANK  0x20

static void init_spikes(void) {
  uint8_t c;
  for (c = 0; c < MAP_COLS; c++) spike[c] = 0;
  /* A few fixed spikes in the LATER half (cols ≥ 32), each with a clear
   * approach so a hop clears it; never on the lead-in runway, never on a pit
   * column, never adjacent to a pit edge (you'd need a frame-perfect double
   * input). Hand-placed (not random) so every run is fair and reproducible. */
  spike[34] = 1;   /* on the raised mesa run-up   */
  spike[48] = 1;   /* flat stretch after pit 2    */
  spike[56] = 1;   /* final flat before pit 3     */
}

/* ── HARDWARE IDIOM (load-bearing) — the TWO-LAYER scroll trick (straight from
 * the shmup): screen RAM holds the MOVING level chars; COLOR RAM holds a
 * STATIC per-row texture that NEVER scrolls. The coarse shift then touches
 * ONLY screen RAM (half the byte-moves), and chars drifting left pick up each
 * cell's resident color for free. This is THE thing that keeps the scroll
 * fast: shifting BOTH screen AND color RAM every 8 px (≈3400 byte-moves of
 * cc65 C) costs ~6-7 frames per coarse step — the loop visibly crawls while
 * you hold a direction (measured: 8 iterations / 60 frames). Screen-only is
 * ~1700 moves and stays real-time. The level's geometry (ground at one row,
 * platforms on a few fixed rows) makes a row-based color texture read fine. */
static const uint8_t row_color[25] = {
  /* rows 0-2 are the bar (drawn separately); 3..24 are the level */
  0,0,0,
  COLOR_BLUE, COLOR_BLUE, COLOR_LIGHT_BLUE, COLOR_BLUE,        /* high sky   */
  COLOR_LIGHT_GRAY, COLOR_BLUE, COLOR_LIGHT_BLUE, COLOR_BLUE,  /* slab band  */
  COLOR_BLUE, COLOR_LIGHT_GRAY, COLOR_LIGHT_BLUE, COLOR_BLUE,  /* slab band  */
  COLOR_BLUE, COLOR_LIGHT_GRAY, COLOR_BLUE, COLOR_LIGHT_BLUE,  /* mesa band  */
  COLOR_BLUE, COLOR_GREEN,                                     /* row 21 grass */
  COLOR_BROWN, COLOR_ORANGE, COLOR_BROWN,                      /* earth      */
};

/* Paint the STATIC color texture for the whole level window — ONCE, at boot. */
static void paint_colors(void) {
  uint8_t r, c;
  for (r = FIELD_TOP; r < 25; r++) {
    volatile uint8_t *crow = COLORS + (uint16_t)r * 40;
    for (c = 0; c < 40; c++) crow[c] = row_color[r];
  }
}

/* Render ONE level column's CHARS into screen RAM at screen column `sc`, for
 * world column `wc`. The COARSE scroll calls this once per 8 px (for the
 * freshly exposed right edge), NOT per cell of the whole screen — a full
 * 40×22 repaint of cc65 C is ~50 frames (a frozen second). Keep it lean. */
static void draw_column(uint8_t sc, uint8_t wc) {
  uint8_t r, g, pr;
  uint8_t *s = (uint8_t*)(0x0400 + FIELD_TOP * 40) + sc;   /* plain RAM (see scroll_field) */
  g = ground_row[wc];
  pr = plat_row[wc];
  for (r = FIELD_TOP; r < 25; r++) {
    uint8_t ch = CH_BLANK;
    if (pr && r == pr) ch = CH_SOLID;                              /* platform */
    else if (r == GROUND_ROW && spike[wc] && g != NO_GROUND) ch = CH_SPIKE;
    else if (g != NO_GROUND && r >= g) ch = CH_SOLID;              /* ground   */
    else if (((uint8_t)(wc + (r << 2)) & 15) == 0) ch = CH_STAR;   /* sky star */
    *s = ch;
    s += 40;
  }
}

/* Repaint the WHOLE visible level window's CHARS from the world map at camera
 * column `coarse`. Runs ONCE per level start (not per frame). */
static void paint_level(uint8_t coarse) {
  uint8_t sc;
  for (sc = 0; sc < 40; sc++)
    draw_column(sc, (uint8_t)(coarse + sc) % MAP_COLS);
}

/* COARSE scroll: shift the 40 visible level columns one char LEFT in SCREEN
 * RAM (color RAM is static — see paint_colors), then render the freshly
 * exposed rightmost column from the world map. Runs only on the frame the
 * fine offset wraps (every 8 px). SCHEDULING IS THE TRICK: called right after
 * wait_frame() (i.e. just after the line-251 IRQ). The beam won't draw
 * playfield row 3 until line 75 of the NEXT frame (~8500 cycles away) and then
 * takes 504 cycles/row; this loop spends ~600 cycles/row, so with that head
 * start it stays ahead of the beam — no tearing, no double buffer. (The
 * grown-up alternative is page-flipping screen RAM via $D018.) */
static void scroll_field(uint8_t new_right_wc) {
  uint8_t r, c;
  /* NON-volatile pointer on purpose: screen RAM is plain memory (not MMIO),
   * so cc65 is free to keep the running pointer in zero page and emit a tight
   * indexed copy. Marking it volatile (as the per-cell game writes do, for
   * mid-frame correctness) would force a reload per access and roughly DOUBLE
   * this loop's cost — and this loop is the scroll's whole frame budget. */
  uint8_t *srow = (uint8_t*)(0x0400 + FIELD_TOP * 40);
  for (r = FIELD_TOP; r < 25; r++) {
    for (c = 0; c < 39; c++) srow[c] = srow[c + 1];
    srow += 40;
  }
  draw_column(39, new_right_wc);
}

/* ── GAME LOGIC (clay) — game state ── */
#define ST_TITLE 0
#define ST_PLAY  1
#define ST_OVER  2
static uint8_t state;
static uint8_t two_player;
static uint8_t cur_player;             /* 0 = P1, 1 = P2 (alternating turns) */
static uint8_t p_lives[2];
static uint16_t p_score[2], hiscore;

/* ── Physics + camera (Q4.4 sub-pixel Y, like the NES platformer) ──
 * The player sits at a FIXED screen X (SCROLL_WALL): pressing RIGHT advances
 * the camera through the world, not the sprite — the classic one-way runner
 * camera. World position is the camera; the player's world column is
 * coarse + player_col. */
#define GRAVITY_Q44   3      /* +3/16 px per frame per frame                */
#define JUMP_VEL_Q44 (-46)   /* launch vy (Q4.4) → a satisfying hop          */
#define MAX_VY_Q44    72      /* terminal velocity ~4.5 px/frame — keep under *
                              * 6 so the 6-px landing window can't tunnel    */
#define MOVE_SPEED    1       /* camera advance px/frame — 1 px keeps the    *
                              * coarse shift to once / 8 frames (like the   *
                              * shmup), so the loop stays real-time; the     *
                              * fine scroll makes 1 px/frame look smooth     */
#define PLAYER_COL    8       /* the player's fixed screen column (0..39)    */
/* Sprite Y origin: VIC visible Y starts at 50; char row r top = raster 51+8r,
 * sprite at $D001=y appears at raster y. Player sprite is ~16 px; we park its
 * feet (y+16) on a char-row top. Char row r's top in sprite-Y units = 51+8r,
 * but $D001 counts from raster 0, and our window top (row 0) is at $D001≈50.
 * Empirically: a sprite at $D001 = 51 + 8*r - 16 stands on row r's surface. */
#define SPR_Y_FOR_ROW(r)  (uint8_t)(51 + 8 * (r) - 16)
#define PLAYER_X_PX  ((PLAYER_COL * 8) + 24)   /* fixed screen X in sprite px */

static uint16_t cam_px;        /* camera position in world px (one-way) */
static uint16_t py_q44;        /* player Y, Q4.4 fixed point */
static int8_t   vy_q44;
static uint8_t  on_ground;
static uint16_t dist_sub;      /* sub-counter: 64 px scrolled = +1 point */
static uint8_t  turn_pause;    /* freeze frames after a turn change */
static uint8_t  prev0, prev1;  /* edge-detect held buttons across turns */

/* World column under the player's feet (his fixed screen column + camera). */
static uint8_t player_world_col(void) {
  return (uint8_t)(((cam_px >> 3) + PLAYER_COL) % MAP_COLS);
}

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
    SCREEN[40 + c] = CH_SOLID;
    COLORS[40 + c] = COLOR_DARK_GRAY;
    SCREEN[80 + c] = CH_BLANK;            /* row 2: the blank spacer the
                                           * raster split hides in */
    SCREEN[c] = CH_BLANK;
  }
  draw_text(0, 1, "SC");
  draw_text(0, 11, "HI");
  draw_text(0, 21, "LV");
  draw_text(0, 26, "P");
  draw_text(0, 30, two_player ? "2P" : "1P");
}
static void draw_bar_stats(void) {
  draw_u16(0, 4, p_score[cur_player]);
  draw_u16(0, 14, hiscore);
  SCREEN[24] = (uint8_t)('0' + p_lives[cur_player]);   /* LV <n>  */
  COLORS[24] = COLOR_WHITE;
  SCREEN[28] = (uint8_t)('1' + cur_player);             /* P <n>   */
  COLORS[28] = COLOR_WHITE;
}

/* ── GAME LOGIC (clay) — coins (a single VIC sprite drifting with the world) ──
 * The active coin is anchored to a world column; it drifts left with the
 * scroll and respawns ahead at the right when collected or passed. */
#define SCREEN_RIGHT_PX 320
static uint16_t coin_wpx;       /* coin world X in px */
static uint8_t  coin_row;       /* coin char row */
static void respawn_coin(void) {
  coin_wpx = cam_px + (uint16_t)(SCREEN_RIGHT_PX) + (uint16_t)(rand8() & 63);
  coin_row = 13 + (rand8() % 6);   /* float at a reachable height */
}

/* ── GAME LOGIC (clay) — title / start / game over ──────────────────────────
 * Transition rule (see paint_level's note): never repaint the whole field on
 * a fire press. The title draws its text ON TOP of the parked level; start
 * repaints the level once (cheap enough at a state change, not per frame). */
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
  draw_text_band(13, 9, "PORT 1 FIRE - 2P TURNS");
  draw_text_band(17, 16, "HI");
  draw_u16(17, 19, hiscore);
  field_d016 = D016_BAR;        /* title field holds still (text lives in it) */
  POKE(VIC_SPR_ENA, 0);
  state = ST_TITLE;
}

/* Start one player's RUN (used both at game start and on each turn handoff). */
static void begin_turn(void) {
  cam_px = 0;
  py_q44 = (uint16_t)SPR_Y_FOR_ROW(GROUND_ROW) << 4;
  vy_q44 = 0;
  on_ground = 1;
  dist_sub = 0;
  turn_pause = 40;              /* "P# ready" breather */
  prev0 = prev1 = 0x1F;         /* swallow held buttons across the turn */
  respawn_coin();
  field_d016 = D016_BAR;
  paint_level(0);              /* repaint the level once for this run */
  draw_bar_labels();
  draw_bar_stats();
}

static void start_game(uint8_t players) {
  two_player = players;
  cur_player = 0;
  p_score[0] = p_score[1] = 0;
  p_lives[0] = 3;
  p_lives[1] = players ? 3 : 0;
  begin_turn();
  sfx_tone(2, 0x40, 0x20, 6);   /* start chirp */
  state = ST_PLAY;
}

static void game_over(void) {
  uint16_t best = p_score[0];
  POKE(VIC_SPR_ENA, 0);         /* sprites off before the message paints */
  field_d016 = D016_BAR;
  if (two_player && p_score[1] > best) best = p_score[1];
  if (best > hiscore) {
    hiscore = best;
    hiscore_save(hiscore);      /* the persistence seam — see its block doc */
  }
  draw_text_band(11, 15, "GAME OVER");
  draw_text_band(13, 13, "FIRE - TITLE");
  draw_bar_stats();
  sfx_noise(24);
  state = ST_OVER;
}

/* ── GAME LOGIC (clay) — death + alternating-turn handoff (arcade-classic) ── */
static void kill_player(void) {
  uint8_t other;
  sfx_noise(16);
  if (p_lives[cur_player]) --p_lives[cur_player];
  if (two_player) {
    other = (uint8_t)(cur_player ^ 1);
    if (p_lives[other]) cur_player = other;            /* swap turns         */
    else if (p_lives[cur_player] == 0) { game_over(); return; }
  } else if (p_lives[0] == 0) { game_over(); return; }
  begin_turn();
}

/* ── GAME LOGIC (clay) — landing probe against the column map ──────────────
 * One-way platforms, classic style: only catch the player while FALLING
 * through a narrow window at a surface. feet = sprite Y + 16 (sprite bottom).
 * A surface at char row r has its top at SPR_Y_FOR_ROW(r)+16 in feet units. */
static uint8_t surface_for_row(uint8_t r) { return (uint8_t)(SPR_Y_FOR_ROW(r) + 16); }
static uint8_t land_top(uint8_t feet) {
  uint8_t wc = player_world_col();
  uint8_t r, top;
  r = plat_row[wc];
  if (r) {
    top = surface_for_row(r);
    if ((uint8_t)(feet + 1) >= top && feet <= (uint8_t)(top + 5)) return top;
  }
  r = ground_row[wc];
  if (r != NO_GROUND) {
    top = surface_for_row(r);
    if ((uint8_t)(feet + 1) >= top && feet <= (uint8_t)(top + 5)) return top;
  }
  return 0;
}

static void copy_sprite_image(uint8_t img, const uint8_t *src) {
  uint8_t i;
  volatile uint8_t *dst = (volatile uint8_t*)SPR_DATA(img);
  for (i = 0; i < 64; i++) dst[i] = src[i];
}

void main(void) {
  uint8_t pad0, pad1, pad, fine_prev = 0;
  uint8_t feet, y8, top;

  /* ── HARDWARE IDIOM (load-bearing) — boot order. VIC + SID config before
   * the IRQ goes live; sfx_init BEFORE music_init (sfx_init writes a plain
   * volume to $D418, music_init re-asserts the filter-mode bits on top). ── */
  POKE(VIC_SPR_ENA, 0);
  POKE(VIC_BORDER, COLOR_BLACK);
  POKE(VIC_BG0, COLOR_BLACK);
  POKE(VIC_CTRL2, D016_BAR);              /* 38-col mode from the start */
  copy_sprite_image(IMG_PLAYER, player_sprite);
  copy_sprite_image(IMG_COIN, coin_sprite);
  SPRITE_POINTERS[SLOT_PLAYER] = SPR_PTR(IMG_PLAYER);
  SPRITE_POINTERS[SLOT_COIN]   = SPR_PTR(IMG_COIN);
  POKE(VIC_SPR_COL(SLOT_PLAYER), COLOR_YELLOW);
  POKE(VIC_SPR_COL(SLOT_COIN),   COLOR_CYAN);
  POKE(CIA1_DDRA, 0xFF);                  /* port A drives keyboard columns */
  POKE(CIA1_DDRB, 0x00);                  /* port B reads rows / stick 1 */

  init_spikes();
  sfx_init();
  music_init();
  hiscore = hiscore_load();               /* 0 until the core save round lands */

  field_d016 = D016_BAR;
  paint_colors();                         /* STATIC color texture — once, ever */
  paint_level(0);                         /* the ONE full-field char paint (boot) */
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
       * picks the mode — port 2 starts 1P, port 1 starts 2P alternating. */
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
     * The current player's controller drives the run (P2 on control port 1).
     * Set field_d016 EARLY — it must be settled long before the beam reaches
     * SPLIT_LINE — and run the coarse shift right after the heartbeat. */
    pad = cur_player ? pad1 : pad0;

    if (turn_pause) {                     /* "P# ready" breather */
      --turn_pause;
      /* Do NOT refresh prev0/prev1 here: begin_turn seeded them with FIRE
       * held (0x1F), so the start/respawn FIRE press that's still down is
       * swallowed — the player won't auto-jump the instant control returns.
       * A fresh release+press after the breather makes the first real jump. */
      stage_begin();
      stage_sprite(SLOT_PLAYER, PLAYER_X_PX, (uint8_t)(py_q44 >> 4));
      stage_commit();
      continue;
    }

    /* Horizontal: RIGHT advances the one-way camera; LEFT nudges it back a
     * little (but never past 0 distance covered for the run). */
    if (pad & JOY_RIGHT) {
      cam_px += MOVE_SPEED;
      dist_sub += MOVE_SPEED;
      if (dist_sub >= 64) { dist_sub -= 64; ++p_score[cur_player]; draw_bar_stats(); }
    }
    if ((pad & JOY_LEFT) && cam_px >= MOVE_SPEED) cam_px -= MOVE_SPEED;

    /* FINE + COARSE scroll. field_d016 low 3 bits = 7-fine (content moves
     * LEFT as the camera advances). When the fine offset wraps past a char
     * boundary, COARSE-shift the field and expose a fresh world column. */
    {
      uint8_t fine = (uint8_t)(cam_px & 7);
      field_d016 = (uint8_t)(D016_BAR | (7 - fine));
      if (fine != fine_prev && fine == 0)
        scroll_field((uint8_t)(((cam_px >> 3) + 39) % MAP_COLS));
      fine_prev = fine;
    }

    /* Jump (only when grounded). FIRE = jump. */
    if ((pad & JOY_FIRE) && !((cur_player ? prev1 : prev0) & JOY_FIRE) && on_ground) {
      vy_q44 = JUMP_VEL_Q44;
      on_ground = 0;
      sfx_tone(2, 0x60, 0x30, 4);         /* jump chirp — voice 2 */
    }
    prev0 = pad0; prev1 = pad1;

    /* Gravity + sub-pixel Y. */
    if (vy_q44 < MAX_VY_Q44) vy_q44 += GRAVITY_Q44;
    py_q44 += vy_q44;
    y8 = (uint8_t)(py_q44 >> 4);

    /* Fell below the window → into a pit → lose the turn. */
    if (y8 >= 224 || (py_q44 >> 4) >= 224) { kill_player(); continue; }

    /* Landing — probe the column under the player's feet (falling only). */
    if (vy_q44 >= 0) {
      feet = (uint8_t)(y8 + 16);
      top = land_top(feet);
      if (top) {
        py_q44 = (uint16_t)(uint8_t)(top - 16) << 4;
        vy_q44 = 0;
        if (!on_ground) sfx_tone(2, 0xA0, 0x10, 2);  /* landing tick */
        on_ground = 1;
      } else {
        on_ground = 0;                    /* walked off an edge */
      }
    }

    /* Spike under the feet (only while on the ground over a spike column). */
    if (on_ground && spike[player_world_col()] &&
        ground_row[player_world_col()] != NO_GROUND) {
      kill_player();
      continue;
    }

    /* Coin: drifts left with the world; collect on overlap, else respawn
     * once it scrolls off the left edge. */
    {
      int16_t coin_sx = (int16_t)((int32_t)coin_wpx - (int32_t)cam_px);  /* screen px */
      uint8_t coin_y = SPR_Y_FOR_ROW(coin_row);
      uint8_t py8 = (uint8_t)(py_q44 >> 4);
      /* collect: player's fixed column vs the coin's screen column + Y near */
      if (coin_sx > -8 && coin_sx < 328) {
        int16_t dx = coin_sx - (PLAYER_COL * 8);
        int16_t dy = (int16_t)coin_y - (int16_t)py8;
        if (dx < 0) dx = -dx;
        if (dy < 0) dy = -dy;
        if (dx < 14 && dy < 14) {
          p_score[cur_player] += 10;
          sfx_tone(2, 0xC0, 0x20, 4);     /* coin ping */
          draw_bar_stats();
          respawn_coin();
        }
      } else if (coin_sx <= -8) {
        respawn_coin();
      }
    }

    /* Stage the player + coin sprites, then commit enable + X-MSB once. */
    stage_begin();
    stage_sprite(SLOT_PLAYER, PLAYER_X_PX, (uint8_t)(py_q44 >> 4));
    {
      int16_t coin_sx = (int16_t)((int32_t)coin_wpx - (int32_t)cam_px) + 24;
      if (coin_sx > 0 && coin_sx < 344)
        stage_sprite(SLOT_COIN, coin_sx, SPR_Y_FOR_ROW(coin_row));
    }
    stage_commit();
  }
}
