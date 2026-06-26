/* psx.c — PS1 helpers + software 3D pipeline (see psx.h). */
#include "psx.h"

/* ── GPU bring-up ── */
void psx_init(void)
{
    GP1 = 0x00000000u;                     /* reset */
    GP1 = 0x08000001u;                     /* display mode 320x240 NTSC 15bpp */
    GP1 = 0x03000000u;                     /* display enable (arg 0 = on) */
    GP1 = 0x05000000u;                     /* display start (0,0) */
    GP1 = 0x06000000u | (0x260u | ((0x260u + 320u*8u) << 12));
    GP1 = 0x07000000u | (16u | ((16u + 240u) << 10));
    GP0 = 0xE3000000u;                      /* draw area TL (0,0) */
    GP0 = 0xE4000000u | (319u) | (239u << 10); /* draw area BR */
    GP0 = 0xE5000000u;                      /* draw offset (0,0) */
}

void psx_clear(unsigned int bgr) {
    /* GP0 0x02 = fast fill of a VRAM rectangle (ignores draw area, no blending). */
    GP0 = 0x02000000u | (bgr & 0x00FFFFFFu);
    GP0 = 0; /* (x,y) = (0,0) */
    GP0 = (240u << 16) | 320u; /* (h,w) */
}

void psx_rect(int x, int y, int w, int h, unsigned int bgr)
{
    GP0 = 0x60000000u | (bgr & 0x00FFFFFFu);
    GP0 = ((unsigned)(y) << 16) | ((unsigned)(x) & 0xFFFF);
    GP0 = ((unsigned)(y) << 16) | ((unsigned)(x + w) & 0xFFFF);
    GP0 = ((unsigned)(y + h) << 16) | ((unsigned)(x) & 0xFFFF);
    GP0 = ((unsigned)(y + h) << 16) | ((unsigned)(x + w) & 0xFFFF);
}

void psx_tri2d(int x0,int y0,int x1,int y1,int x2,int y2,unsigned int bgr)
{
    GP0 = 0x20000000u | (bgr & 0x00FFFFFFu); /* flat opaque triangle */
    GP0 = ((unsigned)(y0)<<16)|((unsigned)(x0)&0xFFFF);
    GP0 = ((unsigned)(y1)<<16)|((unsigned)(x1)&0xFFFF);
    GP0 = ((unsigned)(y2)<<16)|((unsigned)(x2)&0xFFFF);
}

void psx_vsync(void) { volatile int i; for (i = 0; i < 60000; i++) { } }

/* ── input: read controller port 0 via the SIO (the way real PS1 homebrew does;
   the HLE core feeds host input into this SIO emulation). The digital pad reply
   is 0x5A then two button bytes (active-LOW). We return active-HIGH. ── */
#define SIO_DATA (*(volatile unsigned char*)0x1F801040)
#define SIO_STAT (*(volatile unsigned short*)0x1F801044)
#define SIO_CTRL (*(volatile unsigned short*)0x1F80104A)
#define SIO_BAUD (*(volatile unsigned short*)0x1F80104E)
#define SIO_MODE (*(volatile unsigned short*)0x1F801048)

static unsigned char sio_xfer(unsigned char out) {
    volatile int t;
    while (!(SIO_STAT & 0x4)) { } /* TX ready */
    SIO_DATA = out;
    for (t = 0; t < 200; t++) { } /* settle */
    while (!(SIO_STAT & 0x2)) { } /* RX ready */
    return SIO_DATA;
}

unsigned int psx_pad(void) {
    unsigned char b0, b1; volatile int t;
    /* init SIO for controller (8N1, ~250kbps) */
    SIO_MODE = 0x000D; SIO_BAUD = 0x0088; SIO_CTRL = 0x1003; /* TX/RX en + DTR + port0 */
    sio_xfer(0x01);          /* address: controller */
    if (sio_xfer(0x42) == 0xFF) { SIO_CTRL = 0; return 0; } /* request data; 0xFF=no pad */
    sio_xfer(0x00);          /* discard 0x5A */
    b0 = sio_xfer(0x00);     /* buttons lo (active-low) */
    b1 = sio_xfer(0x00);     /* buttons hi (active-low) */
    SIO_CTRL = 0;            /* deselect */
    for (t = 0; t < 100; t++) { }
    return (~((unsigned int)b0 | ((unsigned int)b1 << 8))) & 0xFFFF; /* → active-high */
}
int psx_pressed(unsigned int mask) { return (psx_pad() & mask) ? 1 : 0; }

/* ── trig: 256-entry quarter→full sine, arg in "binary angle" 16.16 where
   FIX(256) = one full turn. ── */
static const short SINTAB[64] = {
0,804,1608,2410,3212,4011,4808,5602,6393,7179,7962,8739,9512,10278,11039,11793,
12539,13279,14010,14732,15446,16151,16846,17530,18204,18868,19519,20159,20787,21403,
22005,22594,23170,23731,24279,24811,25329,25832,26319,26790,27245,27683,28105,28510,
28898,29268,29621,29956,30273,30571,30852,31113,31356,31580,31785,31971,32137,32285,
32412,32521,32609,32678,32728,32757 };
static fix sin_lut(int idx) { /* idx 0..255 → 16.16 sine */
    int q = (idx >> 6) & 3, p = idx & 63; int v;
    if (q == 0) v = SINTAB[p];
    else if (q == 1) v = SINTAB[63 - p];
    else if (q == 2) v = -SINTAB[p];
    else v = -SINTAB[63 - p];
    return ((fix)v << 16) / 32768; /* normalize to 16.16 (~1.0 peak) */
}
fix psx_sin(fix a) { return sin_lut((F2I(a)) & 255); }
fix psx_cos(fix a) { return sin_lut((F2I(a) + 64) & 255); }

