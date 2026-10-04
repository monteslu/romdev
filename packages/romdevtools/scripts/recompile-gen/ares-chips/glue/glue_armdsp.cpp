/* romdev: ares's ARM core (component/processor/arm7tdmi, compiled as it is)
 * as the ST018 of a cart that is not run by ares. The chip's memory map
 * (sfc/coprocessor/armdsp/memory.cpp: sleep, get, set) and its bridge as the
 * S-CPU sees it (io.cpp: read, write) are ares's own files, included below as
 * they are. This file is the rest of ares's driver without its node tree,
 * debugger and scheduler list: the ARMDSP struct of armdsp.hpp (its Bridge
 * copied as it is), boot / main / step / power / reset of armdsp.cpp, the
 * firmware load of cartridge/load.cpp loadARMDSP, and the two halves of
 * ares's Thread::synchronize (see romdev_ares_chips.hpp for the time model).
 *
 * As in ares, the ARM is a cothread (libco; romdev's WebAssembly backend,
 * scripts/patches/libco-wasm/libco-wasm.c): every ARM memory access steps the
 * clock and yields to the S-CPU the moment the ARM is ahead, in the middle of
 * an instruction if that is where it gets ahead, exactly where ares yields.
 * The S-CPU side resumes it on every bridge access (io.cpp's
 * cpu.synchronize). Licence: ares is ISC (Copyright (c) 2004-2025 ares team,
 * Near et al); see romdev's NOTICE. */
#include <ares/ares.hpp>
#include <component/processor/arm7tdmi/arm7tdmi.hpp>
#include <libco/libco.h>

extern "C" void romdev_co_run(void (*root)(void));

#include "romdev_ares_chips.hpp"
#include "romdev_ares_thread.hpp"
#include "romdev_ares_chipstate.h"

/* an inline namespace of its own: the snes9x core links both glue files, each
 * with its own stand-in for the S-CPU (cpu) */
namespace ares::SuperFamicom { inline namespace romdev_armdsp {

/* a Thread with the cothread ares's Thread::create makes for it */
struct CoThread : Thread {
  auto handle() const -> cothread_t { return _handle; }

  /* ares/scheduler/thread.hpp Thread::synchronize(thread): switch to it while
   * it is behind (ares also stops while its scheduler is synchronizing for a
   * save state, which never happens here) */
  auto synchronize(CoThread& thread) -> void {
    while(thread.clock() < clock() && thread.handle()) {
      co_switch(thread.handle());
    }
  }

  cothread_t _handle = nullptr;
};

struct ARMDSP;

/* the S-CPU, as far as the chip sees it: its clock, its cothread (the one that
 * resumed the ARM), and Thread::synchronize */
struct CPU : CoThread {
  auto synchronize(ARMDSP& thread) -> void;
};
CPU cpu;

/* armdsp.hpp: struct ARMDSP : ARM7TDMI, Thread */
struct ARMDSP : ARM7TDMI, CoThread {
  n32 Frequency;

  //armdsp.cpp
  static auto Enter() -> void;
  auto boot() -> void;
  auto main() -> void;
  auto step(u32 clocks) -> void override;
  auto power() -> void;
  auto reset() -> void;  //soft reset

  //memory.cpp
  auto sleep() -> void override;
  auto get(u32 mode, n32 address) -> n32 override;
  auto set(u32 mode, n32 address, n32 word) -> void override;

  //io.cpp
  auto read(n24 address, n8 data) -> n8;
  auto write(n24 address, n8 data) -> void;

  n8 programROM[128_KiB];
  n8 dataROM[32_KiB];
  n8 programRAM[16_KiB];

  struct Bridge {
    struct Buffer {
      n1 ready;
      n8 data;
    };
    Buffer cputoarm;
    Buffer armtocpu;
    n32 timer;
    n32 timerlatch;
    n1  reset;
    n1  ready;
    n1  signal;

