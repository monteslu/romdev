/* The SVP unit: Genesis Plus GX's own cart_hw/svp/svp.c and ssp16.c (the
 * SSP1601 DSP interpreter and the SVP memory controller, by notaz, adapted
 * by Eke-Eke), compiled unchanged, plus the entry points gpgx's own callers
 * use:
 *
 *   md_cart.c md_cart_init        svp_init()            romdev_svp_init
 *   md_cart.c md_cart_reset       svp_reset()           romdev_svp_reset
 *   system.c system_frame_gen     ssp1601_run(SVP_cycles) after every line
 *                                                       romdev_svp_run
 *   m68kcpu.h m68ki_read_8/16, m68ki_write_8/16 on the banks svp_init maps
 *                                 ($300000-$31FFFF DRAM, $390000/$3A0000 cell
 *                                 arrange reads)        romdev_svp_read8/16, romdev_svp_write8/16
 *   mem68k.c ctrl_io_read_byte / ctrl_io_read_word / ctrl_io_write_word,
 *                                 case 0x50 ($A15000-$A150FF)
 *                                                       romdev_svp_ctrl_r8 / _r16 / _w16
 *
 * Non-commercial: see the notice in svp.c / ssp16.c. */
#include "shared.h"

/* loadrom.c / md_cart.c: cart.rom holds the ROM as host-order (little-endian)
 * 16-bit words; svp_init puts the svp_t at cart.rom + 0x200000. */
static uint8 romdev_cart_rom[0x200000 + sizeof(svp_t)] __attribute__((aligned(16)));
md_cart_t cart;
m68ki_cpu_core m68k;
t_zbank_memory_map zbank_memory_map[256];

/* the ROM image in 68000 byte order (padded as md_cart_init pads it) */
void romdev_svp_init(const uint8 *rom, unsigned int size)
{
  unsigned int i;
  cart.rom = romdev_cart_rom;
  if (size > 0x200000) size = 0x200000;
  for (i = 0; i < size; i++) romdev_cart_rom[i ^ 1] = rom[i];
  svp_init();
}

void romdev_svp_reset(void)
{
  svp_reset();
}

void romdev_svp_run(int cycles)
{
  ssp1601_run(cycles);
}

/* the svp_t (svp->iram_rom, svp->dram, svp->ssp1601) */
void *romdev_svp_state(void)
{
  return svp;
}

unsigned int romdev_svp_ssp_size(void)
{
  return sizeof(ssp1601_t);
}

unsigned int romdev_svp_read8(unsigned int address)
{
  cpu_memory_map *temp = &m68k.memory_map[(address >> 16) & 0xff];
  if (temp->read8) return (*temp->read8)(address & 0xffffff);
  return READ_BYTE(temp->base, address & 0xffff);
}

unsigned int romdev_svp_read16(unsigned int address)
{
  cpu_memory_map *temp = &m68k.memory_map[(address >> 16) & 0xff];
  if (temp->read16) return (*temp->read16)(address & 0xffffff);
  return *(uint16 *)(temp->base + (address & 0xffff));
}

void romdev_svp_write8(unsigned int address, unsigned int data)
{
  cpu_memory_map *temp = &m68k.memory_map[(address >> 16) & 0xff];
  if (temp->write8) (*temp->write8)(address & 0xffffff, data);
  else WRITE_BYTE(temp->base, address & 0xffff, data);
}

void romdev_svp_write16(unsigned int address, unsigned int data)
{
  cpu_memory_map *temp = &m68k.memory_map[(address >> 16) & 0xff];
  if (temp->write16) (*temp->write16)(address & 0xffffff, data);
  else *(uint16 *)(temp->base + (address & 0xffff)) = data;
}

/* mem68k.c ctrl_io_read_byte, case 0x50; -1 = m68k_read_bus_8 */
int romdev_svp_ctrl_r8(unsigned int address)
{
  if ((address & 0xFC) == 0x00)
  {
    unsigned int data = svp->ssp1601.gr[SSP_XST].byte.h;
    return (address & 1) ? (data & 0xFF) : (data >> 8);
  }

  if ((address & 0xFE) == 0x04)
  {
    unsigned int data = svp->ssp1601.gr[SSP_PM0].byte.h;
    svp->ssp1601.gr[SSP_PM0].byte.h &= ~1;
    return (address & 1) ? (data & 0xFF) : (data >> 8);
  }

  return -1;
}

/* mem68k.c ctrl_io_read_word, case 0x50; -1 = m68k_read_bus_16 */
int romdev_svp_ctrl_r16(unsigned int address)
{
  if ((address & 0xFC) == 0x00)
  {
    return svp->ssp1601.gr[SSP_XST].byte.h;
  }

  if ((address & 0xFE) == 0x04)
  {
    unsigned int data = svp->ssp1601.gr[SSP_PM0].byte.h;
    svp->ssp1601.gr[SSP_PM0].byte.h &= ~1;
    return data;
  }

  return -1;
}

/* mem68k.c ctrl_io_write_word, case 0x50; 0 = m68k_unused_16_w */
int romdev_svp_ctrl_w16(unsigned int address, unsigned int data)
{
  if (!(address & 0xFD))
  {
    svp->ssp1601.gr[SSP_XST].byte.h = data;
    svp->ssp1601.gr[SSP_PM0].byte.h |= 2;
    svp->ssp1601.emu_status &= ~SSP_WAIT_PM0;
    return 1;
  }
  return 0;
}
