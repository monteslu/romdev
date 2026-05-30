/* SMS vblank wait — polls VDP_CTRL bit 7.
 *
 * Reading $BF returns the status byte and CLEARS bit 7. Spin until set;
 * the act of reading clears the flag for the next iteration.
 */
#include "sms_hw.h"

void sms_vblank_wait(void) {
  while ((PORT_VDP_CTRL & 0x80) == 0) { }
}
