/* psx.h — PS1 (R3000) helper lib with a software 3D pipeline, for romdev.
 *
 * A minimal-but-real 3D engine + GPU/pad helpers — what the PlayStation is FOR.
 * Fixed-point (16.16) vector math, a camera (position + yaw/pitch), perspective
 * projection, and painter-sorted flat-shaded triangles/quads drawn through the
 * GPU. No GTE/SDK dependency — pure C math, so the same pipeline ports to N64.
 *
 * Build: build({ platform:"ps1", language:"c" }). Output is a PS-EXE the HLE BIOS
 * loads at 0x80010000; main() loops forever. Color is BGR (GPU native); RGB() packs.
 *
 * 2D is also available (psx_rect / psx_sprite) for HUDs + the puzzle game.
 */
#ifndef ROMDEV_PSX_H
#define ROMDEV_PSX_H

/* ── fixed-point (16.16) ── */
typedef int fix; /* 16.16 */
#define FIX(n)   ((fix)((n) << 16))
#define FIXF(f)  ((fix)((f) * 65536.0f))
#define FMUL(a,b) ((fix)(((long long)(a) * (b)) >> 16))
#define FDIV(a,b) ((fix)(((long long)(a) << 16) / (b)))
#define F2I(a)   ((a) >> 16)

typedef struct { fix x, y, z; } Vec3;

/* ── GPU ports ── */
#define GP0 (*(volatile unsigned int*)0x1F801810)
#define GP1 (*(volatile unsigned int*)0x1F801814)

/* ── pad (digital, active-HIGH: bit set = pressed) ── */
#define PAD_SELECT   (1u<<0)
#define PAD_START    (1u<<3)
#define PAD_UP       (1u<<4)
#define PAD_RIGHT    (1u<<5)
#define PAD_DOWN     (1u<<6)
#define PAD_LEFT     (1u<<7)
#define PAD_L1       (1u<<10)
#define PAD_R1       (1u<<11)
#define PAD_TRIANGLE (1u<<12)
#define PAD_CIRCLE   (1u<<13)
#define PAD_CROSS    (1u<<14)
#define PAD_SQUARE   (1u<<15)

#define RGB(r,g,b) (((unsigned int)(b)<<16)|((unsigned int)(g)<<8)|(unsigned int)(r))
#define SCREEN_W 320
#define SCREEN_H 240

/* ── GPU / 2D ── */
void psx_init(void);
void psx_clear(unsigned int bgr);
void psx_rect(int x, int y, int w, int h, unsigned int bgr);
void psx_tri2d(int x0,int y0,int x1,int y1,int x2,int y2,unsigned int bgr);
void psx_vsync(void);

/* ── input ── */
unsigned int psx_pad(void);          /* current buttons (active-high) */
int psx_pressed(unsigned int mask);  /* 1 if any of mask is held */

/* ── 3D pipeline ── */
/* camera: eye position + yaw (around Y) + pitch (around X), all 16.16. */
void psx_camera(fix ex, fix ey, fix ez, fix yaw, fix pitch);
/* set a model translation+rotation applied before the camera (simple: yaw only). */
void psx_model(fix tx, fix ty, fix tz, fix yaw);
/* draw a flat triangle of 3 model-space vertices; projected + back-face/near
   culled. Z-buffered by draw order (call back-to-front, or use psx_sort). */
void psx_tri3d(Vec3 a, Vec3 b, Vec3 c, unsigned int bgr);
void psx_quad3d(Vec3 a, Vec3 b, Vec3 c, Vec3 d, unsigned int bgr);
/* returns the average camera-space Z of 3/4 model verts (for manual sorting). */
fix psx_depth3(Vec3 a, Vec3 b, Vec3 c);
fix psx_depth4(Vec3 a, Vec3 b, Vec3 c, Vec3 d);

/* ── misc ── */
fix psx_sin(fix a);   /* a in 16.16 turns? no — a in fix radians-ish (see psx.c) */
fix psx_cos(fix a);
unsigned int psx_rand(void);
void psx_srand(unsigned int seed);
/* draw a small decimal number (HUD/score), 8x8 blocky digits. */
void psx_number(int x, int y, unsigned int value, unsigned int bgr);

#endif
