/* main.c: the sync32 host for the Genesis runtime.
 *
 * game_main() plays the part gpgx's libretro frontend plays: default config,
 * load the cartridge (already in flash, pre-swapped), power on, then one
 * system_frame_gen() per present(). Video goes straight into the console
 * canvas (remap_line -> rd_canvas_line) with gpgx's pixel[] as the 256-entry
 * RGB565 palette; audio is gpgx's own FM+PSG mix resampled by blip_buf to
 * 48 kHz and fed to the console ring in slices during the frame; the SNES-class
 * pad maps by name the way gpgx's libretro port maps a RetroPad
 * (B->B, A->C, Y->A, L->X, X->Y, R->Z, Select->Mode).
 *
 * Tools find the Genesis state through rd_desc (magic "RDMDS32"), a table of
 * the addresses of work RAM, VRAM, CRAM, VSRAM, Z80 RAM, the VDP registers,
 * the sprite table cache and the CPU cores, kept in .data so it is visible in
 * the console's SRAM.
 */
#include "shared.h"
#include "sync32.h"
#include "rd_runtime.h"

t_config config;

static const sync32_api_t *api;
static uint8 *canvas;

/* ---------------------------------------------------------------- stats */
rd_stats_t rd_stats;

/* ------------------------------------------------------------ descriptor */
extern uint8 sat[];
extern uint8 vram[];
extern uint8 cram[];
extern uint8 vsram[];
extern uint8 reg[];
extern const char rd_meta_json[];
rd_desc_t rd_desc = {
  { 'R', 'D', 'M', 'D', 'S', '3', '2', 0 },
  RD_DESC_VERSION,
  sizeof(rd_desc_t),
  work_ram, 0x10000,
  vram, 0x10000,
  cram, 0x80,
  vsram, 0x80,
  zram, 0x2000,
  reg, 0x20,
  sat, 0x400,
  &m68k, sizeof(m68k),
  &Z80, sizeof(Z80),
  &rd_stats, sizeof(rd_stats),
  rd_meta_json,
  RD_CANVAS_Y,
};

/* ------------------------------------------------------------- traps */
volatile const char *rd_trap_what;
void rd_unreachable(const char *what)
{
  rd_trap_what = what;
  rd_stats.trapped = 1;
  if (api) api->exit();
  for (;;) { }
}
uint8 *rd_unreachable_ptr(const char *what)
{
  rd_unreachable(what);
  return 0;
}

/* ------------------------------------------------------------- video */
/* Per-line palettes. The Genesis shows 64 colours at a time, but a game may
   rewrite CRAM between (or during) lines: a water line, raster colour
   effects. gpgx converts each line through pixel[] as it is when the line is
   drawn, so every canvas row here remembers which palette it was drawn with.
   sync32 has one 256-entry palette per frame:
     - the first four distinct palettes of a frame are provisional 64-entry
       banks, a row is stored as bank*64 + colour (the common case, and all
       that happens when a frame has four palettes or fewer);
     - every distinct palette a row is drawn with is recorded (up to 16; past
       that a row whose colours all agree with a recorded one uses it);
     - a frame with more than four palettes is solved at its end: the palettes
       drawn on the most rows keep whole banks, every other palette's colours
       are placed once each (by value) in the entries left, and only the rows
       drawn with those palettes are re-encoded through a lookup. It is exact
       while the frame shows 256 distinct colours or fewer;
     - a row redrawn after a mid-line display switch simply takes the palette
       of its last drawing; a palette no row ends up using takes no entries.
   In shadow/highlight mode a row needs pixel[0x00..0xBF], so such a frame
   uses gpgx's pixel[] as the whole palette. Frames that cannot be shown
   exactly are counted in rd_stats.pal_overflow_frames. */
#define RD_UPAL 16
extern uint8 rd_pal_dirty;
extern uint8 reg[0x20];
const uint16 *rd_pixel(void);
static uint16 rd_frame_pal[256];
static uint16 rd_upal[RD_UPAL][64];       /* the frame's distinct palettes */
static uint8 rd_row_pal[240];             /* palette each row was drawn with */
static int rd_nupal, rd_cur, rd_sh, rd_overflow, rd_adhoc;

