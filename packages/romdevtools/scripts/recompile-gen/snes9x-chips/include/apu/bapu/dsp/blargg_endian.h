/* Freestanding stand-in for blargg_endian.h: msu1.cpp's GET_LE16 / GET_LE32
 * (wasm32 is little-endian). */
#ifndef _ROMDEV_BLARGG_ENDIAN_H_
#define _ROMDEV_BLARGG_ENDIAN_H_
#define GET_LE16(addr) (*(uint16 *) (addr))
#define GET_LE32(addr) (*(uint32 *) (addr))
#endif
