/* n64.c — N64 helpers + software 3D pipeline (see n64.h). Framebuffer backend. */
#include "n64.h"

/* Two 320x240x16bpp framebuffers in RDRAM (double-buffered), cached kseg0. */
#define FB0 0xA0100000u  /* uncached kseg1 — writes go straight to RDRAM */
#define FB1 0xA0120000u
static volatile unsigned short *fb;   /* the back buffer we draw into */
static unsigned int front;

/* VI registers (0xA4400000). */
#define VI(n) (*(volatile unsigned int*)(0xA4400000u + (n)*4))
#define VI_STATUS 0
#define VI_ORIGIN 1
#define VI_WIDTH  2
#define VI_V_CURRENT 4
#define VI_H_START 9
#define VI_V_START 10
#define VI_X_SCALE 12
#define VI_Y_SCALE 13

void n64_init(void)
{
    /* NTSC 320x240 16bpp — register indices per the N64 VI map:
       0=STATUS 1=ORIGIN 2=WIDTH 3=V_INTR 4=CURRENT 5=BURST 6=V_SYNC 7=H_SYNC
       8=LEAP 9=H_START 10=V_START 11=V_BURST 12=X_SCALE 13=Y_SCALE. */
    VI(0)  = 0x0000320E;   /* STATUS: 16bpp(type=2) + AA + dither + pixel_advance */
    VI(2)  = 320;          /* WIDTH */
    VI(3)  = 2;            /* V_INTR */
    VI(4)  = 0;            /* CURRENT */
    VI(5)  = 0x03E52239;   /* BURST (NTSC) */
    VI(6)  = 0x0000020D;   /* V_SYNC = 525 */
    VI(7)  = 0x00000C15;   /* H_SYNC */
    VI(8)  = 0x0C150C15;   /* LEAP */
    VI(9)  = 0x006C02EC;   /* H_START: 108..748 */
    VI(10) = 0x002501FF;   /* V_START: 37..511 */
    VI(11) = 0x000E0204;   /* V_BURST */
    VI(12) = 0x00000200;   /* X_SCALE (320) */
    VI(13) = 0x00000400;   /* Y_SCALE (240) */
    front = FB0;
    fb = (volatile unsigned short *)FB1;
    VI(1) = FB0 & 0x1FFFFFFF;   /* ORIGIN */
}

static inline void putpx(int x, int y, unsigned short c)
{
    if ((unsigned)x < SCREEN_W && (unsigned)y < SCREEN_H) fb[y * SCREEN_W + x] = c;
}

void n64_clear(unsigned short col)
{
    int i; for (i = 0; i < SCREEN_W * SCREEN_H; i++) fb[i] = col;
}

void n64_rect(int x, int y, int w, int h, unsigned short col)
{
    int r, c;
    for (r = 0; r < h; r++) for (c = 0; c < w; c++) putpx(x + c, y + r, col);
}

/* edge function for the rasterizer */
static inline int edge(int ax, int ay, int bx, int by, int cx, int cy)
{ return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); }

void n64_tri2d(int x0,int y0,int x1,int y1,int x2,int y2,unsigned short col)
{
    int minx = x0, maxx = x0, miny = y0, maxy = y0, px, py, w0, w1, w2, area;
    if (x1 < minx) minx = x1; if (x1 > maxx) maxx = x1;
    if (x2 < minx) minx = x2; if (x2 > maxx) maxx = x2;
    if (y1 < miny) miny = y1; if (y1 > maxy) maxy = y1;
    if (y2 < miny) miny = y2; if (y2 > maxy) maxy = y2;
    if (minx < 0) minx = 0; if (miny < 0) miny = 0;
    if (maxx >= SCREEN_W) maxx = SCREEN_W - 1; if (maxy >= SCREEN_H) maxy = SCREEN_H - 1;
    area = edge(x0, y0, x1, y1, x2, y2);
    if (area == 0) return;
    for (py = miny; py <= maxy; py++) {
        for (px = minx; px <= maxx; px++) {
            w0 = edge(x1, y1, x2, y2, px, py);
            w1 = edge(x2, y2, x0, y0, px, py);
            w2 = edge(x0, y0, x1, y1, px, py);
            if (area > 0) { if (w0 >= 0 && w1 >= 0 && w2 >= 0) fb[py * SCREEN_W + px] = col; }
            else          { if (w0 <= 0 && w1 <= 0 && w2 <= 0) fb[py * SCREEN_W + px] = col; }
        }
    }
}