    auto status() const -> n8 {
      n8 data;
      data.bit(0) = armtocpu.ready;
      data.bit(2) = signal;
      data.bit(3) = cputoarm.ready;
      data.bit(7) = ready;
      return data;
    }
  } bridge;
};

ARMDSP* armdsp_ = nullptr;

#include <sfc/coprocessor/armdsp/memory.cpp>
#include <sfc/coprocessor/armdsp/io.cpp>

/* armdsp.cpp */
auto ARMDSP::boot() -> void {
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

/* debugger.instruction() is ares's tracer, not here */
auto ARMDSP::main() -> void {
  processor.cpsr.t = 0;  //force ARM mode
  instruction();
}

auto ARMDSP::step(u32 clocks) -> void {
  if(bridge.timer && --bridge.timer == 0);
  Thread::step(clocks);
  CoThread::synchronize(cpu);
}

/* random.array(programRAM) fills it under ares's entropy setting; romdev runs
 * Random::Entropy::None, which is zero, so a cart and its reference agree */
auto ARMDSP::power() -> void {
  for(auto& byte : programRAM) byte = 0x00;
  bridge.reset = false;
  reset();
}

/* the entry point reset() gives Thread::create, as ares's Thread::Enter runs
 * it: boot(), then main() forever (scheduler.synchronize() between them only
 * stops for a save state) */
auto ARMDSP::Enter() -> void {
  armdsp_->boot();
  while(true) armdsp_->main();
}

auto ARMDSP::reset() -> void {
  ARM7TDMI::power();
  /* Thread::create(Frequency, entry): a new cothread (or the old one derived
   * again), setFrequency, setClock(0); scheduler.append keeps the uniqueID a
   * thread already has */
  _handle = _handle ? co_derive(_handle, Thread::Size, &ARMDSP::Enter) : co_create(Thread::Size, &ARMDSP::Enter);
  setFrequency(Frequency);
  setClock(0);

  bridge.ready = false;
  bridge.signal = false;
  bridge.timer = 0;
  bridge.timerlatch = 0;
  bridge.cputoarm.ready = false;
  bridge.armtocpu.ready = false;
}

/* cpu.synchronize(armdsp) on the S-CPU's side: the S-CPU's cothread is
 * whichever resumed the ARM; switching inside romdev_co_run (libco-wasm) */
void romdev_resume() {
  cpu._handle = co_active();
  cpu.CoThread::synchronize(*armdsp_);
}

auto CPU::synchronize(ARMDSP& thread) -> void {
  if(thread.clock() < clock()) romdev_co_run(romdev_resume);
}

} }

namespace {

using ares::SuperFamicom::ARMDSP;
using ares::SuperFamicom::armdsp_;
using ares::SuperFamicom::cpu;

alignas(16) unsigned char storage[sizeof(ARMDSP)];
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

extern "C" void romdev_armdsp_init(const unsigned char* firmware) {
  /* constructed once: ARM7TDMI() builds its instruction tables */
  if(!armdsp_) armdsp_ = new(storage) ARMDSP();
  /* cartridge/load.cpp loadARMDSP */
  for(auto& b : armdsp_->programROM) b = 0x00;
  for(auto& b : armdsp_->dataROM) b = 0x00;
  for(auto& b : armdsp_->programRAM) b = 0x00;
  /* the oscillator mia's ARM board gives it */
  armdsp_->Frequency = 21'440'000;
  for(unsigned n = 0; n < sizeof(armdsp_->programROM); n++) armdsp_->programROM[n] = firmware[n];
  for(unsigned n = 0; n < sizeof(armdsp_->dataROM); n++) armdsp_->dataROM[n] = firmware[0x20000 + n];
  /* System::power: cpu.power (Thread::create at the S-CPU's frequency), ...,
   * cartridge.power (ARMDSP::power), then scheduler.power(cpu) */
  cpu.setFrequency(ares::Constants::Colorburst::NTSC * 6.0);
  armdsp_->power();
  cpu.setClock(ares::RomdevCPUUniqueID);
  armdsp_->setClock(ares::RomdevChipUniqueID);
  base = 0;
  synced = 0;
}

/* io.cpp ARMDSP::read: MMIO 00-3f,80-bf:3800-38ff, 3800-3807 mirrored, a0
 * ignored. An address of the host's window outside $3800-$38FF is not the
 * chip's: -1 (the host reads open bus), and the chip is not synchronized. */
extern "C" int romdev_armdsp_read(int address, int now) {
  if((address & 0xff00) != 0x3800) return -1;
  advance(now);
  return armdsp_->read(address, 0);
}

/* io.cpp ARMDSP::write (outside $3800-$38FF: not the chip's, nothing happens) */
extern "C" void romdev_armdsp_write(int address, int data, int now) {
  if((address & 0xff00) != 0x3800) return;
  advance(now);
  armdsp_->write(address, data);
}

/* the line end: the S-CPU's clock moves to it, and the clocks are reduced
 * (romdev_ares_thread.hpp). A chip left more than a quarter second behind
 * (no access for that long) is brought up first, so no clock can overflow;
 * where a catch-up is cut changes nothing the chip computes (ares itself
 * synchronizes its coprocessors on every S-CPU step). */
extern "C" void romdev_armdsp_line(int lineLength) {
  /* a host gives one line at a time; a longer span (a test replaying an
   * access log) is taken in pieces a 64-bit clock can hold */
  while(lineLength > 0) {
    int n = lineLength < 0x100000 ? lineLength : 0x100000;
    lineLength -= n;
    base += n;
    advance(0);
    if(armdsp_->clock() < cpu.clock() && cpu.clock() - armdsp_->clock() > ares::Thread::Second / 4) cpu.synchronize(*armdsp_);
    ares::romdev_ares_reduce(cpu, *armdsp_);
  }
}

extern "C" int romdev_armdsp_chipstate(unsigned char* out) {
  return (int)romdev_ares_cs_armdsp(out, *armdsp_, armdsp_->bridge, (const unsigned char*)
    armdsp_->programRAM, sizeof(armdsp_->programRAM), (long long)(armdsp_->clock() - cpu.clock()));
}
