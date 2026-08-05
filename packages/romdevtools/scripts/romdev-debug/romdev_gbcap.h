/* romdev GB/GBC per-pixel capture planes.
 *
 * Feeds the universal GB redraw Active Bezel: the bezel reconstructs the
 * whole 160x144 screen from PPU state in Lua and is scored exact-match
 * against gambatte's own framebuffer.
 *
 * THE BOUNDARY (project Rule 1): this captures TIMING-resolved INPUTS —
 * which tile entry, which palette, which layer, at the moment the core
 * committed the pixel. It must NOT capture composition results or final
 * RGB. Compositing and bgr15->RGB are the reconstruction's job; capturing
 * them would make the bezel a copy of the answer (the NES `linepix`
 * mistake, which scored 100% while hiding four real bugs).
 *
 * Everything here is written from the emit sites in video/ppu.cpp, indexed
 * by the WRITE CURSOR (`dst - fbline`), never recomputed from tile
 * arithmetic — cursor-is-truth, the other NES lesson.
 *
 * Single-threaded core, plain file-scope arrays, no allocation.
 */
#ifndef ROMDEV_GBCAP_H
#define ROMDEV_GBCAP_H

#include <string.h>

#define ROMDEV_GB_W    160
#define ROMDEV_GB_H    144
#define ROMDEV_GB_PIX  (ROMDEV_GB_W * ROMDEV_GB_H)

#ifdef __cplusplus
extern "C" {
#endif

/* gb_bgpix: BG/window pixel, resolved at emit.
 *   bits 0-1  tile entry (0-3)
 *   bits 2-4  CGB palette number (0-7; DMG: 0)
 *   bit  5    layer: 1 = window, 0 = background
 *   bit  6    CGB BG tile-attr priority (attr bit7), participates in merge
 *   bit  7    valid (this pixel was written by the core this frame)
 */
extern unsigned char romdev_gb_bgpix[ROMDEV_GB_PIX];

/* gb_sprpix: sprite contribution, resolved at merge.
 *   bits 0-1  entry (0 = no sprite pixel here)
 *   bits 2-4  palette number (CGB: attr&7; DMG: 0/1 for OBP0/OBP1)
 *   bit  5    sprite attr bgpriority bit
 *   bit  6    reserved
 *   bit  7    valid
 * On CGB the core resolves overlap by lowest OAM index (idtab / minId), so
 * the capture is written INSIDE that guard and inherits the same winner.
 */
extern unsigned char romdev_gb_sprpix[ROMDEV_GB_PIX];

/* gb_lineregs: 16 bytes per scanline, sampled at line start.
 *   0 LCDC   1 SCX   2 SCY   3 WX   4 WY
 *   5 BGP    6 OBP0  7 OBP1
 *   8 window line counter (winYPos)
 *   9 flags: bit0 cgb, bit1 dmgMode (DMG game on GBC core)
 *  10 frame blanked (whole-frame fill; see updateScreen)
 *  11-15 pad
 */
#define ROMDEV_GB_LINEREG_STRIDE 16
extern unsigned char romdev_gb_lineregs[ROMDEV_GB_H * ROMDEV_GB_LINEREG_STRIDE];

/* gb_palline: per line, the ACTIVE translated palettes as bgr15 VALUES
 * (not RGB — Rule 1 keeps colour math in Lua): 32 BG + 32 OBJ entries,
 * little-endian u16 each. Absorbs colorization, CRAM writes and mid-frame
 * palette swaps at line granularity.
 */
#define ROMDEV_GB_PALLINE_STRIDE 128
extern unsigned char romdev_gb_palline[ROMDEV_GB_H * ROMDEV_GB_PALLINE_STRIDE];

/* Per-pixel bgr15 VALUES actually in force at emit — rung 4, absorbs
 * mid-LINE palette writes (DMG raster BGP tricks) that palline misses by
 * one line. Values, never post-colour-math RGB.
 */
extern unsigned short romdev_gb_bgcol15[ROMDEV_GB_PIX];
extern unsigned short romdev_gb_sprcol15[ROMDEV_GB_PIX];

/* Cleared at frame start; the blank flag is set by updateScreen. */
void romdev_gbcap_frame_start(void);
void romdev_gbcap_set_blank(unsigned short fill_bgr15);

/* Snapshot the ACTIVE palettes as bgr15 values into line `ly`'s slot (and
 * every later line, so the last write before a line is drawn is what that
 * line sees). cgbMode selects CRAM vs the DMG colorization tables; on DMG
 * the BGP/OBP0/OBP1 registers (bgpData[0], objpData[0], objpData[1]) remap
 * the 4 base colours, exactly as LCD::setDmgPalette does. */
void romdev_gbcap_palette_snapshot(int cgbMode,
                                   const unsigned char *bgpData,
                                   const unsigned char *objpData,
                                   const unsigned char *dmgColorsGBC,
                                   unsigned ly);

/* DMG variant. There is NO bgr15 for a real DMG: gambatte initialises
 * dmgColorsRgb32_ with FINAL RGB565 values (0xFFFF/0xAD55/0x52AA/0x0000 by
 * default, or whatever the colorization option supplies), so the honest
 * capture is that table after the BGP/OBP0/OBP1 remap. Values are stored
 * in the same u16 slots; the renderer distinguishes by the cgb flag in
 * gb_lineregs[9].
 * NOTE the boundary: these are palette VALUES the core resolved, not
 * composited pixels — the reconstruction still decides what shows. */
void romdev_gbcap_palette_snapshot_dmg(const unsigned char *bgpData,
                                       const unsigned char *objpData,
                                       const unsigned short *dmgColorsRgb,
                                       unsigned ly);

/* Publish the RESOLVED palettes: 32 BG + 32 OBJ video_pixel_t entries as the
 * core will actually use them, for line `ly` and every line after.
 *
 * This is the palette the emulator owns (colorization option, colour
 * correction mode, dark filter all already applied). The bezel reads it
 * rather than re-deriving RGB from CRAM, because that transform is runtime
 * configuration and its default mode is float math a Lua port cannot match
 * bit-exactly. Still Rule 1: VALUES, not composited pixels. */
void romdev_gbcap_palette_publish(const unsigned short *bgPalette,
                                  const unsigned short *spPalette,
                                  unsigned ly);

#ifdef __cplusplus
}
#endif