void n64_flip(void)
{
    /* swap buffers + point VI at the freshly drawn one, then wait for a frame. */
    unsigned int newfront = (unsigned int)(unsigned long)fb;
    VI(1) = newfront & 0x1FFFFFFF;
    fb = (volatile unsigned short *)(front);
    front = newfront;
    { volatile int i; for (i = 0; i < 200000; i++) { } }
}

/* ── input: read controller port 0 via the SI/PIF. The PIF command 0x01 polls
   the pad; the 16-bit button word is at PIF RAM. We use the simple JoyBus poll. ── */
static unsigned int read_pad(void)
{
    volatile unsigned int *pif = (volatile unsigned int *)0xBFC007C0; /* PIF RAM */
    volatile unsigned int *si  = (volatile unsigned int *)0xA4800000;
    unsigned int buttons;
    /* command block: read controller 0 (1 byte cmd 0x01, 1 byte send, ...) */
    pif[0] = 0xFF010401; pif[1] = 0xFFFFFFFF; pif[2] = 0xFFFFFFFF;
    pif[3] = 0xFE000000; pif[4] = 0; pif[5] = 0; pif[6] = 0; pif[7] = 1;
    si[1] = 0x1FC007C0;          /* SI_PIF_ADDR_RD64B: kick the PIF read */
    { volatile int t; for (t = 0; t < 5000; t++) { } }
    buttons = pif[1] >> 16;      /* the button half-word */
    return (~0u) & buttons;      /* JoyBus buttons are active-high already */
}
unsigned int n64_pad(void) { return read_pad(); }
int n64_pressed(unsigned int mask) { return (n64_pad() & mask) ? 1 : 0; }

/* ── trig (shared with PS1 lib: 256-step binary angle) ── */
static const short SINTAB[64] = {
0,804,1608,2410,3212,4011,4808,5602,6393,7179,7962,8739,9512,10278,11039,11793,
12539,13279,14010,14732,15446,16151,16846,17530,18204,18868,19519,20159,20787,21403,
22005,22594,23170,23731,24279,24811,25329,25832,26319,26790,27245,27683,28105,28510,
28898,29268,29621,29956,30273,30571,30852,31113,31356,31580,31785,31971,32137,32285,
32412,32521,32609,32678,32728,32757 };
static fix sin_lut(int idx) {
    int q = (idx >> 6) & 3, p = idx & 63; int v;
    if (q == 0) v = SINTAB[p]; else if (q == 1) v = SINTAB[63 - p];
    else if (q == 2) v = -SINTAB[p]; else v = -SINTAB[63 - p];
    return ((fix)v << 16) / 32768;
}
fix n64_sin(fix a) { return sin_lut((F2I(a)) & 255); }
fix n64_cos(fix a) { return sin_lut((F2I(a) + 64) & 255); }

/* ── camera + model (identical to the PS1 lib) ── */
static fix cam_x, cam_y, cam_z, cam_cy, cam_sy, cam_cp, cam_sp;
static fix mdl_x, mdl_y, mdl_z, mdl_cy, mdl_sy;
void n64_camera(fix ex, fix ey, fix ez, fix yaw, fix pitch)
{ cam_x=ex;cam_y=ey;cam_z=ez; cam_cy=n64_cos(yaw);cam_sy=n64_sin(yaw); cam_cp=n64_cos(pitch);cam_sp=n64_sin(pitch); }
void n64_model(fix tx, fix ty, fix tz, fix yaw)
{ mdl_x=tx;mdl_y=ty;mdl_z=tz; mdl_cy=n64_cos(yaw);mdl_sy=n64_sin(yaw); }

