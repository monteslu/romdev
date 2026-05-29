/* SMS / Game Gear hardware register declarations for SDCC.
 *
 * SDCC's __sfr __at <PORT> declares a Z80 I/O port. Reading the variable
 * compiles to `in a,(port)`; writing compiles to `out (port),a`. So you
 * can write port I/O as plain C assignments:
 *
 *     PORT_VDP_CTRL = 0x80;       // out ($BF), a   ; reg-write prefix
 *     uint8_t status = PORT_VDP_CTRL;  // in a, ($BF)
 *
 * Include this from your main.c. The declarations are __sfr — they don't
 * allocate storage, just bind a name to a port number. Multiple translation
 * units including this header is safe.
 */
#ifndef SMS_HW_H
#define SMS_HW_H

#include <stdint.h>

/* ─── VDP ───────────────────────────────────────────────────────── */
__sfr __at 0xBE PORT_VDP_DATA;   /* data port — read VRAM/CRAM, write VRAM/CRAM/REG */
__sfr __at 0xBF PORT_VDP_CTRL;   /* control port — address-set + register write */

/* ─── PSG / counters ────────────────────────────────────────────── */
__sfr __at 0x7E PORT_V_COUNTER;  /* read = V-counter */
__sfr __at 0x7F PORT_H_COUNTER;  /* read = H-counter; write = PSG (overloaded) */

/* ─── Controllers ───────────────────────────────────────────────── */
__sfr __at 0xDC PORT_JOY_A;      /* P1 D-pad + buttons 1+2, P2 D-pad */
__sfr __at 0xDD PORT_JOY_B;      /* P2 buttons + reset/cart inserted */

/* ─── Memory / cart control ─────────────────────────────────────── */
__sfr __at 0x3E PORT_MEMORY_CTRL;
__sfr __at 0x3F PORT_IO_CTRL;

/* ─── Game Gear extras ($00-$06 + $C0..) ────────────────────────── */
__sfr __at 0x00 PORT_GG_INPUT;
__sfr __at 0x06 PORT_GG_PSG_STEREO;

/* ─── Joypad bit masks (active LOW on the port — invert after read) ── */
#define JOY_UP    0x01
#define JOY_DOWN  0x02
#define JOY_LEFT  0x04
#define JOY_RIGHT 0x08
#define JOY_B1    0x10
#define JOY_B2    0x20

/* ─── VDP address-set high-byte prefixes ────────────────────────── */
#define VDP_VRAM_WRITE 0x40
#define VDP_VRAM_READ  0x00
#define VDP_REG_WRITE  0x80
#define VDP_CRAM_WRITE 0xC0

#endif /* SMS_HW_H */
