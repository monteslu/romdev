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
void rd_canvas_line(int line, const uint8 *src, int width)
{
  int y = line + RD_CANVAS_Y;
  if (y < 0 || y >= 240 || !canvas) return;
  if (width > 320) width = 320;
  memcpy(canvas + y * 320, src, width);
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
  config.filter         = 1;
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
  audio_init(48000, 60.0);
  system_init();
  system_reset();
  for (;;)
  {
    rd_stats.frames++;
    system_frame_gen(0);
    audio_frame();
    audio_pump();
    api->palette_set(rd_palette());
    api->canvas_mark(0, 239);
    api->present();
    audio_pump();
  }
}
