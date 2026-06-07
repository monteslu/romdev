/* ── nes_runtime.c — runtime impl auto-linked into NES C builds ──
 *
 * See nes_runtime.h for the API. The crt0 (chr-ram.crt0.s) wires in
 * the NMI handler that calls vram_queue_flush + commits scroll_x /
 * scroll_y / ppuctrl_value. Shadow OAM lives at $0200 (defined in the
 * crt0's OAM segment, exported as _shadow_oam).
 */

#include "nes_runtime.h"

/* ── PPU register addresses — define here rather than depend on cc65's
 * nes.h, since the chr-ram preset's reduced lib set doesn't pull it. */
#define PPUCTRL   (*(volatile uint8_t *)0x2000)
#define PPUMASK   (*(volatile uint8_t *)0x2001)
#define PPUSTATUS (*(volatile uint8_t *)0x2002)
#define OAMADDR   (*(volatile uint8_t *)0x2003)
#define OAMDATA   (*(volatile uint8_t *)0x2004)
#define PPUSCROLL (*(volatile uint8_t *)0x2005)
#define PPUADDR   (*(volatile uint8_t *)0x2006)
#define PPUDATA   (*(volatile uint8_t *)0x2007)
#define OAMDMA    (*(volatile uint8_t *)0x4014)
#define APUSTATUS (*(volatile uint8_t *)0x4015)
#define JOY1      (*(volatile uint8_t *)0x4016)
#define JOY2      (*(volatile uint8_t *)0x4017)
/* JOY2 doubles as APU frame counter when written. */
#define APUFRAMECTR (*(volatile uint8_t *)0x4017)

/* APU pulse 1 ($4000-$4003) */
#define PULSE1_VOL   (*(volatile uint8_t *)0x4000)
#define PULSE1_SWEEP (*(volatile uint8_t *)0x4001)
#define PULSE1_LO    (*(volatile uint8_t *)0x4002)
#define PULSE1_HI    (*(volatile uint8_t *)0x4003)
/* APU pulse 2 ($4004-$4007) */
#define PULSE2_VOL   (*(volatile uint8_t *)0x4004)
#define PULSE2_SWEEP (*(volatile uint8_t *)0x4005)
#define PULSE2_LO    (*(volatile uint8_t *)0x4006)
#define PULSE2_HI    (*(volatile uint8_t *)0x4007)
/* APU triangle ($4008-$400B) */
#define TRI_LINEAR   (*(volatile uint8_t *)0x4008)
#define TRI_LO       (*(volatile uint8_t *)0x400A)
#define TRI_HI       (*(volatile uint8_t *)0x400B)
/* APU noise ($400C-$400F) */
#define NOISE_VOL    (*(volatile uint8_t *)0x400C)
#define NOISE_LO     (*(volatile uint8_t *)0x400E)
#define NOISE_HI     (*(volatile uint8_t *)0x400F)

/* ── State the crt0's NMI reads (exported globals) ───────────────── */
uint8_t scroll_x = 0;
uint8_t scroll_y = 0;
/* Default PPUCTRL: NMI on (bit 7), sprite pattern $0000, BG pattern $1000,
 * VRAM-increment 1, base nametable $2000. Game can override via ppu_*. */
uint8_t ppuctrl_value = 0x90;
volatile uint8_t nmi_counter = 0;

/* OAM bookkeeping. shadow_oam itself is declared in chr-ram.crt0.s
 * (so OAM segment placement at $0200 is linker-enforced). oam_index
 * tracks the next free slot for oam_spr(). */
static uint8_t oam_index = 0;
static void oam_hide_unused(void);  /* fwd decl — used by ppu_wait_nmi (NES-1) */

/* ── VRAM write queue ─────────────────────────────────────────────
 * Each entry is { hi, lo, byte }. NMI walks the queue, writes
 * PPUADDR(hi); PPUADDR(lo); PPUDATA(byte) for each, then clears the
 * length. Length is capped at QUEUE_MAX entries; if game code overflows
 * it, we busy-wait for an NMI to flush and continue. */
#define QUEUE_MAX 24
static struct {
  uint8_t addr_hi;
  uint8_t addr_lo;
  uint8_t value;
} vram_queue[QUEUE_MAX];
static uint8_t vram_queue_len = 0;

/* Called from the NMI handler in chr-ram.crt0.s. PPU is unlocked
 * (we're in vblank), so writes to $2006/$2007 are safe. */
