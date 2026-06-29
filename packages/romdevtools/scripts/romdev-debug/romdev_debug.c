/* romdev_debug.c — the shared debug machinery for ALL romdev cores. See
 * romdev_debug.h for the contract. This file owns the ~70% that used to be
 * copy-pasted into every core's patch: the watchpoint/read-watch/range/coverage
 * state + rings, the pcbreak/watchdog/single-step logic, the register-snapshot
 * plumbing, and every `romdev_*` EMSCRIPTEN_KEEPALIVE export the host probes.
 *
 * Each core links this in (one extra .o) and provides only a thin hook shim that
 * calls romdev_on_write / romdev_on_read / romdev_on_dispatch from its bus + CPU
 * loop, plus fills romdev_snap_regs[] / romdev_pcbrk_regs[] from its CPU struct.
 *
 * C89, no libc beyond what emscripten gives the core. EMSCRIPTEN_KEEPALIVE keeps
 * the exports from being LTO-stripped; they must ALSO be in EXPORTED_FUNCTIONS.
 */
#include "romdev_debug.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

/* ── shared state (was duplicated per-core) ─────────────────────────────────── */

/* write-watchpoint */
static unsigned      wp_addr = 0;
static int           wp_enabled = 0;
static unsigned      wp_last_pc = 0xFFFFFFFFu;
static unsigned char wp_last_val = 0, wp_last_old = 0;
static int           wp_cond = 0;          /* 0 none, 1 >, 2 <, 3 == */
static unsigned char wp_cond_val = 0;
static unsigned      wp_hits = 0;
static unsigned      wp_last_rom_off = 0xFFFFFFFFu;

/* read-watchpoint */
static unsigned      rd_addr = 0;
static int           rd_enabled = 0;
static unsigned      rd_last_pc = 0xFFFFFFFFu;
static unsigned char rd_last_val = 0;
static unsigned      rd_hits = 0;

/* range watch (ring of {pc,addr,val}) */
static unsigned      range_lo = 0, range_hi = 0;
static int           range_enabled = 0, range_mode = 0; /* 1=read 2=write 3=both */
static unsigned      range_pc [ROMDEV_RANGE_CAP];
static unsigned      range_addr[ROMDEV_RANGE_CAP];
static unsigned char range_val[ROMDEV_RANGE_CAP];
static unsigned      range_count = 0, range_stored = 0;

/* coverage (distinct-PC ring + dedup) */
static unsigned      cov_lo = 0, cov_hi = 0;
static int           cov_enabled = 0;
static unsigned      cov_pcs[ROMDEV_COV_CAP];
static unsigned      cov_count = 0, cov_total = 0;

/* pc breakpoint + single-step + watchdog */
static unsigned      pc_addr = 0;
static int           pc_enabled = 0;
static int           pc_step = 0;          /* per-instruction countdown (arm to 2) */
static int           pc_hit = 0;
static unsigned      pc_last_pc = 0xFFFFFFFFu;
static unsigned      pc_hits = 0;
static unsigned      wd_limit = 0;         /* watchdog: max instrs (0=off) */
static unsigned      wd_count = 0;
static int           wd_tripped = 0;
static int           pc_hit_kind = 0;      /* why the last dispatch froze: 1=pcbreak 2=watchdog */

/* at-hit snapshots (filled by the core's shim; declared in the header) */
unsigned romdev_snap_regs[ROMDEV_SNAP_REGS];
int      romdev_snap_kind = 0;
unsigned romdev_pcbrk_regs[ROMDEV_PCBRK_REGS] =
    { 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu };
int      romdev_irq_block = 0;

/* ── PART 1: host-facing exports ────────────────────────────────────────────── */

EMSCRIPTEN_KEEPALIVE
void romdev_watchpoint_set(unsigned addr, int enabled) {
    wp_addr = addr; wp_enabled = enabled ? 1 : 0;
    wp_last_pc = 0xFFFFFFFFu; wp_last_val = 0; wp_last_old = 0;
    wp_cond = 0; wp_cond_val = 0; wp_hits = 0; wp_last_rom_off = 0xFFFFFFFFu;
}
EMSCRIPTEN_KEEPALIVE
void romdev_watchpoint_set_cond(unsigned addr, int enabled, int cond, int val) {
    romdev_watchpoint_set(addr, enabled);
    wp_cond = cond; wp_cond_val = (unsigned char)val;
}
EMSCRIPTEN_KEEPALIVE
void romdev_watchpoint_get(unsigned *out, int clearHits) {
    if (!out) return;
    out[0] = (unsigned)wp_enabled; out[1] = wp_addr;
    out[2] = wp_last_pc;           out[3] = wp_last_val;
    out[4] = wp_hits;              out[5] = wp_last_rom_off;
    out[6] = wp_hits ? (unsigned)wp_last_old : 0xFFFFFFFFu;
    if (clearHits) { wp_hits = 0; wp_last_pc = 0xFFFFFFFFu; wp_last_rom_off = 0xFFFFFFFFu; }
}

