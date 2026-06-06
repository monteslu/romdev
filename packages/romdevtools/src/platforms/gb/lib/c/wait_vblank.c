/* ── wait_vblank — wait for the next vblank period ─────────────────
 * Spin on LY until it hits 144 (start of vblank). Cheap, busy-wait.
 * Per-frame sync point: pair with all your draw-state updates so they
 * land while the LCD isn't fetching.
 *
 * #include "gb_hardware.h"
 */
#include "gb_hardware.h"

void wait_vblank(void) {
  /* If already in vblank, wait it out first so we catch the leading edge. */
  while (LY >= 144) { }
  while (LY <  144) { }
}
