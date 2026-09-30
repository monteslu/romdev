/* rd_runtime.h: what the sync32 host (main.c), the recompiled 68000 blocks
   (rd_blocks*.c) and the tools share. */
#ifndef _RD_RUNTIME_H_
#define _RD_RUNTIME_H_
#include <stdint.h>

/* Genesis line 0 lands on this canvas row: 224 active lines centred in 240. */
#ifndef RD_CANVAS_Y
#define RD_CANVAS_Y 8
#endif

/* Build metadata (JSON), generated per cart; romdev reads it from the image. */
#ifndef RD_META_JSON
#define RD_META_JSON "{}"
#endif

/* The cartridge ROM in flash, as gpgx's load_rom leaves cart.rom. */
extern const unsigned int rd_rom_words[];
#define rd_rom ((const unsigned char *)rd_rom_words)
extern const unsigned int rd_rom_size;

/* gpgx's pixel[]: the canvas palette. */
const unsigned short *rd_palette(void);

/* Per-run counters the tools read (all u32, little-endian). */
typedef struct {
  uint32_t frames;
  uint32_t trapped;         /* a stub for absent hardware was reached */
  uint32_t audio_frames;    /* stereo frames produced */
  uint32_t audio_dropped;   /* stereo frames the host FIFO had to drop */
  uint32_t blk_runs;        /* compiled block entries */
  uint32_t blk_insns;       /* 68000 instructions run by compiled blocks */
  uint32_t interp_insns;    /* 68000 instructions run by the interpreter */
  uint32_t lookups;         /* dynamic block lookups (pc -> block) */
  uint32_t lookup_miss;     /* lookups that found no block (interpreter ran) */
  uint32_t frame_blk_insns; /* last frame's block instructions */
  uint32_t frame_interp_insns; /* last frame's interpreted instructions */
  uint32_t irq_delay_aborts;/* blocks ended by the VDP's delayed interrupt */
  uint32_t reserved[1];     /* [0] keeps rd_desc alive through --gc-sections */
  uint32_t pal_banks;       /* distinct palettes the last frame drew rows with */
  uint32_t pal_overflow_frames; /* frames that could not be shown exactly (over 256 colours, over 16 palettes, mixed shadow/highlight) */
  uint32_t pal_max_banks;   /* most palettes any frame drew with */
} rd_stats_t;
extern rd_stats_t rd_stats;

#define RD_DESC_VERSION 1
typedef struct {
  char magic[8];            /* "RDMDS32" */
  uint32_t version;
  uint32_t size;
  void *work_ram; uint32_t work_ram_size;
  void *vram;     uint32_t vram_size;
  void *cram;     uint32_t cram_size;
  void *vsram;    uint32_t vsram_size;
  void *zram;     uint32_t zram_size;
  void *vdp_reg;  uint32_t vdp_reg_size;
  void *sat;      uint32_t sat_size;
  void *m68k;     uint32_t m68k_size;
  void *z80;      uint32_t z80_size;
  void *stats;    uint32_t stats_size;
  const char *meta_json;
  int32_t canvas_y;
} rd_desc_t;
extern rd_desc_t rd_desc;

#endif