EMSCRIPTEN_KEEPALIVE
void romdev_readwatch_set(unsigned addr, int enabled) {
    rd_addr = addr; rd_enabled = enabled ? 1 : 0;
    rd_last_pc = 0xFFFFFFFFu; rd_last_val = 0; rd_hits = 0;
}
EMSCRIPTEN_KEEPALIVE
void romdev_readwatch_get(unsigned *out, int clearHits) {
    if (!out) return;
    out[0] = (unsigned)rd_enabled; out[1] = rd_addr;
    out[2] = rd_last_pc;           out[3] = rd_last_val; out[4] = rd_hits;
    if (clearHits) { rd_hits = 0; rd_last_pc = 0xFFFFFFFFu; }
}

EMSCRIPTEN_KEEPALIVE
void romdev_range_set(unsigned lo, unsigned hi, int mode, int enabled) {
    range_lo = lo; range_hi = hi; range_mode = mode;
    range_enabled = enabled ? 1 : 0;
    range_count = 0; range_stored = 0;    /* arming clears the ring */
}
EMSCRIPTEN_KEEPALIVE
unsigned romdev_range_get(unsigned *out, unsigned max, unsigned *out2) {
    unsigned i, n = range_stored;
    if (out2) { out2[0] = range_count; out2[1] = range_stored; }
    if (n > max) n = max;
    if (out) for (i = 0; i < n; i++) {
        out[i * 3 + 0] = range_pc[i];
        out[i * 3 + 1] = range_addr[i];
        out[i * 3 + 2] = (unsigned)range_val[i];
    }
    return n;
}

EMSCRIPTEN_KEEPALIVE
void romdev_pcbreak_set(unsigned addr, int enabled, int step) {
    pc_addr = addr; pc_enabled = enabled ? 1 : 0;
    pc_step = step ? 2 : 0;                /* arm to 2 → one instr runs before stop */
    pc_hit = 0; pc_last_pc = 0xFFFFFFFFu; pc_hits = 0; pc_hit_kind = 0;
    wd_tripped = 0; wd_count = 0;
    romdev_pcbrk_regs[0] = romdev_pcbrk_regs[1] = romdev_pcbrk_regs[2] =
        romdev_pcbrk_regs[3] = romdev_pcbrk_regs[4] = 0xFFFFFFFFu;
}
EMSCRIPTEN_KEEPALIVE
void romdev_pcbreak_get(unsigned *out, int clearHit) {
    int i;
    if (!out) return;
    out[0] = (unsigned)pc_enabled; out[1] = pc_addr; out[2] = (unsigned)pc_hit;
    out[3] = pc_last_pc;           out[4] = pc_hits; out[5] = (unsigned)wd_tripped;
    for (i = 0; i < ROMDEV_PCBRK_REGS; i++) out[6 + i] = romdev_pcbrk_regs[i];
    if (clearHit) { pc_hit = 0; wd_tripped = 0; wd_count = 0; }
}
EMSCRIPTEN_KEEPALIVE
void romdev_watchdog_set(unsigned limit) {
    wd_limit = limit; wd_count = 0; wd_tripped = 0;
}

EMSCRIPTEN_KEEPALIVE
void romdev_cov_set(unsigned lo, unsigned hi, int enabled) {
    cov_lo = lo; cov_hi = hi; cov_enabled = enabled ? 1 : 0;
    cov_count = 0; cov_total = 0;
}
EMSCRIPTEN_KEEPALIVE
unsigned romdev_cov_get(unsigned *out, unsigned max, unsigned *out2) {
    unsigned i, n = cov_count;
    if (out2) { out2[0] = cov_count; out2[1] = cov_total; }
    if (n > max) n = max;
    if (out) for (i = 0; i < n; i++) out[i] = cov_pcs[i];
    return n;
}

