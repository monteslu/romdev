/* shared.h for the sync32 Genesis runtime: gpgx's umbrella header, cut to a
   Mega Drive cartridge (no Mega CD, SMS, Pico, SVP, lock-on or cheat
   devices, so none of their headers). */
#ifndef _SHARED_H_
#define _SHARED_H_

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "types.h"
#include "osd.h"
#include "macros.h"
#include "loadrom.h"
#include "m68k.h"
#include "z80.h"
#include "system.h"
#include "genesis.h"
#include "vdp_ctrl.h"
#include "vdp_render.h"
#include "mem68k.h"
#include "memz80.h"
#include "membnk.h"
#include "io_ctrl.h"
#include "input.h"
#include "sound.h"
#include "psg.h"
#include "ym2612.h"
#include "sram.h"
#include "rd_stubs.h"

/* sms_cart.h cart.special flag the VDP tests even on a Mega Drive cart */
#define HW_3D_GLASSES     0x01

#endif /* _SHARED_H_ */
