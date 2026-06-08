/* ── gb_runtime.c — GBDK-lite helper implementations ───────────────
 * Auto-linked into every GB/GBC build that uses `language:"c"`.
 * See gb_runtime.h for the function list.
 */
#include "gb_hardware.h"
#include "gb_runtime.h"

/* When `enable_vblank_irq()` has been called, wait_vblank uses HALT +
 * the vblank IRQ to sleep until the next vblank — fast on hardware
 * AND on the WASM emulator (where the busy-poll fallback below spins
 * through many WASM-time iterations per emulated LY tick, dropping
 * the game loop to ~1/30 of intended speed — round 26 friction). */
static uint8_t vblank_irq_enabled;

void enable_vblank_irq(void) {
  IF_REG = 0;            /* clear pending interrupts */
  IE_REG = IE_VBLANK;    /* enable VBlank only */
  vblank_irq_enabled = 1;
  __asm__("ei");         /* allow IRQs to be serviced */
}

void wait_vblank(void) {
  /* If the LCD is off, LY is frozen at 0 and we'd hang forever. Bail. */
  if (!(LCDC & LCDC_LCD_ON)) return;
  if (vblank_irq_enabled) {
    /* HALT blocks the CPU until any enabled IRQ fires. With only the
     * vblank IRQ enabled, this is "sleep until vblank, ~10 cycles
     * total per wait." gb_crt0.s vectors $0040 to `reti` which is
     * exactly what we need — no handler body required, just a wake.
     *
     * Round 27 defensive: explicitly NOP after HALT to dodge the
     * famous DMG "HALT bug" — if IME=0 and (IF & IE) != 0 at the
     * moment HALT executes, the CPU skips HALT and duplicates the
     * BYTE that follows. With a NOP in that slot the duplication is
     * harmless. We always run HALT with IME=1 here (enable_vblank_irq
     * leaves IME enabled), so the bug shouldn't fire — but agents
     * have reported "wait_vblank seems involved in long-running
     * corruption" symptoms and this is a 1-byte insurance policy. */
    __asm__("halt");
    __asm__("nop");
    return;
  }
  /* Polling fallback: spin on LY until it crosses into vblank. Fine on
   * real hardware (the CPU is faster than the LCD), DRAMATICALLY slow
   * on the WASM emulator (~1/30 of intended speed). Call
   * `enable_vblank_irq()` once at boot to switch to the HALT path. */
  while (LY >= 144) { }
  while (LY <  144) { }
}

/* Read JOYP into a packed byte. Safe anytime — independent of LCD
 * state, vblank, etc. Returns 1 = pressed, 0 = not (after inverting
 * the hardware's active-low signal).
 *
 * Bit layout (matches the PAD_* masks):
 *   bit 7 Down  bit 6 Up  bit 5 Left  bit 4 Right    ← d-pad HIGH nybble
 *   bit 3 Start bit 2 Sel bit 1 B     bit 0 A        ← buttons LOW nybble
 *
 * Gotcha: d-pad is in the HIGH nybble (opposite of what you might
 * intuit). `pad & PAD_RIGHT` works because PAD_RIGHT = 0x10.
 */
uint8_t joypad_read(void) {
  uint8_t dpad, btns;
  /* Select dpad row (bit 4 = 0). */
  JOYP = 0x20;
  /* Settle: re-read a few times so port wires reach the chip. */
  dpad = JOYP; dpad = JOYP; dpad = JOYP;
  dpad = (uint8_t)((~dpad) & 0x0F);

  /* Select button row (bit 5 = 0). */
  JOYP = 0x10;
  btns = JOYP; btns = JOYP; btns = JOYP;
  btns = (uint8_t)((~btns) & 0x0F);

  /* Deselect both rows. */
  JOYP = 0x30;
  return (uint8_t)((dpad << 4) | btns);
}

