/* romdev: bsnes's ARM core (processor/arm7tdmi, compiled as it is) as the
 * ST018 of a cart that is not run by bsnes. The chip's memory map and bridge
 * are bsnes's own sfc/coprocessor/armdsp/memory.cpp, included below as it
 * is; this file is the rest of sfc/coprocessor/armdsp/armdsp.cpp with a
 * one-thread stand-in for bsnes's scheduler (see romdev_bsnes_chips.hpp for
 * the time model): the bridge as the S-CPU sees it (read / write), the reset,
 * the thread (Enter / boot / main) and step / synchronizeCPU.
 *
 * Like bsnes, the ARM is a cothread (libco; romdev's WebAssembly backend,
 * scripts/patches/bsnes/libco-wasm.c): every ARM memory access steps the
 * clock and yields to the S-CPU the moment the ARM is ahead, in the middle of
 * an instruction if that is where it gets ahead, exactly where bsnes yields.
 * The S-CPU side resumes it on every bridge access (cpu.cpp
 * synchronizeCoprocessors). Licence: GPL-3.0 (bsnes). */
#include <processor/processor.hpp>
#include <processor/arm7tdmi/arm7tdmi.hpp>
#include <libco/libco.h>

extern "C" void romdev_co_run(void (*root)(void));

#include "romdev_bsnes_chips.hpp"
#include "romdev_bsnes_chipstate.h"

namespace SuperFamicom {

/* armdsp.hpp, with Thread's clock / frequency kept here */
struct ArmDSP : Processor::ARM7TDMI {
  #include <sfc/coprocessor/armdsp/registers.hpp>

  auto step(uint clocks) -> void override;
  auto sleep() -> void override;
  auto get(uint mode, uint32 addr) -> uint32 override;
  auto set(uint mode, uint32 addr, uint32 word) -> void override;

  uint Frequency = 0;
  long long clock = 0;

  uint8 programROM[128 * 1024];
  uint8 dataROM[32 * 1024];
  uint8 programRAM[16 * 1024];

  /* sfc.hpp Thread: the cothread, and its size (Thread::Size) */
  cothread_t thread = nullptr;
  enum : uint { Size = 4 * 1024 * sizeof(void*) };

