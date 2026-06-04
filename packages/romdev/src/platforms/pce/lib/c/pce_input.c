/*
 * pce_input.c — PC Engine pad input via cc65's joystick driver (C89).
 *
 * The PCE pad has a 2-button layout: I (east/'a'), II (west/'b'), Select, Run
 * (start), plus the d-pad. cc65 ships a standard PCE joystick driver linked in
 * as joy_static_stddrv; pce_joy_init() installs it and pce_joy_read() returns a
 * CLEAN, stable bitmask (PCE_JOY_* in pce_hw.h) so your game logic doesn't have
 * to know cc65's odd raw mask layout (LEFT=0x80, DOWN=0x40, ...).
 */
#include <joystick.h>
#include "pce_hw.h"

/* cc65's prebuilt standard PCE joystick driver (pce-stdjoy). */
extern const void joy_static_stddrv[];

/* Install the driver. Safe to call once at startup. */
void pce_joy_init(void) {
    joy_install(joy_static_stddrv);
}

/* Read pad 1 and translate cc65's raw masks into our clean PCE_JOY_* bitmask.
 * cc65 PCE raw masks (from pce.h): UP=0x10 DOWN=0x40 LEFT=0x80 RIGHT=0x20,
 * BTN_1(I)=0x01 BTN_2(II)=0x02 SELECT=0x04 RUN=0x08. */
u8 pce_joy_read(void) {
    u8 raw = joy_read(JOY_1);
    u8 out = 0;
    if (JOY_UP(raw))     out |= PCE_JOY_UP;
    if (JOY_DOWN(raw))   out |= PCE_JOY_DOWN;
    if (JOY_LEFT(raw))   out |= PCE_JOY_LEFT;
    if (JOY_RIGHT(raw))  out |= PCE_JOY_RIGHT;
    if (JOY_BTN_1(raw))  out |= PCE_JOY_I;
    if (JOY_BTN_2(raw))  out |= PCE_JOY_II;
    if (JOY_BTN_3(raw))  out |= PCE_JOY_SELECT;
    if (JOY_BTN_4(raw))  out |= PCE_JOY_RUN;
    return out;
}