#ifdef ROMDEV_GBCAP_IMPL

unsigned char  romdev_gb_bgpix[ROMDEV_GB_PIX];
unsigned char  romdev_gb_sprpix[ROMDEV_GB_PIX];
unsigned char  romdev_gb_lineregs[ROMDEV_GB_H * ROMDEV_GB_LINEREG_STRIDE];
unsigned char  romdev_gb_palline[ROMDEV_GB_H * ROMDEV_GB_PALLINE_STRIDE];
unsigned short romdev_gb_bgcol15[ROMDEV_GB_PIX];
unsigned short romdev_gb_sprcol15[ROMDEV_GB_PIX];

void romdev_gbcap_frame_start(void) {
	/* Clearing every frame is what makes a stale row impossible: a line the
	 * core never draws (LCD off, or a shortened frame) must read as invalid
	 * rather than keeping last frame's pixels. */
	memset(romdev_gb_bgpix,   0, sizeof romdev_gb_bgpix);
	memset(romdev_gb_sprpix,  0, sizeof romdev_gb_sprpix);
	memset(romdev_gb_bgcol15, 0, sizeof romdev_gb_bgcol15);
	memset(romdev_gb_sprcol15,0, sizeof romdev_gb_sprcol15);
	memset(romdev_gb_lineregs,0, sizeof romdev_gb_lineregs);
}

static void romdev_gbcap_write_pal(unsigned char *dst,
                                   const unsigned char *src16pairs) {
	memcpy(dst, src16pairs, 64);
}