void __fastcall__ vram_queue_flush(void) {
  uint8_t i;
  if (vram_queue_len == 0) return;
  /* Reset the address latch by reading $2002 — even though the NMI
   * trampoline already did this when it ran the scroll-reset
   * sequence, that came AFTER we ran. Cheap insurance. */
  (void)PPUSTATUS;
  for (i = 0; i < vram_queue_len; i++) {
    PPUADDR = vram_queue[i].addr_hi;
    PPUADDR = vram_queue[i].addr_lo;
    PPUDATA = vram_queue[i].value;
  }
  vram_queue_len = 0;
}

/* Queue one byte. If full, wait for NMI to drain then enqueue. */
static void vram_queue_push(uint16_t ppu_addr, uint8_t v) {
  while (vram_queue_len >= QUEUE_MAX) {
    ppu_wait_nmi();
  }
  vram_queue[vram_queue_len].addr_hi = (uint8_t)(ppu_addr >> 8);
  vram_queue[vram_queue_len].addr_lo = (uint8_t)(ppu_addr & 0xFF);
  vram_queue[vram_queue_len].value = v;
  ++vram_queue_len;
}

/* ── PPU control ──────────────────────────────────────────────── */

void ppu_off(void) {
  PPUMASK = 0;
  PPUCTRL = ppuctrl_value & 0x7F;   /* disable NMI too */
  ppuctrl_value &= 0x7F;
}

void ppu_on_all(void) {
  ppuctrl_value |= 0x80;            /* NMI enable */
  PPUMASK = 0x1E;                   /* show BG + sprites + leftmost cols */
  PPUCTRL = ppuctrl_value;
}

void ppu_on_bg(void) {
  ppuctrl_value |= 0x80;
  PPUMASK = 0x0A;                   /* show BG + leftmost BG col */
  PPUCTRL = ppuctrl_value;
}

void ppu_on_spr(void) {
  ppuctrl_value |= 0x80;
  PPUMASK = 0x14;                   /* show sprites + leftmost sprite col */
  PPUCTRL = ppuctrl_value;
}

void ppu_wait_vblank(void) {
  /* Setup-time wait — polls $2002 directly. Safe when NMI is disabled. */
  while ((PPUSTATUS & 0x80) == 0) { /* spin */ }
}

void ppu_wait_nmi(void) {
  uint8_t target;
  /* Hide last frame's now-unused sprite slots BEFORE waiting, so the buffer
   * the NMI's OAM-DMA copies is fully staged (live slots written by oam_spr,
   * stale slots parked off-screen) — never a half-cleared buffer (NES-1). */
  oam_hide_unused();
  target = (uint8_t)(nmi_counter + 1);
  while (nmi_counter != target) { /* spin */ }
}

uint8_t ppu_system(void) {
  /* Cheap heuristic: count vblanks per CPU loop. Punt for v1 — return
   * NTSC. Real PAL detection is a frame-rate measurement we don't
   * need until anyone asks for PAL builds. */
  return 0;
}

/* ── Palettes ─────────────────────────────────────────────────── */

void palette_load(const uint8_t *pal32) {
  uint8_t i;
  /* Caller must call this with PPU off (so it's a direct write).
   * If we wanted to support runtime palette swaps we'd need a
   * dedicated palette queue, but for v1 the init-only contract is
   * documented in the header. */
  (void)PPUSTATUS;
  PPUADDR = 0x3F;
  PPUADDR = 0x00;
  for (i = 0; i < 32; i++) {
    PPUDATA = pal32[i];
  }
}

/* ── OAM ──────────────────────────────────────────────────────── */

/* High-water mark: the largest oam_index reached last frame. Lets us blank
 * ONLY the slots a frame stopped using, instead of the whole 256-byte buffer
 * every frame. */
static uint8_t oam_high = 0;

void oam_clear(void) {
  /* NES-1 FIX: do NOT blank the whole shadow buffer here. The old full clear
   * wrote slot 0's Y=$FF FIRST and took ~hundreds of cycles; if the NMI's
   * OAM-DMA fired mid-clear it copied a HALF-CLEARED buffer → the live sprite
   * vanished every other frame (the classic "sprite flickers to black"
   * sprite-light scaffold bug). Instead we just reset the staging index here;
   * ppu_wait_nmi() hides the slots this frame stopped using, so the DMA only
   * ever sees a fully-staged buffer. */
  oam_index = 0;
}

