/* system_s32.c: gpgx's system.c cut to a Mega Drive cartridge.
 *
 * audio_init/audio_set_rate/audio_reset/audio_update, system_init/reset and
 * system_frame_gen are genesis_plus_gx's own, statement for statement, minus
 * the Mega CD, SVP, YX5200 and EQ paths a cartridge never takes. Two hooks
 * are added and marked ROMDEV_S32:
 *   rd_line_hook(): called once per scanline between CPU slices so the host
 *   can keep the console's audio ring topped up during the frame (the ring is
 *   shorter than a frame of audio, ABI 6.4);
 *   rd_frame_mark(): per-frame counters for the tools.
 *
 * Derived from Genesis Plus GX (non-commercial). Copyright notices below.
 *  Copyright (C) 1998-2003  Charles Mac Donald (original code)
 *  Copyright (C) 2007-2024  Eke-Eke (Genesis Plus GX)
 */
#include "shared.h"

extern int8 audio_hard_disable;

/* Global variables */
t_bitmap bitmap;
t_snd snd;
uint32 mcycles_vdp;
uint8 system_hw;
uint8 system_bios;
uint32 system_clock;
int16 SVP_cycles = 800;
uint8 reset_do_not_clear_buffers = 0;

static int16 llp,rrp;

void rd_line_hook(int line);

/******************************************************************************************/
/* Audio subsystem                                                                        */
/******************************************************************************************/

int audio_init(int samplerate, double framerate)
{
  /* Shutdown first */
  audio_shutdown();

  /* Clear the sound data context */
  memset(&snd, 0, sizeof (snd));

  /* Initialize Blip Buffers */
  /* ROMDEV_S32: 1/40 s of buffer (gpgx: 1/10); a frame is read out every frame */
  snd.blips[0] = blip_new(samplerate / 40);
  if (!snd.blips[0])
  {
    return -1;
  }

  /* Initialize resampler internal rates */
  audio_set_rate(samplerate, framerate);

  /* Set audio enable flag */
  snd.enabled = 1;

  /* Reset audio */
  audio_reset();

  return (0);
}

void audio_set_rate(int samplerate, double framerate)
{
  double mclk = framerate ? (MCYCLES_PER_LINE * (vdp_pal ? 313 : 262) * framerate) : system_clock;
  blip_set_rates(snd.blips[0], mclk, samplerate);
  snd.sample_rate = samplerate;
  snd.frame_rate  = framerate;
}

void audio_reset(void)
{
  int i;
  for (i=0; i<4; i++)
  {
    if (snd.blips[i])
    {
      blip_clear(snd.blips[i]);
    }
  }
  llp = 0;
  rrp = 0;
}

void audio_shutdown(void)
{
  /* the blip buffers come from the init-only bump allocator: nothing to free */
  snd.blips[0] = 0;
}

int audio_update(int16 *buffer)
{
  /* run FM & PSG sound chips until end of frame */
  int size = sound_update(mcycles_vdp);

  /* resample FM/PSG mixed stream to output buffer */
  blip_read_samples(snd.blips[0], buffer, size);
  /* Audio filtering (off, as in the gpgx libretro reference: its
     check_variables sets config.filter = 0 when audio_filter is unset) */
  if (config.filter & 1)
  {
    int samples = size;
    int16 *out = buffer;
    int32 l, r;
    uint32 factora  = config.lp_range;
    uint32 factorb  = 0x10000 - factora;

    l = llp;
    r = rrp;
    do
    {
      l = l*factora + out[0]*factorb;
      r = r*factora + out[1]*factorb;
      l >>= 16;
      r >>= 16;
      *out++ = l;
      *out++ = r;
    }
    while (--samples);
    llp = l;
    rrp = r;
  }

  return size;
}

/****************************************************************
 * Virtual System emulation
 ****************************************************************/
void system_init(void)
{
  gen_init();
  io_init();
  vdp_init();
  render_init();
  sound_init();
}

void system_reset(void)
{
  gen_reset(1);
  io_reset();
  render_reset();
  vdp_reset();
  sound_reset();
  audio_reset();
}

