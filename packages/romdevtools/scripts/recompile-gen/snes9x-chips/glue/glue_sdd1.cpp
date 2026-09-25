/* The S-DD1 unit: snes9x's sdd1emu.cpp (Andreas Naive's decompressor).
 * The $4800-$4807 registers and the $C0-$FF bank map are the cart's
 * (sdd1.js, from sdd1.cpp / ppu.cpp); dma.cpp's custom-chip block decodes
 * into its static buffer, which is here. */
#include "glue_common.h"
#include "sdd1emu.h"

/* dma.cpp: static uint8 sdd1_decode_buffer[0x10000]; */
static uint8 sdd1_decode_buffer[0x10000];

extern "C" uint8 *romdev_sdd1_buffer (void) { return sdd1_decode_buffer; }

/* dma.cpp S9xDoDMA: SDD1_decompress(sdd1_decode_buffer, in_ptr, d->TransferBytes);
 * in_ptr is the source's place in the cart's own memory (S9xGetBasePointer) */
extern "C" void romdev_sdd1_decompress (uint8 *in, int len) { SDD1_decompress(sdd1_decode_buffer, in, len); }
