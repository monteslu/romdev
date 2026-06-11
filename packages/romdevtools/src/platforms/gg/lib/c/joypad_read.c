/* GG joypad read — port $DC (D-pad + B1/B2) plus port $00 bit 7 for START.
 *
 * Active LOW on the hardware, we invert so pressed = 1. Returned byte
 * layout matches the SMS layout PLUS bit 7 for START:
 *
 *   bit 0  UP
 *   bit 1  DOWN
 *   bit 2  LEFT
 *   bit 3  RIGHT
 *   bit 4  B1
 *   bit 5  B2
 *   bit 7  START   (read from GG-specific port $00 bit 7)
 *
 * Use the JOY_* and JOY_START masks from gg_hw.h.
 */
#include "gg_hw.h"

uint8_t gg_joypad_read(void) {
  uint8_t a = ~PORT_JOY_A;        /* D-pad + B1 + B2 (active low) */
  uint8_t start = ~PORT_GG_INPUT; /* GG-specific port bit 7 = START */
  return (uint8_t)((a & 0x3F) | (start & 0x80));
}

/*
 * Player 2 read — for ALTERNATING-TURNS or 2-controller play.
 *
 * HONEST NOTE: a real Game Gear has only ONE controller port on the unit; its
 * 2P story is the Gear-to-Gear LINK CABLE (a second console). But the GG VDP
 * and I/O chip are the SMS's, and gpgx wires the SMS's full split-across-
 * $DC/$DD second-controller layout for GG too — so a SECOND PAD does drive
 * port B in the emulator (and on an SMS-pad adapter), which is exactly what an
 * alternating-turns 2P platformer needs (the two players never play at once).
 *
 * The hardware layout is the SMS's awkward split:
 *   PORT_JOY_A bits 6-7  = P2 UP, P2 DOWN
 *   PORT_JOY_B bits 0-3  = P2 LEFT, P2 RIGHT, P2 B1, P2 B2
 * Reassembled into the same bit layout P1 uses:
 *   bit 0 = UP, 1 = DOWN, 2 = LEFT, 3 = RIGHT, 4 = B1, 5 = B2.
 * Returns 0 when no P2 pad is present (all bits high = released after invert).
 */
uint8_t gg_joypad_read_p2(void) {
  uint8_t a = ~PORT_JOY_A;          /* P2 UP in bit 6, DOWN in bit 7 */
  uint8_t b = ~PORT_JOY_B;          /* P2 LEFT bit 0, RIGHT 1, B1 2, B2 3 */
  uint8_t up    = (a >> 6) & 0x01;  /* bit 6 -> bit 0 */
  uint8_t down  = (a >> 6) & 0x02;  /* bit 7 -> bit 1 */
  uint8_t left  = (b << 2) & 0x04;  /* bit 0 -> bit 2 */
  uint8_t right = (b << 2) & 0x08;  /* bit 1 -> bit 3 */
  uint8_t b1    = (b << 2) & 0x10;  /* bit 2 -> bit 4 */
  uint8_t b2    = (b << 2) & 0x20;  /* bit 3 -> bit 5 */
  return (uint8_t)(up | down | left | right | b1 | b2);
}