/* Hide slots [oam_index .. oam_high] (the ones used last frame but not this
 * frame) by parking their Y off-screen. Called from ppu_wait_nmi AFTER the
 * game has staged its live sprites, so live slots are never blanked. */
static void oam_hide_unused(void) {
  uint16_t i;
  for (i = oam_index; i < (uint16_t)oam_high + 4 && i < 256; i += 4) {
    shadow_oam[i] = 0xFF;             /* Y off-screen */
  }
  oam_high = oam_index;
}

void oam_spr(uint8_t x, uint8_t y, uint8_t tile, uint8_t attr) {
  /* OAM byte order: Y, tile, attr, X. Y - 1 for the off-by-one PPU
   * convention so the caller can pass "screen Y" and have it land
   * where they expect. */
  shadow_oam[oam_index + 0] = (uint8_t)(y - 1);
  shadow_oam[oam_index + 1] = tile;
  shadow_oam[oam_index + 2] = attr;
  shadow_oam[oam_index + 3] = x;
  oam_index += 4;
  /* Wraps at 256 back to 0 — game code calling oam_spr more than 64
   * times will overwrite earlier slots. That's fine; hardware caps
   * at 64 anyway. */
}

/* ── Input ────────────────────────────────────────────────────── */

uint8_t pad_poll(uint8_t which) {
  uint8_t i, bit;
  uint8_t out = 0;
  /* Strobe — write 1 then 0 to $4016. */
  JOY1 = 1;
  JOY1 = 0;
  if (which == 0) {
    for (i = 0; i < 8; i++) {
      bit = JOY1 & 0x01;
      out = (uint8_t)((out << 1) | bit);
    }
  } else {
    for (i = 0; i < 8; i++) {
      bit = JOY2 & 0x01;
      out = (uint8_t)((out << 1) | bit);
    }
  }
  return out;
}

/* ── CHR-RAM upload ────────────────────────────────────────────── */

void chr_ram_upload(uint16_t ppu_addr, const uint8_t *src, uint16_t n) {
  /* Caller must call with PPU off. Writes are sequential — PPUADDR
   * auto-increments by 1 per write (since PPUCTRL bit 2 = 0). */
  uint16_t i;
  (void)PPUSTATUS;
  PPUADDR = (uint8_t)(ppu_addr >> 8);
  PPUADDR = (uint8_t)(ppu_addr & 0xFF);
  for (i = 0; i < n; i++) {
    PPUDATA = src[i];
  }
}

/* ── Direct VRAM write (init-only) ────────────────────────────── */

void vram_unsafe_set(uint16_t ppu_addr, uint8_t b) {
  (void)PPUSTATUS;
  PPUADDR = (uint8_t)(ppu_addr >> 8);
  PPUADDR = (uint8_t)(ppu_addr & 0xFF);
  PPUDATA = b;
}

/* ── Queued VRAM writes (safe during rendering) ────────────────── */

void vram_set(uint16_t ppu_addr, uint8_t v) {
  vram_queue_push(ppu_addr, v);
}

/* Compute nametable cell address. Nametables are 32 tiles wide × 30
 * tall; nt 0 = $2000, 1 = $2400, 2 = $2800, 3 = $2C00. */
void tile_set(uint8_t nt, uint8_t x, uint8_t y, uint8_t tile) {
  uint16_t base = 0x2000 + ((uint16_t)(nt & 3) << 10);
  uint16_t off  = (uint16_t)((uint16_t)y * 32 + x);
  vram_queue_push((uint16_t)(base + off), tile);
}

/* Attribute table is one byte per 4×4 tile group, at nametable + $3C0.
 * Each byte holds 4 quadrants of 2 bits each: top-left bits 0-1,
 * top-right 2-3, bottom-left 4-5, bottom-right 6-7.
 *
 * NES homebrew typically batches a whole row of attributes at once via
 * a hand-rolled RMW. For a single tile change in C we have to read the
 * current byte, mask the right 2 bits, and re-write. Since the queue
 * is fire-and-forget (we can't read back from VRAM), we maintain a
 * shadow attribute table in WRAM that's kept in sync.
 *
 * Memory cost: 4 nametables × 64 bytes = 256 bytes of WRAM.
 */
static uint8_t shadow_attr[4][64];

