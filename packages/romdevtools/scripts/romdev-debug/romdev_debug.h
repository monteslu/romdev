/* romdev_debug.h — the shared debug ABI for ALL romdev emulator cores.
 *
 * WHY THIS EXISTS: every core used to inline ~700 lines of identical bookkeeping
 * (watchpoint table, coverage ring + dedup, range/read buffers, register-snapshot
 * packing, pcbreak/watchdog state, the EMSCRIPTEN_KEEPALIVE exports). That was ~70%
 * copy-paste across 17 cores — an N-way edit for every change and a silent-drift
 * risk vs the host. This file + romdev_debug.c own that shared 70% in ONE place.
 *
 * THE SPLIT:
 *   - romdev_debug.c provides the SHARED machinery + every `romdev_*` export the
 *     host probes (the ABI). Build it into each core (one extra .o).
 *   - Each core provides only a thin HOOK SHIM: it calls the romdev_on_* functions
 *     below from its memory bus + dispatch loop, passing its OWN cpu PC, the
 *     pre-write value, and (optionally) the active-bank ROM offset. It also fills
 *     romdev_snap_regs[] from its CPU struct on a hit. That's the ~30% that is
 *     genuinely per-core (different register structs, different bus tap points).
 *
 * THE HOST CONTRACT (LibretroHost.js feature-detects these by symbol name — a core
 * lights up a tool the instant it exports the matching function): the exports below
 * MUST keep their signatures + out[] packing. The conformance test
 * (test/romdev-debug-abi.test.js) probes each migrated core's wasm for this set.
 *
 * C89, freestanding-friendly, no libc beyond memcpy-by-loop. C++ cores include it
 * inside `extern "C" { }`.
 */
#ifndef ROMDEV_DEBUG_H
#define ROMDEV_DEBUG_H