static void rd_frame_begin(void)
{
  rd_nupal = 0;
  rd_cur = 0;
  rd_sh = 0;
  rd_overflow = 0;
  rd_pal_dirty = 1;
  rd_adhoc = 0;
  memset(rd_row_pal, 0xff, sizeof(rd_row_pal));
}

/* 64 colours equal (word compares; the libc memcmp goes byte by byte) */
static int rd_pal_eq(const uint16 *a, const uint16 *b)
{
  const uint32 *x = (const uint32 *)a, *y = (const uint32 *)b;
  int i;
  for (i = 0; i < 32; i += 4)
    if ((x[i] ^ y[i]) | (x[i + 1] ^ y[i + 1]) | (x[i + 2] ^ y[i + 2]) | (x[i + 3] ^ y[i + 3])) return 0;
  return 1;
}

static void rd_pick_pal(const uint8 *src, int width)
{
  const uint16 *px = rd_pixel();
  uint32 used[2] = { 0, 0 };
  int k, i;
  rd_pal_dirty = 0;
  rd_adhoc = 0;
  if (rd_nupal && rd_pal_eq(rd_upal[rd_cur], px)) return;
  for (k = 0; k < rd_nupal; k++)
    if (rd_pal_eq(rd_upal[k], px)) { rd_cur = k; return; }
  if (rd_nupal < RD_UPAL)
  {
    rd_cur = rd_nupal++;
    memcpy(rd_upal[rd_cur], px, 128);
    return;
  }
  /* sixteen palettes already: a row whose colours all agree with one of
     them uses it, anything else cannot be shown exactly */
  for (i = 0; i < width; i++) { unsigned c = src[i] & 0x3f; used[c >> 5] |= 1u << (c & 31); }
  for (k = 0; k < rd_nupal; k++)
  {
    for (i = 0; i < 64; i++)
      if (((used[i >> 5] >> (i & 31)) & 1) && rd_upal[k][i] != px[i]) break;
    if (i == 64) { rd_cur = k; rd_adhoc = 1; return; }
  }
  rd_overflow = 1;
  rd_adhoc = 1;
}

void rd_canvas_line(int line, const uint8 *src, int width)
{
  int y = line + RD_CANVAS_Y;
  if (y < 0 || y >= 240 || !canvas) return;
  if (width > 320) width = 320;
  if (reg[12] & 0x08)
  {
    /* shadow/highlight: 192 entries, the whole palette */
    const uint16 *px = rd_pixel();
    if (!rd_sh) { rd_sh = 1; if (rd_nupal) rd_overflow = 1; memcpy(rd_frame_pal, px, 512); rd_pal_dirty = 0; }
    else if (rd_pal_dirty) { rd_pal_dirty = 0; if (memcmp(rd_frame_pal, px, 512)) rd_overflow = 1; }
    memcpy(canvas + y * 320, src, width);
    return;
  }
  if (rd_sh) { rd_overflow = 1; memcpy(canvas + y * 320, src, width); return; }
  if (rd_pal_dirty || rd_adhoc) rd_pick_pal(src, width);
  rd_row_pal[y] = rd_cur;
  {
    /* 32 pixels an iteration (the M33 loads words at any alignment); a
       palette past the fourth is stored as bare colour numbers and placed
       at the end of the frame */
    uint32 bits = rd_cur < 4 ? 0x01010101u * (uint32)(rd_cur << 6) : 0;
    uint32 *d = (uint32 *)(canvas + y * 320);
    const uint32 *s = (const uint32 *)src;
    int n = width >> 5, i;
    for (i = 0; i < n; i++, s += 8, d += 8)
    {
      uint32 w0 = s[0], w1 = s[1], w2 = s[2], w3 = s[3], w4 = s[4], w5 = s[5], w6 = s[6], w7 = s[7];
      d[0] = (w0 & 0x3f3f3f3fu) | bits; d[1] = (w1 & 0x3f3f3f3fu) | bits;
      d[2] = (w2 & 0x3f3f3f3fu) | bits; d[3] = (w3 & 0x3f3f3f3fu) | bits;
      d[4] = (w4 & 0x3f3f3f3fu) | bits; d[5] = (w5 & 0x3f3f3f3fu) | bits;
      d[6] = (w6 & 0x3f3f3f3fu) | bits; d[7] = (w7 & 0x3f3f3f3fu) | bits;
    }
    for (i = 0; i < ((width & 31) >> 2); i++) d[i] = (s[i] & 0x3f3f3f3fu) | bits;
  }
}

