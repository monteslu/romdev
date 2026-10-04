/* romdev: ares's firmware-running SNES coprocessors as cartridge chips for a
 * host that is not ares: a recompiled cart (scripts/recompile-gen/
 * ares-chips.mjs compiles glue_necdsp.cpp / glue_armdsp.cpp into chip units)
 * and the snes9x core (scripts/patches/snes9x-ares-chips.patch compiles the
 * same two files into it). Both hosts run the SAME code, so a cart and that
 * reference agree on the chip to the bit.
 *
 * What is ares's and what is romdev's:
 *   - the processors are ares's own source, compiled as they are:
 *     component/processor/upd96050 (uPD96050: ST010 / ST011) and
 *     component/processor/arm7tdmi (the ARM core ares runs the ST018 on),
 *     against romdev_ares.hpp in place of ares's emulator-wide ares/ares.hpp;
 *   - the S-CPU side of each chip is ares's own driver code, included as it
 *     is: sfc/coprocessor/necdsp/memory.cpp, sfc/coprocessor/armdsp/memory.cpp
 *     and io.cpp;
 *   - the glue is the rest of ares's necdsp.cpp / armdsp.cpp (main, power,
 *     reset, boot, step) without ares's node tree, debugger and scheduler
 *     list, and the part of ares's scheduler a chip and the S-CPU need
 *     (romdev_ares_thread.hpp): two 64-bit clocks in 1/2^63 s steps, each
 *     thread stepping by Second / frequency per clock, the chip running while
 *     it is behind the S-CPU and yielding as soon as the S-CPU is behind it.
 *     Here the S-CPU's master clock is given on every access and the chip is
 *     brought up to it right there, as ares's cpu.synchronize does on the
 *     same access (ares also synchronizes on every S-CPU step; a chip touches
 *     nothing but its own registers, so catching up only when the S-CPU looks
 *     gives the same answers). The uPD96050 yields only between instructions
 *     in ares as well (main: exec(); step(1); synchronize(cpu)), so a plain
 *     loop is exact. The ARM yields inside an instruction (every memory access
 *     steps and synchronizes), so it runs as a cothread here too (libco,
 *     romdev's WebAssembly backend) and yields at the same step ares does.
 *
 * Against bsnes (the romdev-core-bsnes reference, which romdev used before):
 * replaying every S-CPU access of a whole ST011 and ST018 game into these
 * units and bsnes's, the answers differ only where the two emulators' timing
 * differs, at three places, each measured by removing it (with all three
 * removed, every read matched): ares rounds the S-CPU frequency to 21477273 Hz
 * where bsnes truncates it to 21477272 (Thread::setFrequency adds 0.5); a soft
 * reset of the ARM ($3804) restarts its thread clock at 0 (Thread::create
 * setClock(0)) where bsnes restarts it level with the S-CPU, leaving a
 * fraction of a clock of phase; and ares's ARM7TDMI spends one internal cycle
 * on a data-processing instruction with a register-specified shift
 * (armInstructionDataRegisterShift idle(), as the ARM7TDMI data sheet gives
 * it), which bsnes's does not. The firmware polls the chip's status, so these
 * move a few status answers; in those two games every instruction computed
 * the same result on both.
 *
 * Time: `now` is the S-CPU master-clock position in the current line (snes9x
 * CPU.Cycles, the cart's $hnow) and the line end adds the line's length
 * (romdev_*_line), so base + now is a master clock that never goes back.
 *
 * Licence: ares is ISC (Copyright (c) 2004-2025 ares team, Near et al), a
 * permissive licence; its notice is in romdev's NOTICE. The glue is romdev's. */
#ifndef ROMDEV_ARES_CHIPS_HPP
#define ROMDEV_ARES_CHIPS_HPP

#ifdef __cplusplus
extern "C" {
#endif

/* uPD96050: which = 10 (ST010, 11 MHz) or 11 (ST011, 15 MHz); firmware is
 * the 0xC000-byte program ROM (24-bit words, little-endian) followed by the
 * 0x1000-byte data ROM (16-bit words), as st010.rom / st011.rom are dumped. */
void romdev_necdsp_init(int which, const unsigned char* firmware);
/* the S-CPU's access: bank $60-$67 (offset < $4000) is DR / SR by A0, bank
 * $68-$6F (offset < $8000) the data RAM, as ares's EXNEC-LOROM board maps them */
int romdev_necdsp_read(int address, int now);
void romdev_necdsp_write(int address, int data, int now);
void romdev_necdsp_line(int lineLength);
int romdev_necdsp_chipstate(unsigned char* out);

/* ARM (ST018): firmware is the 0x20000-byte program ROM followed by the
 * 0x8000-byte data ROM, as st018.rom is dumped. The S-CPU sees the bridge at
 * $3800-$38FF of banks $00-$3F / $80-$BF (ARM-LOROM-RAM); a read elsewhere
 * in the host's window returns -1 (not the chip's: open bus). */
void romdev_armdsp_init(const unsigned char* firmware);
int romdev_armdsp_read(int address, int now);
void romdev_armdsp_write(int address, int data, int now);
void romdev_armdsp_line(int lineLength);
int romdev_armdsp_chipstate(unsigned char* out);

#ifdef __cplusplus
}
#endif

#endif