void tile_set_palette(uint8_t nt, uint8_t x, uint8_t y, uint8_t palette) {
  uint8_t nt_idx = (uint8_t)(nt & 3);
  uint8_t row = (uint8_t)(y >> 2);
  uint8_t col = (uint8_t)(x >> 2);
  uint8_t attr_idx = (uint8_t)(row * 8 + col);
  uint8_t shift = (uint8_t)(((y & 2) << 1) | (x & 2));  /* 0, 2, 4, or 6 */
  uint8_t mask = (uint8_t)(0x03 << shift);
  uint8_t b = shadow_attr[nt_idx][attr_idx];
  uint16_t addr;
  b = (uint8_t)((b & ~mask) | ((palette & 0x03) << shift));
  shadow_attr[nt_idx][attr_idx] = b;
  addr = (uint16_t)(0x23C0 + ((uint16_t)nt_idx << 10) + attr_idx);
  vram_queue_push(addr, b);
}

/* ── Scroll ───────────────────────────────────────────────────── */

void ppu_scroll(uint16_t x, uint16_t y) {
  /* PPUCTRL bits 0-1 select the base nametable. Bit 0 = X >= 256,
   * bit 1 = Y >= 240. The low 8 bits of X/Y go straight into
   * PPUSCROLL. */
  uint8_t nt = (uint8_t)((ppuctrl_value & 0xFC));
  if (x & 0x100) nt |= 0x01;
  if (y & 0x100) nt |= 0x02;
  ppuctrl_value = nt;
  scroll_x = (uint8_t)(x & 0xFF);
  scroll_y = (uint8_t)(y & 0xFF);
  /* Take effect at next NMI — the crt0 NMI writes scroll_x, scroll_y,
   * and ppuctrl_value to PPUSCROLL/PPUCTRL. */
}

/* ── Sound ──────────────────────────────────────────────────────
 * The NES APU has 5 channels: 2 pulse, 1 triangle, 1 noise, 1 DMC.
 * sound_init() enables the first four. DMC stays off (it needs a
 * sample, which most homebrew doesn't want to deal with).
 */

/* APU length-counter table. The 5-bit value written to the length
 * counter latch (high nybble of $4003/$4007/$400B/$400F) indexes into
 * this table to set how many frames the channel plays. Pulled from
 * nesdev wiki "APU Length Counter". */
static const uint8_t length_table[32] = {
  10, 254, 20,  2, 40,  4, 80,  6, 160,  8, 60, 10, 14, 12, 26, 14,
  12,  16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30,
};

void sound_init(void) {
  APUSTATUS = 0x0F;        /* enable pulse1 + pulse2 + triangle + noise */
  APUFRAMECTR = 0x40;      /* 4-step frame counter, disable frame IRQ */
}

void sound_play_tone(uint8_t channel, uint16_t period, uint8_t vol_4bit, uint8_t length_frames) {
  uint8_t len5 = length_frames & 0x1F;
  uint8_t v = vol_4bit & 0x0F;
  uint8_t lo = (uint8_t)(period & 0xFF);
  uint8_t hi_period = (uint8_t)((period >> 8) & 0x07);
  /* high byte format: bits 7-3 = length-counter latch, bits 2-0 = timer hi */
  uint8_t hi = (uint8_t)((len5 << 3) | hi_period);

  if (channel == 0) {
    PULSE1_VOL   = (uint8_t)(0xB0 | v);   /* duty 10 (50%), const vol, vol=v */
    PULSE1_SWEEP = 0x08;                  /* sweep disabled */
    PULSE1_LO    = lo;
    PULSE1_HI    = hi;
  } else if (channel == 1) {
    PULSE2_VOL   = (uint8_t)(0xB0 | v);
    PULSE2_SWEEP = 0x08;
    PULSE2_LO    = lo;
    PULSE2_HI    = hi;
  } else {
    /* triangle — no volume control, no envelope */
    TRI_LINEAR   = 0xFF;                  /* linear counter max */
    TRI_LO       = lo;
    TRI_HI       = hi;
  }
}

void sound_play_noise(uint8_t period_4bit, uint8_t vol_4bit, uint8_t length_frames) {
  uint8_t len5 = length_frames & 0x1F;
  NOISE_VOL = (uint8_t)(0x30 | (vol_4bit & 0x0F));  /* const vol */
  NOISE_LO  = (uint8_t)(period_4bit & 0x0F);
  NOISE_HI  = (uint8_t)(len5 << 3);
  (void)length_table;  /* documentation; not used directly */
}

void sound_off(void) {
  APUSTATUS = 0x00;
}
