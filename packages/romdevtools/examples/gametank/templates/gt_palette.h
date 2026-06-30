/* ── gt_palette.h — GameTank palette (read DIRECTLY from the core's table) ─────
 *
 * These indices were read straight out of the core's active palette table
 * (vendor/gametank_palette.h, the CAPTURE sub-palette that palette_select points
 * at) — NOT measured from rendered output (that sampling was unreliable and gave
 * wrong, muddy/gray results). The rgb in each comment is the EXACT table entry.
 *
 * The GameTank palette is non-obvious: index != color, and it has FOUR sub-
 * palettes; the core uses CAPTURE (palette_select = 256). An index that looks
 * vibrant in one sub-palette is gray in another, which is why a naive measurement
 * produced gray everywhere. Use THESE indices.
 */
#ifndef GT_PALETTE_H
#define GT_PALETTE_H

/* near-blacks / backgrounds */
#define GT_NIGHT   0xC8   /* rgb(4,32,23)    — near-black */
#define GT_DKBLUE  0xB1   /* rgb(16,52,103)  — deep blue backdrop */
#define GT_DKGREEN 0xF8   /* rgb(0,48,0)     — dark green */

/* greys / white */
#define GT_WHITE   0xA7   /* rgb(184,184,184) — light grey (use as white) */
#define GT_LTGREY  0xA7   /* rgb(184,184,184) */
#define GT_GREY    0xC4   /* rgb(115,115,115) — mid grey */

/* greens */
#define GT_GREEN   0xFF   /* rgb(133,208,102) — bright green */
#define GT_DKGRN   0xFB   /* rgb(44,117,11)   — dark green */
#define GT_LIME    0x1F   /* rgb(185,197,65)  — yellow-green */

/* cyans / teals */
#define GT_CYAN    0xDF   /* rgb(114,205,184) — aqua */
#define GT_TEAL    0xDC   /* rgb(45,136,115)  — teal */

/* blues */
#define GT_SKY     0xBF   /* rgb(135,192,255) — light sky blue */
#define GT_BLUE    0xBD   /* rgb(90,146,222)  — mid blue */
#define GT_NAVY    0xBB   /* rgb(44,100,176)  — navy */

/* indigos / violets / purples */
#define GT_INDIGO  0x9C   /* rgb(116,104,235) — periwinkle */
#define GT_VIOLET  0x9B   /* rgb(95,82,212)   — violet */
#define GT_PURPLE  0x7D   /* rgb(192,116,222) — purple */

/* pinks / magentas */
#define GT_PINK    0x7F   /* rgb(237,162,255) — light pink */
#define GT_MAGENTA 0x7D   /* rgb(192,116,222) — magenta */

/* roses / reds */
#define GT_ROSE    0x5E   /* rgb(234,140,162) — rose */
#define GT_RED     0x5A   /* rgb(142,51,72)   — dark red (the palette's reddest) */

/* golds / oranges / browns / yellow */
#define GT_GOLD    0x3F   /* rgb(237,178,98)  — bright gold */
#define GT_ORANGE  0x3D   /* rgb(191,134,53)  — orange */
#define GT_BROWN   0x3B   /* rgb(146,89,9)    — brown */
#define GT_YELLOW  0x3F   /* rgb(237,178,98)  — (gold doubles as yellow) */

#endif /* GT_PALETTE_H */
