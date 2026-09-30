/* Declarations for hardware this runtime leaves out (Mega CD, SMS carts,
   Pico, YM2413, lock-on cartridges). gpgx still names them on paths that only
   run for those systems; rd_stubs.c defines each as a trap, so reaching one
   is a loud failure rather than silent misbehaviour. */
#ifndef _RD_STUBS_H_
#define _RD_STUBS_H_
void rd_unreachable(const char *what);
void scd_init(void);
void scd_reset(int hard);
void s68k_init(void);
void sms_cart_init(void);
void sms_cart_reset(void);
void sms_cart_switch(unsigned char mode);
int sms_cart_region_detect(void);
void YM2413Init(void);
void YM2413ResetChip(void);
void YM2413Update(int *buffer, int length);
void YM2413Write(unsigned int a, unsigned int v);
unsigned int YM2413Read(void);
#define HW_TEREBI_OEKAKI  0x02
int rand(void);
unsigned int crc32(unsigned int crc, const unsigned char *buf, unsigned int len);
#define RAND_MAX 0x7fffffff
#endif
