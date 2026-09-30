/* Traps for hardware this runtime leaves out. gpgx names these on code paths
   that only run for other systems or add-ons (Mega CD, SMS cartridges, Pico,
   YM2413, light guns and other controllers, cartridge EEPROM/flash, MegaSD);
   reaching one means the cartridge needs hardware the build does not model,
   and it stops the cart with rd_stats.trapped set instead of misbehaving. */
#include "shared.h"
#include "lightgun.h"
#include "mouse.h"
#include "activator.h"
#include "xe_1ap.h"
#include "teamplayer.h"
#include "paddle.h"
#include "sportspad.h"
#include "graphic_board.h"
#include "terebi_oekaki.h"
#include "eeprom_i2c.h"
#include "eeprom_spi.h"
#include "flash_cfi.h"
#include "yx5200.h"
#include "megasd.h"

#define TRAP(what) rd_unreachable(what)

void scd_init(void) { TRAP("mega cd"); }
void scd_reset(int hard) { (void)hard; TRAP("mega cd"); }
void s68k_init(void) { TRAP("mega cd"); }
void sms_cart_init(void) { TRAP("sms cartridge"); }
void sms_cart_reset(void) { TRAP("sms cartridge"); }
void sms_cart_switch(unsigned char mode) { (void)mode; TRAP("sms cartridge"); }
int sms_cart_region_detect(void) { TRAP("sms cartridge"); return 0; }
void YM2413Init(void) { TRAP("ym2413"); }
void YM2413ResetChip(void) { TRAP("ym2413"); }
void YM2413Update(int *b, int l) { (void)b; (void)l; TRAP("ym2413"); }
void YM2413Write(unsigned int a, unsigned int v) { (void)a; (void)v; TRAP("ym2413"); }
unsigned int YM2413Read(void) { TRAP("ym2413"); return 0; }

void lightgun_reset(int i) { (void)i; TRAP("lightgun"); }
void lightgun_refresh(int p) { (void)p; TRAP("lightgun"); }
unsigned char phaser_1_read(void) { TRAP("lightgun"); return 0; }
unsigned char phaser_2_read(void) { TRAP("lightgun"); return 0; }
unsigned char menacer_read(void) { TRAP("lightgun"); return 0; }
unsigned char justifier_read(void) { TRAP("lightgun"); return 0; }
void justifier_write(unsigned char d, unsigned char m) { (void)d; (void)m; TRAP("lightgun"); }
void mouse_reset(int p) { (void)p; TRAP("mouse"); }
unsigned char mouse_read(void) { TRAP("mouse"); return 0; }
void mouse_write(unsigned char d, unsigned char m) { (void)d; (void)m; TRAP("mouse"); }
void activator_reset(int i) { (void)i; TRAP("activator"); }
unsigned char activator_1_read(void) { TRAP("activator"); return 0; }
unsigned char activator_2_read(void) { TRAP("activator"); return 0; }
void activator_1_write(unsigned char d, unsigned char m) { (void)d; (void)m; TRAP("activator"); }
void activator_2_write(unsigned char d, unsigned char m) { (void)d; (void)m; TRAP("activator"); }
void xe_1ap_reset(int i) { (void)i; TRAP("xe-1ap"); }
unsigned char xe_1ap_1_read(void) { TRAP("xe-1ap"); return 0; }
unsigned char xe_1ap_2_read(void) { TRAP("xe-1ap"); return 0; }
void xe_1ap_1_write(unsigned char d, unsigned char m) { (void)d; (void)m; TRAP("xe-1ap"); }
void xe_1ap_2_write(unsigned char d, unsigned char m) { (void)d; (void)m; TRAP("xe-1ap"); }
void teamplayer_init(int p) { (void)p; TRAP("teamplayer"); }
void teamplayer_reset(int p) { (void)p; TRAP("teamplayer"); }
unsigned char teamplayer_1_read(void) { TRAP("teamplayer"); return 0; }
unsigned char teamplayer_2_read(void) { TRAP("teamplayer"); return 0; }
void teamplayer_1_write(unsigned char d, unsigned char m) { (void)d; (void)m; TRAP("teamplayer"); }
void teamplayer_2_write(unsigned char d, unsigned char m) { (void)d; (void)m; TRAP("teamplayer"); }
void paddle_reset(int p) { (void)p; TRAP("paddle"); }
unsigned char paddle_1_read(void) { TRAP("paddle"); return 0; }
unsigned char paddle_2_read(void) { TRAP("paddle"); return 0; }
void paddle_1_write(unsigned char d, unsigned char m) { (void)d; (void)m; TRAP("paddle"); }
void paddle_2_write(unsigned char d, unsigned char m) { (void)d; (void)m; TRAP("paddle"); }
void sportspad_reset(int i) { (void)i; TRAP("sportspad"); }
unsigned char sportspad_1_read(void) { TRAP("sportspad"); return 0; }
unsigned char sportspad_2_read(void) { TRAP("sportspad"); return 0; }
void sportspad_1_write(unsigned char d, unsigned char m) { (void)d; (void)m; TRAP("sportspad"); }
void sportspad_2_write(unsigned char d, unsigned char m) { (void)d; (void)m; TRAP("sportspad"); }
void graphic_board_reset(int p) { (void)p; TRAP("graphic board"); }
unsigned char graphic_board_read(void) { TRAP("graphic board"); return 0; }
void graphic_board_write(unsigned char d, unsigned char m) { (void)d; (void)m; TRAP("graphic board"); }
void terebi_oekaki_reset(void) { TRAP("terebi oekaki"); }
unsigned short terebi_oekaki_read(void) { TRAP("terebi oekaki"); return 0; }
void terebi_oekaki_write(unsigned char d) { (void)d; TRAP("terebi oekaki"); }

/* A cartridge with no serial EEPROM still passes through eeprom_i2c_init:
   gpgx's version returns without effect when the database does not list the
   game, which is every game this runtime is built for (the build refuses
   EEPROM carts), so the same is true here. */
void eeprom_i2c_init(void) { sram.custom = 0; }
void eeprom_spi_init(void) { TRAP("spi eeprom"); }
void eeprom_spi_write(unsigned char d) { (void)d; TRAP("spi eeprom"); }
unsigned int eeprom_spi_read(unsigned int a) { (void)a; TRAP("spi eeprom"); return 0; }
void flash_cfi_init(T_FLASH_CFI_TYPE t, const uint16 *o) { (void)t; (void)o; TRAP("flash cfi"); }
void flash_cfi_write(unsigned int a, unsigned int d) { (void)a; (void)d; TRAP("flash cfi"); }
unsigned int flash_cfi_read(unsigned int a) { (void)a; TRAP("flash cfi"); return 0; }
void yx5200_init(int r) { (void)r; TRAP("yx5200"); }
void yx5200_reset(void) { TRAP("yx5200"); }
void yx5200_write(unsigned int d) { (void)d; TRAP("yx5200"); }
void yx5200_update(unsigned int s) { (void)s; TRAP("yx5200"); }
void megasd_reset(void) { TRAP("megasd"); }
void megasd_rom_mapper_w(unsigned int a, unsigned int d) { (void)a; (void)d; TRAP("megasd"); }
void megasd_enhanced_ssf2_mapper_w(unsigned int a, unsigned int d) { (void)a; (void)d; TRAP("megasd"); }
void megasd_update_cdda(unsigned int s) { (void)s; TRAP("megasd"); }
