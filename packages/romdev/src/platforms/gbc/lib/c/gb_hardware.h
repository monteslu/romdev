/* ── Game Boy hardware register names (SDCC sm83 port) ──────────────
 * Standard `__sfr __at(addr)` declarations for the GB / GBC I/O space.
 * Layer-1 GBDK substitute: gives you LCDC / BGP / OBP / scroll / sound
 * regs without pulling in the full GBDK runtime.
 *
 * Use:
 *   #include "gb_hardware.h"
 *   void main(void) {
 *     LCDC = 0x91;             // turn LCD on, BG on, OBJ off
 *     BGP  = 0xE4;             // default DMG palette
 *     while (1) { }
 *   }
 *
 * SDCC's __sfr __at syntax binds a 1-byte memory-mapped register to a
 * scope-local volatile. Reads / writes compile to inline ld a,(addr) /
 * ldh (n),a. No runtime cost.
 */
#ifndef GB_HARDWARE_H
#define GB_HARDWARE_H

/* ── LCD ──────────────────────────────────────────────────────────── */
/* SDCC sm83 __sfr __at takes the full 16-bit address, not the $FF00-relative
 * I/O port number. ldh-vs-ld is chosen by the compiler from the address.   */
__sfr __at 0xFF40 LCDC;        /* LCD control */
__sfr __at 0xFF41 STAT;        /* LCD status */
__sfr __at 0xFF42 SCY;         /* scroll Y */
__sfr __at 0xFF43 SCX;         /* scroll X */
__sfr __at 0xFF44 LY;          /* current scanline */
__sfr __at 0xFF45 LYC;         /* scanline compare */
__sfr __at 0xFF46 DMA;         /* OAM DMA */
__sfr __at 0xFF47 BGP;         /* BG palette (DMG) */
__sfr __at 0xFF48 OBP0;        /* OBJ palette 0 (DMG) */
__sfr __at 0xFF49 OBP1;        /* OBJ palette 1 (DMG) */
__sfr __at 0xFF4A WY;          /* window Y */
__sfr __at 0xFF4B WX;          /* window X (-7) */

/* LCDC bits */
#define LCDC_LCD_ON          0x80
#define LCDC_WINDOW_MAP_HI   0x40    /* 0 = $9800, 1 = $9C00 */
#define LCDC_WINDOW_ON       0x20
#define LCDC_TILE_DATA_LO    0x10    /* 0 = $9000 signed, 1 = $8000 unsigned */
#define LCDC_BG_MAP_HI       0x08
#define LCDC_OBJ_8x16        0x04
#define LCDC_OBJ_ON          0x02
#define LCDC_BG_ON           0x01

/* ── Sound (NR10-NR52) ────────────────────────────────────────────── */
__sfr __at 0xFF10 NR10;
__sfr __at 0xFF11 NR11;
__sfr __at 0xFF12 NR12;
__sfr __at 0xFF13 NR13;
__sfr __at 0xFF14 NR14;
__sfr __at 0xFF16 NR21;
__sfr __at 0xFF17 NR22;
__sfr __at 0xFF18 NR23;
__sfr __at 0xFF19 NR24;
__sfr __at 0xFF1A NR30;
__sfr __at 0xFF1B NR31;
__sfr __at 0xFF1C NR32;
__sfr __at 0xFF1D NR33;
__sfr __at 0xFF1E NR34;
__sfr __at 0xFF20 NR41;
__sfr __at 0xFF21 NR42;
__sfr __at 0xFF22 NR43;
__sfr __at 0xFF23 NR44;
__sfr __at 0xFF24 NR50;        /* master volume */
__sfr __at 0xFF25 NR51;        /* channel routing */
__sfr __at 0xFF26 NR52;        /* sound on/off */

/* ── Joypad + serial + IE + IF ────────────────────────────────────── */
__sfr __at 0xFF00 JOYP;        /* joypad */
__sfr __at 0xFF01 SB;          /* serial data */
__sfr __at 0xFF02 SC;          /* serial control */
__sfr __at 0xFF04 DIV;
__sfr __at 0xFF05 TIMA;
__sfr __at 0xFF06 TMA;
__sfr __at 0xFF07 TAC;
__sfr __at 0xFF0F IF_REG;      /* interrupt flag — IF is reserved */

/* IE is at $FFFF — not addressable via __sfr __at (that's the 8-bit-port
 * space at $FF00-$FF7F). Read/write via:
 *   *(volatile unsigned char *)0xFFFF = 0x01;
 */
#define IE_REG  (*(volatile unsigned char *)0xFFFF)
#define IE_VBLANK   0x01
#define IE_LCDSTAT  0x02
#define IE_TIMER    0x04
#define IE_SERIAL   0x08
#define IE_JOYPAD   0x10

/* ── GBC extras (only meaningful with CGB compatibility byte $0143=$80/C0) */
__sfr __at 0xFF4D KEY1;        /* speed switch */
__sfr __at 0xFF4F VBK;         /* VRAM bank */
__sfr __at 0xFF51 HDMA1;
__sfr __at 0xFF52 HDMA2;
__sfr __at 0xFF53 HDMA3;
__sfr __at 0xFF54 HDMA4;
__sfr __at 0xFF55 HDMA5;
__sfr __at 0xFF68 BCPS;        /* BG palette spec */
__sfr __at 0xFF69 BCPD;        /* BG palette data */
__sfr __at 0xFF6A OCPS;        /* OBJ palette spec */
__sfr __at 0xFF6B OCPD;        /* OBJ palette data */
__sfr __at 0xFF70 SVBK;        /* WRAM bank */

/* ── Memory map bases ─────────────────────────────────────────────── */
#define VRAM_BASE  ((unsigned char *)0x8000)   /* tile data + maps */
#define BG_MAP_0   ((unsigned char *)0x9800)   /* 32×32 = 1024 bytes */
#define BG_MAP_1   ((unsigned char *)0x9C00)
#define OAM_BASE   ((unsigned char *)0xFE00)   /* 40 sprites × 4 bytes */
#define WRAM_BASE  ((unsigned char *)0xC000)
#define HRAM_BASE  ((unsigned char *)0xFF80)

#endif /* GB_HARDWARE_H */