/* The slot holding colour c among the first n entries, or -1. */
static int rd_find_colour(uint16 c, int n)
{
  int i;
  for (i = 0; i < n; i++) if (rd_frame_pal[i] == c) return i;
  return -1;
}

/* More than four palettes: choose which keep whole banks, place the rest by
   colour, re-encode the rows that moved. */
static void rd_solve_palettes(void)
{
  int rows[RD_UPAL], block_of[RD_UPAL], pal_in[4];
  static uint8 xl[RD_UPAL][64];
  uint32 have = 0;                                   /* palettes whose xl[] is built */
  int k, y, i, nblocks, used;
  memset(rows, 0, sizeof(rows));
  for (y = 0; y < 240; y++) if (rd_row_pal[y] != 0xff) rows[rd_row_pal[y]]++;
  /* palette 0 keeps bank 0 (the rows outside the display show its entry 0) */
  for (nblocks = 4; nblocks >= 1; nblocks--)
  {
    /* the nblocks-1 most drawn palettes besides 0 get banks 1.. */
    int chosen[4] = { 0, -1, -1, -1 };
    for (i = 1; i < nblocks; i++)
    {
      int best = -1;
      for (k = 1; k < rd_nupal; k++)
      {
        int taken = 0, j;
        for (j = 1; j < i; j++) if (chosen[j] == k) taken = 1;
        if (!taken && rows[k] && (best < 0 || rows[k] > rows[best])) best = k;
      }
      chosen[i] = best;
    }
    /* banks first, then every other drawn palette's colours once each */
    used = 0;
    for (i = 0; i < nblocks; i++)
    {
      if (chosen[i] >= 0) memcpy(&rd_frame_pal[i * 64], rd_upal[chosen[i]], 128);
      else memcpy(&rd_frame_pal[i * 64], rd_upal[0], 128);
      used = (i + 1) * 64;
    }
    for (k = 0; k < rd_nupal; k++) block_of[k] = -1;
    for (i = 0; i < nblocks; i++) if (chosen[i] >= 0) block_of[chosen[i]] = i;
    {
      int fits = 1;
      for (k = 0; k < rd_nupal && fits; k++)
      {
        if (!rows[k] || block_of[k] >= 0) continue;
        for (i = 0; i < 64; i++)
        {
          if (rd_find_colour(rd_upal[k][i], used) >= 0) continue;
          if (used == 256) { fits = 0; break; }
          rd_frame_pal[used++] = rd_upal[k][i];
        }
      }
      if (fits || nblocks == 1)
      {
        if (!fits) rd_overflow = 1;
        for (i = 0; i < 4; i++) pal_in[i] = i < nblocks ? chosen[i] : -1;
        break;
      }
    }
  }
  for (i = used; i < 256; i++) rd_frame_pal[i] = rd_frame_pal[i & 63];
  /* re-encode rows whose palette is not where their bits say */
  for (y = 0; y < 240; y++)
  {
    int p = rd_row_pal[y];
    uint8 *row = canvas + y * 320;
    if (p == 0xff) continue;
    if (p < 4 && pal_in[p] == p) continue;                 /* in place */
    if (block_of[p] >= 0)
    {
      uint8 b = (uint8)(block_of[p] << 6);
      for (i = 0; i < 320; i++) row[i] = (row[i] & 0x3f) | b;
    }
    else
    {
      const uint8 *x = xl[p];
      if (!(have & (1u << p)))
      {
        for (i = 0; i < 64; i++) { int s = rd_find_colour(rd_upal[p][i], 256); xl[p][i] = (uint8)(s < 0 ? 0 : s); }
        have |= 1u << p;
      }
      for (i = 0; i < 320; i++) row[i] = x[row[i] & 0x3f];
    }
  }
  rd_stats.pal_banks = rd_nupal;
}