  /* armdsp.cpp */
  auto synchronizeCPU() -> void;
  static auto Enter() -> void;
  auto boot() -> void;
  auto main() -> void;
  auto reset() -> void;
};

ArmDSP* armdsp = nullptr;
/* the S-CPU's cothread: the one that resumed the ARM (scheduler.resume(cpu.thread)) */
cothread_t romdevHost = nullptr;

/* armdsp/memory.cpp: sleep, get, set */
#include <sfc/coprocessor/armdsp/memory.cpp>

/* armdsp.cpp, with Scheduler::resume / Scheduler::synchronize for one thread */
auto ArmDSP::synchronizeCPU() -> void {
  if(clock >= 0) co_switch(romdevHost);
}

auto ArmDSP::Enter() -> void {
  armdsp->boot();
  while(true) {
    armdsp->main();
  }
}

auto ArmDSP::boot() -> void {
  //reset hold delay
  while(bridge.reset) {
    step(1);
    continue;
  }

  //reset sequence delay
  if(bridge.ready == false) {
    step(65'536);
    bridge.ready = true;
  }
}

auto ArmDSP::main() -> void {
  processor.cpsr.t = 0;  //force ARM mode
  instruction();
}

auto ArmDSP::step(uint clocks) -> void {
  if(bridge.timer && --bridge.timer == 0);
  clock += clocks * (uint64_t)ROMDEV_BCHIP_CPU_FREQUENCY;
  synchronizeCPU();
}

auto ArmDSP::reset() -> void {
  ARM7TDMI::power();
  /* Thread::create(ArmDSP::Enter, Frequency) */
  thread = thread ? co_derive(thread, Size, Enter) : co_create(Size, Enter);
  clock = 0;

  bridge.ready = false;
  bridge.signal = false;
  bridge.timer = 0;
  bridge.timerlatch = 0;
  bridge.cputoarm.ready = false;
  bridge.armtocpu.ready = false;
}

}

namespace romdev_bchip {

using SuperFamicom::ArmDSP;
using SuperFamicom::armdsp;
alignas(16) unsigned char storage[sizeof(ArmDSP)];
long long base = 0;
long long synced = 0;

/* scheduler.resume(armdsp.thread) from the S-CPU's side */
void resume() {
  SuperFamicom::romdevHost = co_active();
  co_switch(armdsp->thread);
}

/* cpu.cpp synchronizeCoprocessors: the S-CPU's clocks since the last access,
 * then the ARM runs while it is behind */
void synchronize(int now) {
  long long t = base + now;
  long long d = t - synced;
  if(d <= 0) return;
  synced = t;
  armdsp->clock -= d * (long long)armdsp->Frequency;
  if(armdsp->clock < 0) romdev_co_run(resume);
}

}

using namespace romdev_bchip;

extern "C" void romdev_armdsp_init(const unsigned char* firmware) {
  /* constructed once: ARM7TDMI() builds its instruction tables */
  if(!armdsp) armdsp = new(storage) ArmDSP();
  /* cartridge/load.cpp loadARMDSP */
  for(auto& b : armdsp->programROM) b = 0x00;
  for(auto& b : armdsp->dataROM) b = 0x00;
  for(auto& b : armdsp->programRAM) b = 0x00;
  armdsp->Frequency = 21'440'000;
  for(unsigned n = 0; n < sizeof(armdsp->programROM); n++) armdsp->programROM[n] = firmware[n];
  for(unsigned n = 0; n < sizeof(armdsp->dataROM); n++) armdsp->dataROM[n] = firmware[0x20000 + n];
  /* ArmDSP::power: random.array(programRAM) (Entropy None: zero); bridge.reset = false; reset() */
  for(auto& b : armdsp->programRAM) b = 0x00;
  armdsp->bridge.reset = false;
  armdsp->reset();
  base = 0;
  synced = 0;
}

/* ArmDSP::read: MMIO 00-3f,80-bf:3800-38ff, 3800-3807 mirrored, a0 ignored.
 * An address of the host's window outside $3800-$38FF is not the chip's: -1
 * (the host reads open bus), and the chip is not synchronized. */
extern "C" int romdev_armdsp_read(int address, int now) {
  if((address & 0xff00) != 0x3800) return -1;
  synchronize(now);
  unsigned data = 0x00;
  unsigned addr = address & 0xff06;
  if(addr == 0x3800) {
    if(armdsp->bridge.armtocpu.ready) {
      armdsp->bridge.armtocpu.ready = false;
      data = armdsp->bridge.armtocpu.data;
    }
  }
  if(addr == 0x3802) armdsp->bridge.signal = false;
  if(addr == 0x3804) data = armdsp->bridge.status();
  return data;
}

/* ArmDSP::write (outside $3800-$38FF: not the chip's, nothing happens) */
extern "C" void romdev_armdsp_write(int address, int data, int now) {
  if((address & 0xff00) != 0x3800) return;
  synchronize(now);
  unsigned addr = address & 0xff06;
  if(addr == 0x3802) {
    armdsp->bridge.cputoarm.ready = true;
    armdsp->bridge.cputoarm.data = data;
  }
  if(addr == 0x3804) {
    data &= 1;
    if(!armdsp->bridge.reset && data) armdsp->reset();
    armdsp->bridge.reset = data;
  }
}

extern "C" void romdev_armdsp_line(int lineLength) {
  base += lineLength;
}

extern "C" int romdev_armdsp_chipstate(unsigned char* out) {
  return (int)romdev_bsnes_cs_armdsp(out, *armdsp, armdsp->processor, armdsp->pipeline, armdsp->bridge,
    armdsp->programRAM, sizeof(armdsp->programRAM), armdsp->clock);
}
