/* rd_blocks.h: the recompiled 68000 blocks (rd_blocks*.c, generated) and
   the dispatcher in m68kcpu.c's m68k_run. A block is a C function for one
   straight run of 68000 code starting at `pc`; it returns the next block when
   that is known statically, else NULL (the dispatcher then looks REG_PC up). */
#ifndef _RD_BLOCKS_H_
#define _RD_BLOCKS_H_
typedef const void *(*rd_block_fn)(void);
typedef struct { unsigned int pc; rd_block_fn fn; } rd_block_entry_t;
extern const rd_block_entry_t rd_block_table[];   /* sorted by pc */
extern const unsigned int rd_block_count;
/* Set by m68k_set_irq_delay when the VDP's delayed interrupt ran the next
   instruction from inside a compiled block (see m68kcpu.c). */
extern unsigned int rd_irq_delay_abort;
extern int rd_in_block;
/* The m68k_run target (exact profile blocks stop at it). */
extern unsigned int rd_cycle_target;
#endif