static void rd_frame_end(void)
{
  if (!rd_sh)
  {
    int k;
    if (!rd_nupal) { memcpy(rd_upal[0], rd_pixel(), 128); rd_nupal = 1; }
    if (rd_nupal <= 4)
    {
      for (k = 0; k < 4; k++) memcpy(&rd_frame_pal[k * 64], rd_upal[k < rd_nupal ? k : 0], 128);
      rd_stats.pal_banks = rd_nupal;
    }
    else rd_solve_palettes();
  }
  else rd_stats.pal_banks = 1;
  if (rd_stats.pal_banks > rd_stats.pal_max_banks) rd_stats.pal_max_banks = rd_stats.pal_banks;
  if (rd_overflow) rd_stats.pal_overflow_frames++;
  api->palette_set(rd_frame_pal);
}

/* ------------------------------------------------------------- input */
void osd_input_update(void)
{
  s32_pad_t p;
  unsigned int b, t = 0;
  api->pad(0, &p);
  b = p.buttons;
  if (b & S32_PAD_UP)     t |= INPUT_UP;
  if (b & S32_PAD_DOWN)   t |= INPUT_DOWN;
  if (b & S32_PAD_LEFT)   t |= INPUT_LEFT;
  if (b & S32_PAD_RIGHT)  t |= INPUT_RIGHT;
  if (b & S32_PAD_START)  t |= INPUT_START;
  if (b & S32_PAD_B)      t |= INPUT_B;
  if (b & S32_PAD_A)      t |= INPUT_C;
  if (b & S32_PAD_Y)      t |= INPUT_A;
  if (input.dev[0] == DEVICE_PAD6B)
  {
    if (b & S32_PAD_L)      t |= INPUT_X;
    if (b & S32_PAD_X)      t |= INPUT_Y;
    if (b & S32_PAD_R)      t |= INPUT_Z;
    if (b & S32_PAD_SELECT) t |= INPUT_MODE;
  }
  input.pad[0] = t;
  input.pad[1] = 0;
}

/* ------------------------------------------------------------- audio */
/* A frame of gpgx audio (800 stereo frames at 48 kHz, 60 Hz) is made at the
   end of system_frame_gen. The console ring holds 1024 frames and drains
   continuously, so the samples wait here and are pushed in slices from the
   line hook during the next frame, as ABI 6.4 asks. */
/* The console ring drains 48000 Hz at 60 presents a second: 800 frames each.
   A test build can match the gpgx libretro reference's stream instead
   (-DRD_AUDIO_RATE=44100 -DRD_AUDIO_FPS=0, its audio_init(44100, 0)) so the
   two compare sample for sample. */
#ifndef RD_AUDIO_RATE
#define RD_AUDIO_RATE 48000
#endif
#ifndef RD_AUDIO_FPS
#define RD_AUDIO_FPS 60.0
#endif
#define RD_AFIFO 2048                 /* stereo frames, power of two */
static int16 afifo[RD_AFIFO * 2];
static unsigned int afifo_r, afifo_w;
static int16 aframe[1024 * 2];

static void audio_pump(void)
{
  unsigned int n = afifo_w - afifo_r;
  if (!n) return;
  int space = api->audio_space();
  if (space <= 0) return;
  if (n > (unsigned int)space) n = space;
  while (n)
  {
    unsigned int at = afifo_r & (RD_AFIFO - 1);
    unsigned int run = RD_AFIFO - at;
    if (run > n) run = n;
    api->audio_push(&afifo[at * 2], run);
    afifo_r += run;
    n -= run;
  }
}

void rd_line_hook(int line)
{
  if ((line & 31) == 0) audio_pump();
}