void romdev_gbcap_palette_snapshot(int cgbMode,
                                   const unsigned char *bgpData,
                                   const unsigned char *objpData,
                                   const unsigned char *dmgColorsGBC,
                                   unsigned ly) {
	unsigned char row[ROMDEV_GB_PALLINE_STRIDE];
	unsigned i;

	if (cgbMode) {
		/* CRAM is already bgr15 LE pairs: 32 BG entries then 32 OBJ. */
		romdev_gbcap_write_pal(row, bgpData);
		romdev_gbcap_write_pal(row + 64, objpData);
	} else {
		/* DMG: BGP/OBP0/OBP1 remap 4 of the 12 colorization base colours.
		 * dmgColorsGBC is 12 bgr15 LE pairs: [0..3] BG, [4..7] OBJ0,
		 * [8..11] OBJ1 — the same grouping LCD::refreshPalettes uses when it
		 * builds dmgColorsRgb32_ and hands slices to setDmgPalette. */
		unsigned const bgp  = bgpData[0];
		unsigned const obp0 = objpData[0];
		unsigned const obp1 = objpData[1];
		memset(row, 0, sizeof row);
		for (i = 0; i < 4; ++i) {
			unsigned const bsel = (bgp  >> (i * 2)) & 3;
			unsigned const o0   = (obp0 >> (i * 2)) & 3;
			unsigned const o1   = (obp1 >> (i * 2)) & 3;
			/* BG entry i */
			row[i * 2 + 0]        = dmgColorsGBC[bsel * 2 + 0];
			row[i * 2 + 1]        = dmgColorsGBC[bsel * 2 + 1];
			/* OBJ palette 0 lives at entries 0-3 of the OBJ half */
			row[64 + i * 2 + 0]   = dmgColorsGBC[(4 + o0) * 2 + 0];
			row[64 + i * 2 + 1]   = dmgColorsGBC[(4 + o0) * 2 + 1];
			/* OBJ palette 1 at entries 4-7 */
			row[64 + 8 + i * 2 + 0] = dmgColorsGBC[(8 + o1) * 2 + 0];
			row[64 + 8 + i * 2 + 1] = dmgColorsGBC[(8 + o1) * 2 + 1];
		}
	}

	/* Fill from this line forward: a palette write mid-frame applies to
	 * every subsequent line until the next write overwrites them. */
	for (i = (ly < ROMDEV_GB_H ? ly : 0); i < ROMDEV_GB_H; ++i)
		memcpy(romdev_gb_palline + i * ROMDEV_GB_PALLINE_STRIDE, row, sizeof row);
}

void romdev_gbcap_palette_snapshot_dmg(const unsigned char *bgpData,
                                       const unsigned char *objpData,
                                       const unsigned short *dmgColorsRgb,
                                       unsigned ly) {
	unsigned char row[ROMDEV_GB_PALLINE_STRIDE];
	unsigned const bgp  = bgpData[0];
	unsigned const obp0 = objpData[0];
	unsigned const obp1 = objpData[1];
	unsigned i;
	memset(row, 0, sizeof row);
	for (i = 0; i < 4; ++i) {
		unsigned short const bg = dmgColorsRgb[(bgp  >> (i * 2)) & 3];
		unsigned short const o0 = dmgColorsRgb[4 + ((obp0 >> (i * 2)) & 3)];
		unsigned short const o1 = dmgColorsRgb[8 + ((obp1 >> (i * 2)) & 3)];
		row[i * 2 + 0]          = (unsigned char)(bg & 0xFF);
		row[i * 2 + 1]          = (unsigned char)(bg >> 8);
		row[64 + i * 2 + 0]     = (unsigned char)(o0 & 0xFF);
		row[64 + i * 2 + 1]     = (unsigned char)(o0 >> 8);
		row[64 + 8 + i * 2 + 0] = (unsigned char)(o1 & 0xFF);
		row[64 + 8 + i * 2 + 1] = (unsigned char)(o1 >> 8);
	}
	for (i = (ly < ROMDEV_GB_H ? ly : 0); i < ROMDEV_GB_H; ++i)
		memcpy(romdev_gb_palline + i * ROMDEV_GB_PALLINE_STRIDE, row, sizeof row);
}

void romdev_gbcap_palette_publish(const unsigned short *bgPalette,
                                  const unsigned short *spPalette,
                                  unsigned ly) {
	unsigned char row[ROMDEV_GB_PALLINE_STRIDE];
	unsigned i;
	for (i = 0; i < 32; ++i) {
		row[i * 2 + 0]      = (unsigned char)(bgPalette[i] & 0xFF);
		row[i * 2 + 1]      = (unsigned char)(bgPalette[i] >> 8);
		row[64 + i * 2 + 0] = (unsigned char)(spPalette[i] & 0xFF);
		row[64 + i * 2 + 1] = (unsigned char)(spPalette[i] >> 8);
	}
	for (i = (ly < ROMDEV_GB_H ? ly : 0); i < ROMDEV_GB_H; ++i)
		memcpy(romdev_gb_palline + i * ROMDEV_GB_PALLINE_STRIDE, row, sizeof row);
}

void romdev_gbcap_set_blank(unsigned short fill_bgr15) {
	unsigned i;
	for (i = 0; i < ROMDEV_GB_H; ++i) {
		romdev_gb_lineregs[i * ROMDEV_GB_LINEREG_STRIDE + 10] = 1;
		romdev_gb_palline[i * ROMDEV_GB_PALLINE_STRIDE + 0] = (unsigned char)(fill_bgr15 & 0xFF);
		romdev_gb_palline[i * ROMDEV_GB_PALLINE_STRIDE + 1] = (unsigned char)(fill_bgr15 >> 8);
	}
}

#endif /* ROMDEV_GBCAP_IMPL */
#endif /* ROMDEV_GBCAP_H */
