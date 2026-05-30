/* ── gb_runtime.h — GBDK-lite helpers (auto-included on gb/gbc C builds) ──
 * Function declarations only; implementations are in gb_runtime.c which
 * the build wires in automatically. Pair with gb_hardware.h for the I/O
 * register names.
 *
 * Functions:
 *   void     wait_vblank(void);
 *       Busy-wait until the next vblank starts. SAFE WHEN LCD IS OFF —
 *       returns immediately rather than hanging (LY is frozen at 0 with
 *       LCD off; a blind LY-wait would never exit).
 *
 *   uint8_t  joypad_read(void);
 *       Read JOYP into a packed byte. SAFE ANYTIME.
 *
 *   void     oam_dma_copy(void *src);
 *       DMA-copy 160 bytes from `src` to OAM ($FE00). Caller should
 *       have built the 40-sprite shadow buffer in WRAM/HRAM first. Best
 *       called during vblank; works outside vblank too but the sprite
 *       table will glitch for one frame.
 *
 *   void     memcpy_vram(void *dst, const void *src, uint16_t n);
 *       memcpy with no special timing. Caller is responsible for
 *       picking a VRAM-safe window (vblank, hblank, or LCD off).
 *
 *   void     lcd_init_default(void);
 *       DMG defaults: BGP=$E4, OBP0/1=$E0, SCY/SCX=0, then turn LCD on
 *       with BG + OBJ enabled. SAFE TO CALL WHEN LCD IS OFF — checks
 *       LCDC.7 first instead of blindly waiting for vblank.
 *
 *   void     oam_clear(void);
 *       Zero the 160-byte `shadow_oam` array. Call once at boot to make
 *       sure all 40 slots are off-screen.
 *
 *   void     oam_set(uint8_t slot, uint8_t y, uint8_t x, uint8_t tile, uint8_t attr);
 *       Write one slot of the shadow OAM. `slot` is 0..39. `y` and `x`
 *       are screen coords + 16 / + 8 respectively (the hardware quirk:
 *       Y=0 hides the sprite, Y=16 is the top edge of the screen;
 *       X=0 hides, X=8 is the left edge). `oam_dma_flush` to push to HW.
 *
 *   void     oam_dma_flush(void);
 *       DMA `shadow_oam` → real OAM ($FE00). Call once per frame in
 *       vblank, AFTER you've staged sprites with `oam_set`.
 *
 * Globals:
 *   extern uint8_t shadow_oam[160];
 *       40 sprites × 4 bytes (Y, X, tile, attr). Cleared by oam_clear,
 *       populated by oam_set, copied to hardware by oam_dma_flush.
 *
 * Joypad packed-byte layout (1 = pressed, after inverting hw active-low):
 *   bit 7 Down  bit 6 Up  bit 5 Left  bit 4 Right    ← d-pad HIGH nybble
 *   bit 3 Start bit 2 Sel bit 1 B     bit 0 A        ← buttons LOW nybble
 */
#ifndef GB_RUNTIME_H
#define GB_RUNTIME_H

#include <stdint.h>

void    wait_vblank(void);

/* Switch wait_vblank() from busy-poll-LY to HALT-driven (interrupt
 * wake). Strongly recommended — busy-poll wait_vblank runs at ~1/30
 * intended speed on the WASM emulator because LY only updates at
 * stepFrames quantum boundaries. Call once at boot after lcd_init_*.
 * Safe to call before lcd_init_default (the HALT path checks LCDC
 * before sleeping).
 *
 * Once enabled, wait_vblank() sleeps the CPU until the vblank IRQ
 * fires (~10 cycles per wait instead of thousands of LY-polls). The
 * IRQ handler in gb_crt0.s is just `reti` — its job is to wake the
 * CPU, not to do any work.
 *
 * Implementation: writes IE_REG = IE_VBLANK + clears IF_REG + executes
 * EI. After that, every wait_vblank() compiles to a HALT instead of
 * the LY-polling busy loop. */
void    enable_vblank_irq(void);

uint8_t joypad_read(void);
void    oam_dma_copy(void *src);
void    memcpy_vram(void *dst, const void *src, uint16_t n);
void    lcd_init_default(void);

/* Install the OAM-DMA HRAM stub at $FF80. Call ONCE at boot before
 * any `oam_dma_flush()` / `oam_dma_copy()`. `lcd_init_default()` calls
 * it for you; only call directly if you're bypassing lcd_init_default.
 *
 * Why this is mandatory (R55 fix): during OAM DMA the CPU can only
 * fetch from HRAM. Pre-r55 oam_dma_copy spun in main code, fetching
 * $FF (the bus-conflict default) for every instruction — that decodes
 * as `rst $38` which corrupts the stack. Symptom under long-running
 * code: LCDC flips to $FF, BG tile map wiped to zeros, sprites jump.
 * The HRAM stub fixes it by running the spin from HRAM where DMA
 * doesn't conflict. */
void    oam_dma_init_hram(void);

void    oam_clear(void);
void    oam_set(uint8_t slot, uint8_t y, uint8_t x, uint8_t tile, uint8_t attr);
void    oam_dma_flush(void);

/* shadow_oam is page-aligned at $C100 because OAM DMA uses only the
 * high byte of the source address and always copies 160 bytes from
 * `$XX00`. The `__at` annotation MUST appear on BOTH the extern AND
 * the definition (in gb_runtime.c) — without it SDCC raises "extern
 * definition mismatches". Round 26 footgun fix; see gb_runtime.c. */
extern __at (0xC100) uint8_t shadow_oam[160];

/* ── Sound (Game Boy 4-channel APU) ────────────────────────────── */
/*
 * sound_init()
 *     Power on the APU (NR52 bit 7), set master volume to max,
 *     route both speakers. Call once at boot. Safe anytime.
 *
 * sound_play_tone(channel, freq_period, length_frames)
 *     Trigger a square-wave note on channel 1 (sweep ch) or 2.
 *     `freq_period` is the 11-bit GB frequency code: lower = higher
 *     pitch. Common notes:
 *       A4 = 1750   C5 = 1798   G5 = 1953   C6 = 1923
 *       (formula: 2048 - (131072 / Hz))
 *     `length_frames` ≈ N×4ms playback duration before envelope cuts off.
 *     Channels are { 1 = sweep square, 2 = plain square }.
 *
 * sound_play_noise(length_frames)
 *     Trigger a short noise burst on channel 4 — useful for hit/explosion
 *     SFX. Length in frame-equivalents.
 *
 * sound_off()
 *     Power down the APU (NR52 = 0). All 4 channels go silent.
 *
 * These helpers are fire-and-forget — the APU plays autonomously
 * after one trigger. No per-frame upkeep needed.
 */
void    sound_init(void);
void    sound_play_tone(uint8_t channel, uint16_t freq_period, uint8_t length_frames);
void    sound_play_noise(uint8_t length_frames);
void    sound_off(void);

#define PAD_DOWN    0x80
#define PAD_UP      0x40
#define PAD_LEFT    0x20
#define PAD_RIGHT   0x10
#define PAD_START   0x08
#define PAD_SELECT  0x04
#define PAD_B       0x02
#define PAD_A       0x01

#endif /* GB_RUNTIME_H */
