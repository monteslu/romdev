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
    /* SPG_LOAD / SPG_CONTROL: NTSC 640x480 INTERLACED (480i). Non-interlace (240p)
     * only displays 240 lines, so the top half of a 480-line framebuffer never shows.
     * interlace=1 outputs the full 480-line image. */
    PVR_REG(0x0D8) = (524u << 16) | 857u;   /* SPG_LOAD: vcount, hcount */
    PVR_REG(0x0D0) = 0x00000050u;           /* SPG_CONTROL: NTSC, interlace=1 (bit4), PAL=0 */
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
 * Digital-button bits, matching Flycast's DC kcode (active-LOW on the wire — a bit
 * is 0 when pressed). dc_pad() does a real Maple "Get Condition" DMA, inverts the
 * kcode to active-HIGH, and masks to the real button bits. The romdev host's
 * setInput drives the emulated pad. */
#define DC_BTN_C      (1u << 0)
#define DC_BTN_B      (1u << 1)
#define DC_BTN_A      (1u << 2)
#define DC_BTN_START  (1u << 3)
#define DC_BTN_UP     (1u << 4)
#define DC_BTN_DOWN   (1u << 5)
#define DC_BTN_LEFT   (1u << 6)
#define DC_BTN_RIGHT  (1u << 7)
#define DC_BTN_Y      (1u << 9)
#define DC_BTN_X      (1u << 10)
/* only the bits above are real digital buttons; mask out reserved bits on read. */
#define DC_BTN_MASK   0x06FFu

/* Maple DMA registers (Holly system bus). */
#define DC_SB(o)   (*(volatile u32 *)(0xA05F6C00u + (o)))
#define DC_MDSTAR  0x04   /* command-table address */
#define DC_MDEN    0x14   /* DMA enable */
#define DC_MDST    0x18   /* DMA start */

/* Read controller port 0 via a Maple "Get Condition" DMA. Builds a one-shot command
 * frame (recipient = port-0 controller AP 0x20, cmd 0x09 GetCondition, function =
 * controller 0x01000000), points the recv buffer at a scratch, kicks the DMA, then
 * scans the response for the controller's function-id marker (0x01000000) and reads
 * the 16-bit kcode that immediately follows. kcode is active-LOW on the wire, so we
 * invert + mask to the real button bits → DC_BTN_* set == pressed.
 *
 * NOTE: the exact word offset of the kcode in the recv frame can vary; we locate it
 * by the MFID marker rather than a fixed index, which is robust across the response
 * framing. Returns 0 if no controller response is found. */
static inline u32 dc_pad(void) {
    static volatile u32 cmd[8] __attribute__((aligned(32)));
    static volatile u32 rsp[16] __attribute__((aligned(32)));
    u32 phys_cmd = ((u32)(unsigned long)cmd) & 0x1FFFFFFF;
    u32 phys_rsp = ((u32)(unsigned long)rsp) & 0x1FFFFFFF;
    int i;
    for (i = 0; i < 16; i++) rsp[i] = 0;
    cmd[0] = 0x80000000u;             /* last xfer (bit31), op=START(0), frame len-1=0 */
    cmd[1] = phys_rsp;                /* receive address */
    cmd[2] = (1u << 24)               /* data length in words (1) */
           | (0x20u << 16)            /* sender address */
           | (0x20u << 8)             /* recipient: port 0 controller (AP 0x20) */
           | 0x09u;                   /* command: Get Condition */
    cmd[3] = 0x01000000u;             /* function: controller */
    DC_SB(DC_MDEN) = 1;
    DC_SB(DC_MDSTAR) = phys_cmd;
    DC_SB(DC_MDST) = 1;               /* synchronous under the romdev/HLE core */
    /* find the controller function-id (0x01000000) in the response; the kcode is the
     * next word's low half. The response data starts after the frame header word. */
    for (i = 0; i < 15; i++) {
        if (rsp[i] == 0x01000000u) {
            u32 kcode = rsp[i + 1] & 0xFFFF;
            return ((~kcode) & DC_BTN_MASK);
        }
    }
    return 0;
}
static inline int dc_pressed(u32 mask) { return (dc_pad() & mask) ? 1 : 0; }

#endif /* ROMDEV_DC_H */