EMSCRIPTEN_KEEPALIVE
void romdev_regsnap_get(unsigned *out, int clear) {
    int i;
    if (!out) return;
    out[0] = (unsigned)romdev_snap_kind;   /* 0=none 1=pc-break 2=watchdog 3=write 4=read */
    out[1] = ROMDEV_SNAP_REGS;             /* count word the host reads (u[1]) */
    for (i = 0; i < ROMDEV_SNAP_REGS; i++) out[2 + i] = romdev_snap_regs[i];
    if (clear) romdev_snap_kind = 0;
}

EMSCRIPTEN_KEEPALIVE
void romdev_irqblock_set(int on) { romdev_irq_block = on ? 1 : 0; }

/* ── PART 2: core-facing hooks (the seam) ───────────────────────────────────── */

int romdev_wp_wants_old(void) { return wp_enabled && wp_cond; }

int romdev_any_armed(void) {
    return wp_enabled || rd_enabled || range_enabled || cov_enabled
        || pc_enabled || pc_step || wd_limit || pc_hit;
}

static int wp_cond_ok(unsigned char oldv, unsigned char v) {
    switch (wp_cond) {
        case 1:  return v > oldv;                /* increase */
        case 2:  return v < oldv;                /* decrease */
        case 3:  return v == wp_cond_val;        /* equals */
        default: return 1;                       /* none */
    }
}

int romdev_on_write(unsigned addr, unsigned char oldv, unsigned char newv,
                    unsigned pc, unsigned rom_off) {
    int hit = 0;
    if (wp_enabled && addr == wp_addr && wp_cond_ok(oldv, newv)) {
        wp_last_pc = pc; wp_last_val = newv; wp_last_old = oldv;
        wp_last_rom_off = rom_off; wp_hits++;
        hit = 1; /* caller takes a kind-3 register snapshot */
    }
    if (range_enabled && (range_mode & 2) && addr >= range_lo && addr <= range_hi) {
        range_count++;
        if (range_stored < ROMDEV_RANGE_CAP) {
            range_pc[range_stored] = pc; range_addr[range_stored] = addr;
            range_val[range_stored] = newv; range_stored++;
        }
    }
    return hit;
}

int romdev_on_read(unsigned addr, unsigned char val, unsigned pc) {
    int hit = 0;
    if (rd_enabled && addr == rd_addr) {
        rd_last_pc = pc; rd_last_val = val; rd_hits++;
        hit = 1; /* caller takes a kind-4 register snapshot */
    }
    if (range_enabled && (range_mode & 1) && addr >= range_lo && addr <= range_hi) {
        range_count++;
        if (range_stored < ROMDEV_RANGE_CAP) {
            range_pc[range_stored] = pc; range_addr[range_stored] = addr;
            range_val[range_stored] = val; range_stored++;
        }
    }
    return hit;
}

int romdev_on_dispatch(unsigned pc) {
    /* coverage: record the distinct PC if it's in-window */
    if (cov_enabled && pc >= cov_lo && pc <= cov_hi) {
        unsigned i;
        cov_total++;
        for (i = 0; i < cov_count; i++) if (cov_pcs[i] == pc) goto cov_done;
        if (cov_count < ROMDEV_COV_CAP) cov_pcs[cov_count++] = pc;
    }
cov_done:
    /* watchdog: force-stop a runaway after wd_limit instructions */
    if (wd_limit && !pc_hit) {
        if (++wd_count >= wd_limit) {
            wd_tripped = 1; pc_hit = 1; pc_last_pc = pc; pc_hit_kind = 2;
            return 1;
        }
    }
    /* single-step: arm-to-2 countdown → one instruction runs, then freeze */
    if (pc_step > 0) {
        if (--pc_step == 0) { pc_hit = 1; pc_last_pc = pc; pc_hits++; pc_hit_kind = 1; return 1; }
    }
    /* PC breakpoint */
    if (pc_enabled && pc == pc_addr) {
        pc_hit = 1; pc_last_pc = pc; pc_hits++; pc_hit_kind = 1;
        return 1;
    }
    return pc_hit; /* stay frozen until the host clears it (pcbreak_get/set) */
}

int romdev_pc_hit_kind(void) { return pc_hit_kind; }

int romdev_is_frozen(void) { return pc_hit; }
