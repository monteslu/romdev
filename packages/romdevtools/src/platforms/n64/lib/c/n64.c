/* n64.c — N64 helpers with a GPU (RDP/GBI) drawing backend.
 *
 * WHY THIS IS NOT A SOFTWARE RASTERIZER: the shipping N64 core renders through
 * glide64 (a GL HLE plugin) — it presents the game's RDP/GBI **display lists** on
 * the real GPU, NOT a raw CPU-written framebuffer. A software rasterizer that pokes
 * pixels into RDRAM shows BLACK on glide64 (and would be <1fps even if it didn't).
 * So this lib builds a GBI display list each frame and kicks the RSP/RDP; glide64
 * HLEs it onto the GPU.
 *
 * HOW glide64 ACCEPTS OUR LIST (no Nintendo microcode shipped):
 *  - The RSP-HLE treats an OSTask with type==1 (M_GFXTASK) as a graphics task and
 *    hands the display list to glide64.
 *  - glide64 picks its command table by CRC-summing 3072 bytes of the task's
 *    "ucode" region and matching a known-ucode CRC. The bytes are NEVER executed
 *    (HLE), only summed — so we embed a 3072-byte blob that SUMS to a real F3DEX2
 *    CRC (0x5d3099f1). glide64 then interprets our list as standard F3DEX2.
 *  - We emit standard F3DEX2 GBI: set color image / scissor / fill rectangles for
 *    clear+rects, and shaded vertex triangles for tri2d/tri3d. Solid colors only.
 */
#include "n64.h"

/* ── RCP register blocks ── */
#define SP(n)  (*(volatile unsigned int*)(0xA4040000u + (n)*4))  /* RSP */
#define DP(n)  (*(volatile unsigned int*)(0xA4100000u + (n)*4))  /* RDP cmd */
#define VI(n)  (*(volatile unsigned int*)(0xA4400000u + (n)*4))  /* video */

#define SP_MEM_ADDR  0   /* SP DMEM/IMEM address */
#define SP_DRAM_ADDR 1
#define SP_RD_LEN    2
#define SP_WR_LEN    3
#define SP_STATUS    4

#define FB_ADDR 0x00200000u     /* 320x240x16bpp color image in RDRAM */
#define DL_ADDR 0x00280000u     /* the GBI display list buffer (room for many spans) */
#define UC_ADDR 0x00290000u     /* the fake "ucode" blob (CRC bait) */

/* uncached pointers (kseg1) into those RDRAM regions */
#define U16P(a) ((volatile unsigned short*)(0xA0000000u | (a)))
#define U32P(a) ((volatile unsigned int*)  (0xA0000000u | (a)))

static volatile unsigned int *dl;   /* write cursor into the display list */
static unsigned int dl_count;       /* words written */

/* ── GBI / F3DEX2 command opcodes (the ones the fill-rect path uses) ── */
#define G_ENDDL          0xDF
#define G_SETOTHERMODE_H 0xE3
#define G_RDPPIPESYNC    0xE7
#define G_RDPFULLSYNC    0xE9
#define G_SETSCISSOR     0xED
#define G_FILLRECT       0xF6
#define G_SETFILLCOLOR   0xF7
#define G_SETCIMG        0xFF

static inline void dl_w(unsigned int w0, unsigned int w1)
{ dl[dl_count++] = w0; dl[dl_count++] = w1; }

void n64_init(void)
{
    int i;
    /* NTSC 320x240 16bpp VI setup, scanning out FB_ADDR — glide64 reads our color
       image from the SetColorImage GBI cmd, but the VI must still be programmed so
       there is a valid display target. */
    VI(0)  = 0x0000320E; VI(2) = 320; VI(3) = 2; VI(5) = 0x03E52239;
    VI(6)  = 0x0000020D; VI(7) = 0x00000C15; VI(8) = 0x0C150C15;
    VI(9)  = 0x006C02EC; VI(10)= 0x002501FF; VI(11)= 0x000E0204;
    VI(12) = 0x00000200; VI(13)= 0x00000400;
    VI(1)  = FB_ADDR;

    /* Build the CRC-bait "ucode": 3072 bytes that SUM (as u32 words) to the
       F3DEX2 microcode CRC glide64 expects (0x5d3099f1 in its ucode table).
       All words 0 except one. */
    { volatile unsigned int *uc = U32P(UC_ADDR);
      for (i = 0; i < 3072/4; i++) uc[i] = 0;
      uc[0] = 0x5d3099f1u; }
}

/* Begin a fresh display list for this frame: sync + set the color image + scissor +
   fill cycle, and a default combine that passes the fill/shade through. */
