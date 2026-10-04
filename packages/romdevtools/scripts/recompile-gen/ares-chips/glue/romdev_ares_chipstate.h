/* romdev: the state of a firmware-running coprocessor on ares's code, as one
 * flat byte string, so a recompiled cart and the snes9x reference core can be
 * compared on it (the snes_chipstate memory region).
 *
 * ONE definition, compiled everywhere ares's chips run: the snes9x core's
 * transplanted chips (scripts/patches/snes9x-ares-chips.patch) and the
 * recompiler's chip units (scripts/recompile-gen/ares-chips.mjs). It only
 * reads ares's own objects (uPD96050, ARM7TDMI and the ARMDSP bridge), field
 * by field (never a whole struct: padding and the function objects inside
 * ARM7TDMI's registers are not state), plus the chip's scheduler clock.
 *
 * The layout is byte for byte the one the bsnes reference core writes
 * (scripts/patches/bsnes/romdev_bsnes_chipstate.h), so the two can be put
 * side by side, with one difference in meaning: the trailing clock. bsnes
 * keeps a chip's clock relative to the S-CPU (clock -= S-CPU clocks * chip
 * frequency); ares keeps absolute clocks in 1/2^63 s (romdev_ares_thread.hpp),
 * and the value here is the chip's clock minus the S-CPU's. Two fields ares
 * has and bsnes does not are left out to keep the layout: the pipeline
 * stages' irq bits (a copy of CPSR.I at fetch; the ST018's ARM has no
 * interrupt line), and ARM7TDMI::nonsequential sits where bsnes keeps
 * Pipeline::nonsequential.
 *
 * Every function returns the number of bytes written (at most
 * ROMDEV_ARES_CHIPSTATE_MAX). Little-endian, as wasm32 stores them. */
#ifndef ROMDEV_ARES_CHIPSTATE_H
#define ROMDEV_ARES_CHIPSTATE_H

#define ROMDEV_ARES_CHIPSTATE_MAX 0x10000

#define RACS_U8(v)  do { o[n++] = (unsigned char)(v); } while(0)
#define RACS_U16(v) do { unsigned _v = (unsigned)(v); o[n++] = _v; o[n++] = _v >> 8; } while(0)
#define RACS_U32(v) do { unsigned _v = (unsigned)(v); o[n++] = _v; o[n++] = _v >> 8; o[n++] = _v >> 16; o[n++] = _v >> 24; } while(0)
#define RACS_I64(v) do { unsigned long long _v = (unsigned long long)(long long)(v); for(int _k = 0; _k < 8; _k++) o[n++] = _v >> (8 * _k); } while(0)

/* uPD96050 (ST010 / ST011): registers, flags, data RAM, clock. */
template<typename DSP>
static unsigned romdev_ares_cs_upd96050(unsigned char* o, DSP& d, long long clock)
{
	unsigned n = 0;
	for(int k = 0; k < 16; k++) RACS_U16((unsigned)d.regs.stack[k]);
	RACS_U16((unsigned)(unsigned long long)d.regs.pc);
	RACS_U16((unsigned)(unsigned long long)d.regs.rp);
	RACS_U16((unsigned)(unsigned long long)d.regs.dp);
	RACS_U8((unsigned)d.regs.sp);
	RACS_U16((unsigned)d.regs.si); RACS_U16((unsigned)d.regs.so);
	RACS_U16((short)d.regs.k); RACS_U16((short)d.regs.l); RACS_U16((short)d.regs.m); RACS_U16((short)d.regs.n);
	RACS_U16((short)d.regs.a); RACS_U16((short)d.regs.b);
	RACS_U16((unsigned)d.regs.tr); RACS_U16((unsigned)d.regs.trb); RACS_U16((unsigned)d.regs.dr);
	RACS_U16((unsigned)d.regs.sr);
	RACS_U8((bool)d.regs.sr.drs); RACS_U8((bool)d.regs.sr.siack); RACS_U8((bool)d.regs.sr.soack);
	RACS_U8((unsigned)d.flags.a); RACS_U8((unsigned)d.flags.b);
	for(int k = 0; k < 2048; k++) RACS_U16((unsigned)d.dataRAM[k]);
	RACS_I64(clock);
	return n;
}

/* ARM (ST018): the register file with every bank, the pipeline, the bridge
 * to the S-CPU, the 16KB program RAM, clock. */
template<typename ARM, typename BRIDGE>
static unsigned romdev_ares_cs_armdsp(unsigned char* o, ARM& arm, BRIDGE& b,
	const unsigned char* ram, unsigned ramSize, long long clock)
{
	unsigned n = 0;
	auto& r = arm.processor;
	auto& pl = arm.pipeline;
	RACS_U32(r.r0.data); RACS_U32(r.r1.data); RACS_U32(r.r2.data); RACS_U32(r.r3.data);
	RACS_U32(r.r4.data); RACS_U32(r.r5.data); RACS_U32(r.r6.data); RACS_U32(r.r7.data);
	RACS_U32(r.r8.data); RACS_U32(r.r9.data); RACS_U32(r.r10.data); RACS_U32(r.r11.data);
	RACS_U32(r.r12.data); RACS_U32(r.r13.data); RACS_U32(r.r14.data); RACS_U32(r.r15.data);
	RACS_U32((unsigned)r.cpsr);
	RACS_U32(r.fiq.r8.data); RACS_U32(r.fiq.r9.data); RACS_U32(r.fiq.r10.data); RACS_U32(r.fiq.r11.data);
	RACS_U32(r.fiq.r12.data); RACS_U32(r.fiq.r13.data); RACS_U32(r.fiq.r14.data);
	RACS_U32((unsigned)r.fiq.spsr);
	RACS_U32(r.irq.r13.data); RACS_U32(r.irq.r14.data); RACS_U32((unsigned)r.irq.spsr);
	RACS_U32(r.svc.r13.data); RACS_U32(r.svc.r14.data); RACS_U32((unsigned)r.svc.spsr);
	RACS_U32(r.abt.r13.data); RACS_U32(r.abt.r14.data); RACS_U32((unsigned)r.abt.spsr);
	RACS_U32(r.und.r13.data); RACS_U32(r.und.r14.data); RACS_U32((unsigned)r.und.spsr);
	RACS_U8((unsigned)pl.reload); RACS_U8((bool)arm.nonsequential);
	RACS_U32(pl.fetch.address); RACS_U32(pl.fetch.instruction); RACS_U8((bool)pl.fetch.thumb);
	RACS_U32(pl.decode.address); RACS_U32(pl.decode.instruction); RACS_U8((bool)pl.decode.thumb);
	RACS_U32(pl.execute.address); RACS_U32(pl.execute.instruction); RACS_U8((bool)pl.execute.thumb);
	RACS_U32(arm.opcode); RACS_U8((bool)arm.carry); RACS_U8((bool)arm.irq);
	RACS_U8((bool)b.cputoarm.ready); RACS_U8((unsigned)b.cputoarm.data);
	RACS_U8((bool)b.armtocpu.ready); RACS_U8((unsigned)b.armtocpu.data);
	RACS_U32(b.timer); RACS_U32(b.timerlatch);
	RACS_U8((bool)b.reset); RACS_U8((bool)b.ready); RACS_U8((bool)b.signal);
	for(unsigned k = 0; k < ramSize; k++) o[n++] = ram[k];
	RACS_I64(clock);
	return n;
}

#endif
