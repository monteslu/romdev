/* SMS joypad read — port $DC + $DD, inverted so pressed=1.
 *
 *     uint8_t p1 = sms_joypad_read();
 *     if (p1 & JOY_RIGHT) { ... }
 *     if (p1 & JOY_B1)    { fire(); }
 */
#include "sms_hw.h"

uint8_t sms_joypad_read(void) {
  uint8_t a = ~PORT_JOY_A;
  return a & 0x3F;            /* low 6 bits = P1 D-pad + B1 + B2 */
}

/*
 * Player 2's hardware layout is awkward — SMS splits P2 across two ports:
 *   PORT_JOY_A bits 6-7  = P2 UP, P2 DOWN
 *   PORT_JOY_B bits 0-3  = P2 LEFT, P2 RIGHT, P2 B1, P2 B2
 * We reassemble into the same bit layout the agent already knows for P1:
 *   bit 0 = UP, 1 = DOWN, 2 = LEFT, 3 = RIGHT, 4 = B1, 5 = B2.
 * Returns 0 when no P2 controller is plugged in (all bits read high =
 * "released" = 0 after inversion).
 */
uint8_t sms_joypad_read_p2(void) {
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