static void dl_begin(void)
{
    dl = U32P(DL_ADDR);
    dl_count = 0;
    dl_w((G_RDPPIPESYNC << 24), 0);
    /* SetColorImage: fmt=0(RGBA) size=2(16b) width-1=319, addr=FB */
    dl_w((G_SETCIMG << 24) | (0 << 21) | (2 << 19) | 319, FB_ADDR);
    /* SetScissor: (0,0)-(320,240) in 10.2 fixed (<<2) */
    dl_w((G_SETSCISSOR << 24) | (0 << 12) | 0, (320 << 14) | (240 << 2));
    /* SetOtherMode_H: cycle type = FILL (3<<20 within the H word). F3DEX2 form:
       shift=0x14(20) len=2 → set the 2 cycle-type bits to 3 (G_CYC_FILL). */
    dl_w((G_SETOTHERMODE_H << 24) | ((32 - 20 - 2) << 8) | (2 - 1), 3u << 20);
}

/* End the list with sync + ENDDL, then ship it to the RSP/RDP as a GFX OSTask. */
static void dl_end_and_run(void)
{
    dl_w((G_RDPFULLSYNC << 24), 0);
    dl_w((G_ENDDL << 24), 0);

    /* Write the OSTask into SP DMEM at 0xFC0 (SP DMEM is at 0xA4000000). */
    volatile unsigned int *task = (volatile unsigned int *)0xA4000FC0u;
    task[0] = 1;          /* 0xFC0 TASK_TYPE = M_GFXTASK (glide64 path) */
    task[1] = 0;          /* 0xFC4 flags */
    task[2] = 0;          /* 0xFC8 ucode_boot */
    task[3] = 0;          /* 0xFCC ucode_boot_size */
    task[4] = UC_ADDR;    /* 0xFD0 ucode (CRC-summed by glide64) */
    task[5] = 0xC00;      /* 0xFD4 ucode_size (>= 3072 so the full CRC region reads) */
    task[6] = UC_ADDR;    /* 0xFD8 ucode_data */
    task[7] = 0x800;      /* 0xFDC ucode_data_size */
    task[8] = 0;          /* 0xFE0 dram_stack */
    task[9] = 0x400;      /* 0xFE4 dram_stack_size */
    task[10] = 0;         /* 0xFE8 output_buff */
    task[11] = 0;         /* 0xFEC output_buff_size */
    task[12] = DL_ADDR;   /* 0xFF0 data_ptr → our GBI display list */
    task[13] = dl_count * 4; /* 0xFF4 data_size (bytes) */
    task[14] = 0;         /* 0xFF8 yield_data_ptr */
    task[15] = 0;         /* 0xFFC yield_data_size */

    /* Kick the RSP. The SP status-write handler runs the task only when BOTH HALT
       and BROKE are clear after the write: bit0 (0x1) clears HALT, bit2 (0x4) clears
       BROKE. Setting interrupt-on-break (0x100) makes the task signal completion.
       The RSP-HLE then reads the OSTask at DMEM 0xFC0, sees type==1, and forwards
       our display list to glide64. (SP_PC at 0xA4080000 is irrelevant under HLE —
       the ucode never executes; only the OSTask fields + the CRC matter.) */
    SP(SP_STATUS) = 0x00105;   /* clear HALT (0x1) + clear BROKE (0x4) + intr-on-break (0x100) */
}

void n64_clear(unsigned short col)
{
    dl_begin();
    /* SetFillColor: 16bpp color packed twice into 32 bits. */
    unsigned int c32 = ((unsigned int)col << 16) | col;
    dl_w((G_SETFILLCOLOR << 24), c32);
    /* FillRectangle covering the whole screen (coords in 10.2 fixed, inclusive). */
    dl_w((G_FILLRECT << 24) | (((320 - 1) << 2) << 12) | ((240 - 1) << 2),
         (0 << 12) | 0);
}

void n64_rect(int x, int y, int w, int h, unsigned short col)
{
    int x1 = x + w - 1, y1 = y + h - 1;
    if (x < 0) x = 0; if (y < 0) y = 0;
    if (x1 > 319) x1 = 319; if (y1 > 239) y1 = 239;
    if (x1 < x || y1 < y) return;
    unsigned int c32 = ((unsigned int)col << 16) | col;
    dl_w((G_SETFILLCOLOR << 24), c32);
    dl_w((G_FILLRECT << 24) | ((x1 << 2) << 12) | (y1 << 2),
         ((x << 2) << 12) | (y << 2));
}