/* ── OAM DMA — the HRAM-stub idiom (R55 fix) ────────────────────────
 *
 * The GB OAM DMA engine ($FF46) transfers 160 bytes from `$XX00` (high
 * byte set by the write) to OAM at $FE00-$FE9F. It takes ~160 µs
 * (~640 cycles) and during that window **the CPU can only access
 * HRAM ($FF80-$FFFE) + a couple of I/O registers**. Reads from ROM /
 * WRAM / VRAM during DMA return $FF on real hardware.
 *
 * The "$FF returned for instruction fetch" bug is nasty: $FF decodes
 * as `rst $38`, which CALLs $0038. gb_crt0.s vectors $0038 to a bare
 * `ret`, which pops the stack — but the stack just had the rst's
 * return address pushed, so we return to PC+1. Effectively the CPU
 * skips one byte. Eventually a misaligned fetch lands as the operand
 * of an earlier instruction and you jump into garbage. Common symptom:
 * LCDC silently flips to $FF (the byte the CPU "saw" off of ROM
 * during a DMA window for an unrelated I/O write), BG VRAM at
 * $9800-$9BFF gets a wild burst of zeros, etc. Many emulators (incl.
 * gambatte) don't enforce the DMA-bus-conflict rule strictly which is
 * why the broken pattern "worked" in light testing — but the bug
 * shows up under longer / different code paths (round 27).
 *
 * The canonical fix: install a tiny stub in HRAM that does the DMA
 * register write + spin + return, then CALL the HRAM stub. The stub
 * itself executes from HRAM (allowed during DMA), so the fetch never
 * hits ROM/WRAM. After the spin ends, control returns to wherever
 * called us and normal bus access resumes.
 *
 * HRAM stub (placed at $FF80):
 *   F0 46 / E0 46  ;   ldh ($46), a    — write DMA register (start)
 *   3E 28         ;   ld  a, 40        — spin counter (160 / 4 = 40)
 *   3D            ; - dec a
 *   20 FD         ;   jr  nz, -3       — back to dec a
 *   C9            ;   ret
 * Total: 9 bytes. We install it at boot from `oam_dma_init_hram()`.
 */

#define HRAM_DMA_STUB ((uint8_t *)0xFF80)

/* Install the OAM-DMA HRAM stub. Call once at boot (before any
 * `oam_dma_flush()`). The bundled bootstrap can do this for you;
 * games that bypass the bootstrap should call this themselves. */
void oam_dma_init_hram(void) {
  /* Stub bytes — see comment block above. */
  static const uint8_t stub[] = {
    0xE0, 0x46,             /* ldh ($46), a — start DMA from page in A */
    0x3E, 0x28,             /* ld  a, 40    — spin counter */
    0x3D,                   /* dec a        ─┐ */
    0x20, 0xFD,             /* jr nz, -3    ─┘  spin while a != 0 */
    0xC9,                   /* ret */
  };
  /* Use the pointer-walk memcpy_vram (not an indexed dst[i]=src[i] loop):
   * SDCC sm83 miscompiles the indexed form into a high-pointer like
   * HRAM_DMA_STUB ($FF80). memcpy_vram does *d++=*s++, which is safe. */
  memcpy_vram(HRAM_DMA_STUB, stub, sizeof(stub));
}

/* OAM DMA — copy 160 bytes from `src` to OAM ($FE00-$FE9F) via the
 * HRAM stub installed by oam_dma_init_hram(). Caller passes the source
 * pointer; we extract the high byte (DMA reads source as `src >> 8`)
 * and CALL the HRAM stub. The stub executes from HRAM (the only
 * memory the CPU can fetch from during DMA) so we don't trip the
 * ROM-bus-conflict bug.
 *
 * Should be called during VBlank — DMA writes to OAM and OAM is
 * inaccessible to the PPU during scanline drawing, so a mid-frame
 * DMA flush will flash sprite glitches. */
void oam_dma_copy(void *src) {
  /* Build a function pointer to the HRAM stub. SDCC sm83 calling
   * convention passes the first uint8_t arg in register A — which is
   * what `ldh ($46), a` consumes inside the stub. */
  void (*hram_dma)(uint8_t) = (void (*)(uint8_t))HRAM_DMA_STUB;
  hram_dma((uint8_t)(((uint16_t)src) >> 8));
}

void memcpy_vram(void *dst, const void *src, uint16_t n) {
  /* Safe VRAM access is in modes 0 (HBlank), 1 (VBlank), or with the LCD
   * off. Caller is expected to ensure one of those — usually by calling
   * wait_vblank() first. We just do the byte copy. */
  uint8_t *d = (uint8_t *)dst;
  const uint8_t *s = (const uint8_t *)src;
  while (n) {
    *d++ = *s++;
    n--;
  }
}

void lcd_init_default(void) {
  /* Install the OAM-DMA HRAM stub. Idempotent — installing it more
   * than once just rewrites the same bytes. Doing it here (rather
   * than in crt0) means single-file projects that include this
   * runtime get the fix without having to call it themselves. */
  oam_dma_init_hram();

  /* If the LCD is on, wait for vblank so it's safe to turn it off.
   * If it's already off (typical at boot — DMG/CGB power-up has LCDC=0x91
   * on Nintendo-bootrom paths but LCDC=0 in many homebrew startups), skip
   * the wait — LY is frozen at 0 with the LCD off, so a blind
   * `while (LY < 144)` would hang the whole game. */
  if (LCDC & LCDC_LCD_ON) {
    while (LY < 144) { }
  }
  LCDC = 0;
  BGP  = 0xE4;
  OBP0 = 0xE0;
  OBP1 = 0xE0;
  SCY  = 0;
  SCX  = 0;
  LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO;
}