static void audio_frame(void)
{
  int n = audio_update(aframe);
  int i;
  rd_stats.audio_frames += n;
  for (i = 0; i < n; i++)
  {
    unsigned int at;
    if (afifo_w - afifo_r >= RD_AFIFO) { afifo_r++; rd_stats.audio_dropped++; }
    at = afifo_w & (RD_AFIFO - 1);
    afifo[at * 2] = aframe[i * 2];
    afifo[at * 2 + 1] = aframe[i * 2 + 1];
    afifo_w++;
  }
}

/* ------------------------------------------------------------- setup */
static void config_default(void)
{
  int i;
  memset(&config, 0, sizeof(config));
  /* gpgx libretro config_default() */
  config.psg_preamp     = 150;
  config.fm_preamp      = 100;
  config.cdda_volume    = 100;
  config.pcm_volume     = 100;
  config.hq_fm          = 1;
  config.hq_psg         = 1;
  config.filter         = 0;   /* check_variables: audio_filter unset -> 0 */
  config.lp_range       = 0x9999;
  config.low_freq       = 880;
  config.high_freq      = 5000;
  config.lg             = 100;
  config.mg             = 100;
  config.hg             = 100;
  config.ym2612         = YM2612_DISCRETE;
  config.ym2413         = 2;
  config.mono           = 0;
  config.system         = 0;
  config.region_detect  = 0;
  config.vdp_mode       = 0;
  config.master_clock   = 0;
  config.force_dtack    = 0;
  config.addr_error     = 1;
  config.bios           = 0;
  config.lock_on        = 0;
  config.add_on         = HW_ADDON_AUTO;
  config.lcd            = 0;
  config.overclock      = 100;
  config.no_sprite_limit = 0;
  config.enhanced_vscroll = 0;
  config.enhanced_vscroll_limit = 8;
  config.overscan = 0;
  config.aspect_ratio = 0;
  config.gg_extra = 0;
  config.ntsc     = 0;
  config.render   = 0;
  config.left_border = 0;
#ifdef RD_AUDIO_FAST
  /* gpgx's own "faster linear interpolation" resampling of the FM and PSG
     streams (its hq_fm/hq_psg options off) instead of band-limited synthesis,
     which measured 13% of a gameplay frame on sync32. Only the resampling to
     48 kHz changes; the chips' state and samples are the same. */
  config.hq_fm          = 0;
  config.hq_psg         = 0;
#endif
  input.system[0] = SYSTEM_GAMEPAD;
  input.system[1] = SYSTEM_GAMEPAD;
  for (i = 0; i < MAX_INPUTS; i++)
  {
    config.input[i].padtype = DEVICE_PAD2B | DEVICE_PAD3B | DEVICE_PAD6B;
  }
}

/* load_rom()'s cartridge path: the image in flash is already what load_rom
   leaves in cart.rom (header removed, byte-swapped for 16-bit access, padded
   and mirrored to a power of two), so only the bookkeeping runs here. */
static void rd_load_rom(void)
{
  system_hw = SYSTEM_MD;
  cart.rom = rd_rom;
  cart.romsize = rd_rom_size;
  /* getrominfo/get_region read the header in 68000 byte order */
  {
    static char header[0x200];
    int i;
    for (i = 0; i < 0x200; i++) header[i] = rd_rom[i ^ 1];
    getrominfo(header);
    get_region(header);
  }
  romtype = system_hw;
}

void game_main(const sync32_api_t *a)
{
  api = a;
  /* a live reference keeps the descriptor through --gc-sections */
  rd_stats.reserved[0] = (uint32_t)&rd_desc;
  canvas = api->canvas();
  memset(canvas, 0, 320 * 240);
  config_default();
  rd_load_rom();
  audio_init(RD_AUDIO_RATE, RD_AUDIO_FPS);
  system_init();
  system_reset();
  for (;;)
  {
    rd_stats.frames++;
    rd_frame_begin();
    system_frame_gen(0);
    audio_frame();
    audio_pump();
    rd_frame_end();
    api->canvas_mark(0, 239);
    api->present();
    audio_pump();
  }
}