/* Triangle: a flat-shaded, screen-space triangle. The verts are already projected
   to 2D pixels by the 3D pipeline. Rather than drive glide64's full F3DEX2 vertex/
   matrix/combine pipeline (heavy state), we scan-convert the triangle into a span of
   GPU FILL RECTANGLES — one per scanline. These are the SAME hardware-accelerated
   fill-rects that clear/rect use (rasterized by glide64 on the GPU, NOT CPU pixels),
   so it stays fast + renders correctly under the fill-cycle render state. The
   examples draw a handful of large flat quads, so the per-scanline rect count is low. */
static void emit_tri(int x0,int y0,int x1,int y1,int x2,int y2,unsigned short col)
{
    /* sort vertices by y (y0 <= y1 <= y2) */
    int t;
    if (y0 > y1) { t=x0;x0=x1;x1=t; t=y0;y0=y1;y1=t; }
    if (y1 > y2) { t=x1;x1=x2;x2=t; t=y1;y1=y2;y2=t; }
    if (y0 > y1) { t=x0;x0=x1;x1=t; t=y0;y0=y1;y1=t; }
    if (y2 == y0) return;                 /* degenerate */

    int y;
    for (y = y0; y <= y2; y++) {
        if (y < 0 || y > 239) continue;
        /* x along the long edge 0→2 */
        int xa = x0 + (x2 - x0) * (y - y0) / (y2 - y0);
        int xb;
        if (y < y1) {
            if (y1 == y0) continue;
            xb = x0 + (x1 - x0) * (y - y0) / (y1 - y0);
        } else {
            if (y2 == y1) continue;
            xb = x1 + (x2 - x1) * (y - y1) / (y2 - y1);
        }
        if (xa > xb) { t = xa; xa = xb; xb = t; }
        if (xa < 0) xa = 0; if (xb > 319) xb = 319;
        if (xb < xa) continue;
        /* one GPU fill-rect for this 1px-tall span */
        unsigned int c32 = ((unsigned int)col << 16) | col;
        dl_w((G_SETFILLCOLOR << 24), c32);
        dl_w((G_FILLRECT << 24) | ((xb << 2) << 12) | (y << 2),
             ((xa << 2) << 12) | (y << 2));
    }
}

void n64_tri2d(int x0,int y0,int x1,int y1,int x2,int y2,unsigned short col)
{ emit_tri(x0,y0,x1,y1,x2,y2,col); }

void n64_flip(void)
{
    dl_end_and_run();
    /* wait for the frame to scan out + the RDP to drain. */
    { volatile int i; for (i = 0; i < 100000; i++) { } }
}

/* ── input: read controller port 0 via the SI/PIF JoyBus poll. ── */
static unsigned int read_pad(void)
{
    volatile unsigned int *pif = (volatile unsigned int *)0xBFC007C0;
    volatile unsigned int *si  = (volatile unsigned int *)0xA4800000;
    unsigned int buttons;
    pif[0] = 0xFF010401; pif[1] = 0xFFFFFFFF; pif[2] = 0xFFFFFFFF;
    pif[3] = 0xFE000000; pif[4] = 0; pif[5] = 0; pif[6] = 0; pif[7] = 1;
    si[1] = 0x1FC007C0;
    { volatile int t; for (t = 0; t < 5000; t++) { } }
    buttons = pif[1] >> 16;
    return (~0u) & buttons;
}
unsigned int n64_pad(void) { return read_pad(); }
int n64_pressed(unsigned int mask) { return (n64_pad() & mask) ? 1 : 0; }

/* ── trig (256-step binary angle) ── */
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

/* ── camera + model + projection (math unchanged; output drives emit_tri) ── */
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
    emit_tri(x0,y0,x1,y1,x2,y2,col);
}
void n64_quad3d(Vec3 a, Vec3 b, Vec3 c, Vec3 d, unsigned short col)
{ n64_tri3d(a,b,c,col); n64_tri3d(a,c,d,col); }
void n64_tri3d_nc(Vec3 a, Vec3 b, Vec3 c, unsigned short col)
{
    Vec3 ca=to_cam(a), cb=to_cam(b), cc=to_cam(c);
    int x0,y0,x1,y1,x2,y2;
    if (!project(ca,&x0,&y0)||!project(cb,&x1,&y1)||!project(cc,&x2,&y2)) return;
    emit_tri(x0,y0,x1,y1,x2,y2,col);
}
void n64_quad3d_nc(Vec3 a, Vec3 b, Vec3 c, Vec3 d, unsigned short col)
{ n64_tri3d_nc(a,b,c,col); n64_tri3d_nc(a,c,d,col); }

/* ── RNG ── */
static unsigned int rng = 0x12345678u;
void n64_srand(unsigned int s) { rng = s ? s : 1; }
unsigned int n64_rand(void) { unsigned int x=rng; x^=x<<13; x^=x>>17; x^=x<<5; return rng=x; }

/* ── HUD number (3x5 cells via filled rects) ── */
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