void system_frame_gen(int do_skip)
{
  /* line counters */
  int start, end, line;

  /* reset frame cycle counter */
  mcycles_vdp = 0;

  /* reset VDP FIFO */
  fifo_cycles[0] = 0;
  fifo_cycles[1] = 0;
  fifo_cycles[2] = 0;
  fifo_cycles[3] = 0;

  /* check if display setings have changed during previous frame */
  if (bitmap.viewport.changed & 2)
  {
    /* interlaced modes */
    int old_interlaced = interlaced;
    interlaced = (reg[12] & 0x02) >> 1;

    if (old_interlaced != interlaced)
    {
      /* double resolution mode */
      im2_flag = ((reg[12] & 0x06) == 0x06);

      /* reset field status flag */
      odd_frame = interlaced;

      /* video mode has changed */
      bitmap.viewport.changed = 5;

      /* update rendering mode (Mode 5 only) */
      if (reg[1] & 0x04)
      {
        if (im2_flag)
        {
          parse_satb = parse_satb_m5_im2;
          render_bg = (reg[11] & 0x04) ? render_bg_m5_im2_vs : render_bg_m5_im2;
          render_obj = (reg[12] & 0x08) ? render_obj_m5_im2_ste : render_obj_m5_im2;
        }
        else
        {
          parse_satb = parse_satb_m5;
          render_bg = (reg[11] & 0x04) ? render_bg_m5_vs : render_bg_m5;
          render_obj = (reg[12] & 0x08) ? render_obj_m5_ste : render_obj_m5;
        }
      }
    }
    else
    {
      /* clear flag */
      bitmap.viewport.changed &= ~2;
    }

    /* active screen height */
    if (reg[1] & 0x04)
    {
      /* Mode 5 */
      if (reg[1] & 0x08)
      {
        /* 240 active lines */
        bitmap.viewport.h = 240;
        bitmap.viewport.y = (config.overscan & 1) * 24 * vdp_pal;
      }
      else
      {
        /* 224 active lines */
        bitmap.viewport.h = 224;
        bitmap.viewport.y = (config.overscan & 1) * (8 + (24 * vdp_pal));
      }
    }
    else
    {
      /* Mode 4 (192 active lines) */
      bitmap.viewport.h = 192;
      bitmap.viewport.y = (config.overscan & 1) * 24 * (vdp_pal + 1);
    }

    /* active screen width */
    bitmap.viewport.w = 256 + ((reg[12] & 0x01) << 6);

    /* check viewport changes */
    if (bitmap.viewport.h != bitmap.viewport.oh)
    {
      bitmap.viewport.oh = bitmap.viewport.h;
      bitmap.viewport.changed |= 1;
    }
  }

  /* first line of overscan */
  if (bitmap.viewport.y)
  {
    blank_line(bitmap.viewport.h, -bitmap.viewport.x, bitmap.viewport.w + 2*bitmap.viewport.x);
  }

  /* clear DMA Busy, FIFO FULL & field flags */
  status &= 0xFEED;

  /* set VBLANK flag */
  status |= 0x08;

  /* check interlaced modes */
  if (interlaced)
  {
    /* switch even/odd field flag */
    odd_frame ^= 1;
    status |= (odd_frame << 4);
  }

  /* run VDP DMA */
  if (dma_length)
  {
    vdp_dma_update(0);
  }

  /* update 6-Buttons & Lightguns */
  input_refresh();

  /* H-Int counter */
  if (h_counter == 0)
  {
    /* Horizontal Interrupt is pending */
    hint_pending = 0x10;
    if (reg[0] & 0x10)
    {
      /* level 4 interrupt */
      m68k_update_irq(4);
    }
  }

  /* refresh inputs just before VINT (Warriors of Eternal Sun) */
  osd_input_update();

  /* VDP always starts after VBLANK so VINT cannot occur on first frame after a VDP reset (verified on real hardware) */
  if (v_counter != bitmap.viewport.h)
  {
    /* reinitialize VCounter */
    v_counter = bitmap.viewport.h;

    /* delay between VBLANK flag & Vertical Interrupt (Dracula, OutRunners, VR Troopers) */
    m68k_run(vint_cycle);
    if (zstate == 1)
    {
      z80_run(vint_cycle);
    }

    /* set VINT flag */
    status |= 0x80;

    /* Vertical Interrupt */
    vint_pending = 0x20;
    if (reg[1] & 0x20)
    {
      /* level 6 interrupt */
      m68k_set_irq(6);
    }

    /* assert Z80 interrupt */
    Z80.irq_state = ASSERT_LINE;
  }

  /* run 68k & Z80 until end of line */
  m68k_run(MCYCLES_PER_LINE);
  if (zstate == 1)
  {
    z80_run(MCYCLES_PER_LINE);
  }

  /* Z80 interrupt is cleared at the end of the line */
  Z80.irq_state = CLEAR_LINE;

  /* update VDP cycle count */
  mcycles_vdp = MCYCLES_PER_LINE;

  /* initialize line count */
  line = bitmap.viewport.h + 1;

  /* initialize overscan area */
  start = lines_per_frame - bitmap.viewport.y;
  end = bitmap.viewport.h + bitmap.viewport.y;

  /* Vertical Blanking */
  do
  {
    /* update VCounter */
    v_counter = line;

    /* render overscan */
    if ((line < end) || (line >= start))
    {
      blank_line(line, -bitmap.viewport.x, bitmap.viewport.w + 2*bitmap.viewport.x);
    }

    /* update 6-Buttons & Lightguns */
    input_refresh();

    /* run 68k & Z80 until end of line */
    m68k_run(mcycles_vdp + MCYCLES_PER_LINE);
    if (zstate == 1)
    {
      z80_run(mcycles_vdp + MCYCLES_PER_LINE);
    }

    /* update VDP cycle count */
    mcycles_vdp += MCYCLES_PER_LINE;

    rd_line_hook(line); /* ROMDEV_S32 */
  }
  while (++line < (lines_per_frame - 1));

  /* update VCounter */
  v_counter = line;

  /* last line of overscan */
  if (bitmap.viewport.y)
  {
    blank_line(line, -bitmap.viewport.x, bitmap.viewport.w + 2*bitmap.viewport.x);
  }

  /* reload H-Int counter */
  h_counter = reg[10];

  /* clear VBLANK flag */
  status &= ~0x08;

  /* run VDP DMA */
  if (dma_length)
  {
    vdp_dma_update(mcycles_vdp);
  }

  /* parse first line of sprites */
  if (reg[1] & 0x40)
  {
    parse_satb(-1);
  }

  /* update 6-Buttons & Lightguns */
  input_refresh();

  /* run 68k & Z80 until end of line */
  m68k_run(mcycles_vdp + MCYCLES_PER_LINE);
  if (zstate == 1)
  {
    z80_run(mcycles_vdp + MCYCLES_PER_LINE);
  }

  /* update VDP cycle count */
  mcycles_vdp += MCYCLES_PER_LINE;

  /* reset line count */
  line = 0;

  /* Active Display */
  do
  {
    /* update VCounter */
    v_counter = line;

    /* run VDP DMA */
    if (dma_length)
    {
      vdp_dma_update(mcycles_vdp);
    }

    /* render scanline */
    if (!do_skip)
    {
      render_line(line);
    }

    /* update 6-Buttons & Lightguns */
    input_refresh();

    /* H-Int counter */
    if (h_counter == 0)
    {
      /* reload H-Int counter */
      h_counter = reg[10];

      /* Horizontal Interrupt is pending */
      hint_pending = 0x10;
      if (reg[0] & 0x10)
      {
        /* level 4 interrupt */
        m68k_update_irq(4);
      }
    }
    else
    {
      /* decrement H-Int counter */
      h_counter--;
    }

    /* run 68k & Z80 until end of line */
    m68k_run(mcycles_vdp + MCYCLES_PER_LINE);
    if (zstate == 1)
    {
      z80_run(mcycles_vdp + MCYCLES_PER_LINE);
    }

    /* update VDP cycle count */
    mcycles_vdp += MCYCLES_PER_LINE;

    rd_line_hook(line); /* ROMDEV_S32 */
  }
  while (++line < bitmap.viewport.h);

  /* check viewport changes */
  if (bitmap.viewport.w != bitmap.viewport.ow)
  {
    bitmap.viewport.ow = bitmap.viewport.w;
    bitmap.viewport.changed |= 1;
  }

  /* adjust timings for next frame */
  input_end_frame(mcycles_vdp);
  m68k.refresh_cycles -= mcycles_vdp;
  m68k.cycles -= mcycles_vdp;
  Z80.cycles -= mcycles_vdp;
  dma_endCycles = 0;
}
