/* romdev: the state of a firmware-running coprocessor from bsnes, as one flat
 * byte string, so a recompiled cart and a reference core can be compared on
 * it (the snes_chipstate memory region).
 *
 * Compiled into the bsnes reference core (scripts/patches/bsnes/
 * romdev_bsnes_sfc.cpp). The snes9x core and the recompiler's chip units run
 * ares's chips and write the same layout from ares's objects
 * (scripts/recompile-gen/ares-chips/glue/romdev_ares_chipstate.h; only the
 * trailing clock differs in meaning, see there). It only reads bsnes's own
 * objects (Processor::uPD96050, Processor::ARM7TDMI and the ArmDSP bridge),
 * field by field in declaration order (never a whole struct: padding and the
 * function objects inside ARM7TDMI's registers are not state), plus the
 * chip's scheduler clock.
 *
 * Every function returns the number of bytes written (at most
 * ROMDEV_BSNES_CHIPSTATE_MAX). Little-endian, as wasm32 stores them. */
#ifndef ROMDEV_BSNES_CHIPSTATE_H
#define ROMDEV_BSNES_CHIPSTATE_H

#define ROMDEV_BSNES_CHIPSTATE_MAX 0x10000

#define RBCS_U8(v)  do { o[n++] = (unsigned char)(v); } while(0)
#define RBCS_U16(v) do { unsigned _v = (unsigned)(v); o[n++] = _v; o[n++] = _v >> 8; } while(0)
#define RBCS_U32(v) do { unsigned _v = (unsigned)(v); o[n++] = _v; o[n++] = _v >> 8; o[n++] = _v >> 16; o[n++] = _v >> 24; } while(0)
#define RBCS_I64(v) do { unsigned long long _v = (unsigned long long)(long long)(v); for(int _k = 0; _k < 8; _k++) o[n++] = _v >> (8 * _k); } while(0)

/* uPD96050 (ST010 / ST011): registers, flags, data RAM, clock. */
template<typename DSP>
static unsigned romdev_bsnes_cs_upd96050(unsigned char* o, DSP& d, long long clock)
{
	unsigned n = 0;
	for(int k = 0; k < 16; k++) RBCS_U16(d.regs.stack[k]);
	RBCS_U16((unsigned)(unsigned long long)d.regs.pc);
	RBCS_U16((unsigned)(unsigned long long)d.regs.rp);
	RBCS_U16((unsigned)(unsigned long long)d.regs.dp);
	RBCS_U8((unsigned)d.regs.sp);
	RBCS_U16(d.regs.si); RBCS_U16(d.regs.so);
	RBCS_U16((short)d.regs.k); RBCS_U16((short)d.regs.l); RBCS_U16((short)d.regs.m); RBCS_U16((short)d.regs.n);
	RBCS_U16((short)d.regs.a); RBCS_U16((short)d.regs.b);
	RBCS_U16(d.regs.tr); RBCS_U16(d.regs.trb); RBCS_U16(d.regs.dr);
	RBCS_U16((unsigned)d.regs.sr);
	RBCS_U8((bool)d.regs.sr.drs); RBCS_U8((bool)d.regs.sr.siack); RBCS_U8((bool)d.regs.sr.soack);
	RBCS_U8((unsigned)d.flags.a); RBCS_U8((unsigned)d.flags.b);
	for(int k = 0; k < 2048; k++) RBCS_U16(d.dataRAM[k]);
	RBCS_I64(clock);
	return n;
}

/* ARM (ST018): the register file with every bank, the pipeline, the bridge
 * to the S-CPU, the 16KB program RAM, clock. */
template<typename P>
static unsigned romdev_bsnes_cs_psr(unsigned char* o, P& p)
{
	unsigned n = 0;
	RBCS_U32((unsigned)p);
	return n;
}

template<typename ARM, typename PROC, typename PIPE, typename BRIDGE>
static unsigned romdev_bsnes_cs_armdsp(unsigned char* o, ARM& arm, PROC& r, PIPE& pl, BRIDGE& b,
	const unsigned char* ram, unsigned ramSize, long long clock)
{
	unsigned n = 0;
	RBCS_U32(r.r0.data); RBCS_U32(r.r1.data); RBCS_U32(r.r2.data); RBCS_U32(r.r3.data);
	RBCS_U32(r.r4.data); RBCS_U32(r.r5.data); RBCS_U32(r.r6.data); RBCS_U32(r.r7.data);
	RBCS_U32(r.r8.data); RBCS_U32(r.r9.data); RBCS_U32(r.r10.data); RBCS_U32(r.r11.data);
	RBCS_U32(r.r12.data); RBCS_U32(r.r13.data); RBCS_U32(r.r14.data); RBCS_U32(r.r15.data);
	n += romdev_bsnes_cs_psr(o + n, r.cpsr);
	RBCS_U32(r.fiq.r8.data); RBCS_U32(r.fiq.r9.data); RBCS_U32(r.fiq.r10.data); RBCS_U32(r.fiq.r11.data);
	RBCS_U32(r.fiq.r12.data); RBCS_U32(r.fiq.r13.data); RBCS_U32(r.fiq.r14.data);
	n += romdev_bsnes_cs_psr(o + n, r.fiq.spsr);
	RBCS_U32(r.irq.r13.data); RBCS_U32(r.irq.r14.data); n += romdev_bsnes_cs_psr(o + n, r.irq.spsr);
	RBCS_U32(r.svc.r13.data); RBCS_U32(r.svc.r14.data); n += romdev_bsnes_cs_psr(o + n, r.svc.spsr);
	RBCS_U32(r.abt.r13.data); RBCS_U32(r.abt.r14.data); n += romdev_bsnes_cs_psr(o + n, r.abt.spsr);
	RBCS_U32(r.und.r13.data); RBCS_U32(r.und.r14.data); n += romdev_bsnes_cs_psr(o + n, r.und.spsr);
	RBCS_U8((unsigned)pl.reload); RBCS_U8((unsigned)pl.nonsequential);
	RBCS_U32(pl.fetch.address); RBCS_U32(pl.fetch.instruction); RBCS_U8((bool)pl.fetch.thumb);
	RBCS_U32(pl.decode.address); RBCS_U32(pl.decode.instruction); RBCS_U8((bool)pl.decode.thumb);
	RBCS_U32(pl.execute.address); RBCS_U32(pl.execute.instruction); RBCS_U8((bool)pl.execute.thumb);
	RBCS_U32(arm.opcode); RBCS_U8((bool)arm.carry); RBCS_U8((bool)arm.irq);
	RBCS_U8((bool)b.cputoarm.ready); RBCS_U8(b.cputoarm.data);
	RBCS_U8((bool)b.armtocpu.ready); RBCS_U8(b.armtocpu.data);
	RBCS_U32(b.timer); RBCS_U32(b.timerlatch);
	RBCS_U8((bool)b.reset); RBCS_U8((bool)b.ready); RBCS_U8((bool)b.signal);
	for(unsigned k = 0; k < ramSize; k++) o[n++] = ram[k];
	RBCS_I64(clock);
	return n;
}

#endif
