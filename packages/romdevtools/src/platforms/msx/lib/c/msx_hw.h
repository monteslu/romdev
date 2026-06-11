/* MSX / MSX2 hardware helper library for SDCC (z80, C89).
 *
 * Everything here drives the VDP and PSG through DIRECT Z80 I/O PORTS — no
 * fragile IX-offset inline asm. Under SDCC's default `--sdcccall 1` the first
 * function argument arrives in registers (NOT on the stack), so the old
 * `ld c,4(ix)` style wrappers read garbage. The direct-port approach below is
 * verified on the bluemsx core (msx_wrtvdp(7,0x55) -> msx_vdp_regs[7]==0x55).
 *
 * SDCC `__sfr __at <port>` binds a name to a Z80 I/O port: reading the variable
 * emits `in a,(port)`, writing emits `out (port),a`. That gives us VDP/PSG
 * access in plain C.
 *
 * Add msx_vdp.c to your build alongside main.c and msx_crt0.s:
 *   buildForPlatform({ platform:"msx",
 *     sources: { "main.c":..., "msx_vdp.c":..., "msx_crt0.s":... },
 *     includes:{ "msx_hw.h":... },
 *     crt0: ".module empty\n", sourceName:"main.c" })
 */
#ifndef MSX_HW_H
#define MSX_HW_H

#include <stdint.h>

/* ─── VDP I/O ports (V9938 on MSX2; TMS9918 on MSX1) ────────────────────── */
__sfr __at 0x98 VDPDATA;   /* VRAM data read/write (address auto-increments) */
__sfr __at 0x99 VDPCTRL;   /* address-set (lo then hi) + register write       */
__sfr __at 0x9A VDPPAL;    /* V9938 palette write (MSX2 only)                 */
__sfr __at 0x9B VDPREG;    /* V9938 indirect register write (MSX2 only)       */

/* ─── PSG (AY-3-8910), reached through the PPI on ports 0xA0..0xA2 ──────── */
__sfr __at 0xA0 PSGADDR;   /* select PSG register 0-15                        */
__sfr __at 0xA1 PSGWRITE;  /* write the selected PSG register                 */
__sfr __at 0xA2 PSGREAD;   /* read the selected PSG register                  */

/* ─── VDP address-set high-byte flags (for raw VDPCTRL sequencing) ─────────
 * Set address: VDPCTRL = lo; VDPCTRL = (hi & 0x3F) | <flag>;
 *   - VRAM write  -> OR with 0x40, then stream bytes out via VDPDATA
 *   - VRAM read   -> OR with 0x00, then read bytes in  via VDPDATA
 *   - register    -> VDPCTRL = value; VDPCTRL = 0x80 | reg;  (see msx_wrtvdp)  */
#define VDP_VRAM_READ  0x00
#define VDP_VRAM_WRITE 0x40
#define VDP_REG_WRITE  0x80

/* ─── screen 2 (GRAPHIC II) VRAM layout, the default this lib sets up ──────
 * 256x192, 32x24 cells, three colour-banked thirds. These match the V9938
 * register values written by msx_set_screen2() (R2=0x06,R3=0xFF,R4=0x03,
 * R5=0x36,R6=0x07,R10=0x00,R11=0x00). */
#define VRAM_PATTERN  0x0000  /* pattern generator  (R4=0x03 -> 0x03<<11)      */
#define VRAM_NAME     0x1800  /* name table         (R2=0x06 -> 0x06<<10)      */
#define VRAM_SPRPAT   0x3800  /* sprite patterns    (R6=0x07 -> 0x07<<11)      */
#define VRAM_SPRATTR  0x1B00  /* sprite attributes  (R5=0x36 -> 0x36<<7)       */
#define VRAM_COLOR    0x2000  /* colour table       (R3=0xFF,R10=0x00 -> 0x2000)*/

/* ─── joystick directions returned by msx_read_joystick (0=center, CW) ───── */
#define STICK_CENTER 0
#define STICK_UP     1
#define STICK_UR     2
#define STICK_RIGHT  3
#define STICK_DR     4
#define STICK_DOWN   5
#define STICK_DL     6
#define STICK_LEFT   7
#define STICK_UL     8

/* ─── sprite-list terminator: a sprite Y of 0xD0 (208) ends the OAM scan ─── */
#define SPRITE_END_Y 0xD0

/* ─── BIOS entry addresses we still use (called via function-pointer cast) ── */
#define BIOS_INITXT 0x006C  /* set 40-col text screen (mode 0) + clear        */
#define BIOS_INIGRP 0x0072  /* set screen-2 (GRAPHIC II) + clear              */

/* ─── BIOS calls via the SDCC function-pointer-cast trick ──────────────────
 * Clean under sdcccall(1): A in / A out, no stack-frame juggling. GTSTCK/GTTRIG
 * live at fixed ROM addresses on every MSX. */
static uint8_t gtstck(uint8_t s) { return ((uint8_t (*)(uint8_t))0x00D5)(s); }
static uint8_t gttrig(uint8_t t) { return ((uint8_t (*)(uint8_t))0x00D8)(t); }

/* ─── helper prototypes (implemented in msx_vdp.c, all via direct ports) ─── */
void    msx_set_screen2(void);
void    msx_wrtvdp(uint8_t reg, uint8_t value);
void    msx_vram_write(uint16_t addr, const uint8_t *src, uint16_t len);
void    msx_fill_vram(uint16_t addr, uint16_t len, uint8_t byte);
void    msx_set_palette_entry(uint8_t idx, uint16_t grb);
void    msx_set_sprite(uint8_t plane, uint8_t x, uint8_t y,
                       uint8_t pattern, uint8_t color);
void    msx_clear_sprites(void);
void    msx_vblank_wait(void);
uint8_t msx_read_joystick(uint8_t stick);
void    msx_psg_tone(uint8_t chan, uint16_t period, uint8_t vol);
void    msx_psg_noise(uint8_t chan, uint8_t rate, uint8_t vol); /* vol 0 = off */
void    msx_music(uint8_t on);   /* background melody on channel C — ON by default; 0 = off */
void    msx_music_tick(void);    /* call once per frame (scaffolds do) */
void    msx_psg_off(uint8_t chan);

#endif /* MSX_HW_H */