/* ── camera + model state ── */
static fix cam_x, cam_y, cam_z, cam_cy, cam_sy, cam_cp, cam_sp;
static fix mdl_x, mdl_y, mdl_z, mdl_cy, mdl_sy;

void psx_camera(fix ex, fix ey, fix ez, fix yaw, fix pitch)
{
    cam_x = ex; cam_y = ey; cam_z = ez;
    cam_cy = psx_cos(yaw); cam_sy = psx_sin(yaw);
    cam_cp = psx_cos(pitch); cam_sp = psx_sin(pitch);
}
void psx_model(fix tx, fix ty, fix tz, fix yaw)
{
    mdl_x = tx; mdl_y = ty; mdl_z = tz;
    mdl_cy = psx_cos(yaw); mdl_sy = psx_sin(yaw);
}

/* model-space vertex → camera space (16.16). */
static Vec3 to_cam(Vec3 v)
{
    /* model yaw (around Y) + translate */
    fix mx = FMUL(v.x, mdl_cy) + FMUL(v.z, mdl_sy);
    fix mz = -FMUL(v.x, mdl_sy) + FMUL(v.z, mdl_cy);
    fix wx = mx + mdl_x, wy = v.y + mdl_y, wz = mz + mdl_z;
    /* world → relative to camera */
    fix rx = wx - cam_x, ry = wy - cam_y, rz = wz - cam_z;
    /* camera yaw */
    fix cx = FMUL(rx, cam_cy) - FMUL(rz, cam_sy);
    fix cz = FMUL(rx, cam_sy) + FMUL(rz, cam_cy);
    /* camera pitch */
    fix cy = FMUL(ry, cam_cp) - FMUL(cz, cam_sp);
    fix cz2 = FMUL(ry, cam_sp) + FMUL(cz, cam_cp);
    Vec3 o; o.x = cx; o.y = cy; o.z = cz2; return o;
}

/* perspective project camera-space → screen. returns 0 if behind/near plane. */
#define NEAR FIXF(0.5f)
#define FOV  FIX(220)   /* focal length in pixels-ish */
static int project(Vec3 c, int *sx, int *sy)
{
    if (c.z <= NEAR) return 0;
    fix sxf = FDIV(FMUL(c.x, FOV), c.z);
    fix syf = FDIV(FMUL(c.y, FOV), c.z);
    *sx = (SCREEN_W / 2) + F2I(sxf);
    *sy = (SCREEN_H / 2) - F2I(syf);
    return 1;
}

fix psx_depth3(Vec3 a, Vec3 b, Vec3 c)
{ Vec3 ca=to_cam(a), cb=to_cam(b), cc=to_cam(c); return (ca.z + cb.z + cc.z) / 3; }
fix psx_depth4(Vec3 a, Vec3 b, Vec3 c, Vec3 d)
{ Vec3 ca=to_cam(a),cb=to_cam(b),cc=to_cam(c),cd=to_cam(d); return (ca.z+cb.z+cc.z+cd.z)/4; }

void psx_tri3d(Vec3 a, Vec3 b, Vec3 c, unsigned int bgr)
{
    Vec3 ca=to_cam(a), cb=to_cam(b), cc=to_cam(c);
    int x0,y0,x1,y1,x2,y2;
    if (!project(ca,&x0,&y0) || !project(cb,&x1,&y1) || !project(cc,&x2,&y2)) return;
    /* back-face cull (screen-space cross product) */
    int cross = (x1-x0)*(y2-y0) - (x2-x0)*(y1-y0);
    if (cross <= 0) return;
    psx_tri2d(x0,y0,x1,y1,x2,y2,bgr);
}

void psx_quad3d(Vec3 a, Vec3 b, Vec3 c, Vec3 d, unsigned int bgr)
{
    /* split into two tris; both share the back-face test inside */
    psx_tri3d(a,b,c,bgr);
    psx_tri3d(a,c,d,bgr);
}

/* ── RNG (xorshift) ── */
static unsigned int rng_state = 0x12345678u;
void psx_srand(unsigned int s) { rng_state = s ? s : 1; }
unsigned int psx_rand(void)
{ unsigned int x = rng_state; x ^= x << 13; x ^= x >> 17; x ^= x << 5; return rng_state = x; }

/* ── blocky decimal number (3x5 cells scaled to 8x10), for HUD/score ── */
static const unsigned char DIGITS[10][5] = {
 {0x7,0x5,0x5,0x5,0x7},{0x2,0x6,0x2,0x2,0x7},{0x7,0x1,0x7,0x4,0x7},{0x7,0x1,0x3,0x1,0x7},
 {0x5,0x5,0x7,0x1,0x1},{0x7,0x4,0x7,0x1,0x7},{0x7,0x4,0x7,0x5,0x7},{0x7,0x1,0x1,0x1,0x1},
 {0x7,0x5,0x7,0x5,0x7},{0x7,0x5,0x7,0x1,0x7} };
static void draw_digit(int x, int y, int d, unsigned int bgr)
{
    int r, c;
    for (r = 0; r < 5; r++)
        for (c = 0; c < 3; c++)
            if (DIGITS[d][r] & (1 << (2 - c)))
                psx_rect(x + c*3, y + r*3, 3, 3, bgr);
}
void psx_number(int x, int y, unsigned int value, unsigned int bgr)
{
    char buf[10]; int n = 0, i;
    if (value == 0) buf[n++] = 0;
    while (value && n < 10) { buf[n++] = value % 10; value /= 10; }
    for (i = 0; i < n; i++) draw_digit(x + (n-1-i)*12, y, buf[i], bgr);
}