static Vec3 to_cam(Vec3 v)
{
    fix mx = FMUL(v.x, mdl_cy) + FMUL(v.z, mdl_sy);
    fix mz = -FMUL(v.x, mdl_sy) + FMUL(v.z, mdl_cy);
    fix wx = mx + mdl_x, wy = v.y + mdl_y, wz = mz + mdl_z;
    fix rx = wx - cam_x, ry = wy - cam_y, rz = wz - cam_z;
    fix cx = FMUL(rx, cam_cy) - FMUL(rz, cam_sy);
    fix cz = FMUL(rx, cam_sy) + FMUL(rz, cam_cy);
    fix cy = FMUL(ry, cam_cp) - FMUL(cz, cam_sp);
    fix cz2 = FMUL(ry, cam_sp) + FMUL(cz, cam_cp);
    Vec3 o; o.x = cx; o.y = cy; o.z = cz2; return o;
}
#define NEAR FIXF(0.5f)
#define FOV  FIX(220)
static int project(Vec3 c, int *sx, int *sy)
{
    if (c.z <= NEAR) return 0;
    *sx = (SCREEN_W / 2) + F2I(FDIV(FMUL(c.x, FOV), c.z));
    *sy = (SCREEN_H / 2) - F2I(FDIV(FMUL(c.y, FOV), c.z));
    return 1;
}
void n64_tri3d(Vec3 a, Vec3 b, Vec3 c, unsigned short col)
{
    Vec3 ca=to_cam(a), cb=to_cam(b), cc=to_cam(c);
    int x0,y0,x1,y1,x2,y2;
    if (!project(ca,&x0,&y0)||!project(cb,&x1,&y1)||!project(cc,&x2,&y2)) return;
    if ((x1-x0)*(y2-y0)-(x2-x0)*(y1-y0) <= 0) return; /* back-face cull */
    n64_tri2d(x0,y0,x1,y1,x2,y2,col);
}
void n64_quad3d(Vec3 a, Vec3 b, Vec3 c, Vec3 d, unsigned short col)
{ n64_tri3d(a,b,c,col); n64_tri3d(a,c,d,col); }
void n64_tri3d_nc(Vec3 a, Vec3 b, Vec3 c, unsigned short col)
{
    Vec3 ca=to_cam(a), cb=to_cam(b), cc=to_cam(c);
    int x0,y0,x1,y1,x2,y2;
    if (!project(ca,&x0,&y0)||!project(cb,&x1,&y1)||!project(cc,&x2,&y2)) return;
    n64_tri2d(x0,y0,x1,y1,x2,y2,col);
}
void n64_quad3d_nc(Vec3 a, Vec3 b, Vec3 c, Vec3 d, unsigned short col)
{ n64_tri3d_nc(a,b,c,col); n64_tri3d_nc(a,c,d,col); }

/* ── RNG ── */
static unsigned int rng = 0x12345678u;
void n64_srand(unsigned int s) { rng = s ? s : 1; }
unsigned int n64_rand(void) { unsigned int x=rng; x^=x<<13; x^=x>>17; x^=x<<5; return rng=x; }

/* ── HUD number (3x5 cells scaled) ── */
static const unsigned char DIG[10][5] = {
 {0x7,0x5,0x5,0x5,0x7},{0x2,0x6,0x2,0x2,0x7},{0x7,0x1,0x7,0x4,0x7},{0x7,0x1,0x3,0x1,0x7},
 {0x5,0x5,0x7,0x1,0x1},{0x7,0x4,0x7,0x1,0x7},{0x7,0x4,0x7,0x5,0x7},{0x7,0x1,0x1,0x1,0x1},
 {0x7,0x5,0x7,0x5,0x7},{0x7,0x5,0x7,0x1,0x7} };
static void digit(int x,int y,int d,unsigned short col)
{ int r,c; for(r=0;r<5;r++)for(c=0;c<3;c++) if(DIG[d][r]&(1<<(2-c))) n64_rect(x+c*3,y+r*3,3,3,col); }
void n64_number(int x, int y, unsigned int value, unsigned short col)
{
    char buf[10]; int n=0,i;
    if(!value)buf[n++]=0; while(value&&n<10){buf[n++]=value%10;value/=10;}
    for(i=0;i<n;i++) digit(x+(n-1-i)*12,y,buf[i],col);
}