#ifdef __cplusplus
extern "C" {
#endif

/* ── capacities (must match what the host's get-functions read out) ── */
#define ROMDEV_COV_CAP    8192   /* distinct PCs the coverage ring holds */
#define ROMDEV_RANGE_CAP  4096   /* range-watch event ring */
#define ROMDEV_SNAP_REGS  19     /* registers in a snapshot (romdev_snap_regs[]) */
#define ROMDEV_SNAP_WORDS 21     /* regsnap_get out: [kind, count(19), regs0..18] */

/* ═══════════════════════════════════════════════════════════════════════════
 * PART 1 — exports the HOST calls (the ABI). Implemented in romdev_debug.c.
 *   `out` buffers are caller-allocated; the packing is fixed (see each comment).
 * ═════════════════════════════════════════════════════════════════════════ */

/* Write-watchpoint: fire when a WRITE hits `addr` (optionally gated by a value
 * condition). out6: [enabled, addr, last_pc, last_val, hits, last_rom_off, last_old]. */
void romdev_watchpoint_set(unsigned addr, int enabled);
void romdev_watchpoint_set_cond(unsigned addr, int enabled, int cond, int val);
void romdev_watchpoint_get(unsigned *out, int clearHits);

/* Read-watchpoint: fire when a READ hits `addr`.
 * out5: [enabled, addr, last_pc, last_val, hits]. */
void romdev_readwatch_set(unsigned addr, int enabled);
void romdev_readwatch_get(unsigned *out, int clearHits);

/* Range watch: log {pc,addr,val} for every R/W in [lo,hi] (mode 1=read 2=write 3=both).
 * get fills `out` with INTERLEAVED triples [pc0,addr0,val0, pc1,addr1,val1, …] up to
 * `max` events (returns the count); out2 (if non-null) gets [total, stored]. */
void romdev_range_set(unsigned lo, unsigned hi, int mode, int enabled);
unsigned romdev_range_get(unsigned *out, unsigned max, unsigned *out2);

/* PC breakpoint + single-step + watchdog. set(addr,enabled,step); a hit freezes the
 * CPU (the core's dispatch checks the freeze via romdev_on_dispatch). watchdog_set
 * arms a no-hit timeout. out is 11 words:
 *   [enabled, addr, hit, last_pc, hits, watchdog,  reg0, reg1, reg2, reg3, reg4]
 * Slots 6-10 are an at-hit register snapshot the core fills (6502: A,X,Y,P,S); a core
 * that doesn't fill them leaves 0xFFFFFFFF = "not captured" (the host pre-seeds those). */
void romdev_pcbreak_set(unsigned addr, int enabled, int step);
void romdev_pcbreak_get(unsigned *out, int clearHit);
void romdev_watchdog_set(unsigned limit);

/* Coverage: which distinct PCs dispatched in [lo,hi]. get fills `out` with up to
 * `max` distinct PCs (returns the count); out2 (if non-null) gets [distinct, total]. */
void romdev_cov_set(unsigned lo, unsigned hi, int enabled);
unsigned romdev_cov_get(unsigned *out, unsigned max, unsigned *out2);

/* At-hit CPU register snapshot. The core fills romdev_snap_regs[] (ROMDEV_SNAP_REGS
 * registers) on a hit via its snapshot shim; the host reads it here. out is
 * ROMDEV_SNAP_WORDS (21) words: [0]=kind (0 = no snapshot), [1]=count (=19),
 * [2..20]=the per-CPU register layout. */
void romdev_regsnap_get(unsigned *out, int clear);

/* IRQ block: when set, the core's interrupt dispatch is gated off (deterministic
 * stepping). The core reads romdev_irq_block in its IRQ path. */
void romdev_irqblock_set(int on);

/* ═══════════════════════════════════════════════════════════════════════════
 * PART 2 — what the CORE calls (the hook surface). Implemented in romdev_debug.c;
 *   the core invokes these from its bus taps + dispatch loop. This is the seam
 *   that replaces every core's hand-rolled ROMDEV_WP_CHECK/RANGE/COV macros.
 * ═════════════════════════════════════════════════════════════════════════ */

/* Call on every memory WRITE the core performs.
 *   addr   — the bus address written
 *   oldv   — the value at addr BEFORE the write (only needed when a watchpoint
 *            condition is armed; pass 0 if you don't have it cheaply and no cond
 *            is set — romdev_wp_wants_old() tells you if it's needed)
 *   newv   — the value being written
 *   pc     — the live PC of the executing instruction
 *   rom_off— active-bank ROM offset for `pc`, or 0xFFFFFFFF if N/A
 * Drives the write-watchpoint + the range-watch (write side).
 * RETURNS 1 if a write-watchpoint just HIT — the core should then take its register
 * snapshot (fill romdev_snap_regs[] from its live CPU state + set romdev_snap_kind=3),
 * since only the core knows its register layout. Returns 0 otherwise. */
int romdev_on_write(unsigned addr, unsigned char oldv, unsigned char newv,
                    unsigned pc, unsigned rom_off);

/* Call on every memory READ. Drives the read-watchpoint + range-watch (read side).
 * RETURNS 1 if a read-watchpoint just HIT — core takes its snapshot (kind=4). */
int romdev_on_read(unsigned addr, unsigned char val, unsigned pc);

/* Call once per instruction dispatch with the live PC. Drives coverage + the PC
 * breakpoint/watchdog. Returns 1 if the CPU should FREEZE (a pcbreak/watchdog hit
 * or single-step) — the core must then drain its cycle budget + return without
 * executing, and stay frozen until the host clears the hit. Returns 0 to run normally. */
int romdev_on_dispatch(unsigned pc);

/* True when an armed write-watchpoint condition needs the pre-write value — lets a
 * core skip the (sometimes costly) old-value read on the hot path when no cond is set. */
int romdev_wp_wants_old(void);

/* ═══════════════════════════════════════════════════════════════════════════
 * PART 3 — the snapshot buffer the core's per-CPU snapshot shim fills on a hit.
 *   On a watchpoint/pcbreak hit the core calls its own romdev_<cpu>_snap(kind)
 *   which writes romdev_snap_regs[0]=kind and [1..] = its registers, then the host
 *   reads them via romdev_regsnap_get. Declared here so both sides agree on layout.
 * ═════════════════════════════════════════════════════════════════════════ */
extern unsigned romdev_snap_regs[ROMDEV_SNAP_REGS];
extern int      romdev_snap_kind;

/* Compact at-PC-break register snapshot, surfaced inline in pcbreak_get slots 6-10.
 * A core with a tiny register file (e.g. 6502 A,X,Y,P,S) fills these on a pcbreak hit;
 * leave them 0xFFFFFFFF (the init value) to report "not captured". Bigger CPUs use the
 * full romdev_snap_regs[] via regsnap_get instead and can ignore this. */
#define ROMDEV_PCBRK_REGS 5
extern unsigned romdev_pcbrk_regs[ROMDEV_PCBRK_REGS];

/* The core reads this in its IRQ dispatch (1 = block interrupts). */
extern int romdev_irq_block;

#ifdef __cplusplus
}
#endif

#endif /* ROMDEV_DEBUG_H */
