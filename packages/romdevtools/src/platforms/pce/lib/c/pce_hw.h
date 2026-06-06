/*
 * pce_hw.h — PC Engine / TurboGrafx-16 hardware helper library (cc65, C89).
 *
 * Raw register addresses + prototypes for the HuC6270 VDC (video), HuC6260 VCE
 * (color), and HuC6280 PSG (sound). There is NO sprite/tile library on the PCE
 * with cc65 — you talk to the chips directly. These helpers wrap the most common
 * register dances so you don't have to remember the index/lo/hi protocol.
 *
 * USAGE: pair this header with pce_video.c, pce_input.c, pce_sound.c. Build all
 * four .c files together (the .h goes in `includes:` / `headers:`, the .c files
 * in `sources:`). cc65 is C89 — declare locals at the top of a block.
 *
 * EMPTY-BSS TRAP: cc65's pce/crt0.s clears .bss with a block copy sized
 * __BSS_SIZE__-1. With NO globals/statics that underflows → "Range error in
 * pce/crt0.s" + a black screen. Keep at least one (>=2 byte) global. Including
 * pce_video.c already provides `_pce_keep[4]` for you, so you're covered.
 *
 * The pce.inc names from cc65 are ASM-ONLY. In C you write raw addresses, which
 * is what every macro below expands to.
 */
#ifndef PCE_HW_H
#define PCE_HW_H

/* cc65 fixed-width-ish types */
typedef unsigned char  u8;
typedef unsigned short u16;

/* ---- HuC6270 VDC (Video Display Controller) ------------------------------ */
/* Write the register index to VDC_CTRL, then the 16-bit value to DATA_LO/HI. */
#define VDC_CTRL      (*(volatile unsigned char *)0x0200) /* select register index   */
#define VDC_DATA_LO   (*(volatile unsigned char *)0x0202) /* low byte of reg value   */
#define VDC_DATA_HI   (*(volatile unsigned char *)0x0203) /* high byte of reg value  */
#define VDC_STATUS    (*(volatile unsigned char *)0x0200) /* read: VDC status flags  */

/* VDC register indices */
#define VDC_MAWR   0  /* VRAM write address (auto-increments)        */
#define VDC_MARR   1  /* VRAM read  address (auto-increments)        */
#define VDC_VWR    2  /* VRAM write data port (stream words here)    */
#define VDC_VRR    2  /* VRAM read  data port                        */
#define VDC_CR     5  /* control: bit7 BG enable, bit6 SPR enable    */
#define VDC_RCR    6  /* raster compare                              */
#define VDC_BXR    7  /* background X scroll                         */
#define VDC_BYR    8  /* background Y scroll                         */
#define VDC_MWR    9  /* memory-access width / virtual screen size   */
#define VDC_HSR   10  /* horizontal sync                             */
#define VDC_HDR   11  /* horizontal display                          */
#define VDC_VPR   12  /* vertical sync                               */
#define VDC_VDW   13  /* vertical display width                      */
#define VDC_VCR   14  /* vertical display end                        */
#define VDC_DCR   15  /* DMA control                                 */
#define VDC_SOUR  16  /* DMA source                                  */
#define VDC_DESR  17  /* DMA destination                             */
#define VDC_LENR  18  /* DMA length                                  */
#define VDC_SATB  19  /* SATB DMA source (sprite table -> internal)  */

/* VDC R5 (CR) bits */
#define VDC_CR_BG_ON      0x80
#define VDC_CR_SPR_ON     0x40
#define VDC_CR_VBLANK_IRQ 0x08  /* raise the VBlank IRQ (needed for waitvsync) */

/* ---- HuC6260 VCE (Video Color Encoder) ----------------------------------- */
/* 512 color entries (256 BG sub-palettes + 256 SPR), each a 9-bit GRB value. */
#define VCE_CTRL      (*(volatile unsigned char *)0x0400)
#define VCE_ADDR_LO   (*(volatile unsigned char *)0x0402) /* color index low  */
#define VCE_ADDR_HI   (*(volatile unsigned char *)0x0403) /* color index high */
#define VCE_DATA_LO   (*(volatile unsigned char *)0x0404) /* GRB low byte     */
#define VCE_DATA_HI   (*(volatile unsigned char *)0x0405) /* GRB high byte    */

/* Build a 9-bit GRB color: each of g/r/b is 0..7. Layout %gggrrrbbb. */
#define PCE_RGB(r, g, b)  ((u16)((((g) & 7) << 6) | (((r) & 7) << 3) | ((b) & 7)))