/* ── OAM helpers ──────────────────────────────────────────────────
 * shadow_oam mirrors hardware OAM ($FE00, 40 sprites × 4 bytes). Build
 * your sprite list here each frame, then call oam_dma_flush() in
 * vblank to push to the LCD.
 *
 * Hardware OAM byte layout per sprite:
 *   +0  Y position (real Y = this - 16; 0 hides, 16 = top of screen)
 *   +1  X position (real X = this - 8;  0 hides, 8  = left of screen)
 *   +2  Tile index
 *   +3  Attributes (palette / flip / priority / CGB palette + VRAM bank)
 *
 * Round 26 footgun fix: shadow_oam MUST be page-aligned. The OAM DMA
 * engine takes ONLY the high byte of the source address — it always
 * copies 160 bytes from `$XX00` to OAM. If shadow_oam happens to land
 * at e.g. $C017, oam_dma_copy(&shadow_oam) latches DMA = $C0 and the
 * hardware DMA's $C000..$C09F (NOT $C017..$C0B6). Result: silent
 * garbage in OAM, sprites never appear where you put them.
 *
 * We pin shadow_oam at $C100 with SDCC's `__at` attribute. WRAM is
 * 8 KB at $C000-$DFFF on DMG, so $C100..$C19F leaves $C000-$C0FF for
 * static initialisers + the first 256 bytes of stack growth, and the
 * gsinit region in gb_crt0.s lives in ROM. No conflict.
 *
 * If your game needs a custom OAM buffer location, declare your own
 * with `__at(0xCXYZ)` where Y in 0..F, ZX = 0, and pass it to
 * oam_dma_copy() directly. Whatever address you pick, the low byte
 * MUST be $00.
 */
__at (0xC100) uint8_t shadow_oam[160];

void oam_clear(void) {
  uint16_t i;
  for (i = 0; i < 160; i++) shadow_oam[i] = 0;
}

void oam_set(uint8_t slot, uint8_t y, uint8_t x, uint8_t tile, uint8_t attr) {
  uint16_t off = (uint16_t)slot << 2;  /* slot * 4 */
  shadow_oam[off + 0] = y;
  shadow_oam[off + 1] = x;
  shadow_oam[off + 2] = tile;
  shadow_oam[off + 3] = attr;
}

void oam_dma_flush(void) {
  oam_dma_copy(shadow_oam);
}

/* ── Sound ──────────────────────────────────────────────────────── */

void sound_init(void) {
  /* APU off → on sequence per nesdev wiki "Sound startup":
   *   NR52 = 0x00 → power off all channels (clears NR10-NR41 to 0)
   *   NR52 = 0x80 → power on
   *   NR50 = 0x77 → max volume both speakers (3 bits per side)
   *   NR51 = 0xFF → all 4 channels routed to both speakers
   */
  NR52 = 0x00;
  NR52 = 0x80;
  NR50 = 0x77;
  NR51 = 0xFF;
}

void sound_play_tone(uint8_t channel, uint16_t freq_period, uint8_t length_frames) {
  /* freq_period is the 11-bit GB frequency code. Lower = higher pitch.
   * Length register (NR11/NR21) sets a 64-step countdown; we map
   * `length_frames` (~4ms each) to that scale: 64 - min(length_frames, 63).
   */
  uint8_t len_code = (length_frames >= 63) ? 0 : (uint8_t)(64 - length_frames);
  uint8_t lo = (uint8_t)(freq_period & 0xFF);
  uint8_t hi = (uint8_t)((freq_period >> 8) & 0x07);
  if (channel == 1) {
    NR10 = 0x00;                       /* no sweep */
    NR11 = (uint8_t)(0x80 | len_code); /* 50% duty + length */
    NR12 = 0xF0;                       /* full volume, no envelope */
    NR13 = lo;
    NR14 = (uint8_t)(0xC0 | hi);       /* trigger + length-enable + hi 3 bits */
  } else {
    NR21 = (uint8_t)(0x80 | len_code);
    NR22 = 0xF0;
    NR23 = lo;
    NR24 = (uint8_t)(0xC0 | hi);
  }
}

void sound_play_noise(uint8_t length_frames) {
  uint8_t len_code = (length_frames >= 63) ? 0 : (uint8_t)(64 - length_frames);
  NR41 = len_code;
  NR42 = 0xF0;          /* full volume, no envelope */
  NR43 = 0x33;          /* mid-pitch noise */
  NR44 = 0xC0;          /* trigger + length-enable */
}

void sound_off(void) {
  NR52 = 0x00;
}
