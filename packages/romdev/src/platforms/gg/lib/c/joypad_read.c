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
