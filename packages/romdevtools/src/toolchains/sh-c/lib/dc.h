/* dc.h — minimal Dreamcast helper for romdev homebrew.
 *
 * Brings up the PowerVR2 video output for a plain 640x480 RGB565 framebuffer and
 * exposes pixel/fill/rect primitives. No KallistiOS dependency — just the registers
 * the Flycast (reios HLE) core needs to scan out a direct framebuffer.
 *
 * Memory map:
 *   PVR/HOLLY registers : 0xA05F8000 (uncached)
 *   VRAM (64-bit area)  : 0xA5000000 (16 MB) — the framebuffer lives here
 *
 * The DC has two VRAM views; the 64-bit area (0xA5000000) is the linear one we draw to.
 */
#ifndef ROMDEV_DC_H
#define ROMDEV_DC_H

typedef unsigned char  u8;
typedef unsigned short u16;
typedef unsigned int   u32;

#define DC_W 640
#define DC_H 480

/* PVR register access */
#define PVR_BASE 0xA05F8000u
#define PVR_REG(off) (*(volatile u32 *)(PVR_BASE + (off)))

/* The framebuffer we draw to (offset 0 in the 64-bit VRAM area). */
#define DC_FB_OFFSET 0x000000u
#define DC_VRAM ((volatile u16 *)(0xA5000000u + DC_FB_OFFSET))

/* RGB565 helper */
static inline u16 dc_rgb(u8 r, u8 g, u8 b) {
    return (u16)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}

/* Bring up 640x480 RGB565 video. Call once at start. The register values are the
 * documented PowerVR2 settings for a progressive NTSC 640x480 RGB565 framebuffer;
 * Flycast's reios + EmulateFramebuffer scanout reads FB_R_CTRL/FB_R_SIZE/FB_R_SOF1. */
static inline void dc_video_init(void) {
    /* FB_R_CTRL: fb_enable=1, fb_depth=1 (RGB565), fb_concat=4 (fill low bits). */
    PVR_REG(0x044) = 0x00000001u | (1u << 2) | (4u << 4); /* = 0x45 */
    /* FB_W_CTRL: fb_packmode=1 (RGB565). */
    PVR_REG(0x048) = 0x00000001u;
    /* FB_R_SOF1 / FB_W_SOF1: framebuffer start = DC_FB_OFFSET. */
    PVR_REG(0x050) = DC_FB_OFFSET;          /* FB_R_SOF1 */
    PVR_REG(0x060) = DC_FB_OFFSET;          /* FB_W_SOF1 */
    /* FB_R_SIZE: fb_x_size = (line bytes / 4) - 1, fb_y_size = lines - 1, modulus = 1.
     * 640px * 2 bytes = 1280 bytes/line -> 1280/4 - 1 = 319. */
    PVR_REG(0x05C) = (u32)(DC_W * 2 / 4 - 1)        /* fb_x_size = 319 */
                   | ((u32)(DC_H - 1) << 10)        /* fb_y_size = 479 */
                   | ((u32)1u << 20);               /* fb_modulus = 1 */
    /* FB_W_LINESTRIDE: line stride in 64-bit (8-byte) units = 1280/8 = 160. */
    PVR_REG(0x11C) = (u32)(DC_W * 2 / 8);
    /* VO_CONTROL: pixel double off, normal output. */
    PVR_REG(0x0E8) = 0x00000000u;
    /* VO_BORDER_COL: black border. */
    PVR_REG(0x040) = 0x00000000u;
    /* SPG_LOAD / SPG_CONTROL: NTSC 640x480 progressive timing. */
    PVR_REG(0x0D8) = (524u << 16) | 857u;   /* SPG_LOAD: vcount, hcount */
    PVR_REG(0x0D0) = 0x00000000u;           /* SPG_CONTROL: NTSC, non-interlace */
}

/* Plot a pixel (no bounds clamp on the hot path; caller keeps in range). */
static inline void dc_plot(int x, int y, u16 c) {
    DC_VRAM[y * DC_W + x] = c;
}

/* Fill the whole framebuffer with one color. */
static inline void dc_clear(u16 c) {
    int i;
    for (i = 0; i < DC_W * DC_H; i++)
        DC_VRAM[i] = c;
}

/* Fill an axis-aligned rectangle (clipped to the screen). */
static inline void dc_rect(int x0, int y0, int w, int h, u16 c) {
    int x, y;
    if (x0 < 0) { w += x0; x0 = 0; }
    if (y0 < 0) { h += y0; y0 = 0; }
    if (x0 + w > DC_W) w = DC_W - x0;
    if (y0 + h > DC_H) h = DC_H - y0;
    for (y = 0; y < h; y++)
        for (x = 0; x < w; x++)
            DC_VRAM[(y0 + y) * DC_W + (x0 + x)] = c;
}

/* ── Controller input (Maple bus, port 0) ─────────────────────────────────────
 * The DC Maple controller digital-button bit layout. Full Maple DMA setup is
 * non-trivial; the romdev host injects input (setInput) that the core maps onto
 * Maple, so these constants document the bit layout for game logic. */
#define DC_BTN_C      0x0001
#define DC_BTN_B      0x0002
#define DC_BTN_A      0x0004
#define DC_BTN_START  0x0008
#define DC_BTN_UP     0x0010
#define DC_BTN_DOWN   0x0020
#define DC_BTN_LEFT   0x0040
#define DC_BTN_RIGHT  0x0080
#define DC_BTN_Y      0x0200
#define DC_BTN_X      0x0400

#endif /* ROMDEV_DC_H */
