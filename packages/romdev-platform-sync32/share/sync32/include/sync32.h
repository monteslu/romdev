// sync32 ABI: the permanent contract between games and the console.
// Full specification: docs/ABI.md in github.com/monteslu/sync32.
// Games include ONLY this header. Frozen field order; additions append.
#ifndef SYNC32_H
#define SYNC32_H
#include <stdint.h>

#define S32_MAGIC        0x32335953u   // "SY32" little-endian
#define S32_HEADER_VERSION 1
#define S32_API_VERSION    2

// header flags / modes
#define S32_LOAD_RAM     0
#define S32_LOAD_XIP     1
#define S32_VIDEO_240    0             // 320x240 4:3
#define S32_VIDEO_180    1             // 320x180 letterbox 16:9

// canonical pad: SNES-class digital (XInput bit layout)
#define S32_PAD_UP       0x0001
#define S32_PAD_DOWN     0x0002
#define S32_PAD_LEFT     0x0004
#define S32_PAD_RIGHT    0x0008
#define S32_PAD_START    0x0010
#define S32_PAD_SELECT   0x0020
#define S32_PAD_L        0x0100
#define S32_PAD_R        0x0200
#define S32_PAD_A        0x1000
#define S32_PAD_B        0x2000
#define S32_PAD_X        0x4000
#define S32_PAD_Y        0x8000

#define S32_SPRITE_FLIP_X 0x01
#define S32_SPRITE_FLIP_Y 0x02

#define S32_W 320
#define S32_MAX_SPRITES 128
#define S32_SAVE_SLOTS 8
#define S32_SAVE_MAX 65536

// disk (api v2): read-only streaming from the game's own data directory,
// "<romname>/" beside the .s32 file. Plain filenames only, no paths.
#define S32_DISK_MAX_OPEN 4
#define S32_DISK_NAME_MAX 32
#define S32_DISK_EOK       0
#define S32_DISK_ENOENT   -1   // no such file / end of listing
#define S32_DISK_ENFILE   -2   // too many open files
#define S32_DISK_EBADF    -3   // bad fd
#define S32_DISK_EIO      -4   // media error / no card / no data dir
#define S32_DISK_EINVAL   -5   // bad name or argument

/* Guaranteed depth of the console audio ring, in stereo frames. */
#define S32_AUDIO_RING 1024

typedef struct {
  uint16_t buttons;
  int8_t   lx, ly, rx, ry;   // reported when hardware has them; NEVER required
  uint8_t  connected;
  uint8_t  _pad;
} s32_pad_t;

typedef struct {
  uint16_t api_version;
  uint16_t _pad;
  // system
  void     (*exit)(void);
  uint32_t (*ticks_us)(void);
  uint32_t (*random)(void);
  void     (*rng_seed)(uint64_t seed);
  uint32_t (*rng_next)(void);
  // video
  void     (*palette_set)(const uint16_t *rgb565_256);
  int      (*sheet_load)(const void *pixels8, int w, int h);
  void     (*clear)(uint16_t rgb565);
  void     (*sprite)(int sheet, int sx, int sy, int w, int h,
                     int x, int y, uint8_t flags);
  void     (*rect)(int x, int y, int w, int h, uint16_t rgb565);
  uint8_t* (*canvas)(void);
  void     (*canvas_mark)(int y0, int y1);
  void     (*present)(void);
  // input
  void     (*pad)(int player, s32_pad_t *out);
  // audio: 48kHz stereo s16. The console ring holds at least S32_AUDIO_RING
  // frames and drains continuously, so it is SMALLER than one video frame of
  // audio (48000/60 = 800). audio_push() takes at most audio_space() frames
  // and silently drops the rest, so pushing a whole frame in one call loses
  // samples and leaves the stream under 48kHz -- which, against the HDMI
  // clock the console declares, is a mismatch a sink resolves by muting.
  // Push in smaller amounts spread across the frame instead, topping up as
  // the console drains. See ABI.md 6.4.
  int      (*audio_space)(void);
  void     (*audio_push)(const int16_t *lr, int frames);
  // storage
  int      (*save_read)(int slot, void *buf, int max);
  int      (*save_write)(int slot, const void *buf, int len);
  // v1 ends here; future functions append below with bumped S32_API_VERSION
  // ---- api v2: disk streaming (read-only, sandboxed to the game's dir) ----
  // enumerate: index 0.. until S32_DISK_ENOENT; name_out has room for
  // S32_DISK_NAME_MAX bytes (NUL included), size_out may be NULL
  int      (*disk_list)(int index, char *name_out, uint32_t *size_out);
  int      (*disk_open)(const char *name);            // fd >= 0, or error
  int      (*disk_size)(int fd);
  int      (*disk_seek)(int fd, uint32_t offset);
  int      (*disk_read)(int fd, void *dst, uint32_t len);  // bytes read
  int      (*disk_close)(int fd);
  // v2 ends here
} sync32_api_t;

// the one symbol a ROM exports:
//   void game_main(const sync32_api_t *api);

// ROM file header (64 bytes, little-endian)
typedef struct {
  uint32_t magic;          // S32_MAGIC
  uint16_t header_version; // 1
  uint16_t api_version;    // minimum required
  uint32_t rom_size;       // total file size
  uint32_t crc32;          // IEEE, of everything after this 64-byte header
  uint32_t code_offset;    // usually 64
  uint32_t code_size;
  uint32_t entry_offset;   // offset of game_main within image
  uint8_t  load_mode;      // S32_LOAD_*
  uint8_t  video_mode;     // S32_VIDEO_*
  uint8_t  flags;          // bit0 big_slot
  uint8_t  reserved0;
  char     title[16];
  uint8_t  game_id[8];
  uint8_t  reserved1[8];
} s32_header_t;

#endif
