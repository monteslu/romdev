// romdev live-debug instrumentation for the GameTank core (W65C02S main CPU).
// Appended to src/libretro.cpp by the romdev build (build-gametank.sh) — it sees
// cpu_core (the main mos6502*) + system_state + AudioCoprocessor. A thin shim over
// the SHARED romdev_debug.{h,c} (the same lib every romdev core links): watchpoints,
// read/range/coverage watch, PC breakpoints, the instruction watchdog, the at-hit
// 6502 register snapshot, setReg/getReg, and the ACP audio-coprocessor state.
// Hook CALL SITES are injected into MemoryWrite / MemoryRead / the mos6502 dispatch.
extern "C" {
#include "romdev_debug.h"
}

extern mos6502 *cpu_core;

// romdev at-hit register snapshot (6502) — fills the shared romdev_snap_regs[] in
// the regId order the host's getRegSnapshot reads: [0]=A [1]=X [2]=Y [3]=P [4]=SP
// [16]=PC. A FUNCTION so the C hook call sites can invoke it.
extern "C" unsigned int romdev_gametank_instr_pc = 0xFFFFFFFFu;
extern "C" void romdev_gametank_snap(int kind) {
    int i; for (i = 0; i < 19; i++) romdev_snap_regs[i] = 0;
    if (cpu_core) {
        romdev_snap_regs[0]  = cpu_core->A;
        romdev_snap_regs[1]  = cpu_core->X;
        romdev_snap_regs[2]  = cpu_core->Y;
        romdev_snap_regs[3]  = cpu_core->status;     // packed P
        romdev_snap_regs[4]  = cpu_core->sp;
        romdev_snap_regs[16] = cpu_core->pc;
    }
    romdev_snap_kind = kind;
}

// ── the call-site adapters (named romdev_gametank_* so they don't collide with
//    the shared lib's own romdev_on_write/on_read/on_dispatch) ──────────────

// MemoryWrite → romdev_gametank_write(address, value). oldv=0 (the write path
// doesn't read back cheaply; plain watch + range-write still work). PC = cpu pc.
extern "C" void romdev_gametank_write(unsigned int address, unsigned int value) {
    unsigned int pc = cpu_core ? cpu_core->pc : 0;
    if (romdev_on_write(address & 0xFFFF, 0, (unsigned char)value, pc, 0xFFFFFFFFu))
        romdev_gametank_snap(3);
}

// MemoryRead → romdev_gametank_read(address, value).
extern "C" void romdev_gametank_read(unsigned int address, unsigned int value) {
    unsigned int pc = cpu_core ? cpu_core->pc : 0;
    if (romdev_on_read(address & 0xFFFF, (unsigned char)value, pc))
        romdev_gametank_snap(4);
}

// mos6502 Run() dispatch → romdev_gametank_step(pc). Returns 1 to FREEZE — the
// caller sets cpu_core->freeze (the Run loop's existing freeze check halts with
// pc un-advanced). Asks the shared lib (coverage + watchdog + pc-break/step).
extern "C" int romdev_gametank_step(unsigned int pc) {
    romdev_gametank_instr_pc = pc;
    if (romdev_on_dispatch(pc & 0xFFFF)) {
        romdev_gametank_snap(romdev_pc_hit_kind() == 2 ? 2 : 1);
        return 1;
    }
    return 0;
}

// setReg/getReg — go through the live mos6502 register file (regId: 0=A 1=X 2=Y
// 3=P 4=SP 16=PC). The shared lib provides the watch/break machinery + regsnap_get;
// these per-core accessors are the only extra surface a 6502 core adds.
extern "C" int romdev_setreg(int regId, unsigned int value) {
    if (!cpu_core) return -1;
    switch (regId) {
        case 0:  cpu_core->A      = (unsigned char)(value & 0xFF); break;
        case 1:  cpu_core->X      = (unsigned char)(value & 0xFF); break;
        case 2:  cpu_core->Y      = (unsigned char)(value & 0xFF); break;
        case 3:  cpu_core->status = (unsigned char)(value & 0xFF); break;
        case 4:  cpu_core->sp     = (unsigned char)(value & 0xFF); break;
        case 16: cpu_core->pc     = (unsigned short)(value & 0xFFFF); break;
        default: return -1;
    }
    return 0;
}
extern "C" unsigned int romdev_getreg(int regId) {
    if (!cpu_core) return 0;
    switch (regId) {
        case 0:  return cpu_core->A;
        case 1:  return cpu_core->X;
        case 2:  return cpu_core->Y;
        case 3:  return cpu_core->status;
        case 4:  return cpu_core->sp;
        case 16: return cpu_core->pc;
        default: return 0;
    }
}

// ── ACP audio coprocessor state (audioDebug) ───────────────────────────────
// GameTank's "sound chip" is a SECOND 65C02 running an audio program in 4 KB RAM
// that drives a DAC (dacReg) at an IRQ rate. There's no fixed register synth like
// an APU/SID, so audioDebug exposes the ACP's STATE: DAC output, IRQ rate, the
// running/muted/resetting flags, volume, the audio-CPU PC, and the sample clock.
// Source = AudioCoprocessor::singleton_acp_state (audio_coprocessor.cpp). Filled
// into a Uint32Array(10), N64-AI style.
extern "C" void romdev_acp_get(unsigned int *out) {
    if (!out) return;
    for (int i = 0; i < 10; i++) out[i] = 0;
    ACPState *s = AudioCoprocessor::singleton_acp_state;
    if (!s) return;
    out[0] = s->dacReg;                 // last DAC output byte (the "current sample")
    out[1] = s->irqRate;                // ACP IRQ rate (sets the sample rate)
    out[2] = (unsigned)(s->irqCounter & 0xFFFF);
    out[3] = s->running ? 1 : 0;
    out[4] = s->resetting ? 1 : 0;
    out[5] = s->isMuted ? 1 : 0;
    out[6] = (unsigned)s->volume;
    out[7] = s->cpu ? s->cpu->pc : 0;   // audio-CPU PC (which routine is playing)
    out[8] = (unsigned)s->samples_per_frame;
    out[9] = (unsigned)s->clkMult;
}
