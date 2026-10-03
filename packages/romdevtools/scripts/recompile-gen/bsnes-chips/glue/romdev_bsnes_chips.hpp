/* romdev: bsnes's firmware-running SNES coprocessors as cartridge chips for a
 * host that is not bsnes: a recompiled cart (scripts/recompile-gen/
 * bsnes-chips.mjs compiles glue_necdsp.cpp / glue_armdsp.cpp into chip units)
 * and the snes9x core (scripts/patches/snes9x-bsnes-chips.patch compiles the
 * same two files into it). Both hosts run the SAME code, so a cart and that
 * reference agree on the chip to the bit.
 *
 * What is bsnes's and what is romdev's:
 *   - the processors are bsnes's own source, compiled as they are:
 *     processor/upd96050 (uPD96050: ST010 / ST011) and processor/arm7tdmi
 *     (the ARM core bsnes runs the ST018 on), plus sfc/coprocessor/armdsp/
 *     memory.cpp (the ST018's memory map and bridge, included as it is);
 *   - the glue replaces what bsnes's scheduler does: sfc/coprocessor/necdsp/
 *     necdsp.cpp and armdsp/armdsp.cpp run each chip as a cothread that
 *     advances in lock step with the S-CPU (clock -= cpu clocks * chip
 *     frequency; the chip runs while clock < 0, adding cpu.frequency per chip
 *     clock). Here the S-CPU's master clock is given on every access, and the
 *     chip is brought up to it right there, as bsnes's synchronizeCoprocessors
 *     does on the same access. A chip touches nothing but its own registers,
 *     so catching up only when the S-CPU looks gives the same answers.
 *     The uPD96050 yields to the S-CPU only between instructions in bsnes as
 *     well (main: exec(); step(1); synchronizeCPU()), so a plain loop is
 *     exact. The ARM yields inside an instruction (every memory access steps
 *     and synchronizes), so it runs as a cothread here too (libco, romdev's
 *     WebAssembly backend) and yields at the same step bsnes does.
 *     sms-wat/work/st01x/tools/chip-replay.mjs checks both against bsnes:
 *     every S-CPU read of a whole game, status polls included, replayed.
 *
 * Time: `now` is the S-CPU master-clock position in the current line (snes9x
 * CPU.Cycles, the cart's $hnow) and the line end adds the line's length
 * (romdev_bchip_line), so base + now is a master clock that never goes back.
 *
 * Licence: bsnes is GPL-3.0; anything these files are compiled into is too. */
#ifndef ROMDEV_BSNES_CHIPS_HPP
#define ROMDEV_BSNES_CHIPS_HPP

#ifdef __cplusplus
extern "C" {
#endif

/* bsnes's System::cpuFrequency() for NTSC: Colorburst::NTSC * 6, as the uint
 * Thread::create stores it. */
#define ROMDEV_BCHIP_CPU_FREQUENCY 21477272u

/* uPD96050: which = 10 (ST010, 11 MHz) or 11 (ST011, 15 MHz); firmware is
 * the 0xC000-byte program ROM (24-bit words, little-endian) followed by the
 * 0x1000-byte data ROM (16-bit words), as st010.rom / st011.rom are dumped. */
void romdev_necdsp_init(int which, const unsigned char* firmware);
/* the S-CPU's access: bank $60-$67 (offset < $4000) is DR / SR by A0, bank
 * $68-$6F (offset < $8000) the data RAM, as bsnes's EXNEC-LOROM board maps them */
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
