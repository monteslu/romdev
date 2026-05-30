/* ── C64 hardware register names ───────────────────────────────────
 * Standard cc65 / ca65 symbolic names for VIC-II + SID + CIA1/2 +
 * 6510 I/O ports. Works in both C (`(*(volatile uint8_t*)VIC_BORDER)`)
 * and ca65 asm (`lda #$00 / sta VIC_BORDER`).
 *
 * Address constants follow cc65 cbm.h conventions where possible.
 */
#ifndef C64_REGISTERS_H
#define C64_REGISTERS_H

/* ── 6510 internal I/O ports ($00-$01) ──────────────────────────── */
#define CPU_PORT_DIR    0x0000  /* data direction */
#define CPU_PORT        0x0001  /* LORAM/HIRAM/CHAREN/cassette */
#define CPU_PORT_LORAM  0x01    /* 1 = BASIC ROM visible */
#define CPU_PORT_HIRAM  0x02    /* 1 = KERNAL ROM visible */
#define CPU_PORT_CHAREN 0x04    /* 0 = char ROM at $D000, 1 = I/O */

/* ── VIC-II ($D000-$D02E) ───────────────────────────────────────── */
#define VIC_BASE        0xD000
#define VIC_SPRITE_X(N) (0xD000 + (N) * 2)
#define VIC_SPRITE_Y(N) (0xD001 + (N) * 2)
#define VIC_SPRITES_X8  0xD010   /* sprite X high bits */
#define VIC_CTRL1       0xD011   /* Y-scroll, 24/25 rows, on, mode bits */
#define VIC_RASTER      0xD012
#define VIC_LPEN_X      0xD013
#define VIC_LPEN_Y      0xD014
#define VIC_SPR_ENA     0xD015
#define VIC_CTRL2       0xD016   /* X-scroll, 38/40 cols, multicolor */
#define VIC_SPR_Y_EXP   0xD017
#define VIC_MEMORY      0xD018   /* screen base + char base */
#define VIC_IRQ         0xD019
#define VIC_IRQ_ENA     0xD01A
#define VIC_SPR_BG_PRI  0xD01B
#define VIC_SPR_MCOLOR  0xD01C
#define VIC_SPR_X_EXP   0xD01D
#define VIC_SPR_SPR_COL 0xD01E
#define VIC_SPR_BG_COL  0xD01F
#define VIC_BORDER      0xD020
#define VIC_BG0         0xD021
#define VIC_BG1         0xD022
#define VIC_BG2         0xD023
#define VIC_BG3         0xD024
#define VIC_SPR_MC0     0xD025
#define VIC_SPR_MC1     0xD026
#define VIC_SPR_COL(N)  (0xD027 + (N))

/* ── SID ($D400-$D41C) ──────────────────────────────────────────── */
#define SID_BASE         0xD400
#define SID_VOICE(N)     (0xD400 + (N) * 7)
#define SID_FREQ_LO(N)   (0xD400 + (N) * 7 + 0)
#define SID_FREQ_HI(N)   (0xD400 + (N) * 7 + 1)
#define SID_PW_LO(N)     (0xD400 + (N) * 7 + 2)
#define SID_PW_HI(N)     (0xD400 + (N) * 7 + 3)
#define SID_CTRL(N)      (0xD400 + (N) * 7 + 4)
#define SID_AD(N)        (0xD400 + (N) * 7 + 5)
#define SID_SR(N)        (0xD400 + (N) * 7 + 6)
#define SID_FILTER_LO    0xD415
#define SID_FILTER_HI    0xD416
#define SID_RES_FILT     0xD417
#define SID_VOL_MODE     0xD418

/* SID waveform control bits */
#define SID_GATE         0x01
#define SID_SYNC         0x02
#define SID_RING         0x04
#define SID_TEST         0x08
#define SID_TRIANGLE     0x10
#define SID_SAWTOOTH     0x20
#define SID_PULSE        0x40
#define SID_NOISE        0x80

/* ── CIA1 ($DC00-$DC0F) — keyboard / joystick / timers ──────────── */
#define CIA1_PRA         0xDC00  /* port A (keyboard col / joystick 2) */
#define CIA1_PRB         0xDC01  /* port B (keyboard row / joystick 1) */
#define CIA1_DDRA        0xDC02
#define CIA1_DDRB        0xDC03

/* ── CIA2 ($DD00-$DD0F) — VIC bank select + serial bus ──────────── */
#define CIA2_PRA         0xDD00  /* bits 0-1 = VIC bank (inverted) */
#define CIA2_PRB         0xDD01
#define CIA2_DDRA        0xDD02
#define CIA2_DDRB        0xDD03

/* ── Color RAM ──────────────────────────────────────────────────── */
#define COLOR_RAM        0xD800  /* 1 KB, low nibble only */

/* ── Default screen / char locations (VIC bank 0) ───────────────── */
#define SCREEN_RAM       0x0400  /* 40×25 = 1000 bytes */

/* ── Standard color codes (matches BASIC's PEEK/POKE values) ────── */
#define COLOR_BLACK      0
#define COLOR_WHITE      1
#define COLOR_RED        2
#define COLOR_CYAN       3
#define COLOR_PURPLE     4
#define COLOR_GREEN      5
#define COLOR_BLUE       6
#define COLOR_YELLOW     7
#define COLOR_ORANGE     8
#define COLOR_BROWN      9
#define COLOR_LIGHT_RED  10
#define COLOR_DARK_GRAY  11
#define COLOR_MED_GRAY   12
#define COLOR_LIGHT_GREEN 13
#define COLOR_LIGHT_BLUE 14
#define COLOR_LIGHT_GRAY 15

#endif /* C64_REGISTERS_H */
