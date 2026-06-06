/* Game Gear hardware register declarations for SDCC.
 *
 * GG = "SMS in a handheld" — same Z80, same VDP (Mode 4), same SN76489 PSG,
 * same I/O port layout for SMS-compatible reads. Key differences:
 *
 *   1. Visible viewport is 160×144 (vs SMS 256×192). The framebuffer is
 *      still 256×192 internally; only the centered 160×144 region shows.
 *      Borders fill the rest. Always render game content centered.
 *
 *   2. Input is at port $DC (same as SMS) PLUS port $00 (GG-specific
 *      START button). When porting an SMS game, START on GG requires a
 *      separate read.
 *
 *   3. PSG has a stereo control register at port $06 (write-only). Each
 *      of the 4 PSG channels can be routed to L, R, or both. Defaults
 *      to mono (both speakers, all channels). We don't touch it; if you
 *      want stereo, write to PORT_GG_PSG_STEREO directly.
 *
 *   4. ROM header is at the same $7FF0-$7FFF region but the "TMR SEGA"
 *      magic is identical; gpgx accepts headerless ROMs fine.
 *
 * SDCC __sfr declares Z80 I/O ports: reading the variable compiles to
 * `in a, (port)`, writing to `out (port), a`. So port I/O is plain C
 * assignment.
 */
#ifndef GG_HW_H
#define GG_HW_H

#include <stdint.h>

/* ─── VDP (SMS-compatible) ──────────────────────────────────────── */
__sfr __at 0xBE PORT_VDP_DATA;
__sfr __at 0xBF PORT_VDP_CTRL;

/* ─── PSG / counters (SMS-compatible) ───────────────────────────── */
__sfr __at 0x7E PORT_V_COUNTER;
__sfr __at 0x7F PORT_H_COUNTER;     /* write = PSG */

/* ─── SMS-style controller ports (D-pad + 1/2) ──────────────────── */
__sfr __at 0xDC PORT_JOY_A;
__sfr __at 0xDD PORT_JOY_B;

/* ─── GG-specific extras ───────────────────────────────────────── */
__sfr __at 0x00 PORT_GG_INPUT;       /* bit 7 = START (active low) */
__sfr __at 0x06 PORT_GG_PSG_STEREO;  /* PSG L/R routing, write-only */

/* ─── Joypad bits (active low — invert after read) ─────────────── */
#define JOY_UP    0x01
#define JOY_DOWN  0x02
#define JOY_LEFT  0x04
#define JOY_RIGHT 0x08
#define JOY_B1    0x10
#define JOY_B2    0x20
#define JOY_START 0x80  /* on GG_INPUT bit 7, NOT on JOY_A */

/* ─── VDP address-set prefixes ──────────────────────────────────── */
#define VDP_VRAM_WRITE 0x40
#define VDP_VRAM_READ  0x00
#define VDP_REG_WRITE  0x80
#define VDP_CRAM_WRITE 0xC0

#endif
