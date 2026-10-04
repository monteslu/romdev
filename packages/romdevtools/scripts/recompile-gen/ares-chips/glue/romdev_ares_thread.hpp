/* romdev: ares's scheduler time model for a coprocessor that runs outside
 * ares (glue_necdsp.cpp, glue_armdsp.cpp; see romdev_ares_chips.hpp).
 *
 * ares (ares/scheduler/thread.hpp) gives every thread a 64-bit clock counted
 * in units of 1/Second of a second (Second = 2^63 - 1): setFrequency rounds
 * the frequency to an integer and keeps scalar = Second / frequency, and
 * step(clocks) adds scalar * clocks. One thread is behind another when its
 * clock is lower; Thread::synchronize(other) switches to `other` while
 * other.clock() < clock(). This struct is that clock, with ares's own
 * arithmetic, and nothing else of ares's scheduler (no thread list, no
 * entry-point table, no serialization): each glue file runs one chip against
 * the S-CPU.
 *
 * ares's scheduler subtracts the clock of the thread furthest behind from
 * every thread at each scheduler exit (once a frame) so the clocks cannot
 * overflow; here the same is done at each line end (romdev_ares_reduce). A
 * common subtraction changes no comparison between two clocks.
 *
 * ares is ISC-licensed (Copyright (c) 2004-2025 ares team, Near et al); this
 * file restates its thread clock and is romdev's. */
#ifndef ROMDEV_ARES_THREAD_HPP
#define ROMDEV_ARES_THREAD_HPP

namespace ares {

/* ares/ares.hpp Constants::Colorburst */
namespace Constants::Colorburst {
  static constexpr f64 NTSC = 315.0 / 88.0 * 1'000'000.0;
}

/* ares/scheduler/thread.hpp: the clock part of Thread */
struct Thread {
  enum : u64 { Second = (u64)-1 >> 1 };
  enum : u64 { Size = 16_KiB * sizeof(void*) };

  auto frequency() const -> u64 { return _frequency; }
  auto scalar() const -> u64 { return _scalar; }
  auto clock() const -> u64 { return _clock; }

  auto setFrequency(double frequency) -> void {
    _frequency = frequency + 0.5;
    _scalar = Second / _frequency;
  }

  auto setClock(u64 clock) -> void {
    _clock = clock;
  }

  auto step(u32 clocks) -> void {
    _clock += _scalar * clocks;
  }

  u64 _frequency = 0;
  u64 _scalar = 0;
  u64 _clock = 0;
};

/* the uniqueID scheduler.append gives each thread, which is the clock
 * System::power's scheduler.power(cpu) starts it at (it breaks a tie between
 * two equal clocks): ares's Super Famicom powers the CPU, SMP, DSP and PPU
 * threads, then the cartridge's coprocessor, so the S-CPU is 0 and the chip 4 */
enum : u32 { RomdevCPUUniqueID = 0, RomdevChipUniqueID = 4 };

/* ares/scheduler/scheduler.hpp Scheduler::exit's clock reduction for the two
 * threads here (by the lower clock, so neither can wrap) */
inline auto romdev_ares_reduce(Thread& a, Thread& b) -> void {
  u64 reduce = a.clock() < b.clock() ? a.clock() : b.clock();
  a.setClock(a.clock() - reduce);
  b.setClock(b.clock() - reduce);
}

}

#endif
