/* romdev: bsnes's uPD96050 (processor/upd96050, compiled as it is) as the
 * ST010 / ST011 chip of a cart that is not run by bsnes. This file is the
 * part of sfc/coprocessor/necdsp/necdsp.cpp that is not bsnes's scheduler,
 * and the board map bsnes gives it (EXNEC-LOROM). See romdev_bsnes_chips.hpp
 * for the time model. Licence: GPL-3.0 (bsnes). */
#include <processor/processor.hpp>
#include <processor/upd96050/upd96050.hpp>

#include "romdev_bsnes_chips.hpp"
#include "romdev_bsnes_chipstate.h"

namespace {

/* necdsp.hpp: struct NECDSP : Processor::uPD96050, Thread (Thread's clock and
 * Frequency kept here) */
struct ChipNECDSP : Processor::uPD96050 {
  long long clock = 0;
  unsigned Frequency = 0;
};

alignas(16) unsigned char storage[sizeof(ChipNECDSP)];
ChipNECDSP* necdsp = nullptr;
long long base = 0;     /* master clock at the start of the current line */
long long synced = 0;   /* master clock the chip has been brought up to */

/* cpu.cpp synchronizeCoprocessors + necdsp.cpp main / step: the S-CPU's
 * clocks since the last access, then the chip runs while it is behind */
void synchronize(int now) {
  long long t = base + now;
  long long d = t - synced;
  if(d <= 0) return;
  synced = t;
  necdsp->clock -= d * (long long)necdsp->Frequency;     /* CPU::step: clock -= Clocks * frequency */
  while(necdsp->clock < 0) {
    necdsp->exec();                                       /* NECDSP::main: exec(); step(1); */
    necdsp->clock += ROMDEV_BCHIP_CPU_FREQUENCY;          /* NECDSP::step: clock += clocks * cpu.frequency */
  }
}

}

extern "C" void romdev_necdsp_init(int which, const unsigned char* firmware) {
  necdsp = new(storage) ChipNECDSP();
  /* cartridge/load.cpp loaduPD96050 */
  necdsp->revision = Processor::uPD96050::Revision::uPD96050;
  for(auto& word : necdsp->programROM) word = 0x000000;
  for(auto& word : necdsp->dataROM) word = 0x0000;
  for(auto& word : necdsp->dataRAM) word = 0x0000;
  necdsp->Frequency = which == 10 ? 11'000'000 : 15'000'000;
  for(unsigned n = 0; n < 16384; n++) {
    const unsigned char* p = firmware + n * 3;
    necdsp->programROM[n] = p[0] | p[1] << 8 | p[2] << 16;
  }
  for(unsigned n = 0; n < 2048; n++) {
    const unsigned char* p = firmware + 0xc000 + n * 2;
    necdsp->dataROM[n] = p[0] | p[1] << 8;
  }
  /* NECDSP::power: uPD96050::power(); create(NECDSP::Enter, Frequency) */
  necdsp->power();
  necdsp->clock = 0;
  base = 0;
  synced = 0;
}

/* EXNEC-LOROM: processor map 60-67,e0-e7:0000-3fff (NECDSP::read / write:
 * A0 selects SR / DR); RAM map 68-6f,e8-ef:0000-7fff mask=0x8000
 * (readRAM / writeRAM: uPD96050::readDP / writeDP take 12 address bits) */
extern "C" int romdev_necdsp_read(int address, int now) {
  synchronize(now);
  unsigned bank = (unsigned)address >> 16 & 0x7f;
  if(bank >= 0x68) return necdsp->readDP(address & 0xfff);
  return address & 1 ? necdsp->readSR() : necdsp->readDR();
}

extern "C" void romdev_necdsp_write(int address, int data, int now) {
  synchronize(now);
  unsigned bank = (unsigned)address >> 16 & 0x7f;
  if(bank >= 0x68) return necdsp->writeDP(address & 0xfff, data);
  if(address & 1) necdsp->writeSR(data); else necdsp->writeDR(data);
}

extern "C" void romdev_necdsp_line(int lineLength) {
  base += lineLength;
}

extern "C" int romdev_necdsp_chipstate(unsigned char* out) {
  return (int)romdev_bsnes_cs_upd96050(out, *necdsp, necdsp->clock);
}
