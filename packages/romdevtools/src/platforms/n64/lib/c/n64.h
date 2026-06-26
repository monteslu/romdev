/* n64.h — N64 (R4300) helper lib with a software 3D pipeline, for romdev.
 *
 * The N64 is a 3D machine; this is a real software 3D engine (identical fixed-point
 * math to the PS1 lib, so games port directly) with an N64 framebuffer backend: a
 * 320x240 16-bit (RGBA5551) framebuffer in RDRAM that the Video Interface scans out,
 * and a software triangle rasterizer (the RDP is far more complex; direct FB writes
 * are portable + reliable). Big-endian.
 *
 * Build: build({ platform:"n64", language:"c" }) → a self-booting .z64 (our clean
 * IPL3 DMAs the game to RDRAM and jumps in). main() loops forever.
 */
#ifndef ROMDEV_N64_H
#define ROMDEV_N64_H

typedef int fix; /* 16.16 */
#define FIX(n)   ((fix)((n) << 16))
#define FIXF(f)  ((fix)((f) * 65536.0f))
#define FMUL(a,b) ((fix)(((long long)(a) * (b)) >> 16))
#define FDIV(a,b) ((fix)(((long long)(a) << 16) / (b)))
#define F2I(a)   ((a) >> 16)

typedef struct { fix x, y, z; } Vec3;

#define SCREEN_W 320
#define SCREEN_H 240

/* RGBA5551 color (the VI framebuffer format): 5-5-5-1. */
#define RGB(r,g,b) ((unsigned short)((((r)>>3)<<11)|(((g)>>3)<<6)|(((b)>>3)<<1)|1))

/* controller digital buttons (active-high after read). */
#define PAD_A      0x8000
#define PAD_B      0x4000
#define PAD_Z      0x2000
#define PAD_START  0x1000
#define PAD_UP     0x0800
#define PAD_DOWN   0x0400
#define PAD_LEFT   0x0200
#define PAD_RIGHT  0x0100
#define PAD_L      0x0020
#define PAD_R      0x0010

/* ── framebuffer / 2D ── */
void n64_init(void);
void n64_clear(unsigned short col);
void n64_rect(int x, int y, int w, int h, unsigned short col);
void n64_tri2d(int x0,int y0,int x1,int y1,int x2,int y2,unsigned short col);
void n64_flip(void);          /* present the framebuffer (swap + wait vblank) */

/* ── input ── */
unsigned int n64_pad(void);
int n64_pressed(unsigned int mask);

/* ── 3D pipeline (same API as the PS1 lib) ── */
void n64_camera(fix ex, fix ey, fix ez, fix yaw, fix pitch);
void n64_model(fix tx, fix ty, fix tz, fix yaw);
void n64_tri3d(Vec3 a, Vec3 b, Vec3 c, unsigned short col);
void n64_quad3d(Vec3 a, Vec3 b, Vec3 c, Vec3 d, unsigned short col);
void n64_tri3d_nc(Vec3 a, Vec3 b, Vec3 c, unsigned short col);
void n64_quad3d_nc(Vec3 a, Vec3 b, Vec3 c, Vec3 d, unsigned short col);

/* ── misc ── */
fix n64_sin(fix a);
fix n64_cos(fix a);
unsigned int n64_rand(void);
void n64_srand(unsigned int seed);
void n64_number(int x, int y, unsigned int value, unsigned short col);

#endif
