/* romdev: ares's uPD96050 (component/processor/upd96050, compiled as it is)
 * as the ST010 / ST011 chip of a cart that is not run by ares. The S-CPU
 * side of the chip is ares's own sfc/coprocessor/necdsp/memory.cpp, included
 * below as it is (NECDSP::read / write / readRAM / writeRAM, each of which
 * first brings the chip up to the S-CPU with cpu.synchronize). This file is
 * the rest of ares's driver without its node tree, debugger and scheduler
 * list: the NECDSP struct of necdsp.hpp, NECDSP::main / power of necdsp.cpp,
 * the firmware load of cartridge/load.cpp loaduPD96050, and the S-CPU's
 * Thread::synchronize for a chip that yields only between instructions (see
 * romdev_ares_chips.hpp). Licence: ares is ISC (Copyright (c) 2004-2025 ares
 * team, Near et al); see romdev's NOTICE. */
#include <ares/ares.hpp>
#include <component/processor/upd96050/upd96050.hpp>

#include "romdev_ares_chips.hpp"
#include "romdev_ares_thread.hpp"
#include "romdev_ares_chipstate.h"

/* an inline namespace of its own: the snes9x core links both glue files, each
 * with its own stand-in for the S-CPU (cpu) */
namespace ares::SuperFamicom { inline namespace romdev_necdsp {

struct NECDSP;

/* the S-CPU, as far as the chip sees it: its clock, and Thread::synchronize */
struct CPU : Thread {
  auto synchronize(NECDSP& thread) -> void;
};
CPU cpu;

/* necdsp.hpp: struct NECDSP : uPD96050, Thread */
struct NECDSP : uPD96050, Thread {
  n32 Frequency = 0;

  //necdsp.cpp
  auto main() -> void;
  auto power() -> void;

  //memory.cpp
  auto read(n24 address, n8 data) -> n8;
  auto write(n24 address, n8 data) -> void;

  auto readRAM(n24 address, n8 data) -> n8;
  auto writeRAM(n24 address, n8 data) -> void;
};

#include <sfc/coprocessor/necdsp/memory.cpp>

/* necdsp.cpp NECDSP::main: debugger.instruction(); exec(); Thread::step(1);
 * Thread::synchronize(cpu). The last switches back to the S-CPU only when
 * the S-CPU is behind; CPU::synchronize below is the loop that makes. */
auto NECDSP::main() -> void {
  exec();
  Thread::step(1);
}

/* necdsp.cpp NECDSP::power: uPD96050::power(); Thread::create(Frequency, ...)
 * (setFrequency, setClock(0); scheduler.append then gives it its uniqueID) */
auto NECDSP::power() -> void {
  uPD96050::power();
  setFrequency(Frequency);
  setClock(0);
}

/* Thread::synchronize(necdsp) on the S-CPU's side: while the chip is behind,
 * switch to it. ares runs the chip as a cothread whose entry point loops
 * NECDSP::main; main's Thread::synchronize(cpu) switches back only once the
 * S-CPU is behind the chip, so the chip runs instructions until then (an equal
 * clock runs one more). The uPD96050 never yields inside an instruction, so
 * that cothread is this loop. */
auto CPU::synchronize(NECDSP& thread) -> void {
  while(thread.clock() < clock()) {
    do thread.main(); while(!(clock() < thread.clock()));
  }
}

} }

namespace {

using ares::SuperFamicom::NECDSP;
using ares::SuperFamicom::cpu;

alignas(16) unsigned char storage[sizeof(NECDSP)];
NECDSP* necdsp = nullptr;
long long base = 0;     /* master clock at the start of the current line */
long long synced = 0;   /* master clock the S-CPU's thread clock stands at */

/* CPU::step: Thread::step(clocks) for the master clocks since the last
 * access (the access itself then synchronizes the chip, as in ares) */
void advance(int now) {
  long long t = base + now;
  long long d = t - synced;
  if(d <= 0) return;
  synced = t;
  cpu.step((u32)d);
}

}

extern "C" void romdev_necdsp_init(int which, const unsigned char* firmware) {
  necdsp = new(storage) NECDSP();
  /* cartridge/load.cpp loaduPD96050 */
  necdsp->revision = ares::uPD96050::Revision::uPD96050;
  for(auto& word : necdsp->programROM) word = 0x000000;
  for(auto& word : necdsp->dataROM) word = 0x0000;
  for(auto& word : necdsp->dataRAM) word = 0x0000;
  /* the oscillator mia's EXNEC board gives it: ST010 11 MHz, ST011 15 MHz */
  necdsp->Frequency = which == 10 ? 11'000'000 : 15'000'000;
  for(unsigned n = 0; n < 16384; n++) {
    const unsigned char* p = firmware + n * 3;
    necdsp->programROM[n] = p[0] | p[1] << 8 | p[2] << 16;   /* readl(3) */
  }
  for(unsigned n = 0; n < 2048; n++) {
    const unsigned char* p = firmware + 0xc000 + n * 2;
    necdsp->dataROM[n] = p[0] | p[1] << 8;                   /* readl(2) */
  }
  /* System::power: cpu.power (Thread::create at the S-CPU's frequency), ...,
   * cartridge.power (NECDSP::power), then scheduler.power(cpu) */
  cpu.setFrequency(ares::Constants::Colorburst::NTSC * 6.0);
  necdsp->power();
  cpu.setClock(ares::RomdevCPUUniqueID);
  necdsp->setClock(ares::RomdevChipUniqueID);
  base = 0;
  synced = 0;
}

/* EXNEC-LOROM (ares's boards.bml): processor map 60-67,e0-e7:0000-3fff
 * (NECDSP::read / write: A0 selects SR / DR); RAM map 68-6f,e8-ef:0000-7fff
 * mask=0x8000 (readRAM / writeRAM; uPD96050::readDP / writeDP take 12 bits) */
extern "C" int romdev_necdsp_read(int address, int now) {
  advance(now);
  unsigned bank = (unsigned)address >> 16 & 0x7f;
  if(bank >= 0x68) return necdsp->readRAM(address & 0xfff, 0);
  return necdsp->read(address, 0);
}

extern "C" void romdev_necdsp_write(int address, int data, int now) {
  advance(now);
  unsigned bank = (unsigned)address >> 16 & 0x7f;
  if(bank >= 0x68) return necdsp->writeRAM(address & 0xfff, data);
  necdsp->write(address, data);
}

/* the line end: the S-CPU's clock moves to it, and the clocks are reduced
 * (romdev_ares_thread.hpp). A chip left more than a quarter second behind
 * (no access for that long) is brought up first, so no clock can overflow;
 * where a catch-up is cut changes nothing the chip computes (ares itself
 * synchronizes its coprocessors on every S-CPU step). */
extern "C" void romdev_necdsp_line(int lineLength) {
  /* a host gives one line at a time; a longer span (a test replaying an
   * access log) is taken in pieces a 64-bit clock can hold */
  while(lineLength > 0) {
    int n = lineLength < 0x100000 ? lineLength : 0x100000;
    lineLength -= n;
    base += n;
    advance(0);
    if(necdsp->clock() < cpu.clock() && cpu.clock() - necdsp->clock() > ares::Thread::Second / 4) cpu.synchronize(*necdsp);
    ares::romdev_ares_reduce(cpu, *necdsp);
  }
}

extern "C" int romdev_necdsp_chipstate(unsigned char* out) {
  return (int)romdev_ares_cs_upd96050(out, *necdsp, (long long)(necdsp->clock() - cpu.clock()));
}