/* ---- HuC6280 PSG (Programmable Sound Generator) -------------------------- */
/* 6 wavetable channels. Select a channel, then write its registers. */
#define PSG_CHAN_SELECT (*(volatile unsigned char *)0x0800) /* 0..5 channel   */
#define PSG_GLOBAL_PAN  (*(volatile unsigned char *)0x0801) /* main L/R volume*/
#define PSG_FREQ_LO     (*(volatile unsigned char *)0x0802) /* 12-bit freq low */
#define PSG_FREQ_HI     (*(volatile unsigned char *)0x0803) /* freq high nibble*/
#define PSG_CHAN_CTRL   (*(volatile unsigned char *)0x0804) /* 0x80|vol = on   */
#define PSG_CHAN_PAN    (*(volatile unsigned char *)0x0805) /* per-channel L/R */
#define PSG_CHAN_DATA   (*(volatile unsigned char *)0x0806) /* 32-byte waveform*/
#define PSG_NOISE       (*(volatile unsigned char *)0x0807) /* ch4/5 noise     */
#define PSG_LFO_FREQ    (*(volatile unsigned char *)0x0808)
#define PSG_LFO_CTRL    (*(volatile unsigned char *)0x0809)

/* PSG_CHAN_CTRL bits */
#define PSG_CTRL_ON       0x80  /* channel enable                  */
#define PSG_CTRL_DDA      0x40  /* direct D/A mode (else wavetable) */
#define PSG_CTRL_VOL_MASK 0x1F  /* 5-bit channel volume            */

/* ---- video helpers (pce_video.c) ----------------------------------------- */
/* The empty-BSS guard array, defined in pce_video.c. Touch _pce_keep[0]=0 at
 * the top of main() if you have no other globals (see the trap note above). */
extern unsigned char _pce_keep[4];

void vdc_set_reg(u8 reg, u16 val);              /* select reg, write 16-bit value */
void vram_set_write_addr(u16 addr);             /* point MAWR + arm VWR streaming */
void vram_write(u16 addr, const u16 *data, u16 n); /* upload n words to VRAM[addr] */
void vce_set_color(u16 idx, u16 grb);           /* set VCE palette entry (0..511) */
void bg_enable(void);     /* VDC R5: background on + VBlank IRQ (so waitvsync works) */
void spr_enable(void);    /* VDC R5: sprites on    + VBlank IRQ                      */
void disp_enable(void);   /* VDC R5: BG + SPR + VBlank IRQ on at once                */
void vblank_irq_enable(void); /* just the VBlank IRQ bit (waitvsync needs it)        */
void load_tiles(u16 vram, const u16 *src, u16 n);  /* alias of vram_write (tiles) */
void set_sprite(u8 slot, u16 x, u16 y, u16 pattern, u8 palette); /* fill shadow SATB */
void satb_dma(void);                            /* DMA shadow SATB -> VDC (R19)    */

/* The shadow SATB lives in VRAM at this word address; satb_dma() points the VDC
 * SATB-DMA source (R19) here. Pattern base for tiles is your choice; sprites
 * default to using the same VRAM you load_tiles() into. */
#define PCE_SATB_VRAM   0x7F00  /* 64 sprites * 4 words = 0x100 words, fits < 0x8000 */

/* ---- input helpers (pce_input.c) ----------------------------------------- */
void pce_joy_init(void);   /* install the cc65 standard PCE joystick driver */
u8   pce_joy_read(void);   /* read pad 1 -> clean bitmask (PCE_JOY_* below)  */

/* Clean, stable joystick bitmask returned by pce_joy_read(). */
#define PCE_JOY_UP      0x01
#define PCE_JOY_DOWN    0x02
#define PCE_JOY_LEFT    0x04
#define PCE_JOY_RIGHT   0x08
#define PCE_JOY_I       0x10  /* button I  (east / 'a')   */
#define PCE_JOY_II      0x20  /* button II (west / 'b')   */
#define PCE_JOY_SELECT  0x40
#define PCE_JOY_RUN     0x80  /* Run = start              */

/* ---- sound helpers (pce_sound.c) ----------------------------------------- */
void psg_tone(u8 chan, u16 freq, u8 vol); /* play a wavetable tone (vol 0..31) */
void psg_off(u8 chan);                    /* silence + disable a channel        */

#endif /* PCE_HW_H */
