/* ── nes_runtime.h — neslib-shaped runtime for cc65 NES builds ───
 * Auto-included on every `buildSource({platform:"nes", language:"c"})`.
 *
 * API mirrors Shiru's neslib so existing tutorials port cleanly:
 *
 *   PPU control
 *     ppu_off()            — disable rendering. Safe anytime.
 *     ppu_on_all()         — enable BG + sprites. Use after init.
 *     ppu_on_bg()          — enable BG only.
 *     ppu_on_spr()         — enable sprites only.
 *     ppu_wait_vblank()    — poll $2002 for vblank flag. Use during INIT,
 *                            before rendering is enabled. Do not call in
 *                            the game loop — use ppu_wait_nmi instead.
 *     ppu_wait_nmi()       — wait until the next NMI fires (vblank-driven).
 *                            Returns within ~1 frame. Use as the heartbeat
 *                            of your game loop.
 *
 *   Palettes
 *     palette_load(p32)    — write 32 bytes to $3F00. PPU must be off.
 *
 *   OAM (shadow buffer at $0200; NMI auto-DMAs each frame)
 *     oam_clear()          — set all 64 sprites Y=$FF (off-screen).
 *     oam_spr(x,y,tile,attr) — push one sprite to the next free slot.
 *
 *   Input (Shiru bit layout: A=$80, B=$40, ...)
 *     pad_poll(0|1)        — read controller, return packed byte.
 *
 *   CHR-RAM (only in chr-ram preset — the default for C builds)
 *     chr_ram_upload(ppu_addr, src, n) — copy tiles to pattern table.
 *                            PPU must be off (rendering disabled). Set
 *                            ppu_addr = 0x0000 for sprite tiles, 0x1000
 *                            for BG tiles (or wherever your LCDC config
 *                            points).
 *
 *   Nametable / VRAM queue (writes batched + flushed by NMI)
 *     vram_set(ppu_addr, tile)       — queue a single byte write.
 *     tile_set(nt, x, y, tile)       — queue write to nametable cell.
 *     tile_set_palette(nt, x, y, p)  — queue attribute-table RMW.
 *     vram_unsafe_set(ppu_addr, byte) — write directly (PPU must be off).
 *     ppu_scroll(x, y)               — set scroll (NMI commits it).
 *
 *   System
 *     ppu_system()         — 0 = NTSC, 1 = PAL. Detected at boot.
 *
 * Globals (live in BSS / ZP — read at your peril):
 *
 *   shadow_oam[256]   — at $0200. NMI DMAs this to $2003.
 *   nmi_counter       — increments each NMI. Useful for "wait N frames".
 */
#ifndef NES_RUNTIME_H
#define NES_RUNTIME_H

#include <stdint.h>

/* cc65 lacks <stdbool.h>; provide the basics. */
typedef uint8_t bool;
#define true  1
#define false 0

/* ── PPU control ──────────────────────────────────────────────── */
void ppu_off(void);
void ppu_on_all(void);
void ppu_on_bg(void);
void ppu_on_spr(void);
void ppu_wait_vblank(void);
void ppu_wait_nmi(void);
uint8_t ppu_system(void);

/* ── Palettes ─────────────────────────────────────────────────── */
void palette_load(const uint8_t *pal32);

/* ── OAM ──────────────────────────────────────────────────────── */
void oam_clear(void);
void oam_spr(uint8_t x, uint8_t y, uint8_t tile, uint8_t attr);

/* ── Input ────────────────────────────────────────────────────── */
uint8_t pad_poll(uint8_t which);

/* Shiru bit layout — d-pad in LOW nybble, buttons in HIGH nybble. */
#define PAD_A       0x80
#define PAD_B       0x40
#define PAD_SELECT  0x20
#define PAD_START   0x10
#define PAD_UP      0x08
#define PAD_DOWN    0x04
#define PAD_LEFT    0x02
#define PAD_RIGHT   0x01

/* ── CHR-RAM upload ────────────────────────────────────────────── */
void chr_ram_upload(uint16_t ppu_addr, const uint8_t *src, uint16_t n);

/* ── Nametable + VRAM queue ────────────────────────────────────── */
/* Direct writes — PPU must be off (rendering disabled). Use during init. */
void vram_unsafe_set(uint16_t ppu_addr, uint8_t byte);

/* Queued writes — committed by the NMI handler next vblank. Safe during
 * rendering. Queue holds 16 entries; flushes itself on overflow by
 * waiting for the next NMI. */
void vram_set(uint16_t ppu_addr, uint8_t tile);
void tile_set(uint8_t nt, uint8_t x, uint8_t y, uint8_t tile);
void tile_set_palette(uint8_t nt, uint8_t x, uint8_t y, uint8_t palette);

/* Scroll. NMI commits these to PPUSCROLL/PPUCTRL at end of vblank. */
void ppu_scroll(uint16_t x, uint16_t y);

/* ── Sound (NES APU — pulse/triangle/noise channels) ──────────── */
/*
 * sound_init()
 *     Enable the APU channels (writes $0F to $4015 — pulse1+pulse2+
 *     triangle+noise on, DMC off) + set frame counter to 4-step mode
 *     (writes $40 to $4017 to disable frame IRQ). Call once at boot.
 *
 * sound_play_tone(channel, period, vol_4bit, length_frames)
 *     Trigger a tone on `channel` (0 = pulse1, 1 = pulse2, 2 = triangle).
 *     `period` is the 11-bit NES timer value (lower = higher pitch):
 *       A4 = $0FD   C5 = $1AA   G5 = $0FE   C6 = $0D6
 *       (formula: 1789773 / (16 * Hz) - 1)
 *     `vol_4bit` (0-15) is volume — ignored for triangle (always max).
 *     `length_frames` (0-31) maps into the APU length-counter table
 *     (roughly N * 16ms).
 *
 * sound_play_noise(period, vol_4bit, length_frames)
 *     Trigger a noise burst on channel 3. `period` is 0-15 (rate index);
 *     8-15 = lower-pitched noise, 0-7 = high. Good for hit/explosion SFX.
 *
 * sound_off()
 *     Silences all channels (writes $00 to $4015).
 *
 * These are fire-and-forget — the APU's length counter cuts off the
 * note after `length_frames`. No per-frame upkeep needed.
 */
void sound_init(void);
void sound_play_tone(uint8_t channel, uint16_t period, uint8_t vol_4bit, uint8_t length_frames);
void sound_play_noise(uint8_t period_4bit, uint8_t vol_4bit, uint8_t length_frames);
void sound_off(void);

/* ── Globals ──────────────────────────────────────────────────── */
extern uint8_t shadow_oam[256];       /* at $0200, DMA'd by NMI */
extern volatile uint8_t nmi_counter;  /* increments each NMI */

#endif /* NES_RUNTIME_H */
