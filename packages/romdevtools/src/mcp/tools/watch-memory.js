// `watchMemory` — run the emulator forward and report every frame that changed
// a watched byte range. Cross-platform (no core patches): polls the region
// before/after each frame, diffs the result, records (frame, offset, before,
// after, PC).
//
// `runUntilWrite` — narrower: step until target address is written, then stop.
// Returns the same shape minus the full timeline.
//
// Granularity: this is frame-level, not instruction-level. If a single frame
// writes to the same address ten times, we only see the LAST value. For most
// ROM-hacking workflows this is enough — you usually just want "what code is
// touching this byte and what does the screen look like after," not a complete
// CPU trace. Instruction-level tracing would need core-side breakpoint hooks.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";
import { getCPUState } from "romdev-core-host/cpu-state.js";
import { resolveButtonAlias } from "./input.js";
import { getCPUStateCore } from "./platform-tools.js";
import { traceVramSourceCore } from "./trace-vram-source.js";
import { resolveStatePath } from "./state.js";
import { buildBacktrace } from "../../analysis/backtrace.js";
import { mapNesAddress, mapC64Address, mapAtari2600Address, mapAtari7800Address } from "./disasm.js";
import { loadSymbolList, loadDebugSource } from "./symbols.js";
import { MemoryRegionToRetro } from "romdev-core-host/types.js";

/**
 * Build the decoded call stack for a breakpoint hit: who called the routine the
 * PC is in. Uses the captured register snapshot's stack pointer + the stack RAM.
 * Returns null when unavailable (unsupported ISA / no regs) — never throws.
 * @param {import("romdev-core-host/index.js").LibretroHost} host
 * @param {Object|null} regs   the `named` register snapshot (has the stack ptr)
 */
function backtraceForHit(host, regs) {
  if (!regs) return null;
  const platform = host.status?.platform;

  // 6502: validate the $20 (JSR) opcode at each candidate caller PC by mapping the
  // CPU address to a ROM byte. NES uses the cart image + the mapper.
  let readByteAt = null;
  if (platform === "nes") {
    try {
      const cart = host.getCartRom();
      readByteAt = (cpuAddr) => {
        try {
          const { bytes } = mapNesAddress(cart.raw, cpuAddr, 1);
          return bytes && bytes.length ? bytes[0] : null;
        } catch { return null; }
      };
    } catch { /* no cart / mapping — frames stay best-effort */ }
  }

  // Z80/SM83 + m68k stacks live in WORK RAM at the SP (not a fixed page). Read the
  // stack via system_ram using the platform's CPU-addr→RAM mask (the same mapping
  // the callSubroutine watchdog uses). Best-effort: return null on any read miss.
  const ramMask = platform === "genesis" ? 0xffff
    : (platform === "gb" || platform === "gbc" || platform === "sms" || platform === "gg" || platform === "msx") ? 0x1fff
      : 0xffff;
  const readRamByte = (cpuAddr) => {
    try {
      const b = host.readMemory("system_ram", cpuAddr & ramMask, 1);
      return b && b.length ? b[0] : null;
    } catch { return null; }
  };
  const readCpuWord = (cpuAddr) => {
    const lo = readRamByte(cpuAddr); const hi = readRamByte(cpuAddr + 1);
    return (lo == null || hi == null) ? null : (lo | (hi << 8));
  };
  const readCpuLongBE = (cpuAddr) => {
    const b0 = readRamByte(cpuAddr), b1 = readRamByte(cpuAddr + 1), b2 = readRamByte(cpuAddr + 2), b3 = readRamByte(cpuAddr + 3);
    return (b0 == null || b1 == null || b2 == null || b3 == null) ? null : ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
  };

  const bt = buildBacktrace({
    platform,
    regs,
    readMemory: (region, off, len) => host.readMemory(region, off, len),
    readByteAt,
    readCpuWord,
    readCpuLongBE,
  });
  if (!bt || !bt.frames.length) return null;
  const pad = bt.isa === "m68k" ? 6 : 4; // 24-bit m68k addresses print wider
  const isaNote = {
    "6502": "confident=true means the byte before the return target is a JSR ($20).",
    sm83: "confident=true means the return address lands in a plausible code range (SM83 call frames are 2-byte LE; the call's own length isn't recovered, so callerPc IS the return address).",
    z80: "confident=true means the return address lands in a plausible code range (Z80 call frames are 2-byte LE; callerPc IS the return address).",
    m68k: "confident=true means the return longword is even + in-range (m68k jsr/bsr push a 4-byte BE return; callerPc IS the return address).",
  }[bt.isa] || "";
  return {
    isa: bt.isa,
    frames: bt.frames.map((f) => ({
      callerPc: "$" + f.callerPc.toString(16).toUpperCase().padStart(pad, "0"),
      returnAddr: "$" + f.returnAddr.toString(16).toUpperCase().padStart(pad, "0"),
      confident: f.confident,
    })),
    note: `callStack[0] is the immediate caller (the call that reached this routine), decoded from the stack at the break instant. ${isaNote} Generated server-side — no hand stack-walking.`,
  };
}

// Restore a savestate (in-memory slot `fromState` OR disk file `fromStatePath`)
// before a trace, so on:'range'/'pc' run from a known moment. Returns a small
// {slot|path} descriptor for the response, or null if neither was given.
// Throws a clear error if both are given or the restore fails.
async function maybeRestoreState(host, fromState, fromStatePath) {
  if (fromState && fromStatePath) {
    throw new Error("watch: provide `fromState` (slot) OR `fromStatePath` (file), not both.");
  }
  if (fromStatePath) {
    const resolved = resolveStatePath(fromStatePath, host);
    let blob;
    try { blob = new Uint8Array(await readFile(resolved)); }
    catch (e) { throw new Error(`watch: can't read fromStatePath '${resolved}': ${e.message}`); }
    host.unserializeState(blob);
    return { path: resolved };
  }
  if (fromState) {
    host.loadState(fromState); // throws if the slot doesn't exist
    return { slot: fromState };
  }
  return null;
}

// Let a human watching /livestream (or a playtest window) SEE what a
// breakpoint/watch tool just did — the frozen breakpoint frame, the state when a
// write was caught — even though the AGENT gets only a small JSON result.
//
// CRITICAL: this must NOT slow the agent down. The PNG encode is the expensive
// part, so we do NOT encode here on the tool's critical path. Instead we attach a
// `_observerFrameProvider` thunk (just captures the host ref — free) and the
// observer wrapper encodes it ASYNCHRONOUSLY, after the agent's response has
// already gone out. The provider is stripped from the agent-visible result. The
// frame is captured by reference now (correct frozen state) but rasterized later.
export function attachObserverFrame(json, host, caption) {
  json._observerFrameProvider = () => {
    try {
      const shot = host.screenshot(); // { pngBase64, width, height }
      return shot && shot.pngBase64
        ? { kind: "image", mimeType: "image/png", base64: shot.pngBase64 }
        : null;
    } catch { return null; }
  };
  if (caption) json._observerFrameCaption = String(caption);
  return json;
}

// Drive scheduled `pressDuring` input through the host's ONLY input API
// (setInput) — the watch loop owns stepFrames, so this must never advance the
// emulator itself. Returns a stateful driver: call applyForFrame(i) at the top
// of each watched frame (before stepFrames) to set the held-button state, and
// finish() once at the end to release everything. `presses` is the sorted
// schedule; each press holds from its `frame` for `holdFrames` frames.
// frame({op:'stepInstruction'}) — execute exactly ONE CPU instruction and stop.
// Exported so the `frame` router (frame.js) can call it; takes sessionKey.
export async function stepInstructionCore(sessionKey) {
  const host = getHost(sessionKey);
  if (!host.pcBreakSupported || !host.pcBreakSupported()) {
    return jsonContent({
      stepped: false, notSupported: true,
      note: "This core build has no single-step (shipped on all 14 platforms as of 0.5.0 — update the core package if you see this).",
    });
  }
  const r = host.stepInstruction();
  return attachObserverFrame(jsonContent({
    stepped: true,
    pc: r.pc != null ? "$" + r.pc.toString(16).toUpperCase() : null,
    pcRaw: r.pc,
    note: "CPU is frozen one instruction later. cpu({op:'read'}) to read registers; frame({op:'stepInstruction'}) again to keep stepping.",
  }), host);
}

/**
 * Step N CPU instructions and return an ORDERED trace in ONE call — the bulk
 * form of stepInstruction, for confirming routine boundaries + immediate widths
 * without a round trip per instruction (the 65816 `.a8` vs `.i16` case, where the
 * width shows up only as the PC delta). Each trace entry carries the PC and the
 * raw instruction bytes (PC[n+1]-PC[n] bytes from RAM), so widths are visible
 * directly; the boilerplate `note` is emitted ONCE for the whole trace, not per
 * entry. `withRegisters` adds the CPU register file at each step.
 * @param {string} sessionKey
 * @param {{count?:number, withRegisters?:boolean, platform?:string, cpu?:string}} [opts]
 */
export async function stepInstructionsCore(sessionKey, { count = 16, withRegisters = false, platform, cpu = "main", format = "full" } = {}) {
  const host = getHost(sessionKey);
  if (!host.pcBreakSupported || !host.pcBreakSupported()) {
    return jsonContent({
      stepped: false, notSupported: true,
      note: "This core build has no single-step (shipped on all classic platforms as of 0.5.0 — update the core package if you see this).",
    });
  }
  const n = Math.max(1, Math.min(count, 4096));
  const plat = platform ?? host.status?.platform;
  // Collect a PC at each stop; the byte span of instruction k is PC[k+1]-PC[k],
  // so read one extra step's PC to size the last instruction.
  const stops = [];
  for (let i = 0; i < n; i++) {
    const r = host.stepInstruction();
    stops.push(r.pc);
    if (r.pc == null) break;
  }
  const finalPc = stops.length ? stops[stops.length - 1] : null;

  // Classify each step's control FLOW from its opcode. This is the fix for the
  // width paper cut (field report): `width` was reported as the raw PC delta, so
  // a TAKEN forward branch (2-byte `beq` to +3) looked exactly like a 3-byte
  // instruction — silently mis-validating a decode. The delta is the true
  // instruction size ONLY on a sequential step; on any branch/jsr/jmp it's the
  // jump distance. We read the opcode byte at each PC (6502/65816 have a small,
  // fixed control-transfer opcode set) and emit `flow` always + `width` ONLY for
  // truly sequential steps. Other CPUs (no classifier yet) keep the delta-`width`
  // fallback but carry `flow:'seq'|'nonseq'` so a delta is never mistaken for a
  // width across a branch.
  let rom = null, opAt = null;
  try {
    rom = host.getCartRom?.();
  } catch { rom = null; }
  const family = CPU_FAMILY_FOR[plat];
  if (rom && (family === "6502" || family === "65816")) {
    const { mapSnesAddress, mapNesAddress } = await import("./disasm.js");
    opAt = (pc) => {
      try {
        const m = plat === "snes" ? mapSnesAddress(rom.raw ?? rom, pc >>> 0, 1)
          : plat === "nes" ? mapNesAddress(rom.raw ?? rom, pc >>> 0, 1)
          : null;
        return m ? m.bytes[0] : null;
      } catch { return null; }
    };
  }

  const trace = [];
  for (let k = 0; k < stops.length; k++) {
    const pc = stops[k];
    if (pc == null) continue;
    const nextPc = k + 1 < stops.length ? stops[k + 1] : null;
    const op = opAt ? opAt(pc) : null;
    const flow = op != null ? classify6502Flow(op) : null; // 'branch'|'call'|'jump'|'ret'|'seq'
    const delta = (nextPc != null && nextPc > pc && nextPc - pc <= 16) ? nextPc - pc : null;
    // `width` = true instruction size. Trustworthy ONLY when the step was
    // sequential: we know that either because the opcode says non-control-flow
    // ('seq'), or (no classifier) we fall back to the delta but flag it.
    let width = null;
    if (flow === "seq") width = delta;                 // classified sequential → delta IS the size
    else if (flow == null) width = delta;              // no classifier (other CPU) → delta, flagged nonseq-unknown
    // control-transfer ('branch'/'call'/'jump'/'ret') → width omitted (delta is a jump distance)
    const entry = {
      pc: "$" + pc.toString(16).toUpperCase(),
      pcRaw: pc,
      ...(flow ? { flow } : {}),
      ...(width != null ? { width } : {}),
      // On a control transfer, expose the raw delta separately so it's never
      // confused with a width but the target is still visible.
      ...(flow && flow !== "seq" && nextPc != null ? { nextPc: "$" + nextPc.toString(16).toUpperCase() } : {}),
    };
    if (withRegisters) {
      try { entry.registers = getCPUState(host, plat, cpu); } catch { /* skip */ }
    }
    trace.push(entry);
  }
  const finalPcHex = finalPc != null ? "$" + finalPc.toString(16).toUpperCase() : null;

  // format:'compact' — one string per step instead of a per-step object. A
  // triage trace's signal is "which loop is the CPU in", and 48 steps of JSON
  // objects (~250 lines) is ~90% padding for that. Each string is
  // `"$PC seq"` / `"$PC branch->$TGT"` — same info, a fraction of the tokens.
  if (format === "compact") {
    const steps = trace.map((e) => {
      const f = e.flow || (e.width != null ? "seq" : "?");
      return e.nextPc ? `${e.pc} ${f}->${e.nextPc}` : `${e.pc} ${f}`;
    });
    // Also fold the visited PCs into ranges with visit counts — the loop map.
    const counts = new Map();
    for (const e of trace) counts.set(e.pcRaw, (counts.get(e.pcRaw) || 0) + 1);
    const visited = [...counts.keys()].sort((a, b) => a - b);
    const ranges = [];
    for (const pc of visited) {
      const last = ranges[ranges.length - 1];
      if (last && pc <= last._end + 4) { last._end = pc; last.hits += counts.get(pc); }
      else ranges.push({ from: "$" + pc.toString(16).toUpperCase(), _start: pc, _end: pc, hits: counts.get(pc) });
    }
    const pcRanges = ranges.map((r) => ({ from: r.from, to: "$" + r._end.toString(16).toUpperCase(), hits: r.hits }));
    return attachObserverFrame(jsonContent({
      stepped: true, count: trace.length, finalPc: finalPcHex,
      steps, pcRanges,
      note: "compact: `steps` = one string per step (`$PC flow` / `$PC flow->$target`); `pcRanges` = the distinct PC spans visited with hit counts (the loop map). Full per-step objects: pass format:'full'.",
    }), host);
  }

  return attachObserverFrame(jsonContent({
    stepped: true,
    count: trace.length,
    finalPc: finalPcHex,
    trace,
    note: (opAt
      ? "CPU is frozen at finalPc. `flow` classifies each step from its opcode (seq/branch/call/jump/ret); `width` = the instruction's true byte size and is present ONLY on `flow:'seq'` steps, so a 65816 immediate width (2-byte lda #imm8 vs 3-byte ldx #imm16) is trustworthy — a taken forward branch no longer masquerades as a width (it carries `flow` + `nextPc` instead). "
      : "CPU is frozen at finalPc. `width` = PC[k+1]-PC[k]; on this core no opcode classifier ran, so `flow:'seq'` means the step was linear (delta = size) and a branch omits `width`. ") +
      "Step more with frame({op:'stepInstructions', count}). For a compact loop-map trace pass format:'compact'.",
  }), host);
}

// CPU family for the opcode-flow classifier (subset — only where classify runs).
const CPU_FAMILY_FOR = { nes: "6502", c64: "6502", atari2600: "6502", atari7800: "6502", lynx: "6502", pce: "6502", gametank: "6502", snes: "65816" };

/**
 * Classify a 6502/65816 opcode as a control transfer for the step trace.
 * Returns 'branch' | 'call' | 'jump' | 'ret' | 'seq'. Covers the full 65816
 * transfer set (a superset of 6502): conditional branches (bcc/bcs/beq/bne/bmi/
 * bpl/bvc/bvs + bra/brl), jsr/jsl (call), jmp variants/rti/brk-vector (jump),
 * rts/rtl/rti (ret). Everything else is sequential.
 */
function classify6502Flow(op) {
  switch (op) {
    // conditional branches (rel8) + BRA/BRL
    case 0x10: case 0x30: case 0x50: case 0x70:
    case 0x90: case 0xB0: case 0xD0: case 0xF0:
    case 0x80: case 0x82:
      return "branch";
    case 0x20: case 0x22: case 0xFC: // jsr abs / jsl long / jsr (abs,x)
      return "call";
    case 0x4C: case 0x5C: case 0x6C: case 0x7C: case 0xDC: // jmp abs/long/(ind)/(abs,x)/[long]
    case 0x00: // brk (vectors away)
    case 0x02: // cop (vectors away)
      return "jump";
    case 0x40: case 0x60: case 0x6B: // rti / rts / rtl
      return "ret";
    default:
      return "seq";
  }
}

export function makePressDriver(host, presses) {
  let applied = 0;          // how many scheduled presses actually got a frame
  let lastSet = null;       // last setInput payload we pushed (to avoid churn)
  const platform = host.status?.platform;
  // When NO pressDuring schedule is given, the driver must NOT touch input at
  // all — it leaves whatever persistent state input({op:'set'}) established in
  // place, so a watch/breakpoint inherits the held pad exactly like
  // frame({op:'step'}) does. (Previously applyForFrame(0) pushed an empty
  // [{},{}] payload on the first frame, silently neutralizing a held Right+A —
  // the v0.16.0 movement-analysis bug.) A non-empty schedule still OWNS the
  // pad (deterministic capture): it drives the buttons and releases on finish.
  const driven = presses.length > 0;
  return {
    applied: () => applied,
    applyForFrame(i) {
      if (!driven) return;   // inherit persistent input({op:'set'}) state
      // Buttons whose [frame, frame+holdFrames) window covers frame i.
      const held = presses.filter((p) => i >= p.frame && i < p.frame + (p.holdFrames ?? 2));
      // Build a 2-port setInput payload from the held buttons.
      const ports = [{}, {}];
      for (const p of held) {
        const resolved = resolveButtonAlias(p.button, platform);
        ports[p.port ?? 0][resolved] = true;
      }
      const key = JSON.stringify(ports);
      if (key !== lastSet) { host.setInput({ ports }); lastSet = key; }
      // Count each scheduled press once, on the first frame it's actually held.
      for (const p of held) { if (p.frame === i) applied++; }
    },
    finish() {
      if (!driven) return;   // we never touched input; leave it as the caller set it
      if (lastSet !== null && lastSet !== "[{},{}]") host.setInput({ ports: [{}, {}] });
    },
  };
}

/**
 * Flush any held-input shadow before a driven run. Back-to-back `pressDuring`
 * runs on the SAME live host can leak the PRIOR run's held button into the next
 * run's frame 0 — the game latches the pad into its own RAM each frame, and the
 * new run's frame-0 logic reads that stale chord before the new input propagates.
 * That makes a negative control (hold A to prove A does NOT reach a B-only branch)
 * FALSE-POSITIVE on frame 1. (v0.41.0 feedback 213831 #1.) Calling this first sets
 * the pad neutral and steps `n` frames so the game's input shadow settles to
 * neutral; then the schedule drives a clean run. Only steps when a press schedule
 * is actually given (no-op otherwise, so it never disturbs an inherited pad).
 * @param {import("romdev-core-host/index.js").LibretroHost} host
 * @param {number} n   neutral frames to settle (0 = skip)
 * @param {boolean} driven  whether this run has a pressDuring schedule
 */
function settleHeldInput(host, n, driven) {
  if (!driven || !n || n <= 0) return;
  host.setInput({ ports: [{}, {}] });
  host.stepFrames(n | 0);
}

// Single source of truth: the same canonical region vocabulary readMemory uses
// (host/types.js). Derived from the host map so new regions flow through
// automatically and the two tools never disagree. Used by the ONE primary
// `on:'mem'` region enum (kept discoverable on purpose); every SECONDARY region
// sub-param uses the lean regionStr string instead (0.28.0/0.30.0 feedback #5).
const MEMORY_REGIONS = /** @type {[string, ...string[]]} */ (Object.keys(MemoryRegionToRetro));

// A region param that does NOT inline the full ~62-value enum into the JSON
// schema. The enum array is ~214 tokens PER param site; inlining it on every
// secondary region sub-param across this file was the dominant tool-schema
// bloat (0.28.0 feedback #5). Used on SECONDARY/sub params; the PRIMARY region
// inputs keep z.enum so the full list stays discoverable where the region IS
// the choice. A plain string — validated at RUNTIME by the handler (the
// host.readMemory / MemoryRegionToRetro lookup throws on an unknown region with
// a clear message), so dropping the schema enum here costs no safety.
// NOTE: `z` is passed into registerWatchMemoryTools (not a module import), so
// this factory takes `z` and is invoked once inside the register fn.
const makeRegionStr = (z) => (desc) =>
  z.string().describe(desc + " (validated at runtime against the canonical region set).");

// Abort-guard for input-driven watchpoint runs: sample caller-named bytes each
// frame; the FIRST one to change stops the run with {label,addr,before,after}.
// Lets a derailed driven scenario (player died, scene flipped) return immediately
// with WHY, instead of burning all maxFrames on a meaningless miss.
function makeAbortGuard(host, abortIf) {
  const specs = Array.isArray(abortIf) ? abortIf : [];
  const watched = specs.map((s, _i) => {
    const region = s.region ?? "system_ram";
    const offset = s.offset ?? 0;
    let before;
    try { before = host.readMemory(region, offset, 1)[0]; } catch { before = null; }
    const addr = "$" + (offset >>> 0).toString(16).toUpperCase();
    return { region, offset, addr, label: s.label ?? `${region}${addr}`, before };
  }).filter((w) => w.before != null);
  return {
    count: watched.length,
    check() {
      for (const w of watched) {
        let now;
        try { now = host.readMemory(w.region, w.offset, 1)[0]; } catch { continue; }
        if (now !== w.before) {
          return {
            label: w.label, addr: w.addr,
            before: "0x" + w.before.toString(16).padStart(2, "0").toUpperCase(),
            after: "0x" + now.toString(16).padStart(2, "0").toUpperCase(),
          };
        }
      }
      return null;
    },
  };
}

// No-hit note for bpFindWriter. The full "two reasons" explainer (~100 tokens)
// is useful ONCE; as a repeated payload it's pure overhead (v0.15.0 feedback
// #2b). Emit the long form only on the first miss per MCP session, a one-liner
// after.
const _bpNoHitSeen = new Set();
function noHitNote(sessionKey) {
  const short = "No per-byte CPU write to that address within maxFrames. Either the event didn't fire " +
    "(raise maxFrames / drive it with pressDuring; add abortIf to stop early if the scenario derails), " +
    "OR the region is rebuilt as a BLOCK (OAM/display-list/VRAM bulk-copy or DMA) so no single instruction " +
    "writes it — watch the SOURCE struct the copy reads from instead.";
  if (_bpNoHitSeen.has(sessionKey)) return short;
  _bpNoHitSeen.add(sessionKey);
  return "No per-byte CPU write to that address within maxFrames. Two common reasons: " +
    "(1) the event didn't fire — increase maxFrames or drive the game with pressDuring to trigger it " +
    "(and pass `abortIf` to abort early + say why if a driven run derails, e.g. the player dies). " +
    "(2) this region is rebuilt as a BLOCK rather than written field-by-field — sprite/OAM shadow tables, " +
    "display lists, and VRAM are typically bulk-copied (memcpy/loop) or DMA'd from a SOURCE struct elsewhere, " +
    "so no single instruction writes this exact byte. In that case the address you want is the SOURCE: watch " +
    "the struct the copy reads from (find it with memory({op:'search'}) on the live value), or for graphics trace the " +
    "DMA/copy source (Genesis VRAM DMA source is in VDP regs). 'Address is wrong' is usually case (2), not a bad address.";
}

function tryGetPC(host) {
  try {
    const platform = host.status?.platform;
    if (!platform) return null;
    const cpu = getCPUState(host, platform);
    if (cpu && typeof cpu.pc === "number") return cpu.pc;
    return null;
  } catch {
    return null;
  }
}

/**
 * Where is the MAIN THREAD, not the frame-boundary snapshot? A single
 * `tryGetPC` after `stepFrames` lands on whatever ran last at the boundary —
 * almost always the NMI/idle handler (`$8520` etc.), which is useless for "where
 * was the code I'm hunting." Instead single-step across ~a frame and histogram
 * the PCs: the main loop dominates the sample count while the interrupt handler
 * is a brief once-per-frame blip. Report the modal PC (the busiest instruction)
 * plus a couple of runners-up as `pcHistogram`. Best-effort — null if the core
 * has no single-step, so callers keep the frame-boundary `pcNow` as a fallback.
 *
 * @param {*} host
 * @param {number} [samples] instructions to single-step (default ~one frame)
 * @returns {{modalPc:number, hits:number, total:number, top:Array<{pc:number,hits:number}>}|null}
 */
function sampleMainThreadPc(host, samples = 400) {
  try {
    if (!host.pcBreakSupported || !host.pcBreakSupported()) return null;
    if (typeof host.stepInstruction !== "function") return null;
    // Snapshot the FULL emulator state so the sampling has ZERO side effects —
    // single-stepping ~a frame advances the CPU and the frame counter, which
    // would otherwise surprise a caller who wants to retry the miss with
    // different input. Restore it after. (serializeState is cross-platform; if
    // the core lacks it we bail rather than mutate state unrestorably.)
    let snapshot = null;
    try { snapshot = typeof host.serializeState === "function" ? host.serializeState() : null; }
    catch { snapshot = null; }
    if (!snapshot) return null; // no restore path → don't perturb state for a diagnostic
    // `frameCount` is a JS-side counter, NOT part of the core's serialized blob,
    // so unserializeState won't roll it back — save/restore it explicitly.
    const prevFrameCount = host.status?.frameCount;
    try {
      const counts = new Map();
      let total = 0;
      for (let i = 0; i < samples; i++) {
        const r = host.stepInstruction();
        // stepInstruction returns the post-step PC on most cores; fall back to a
        // direct read if not.
        const pc = (r && typeof r.pc === "number") ? r.pc : tryGetPC(host);
        if (pc == null) break;
        counts.set(pc, (counts.get(pc) || 0) + 1);
        total++;
      }
      if (!total) return null;
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      return {
        modalPc: sorted[0][0],
        hits: sorted[0][1],
        total,
        top: sorted.slice(0, 4).map(([pc, hits]) => ({ pc, hits })),
      };
    } finally {
      // Restore the pre-sample state no matter what.
      try { host.unserializeState(snapshot); } catch { /* best-effort */ }
      if (prevFrameCount != null && host.status) host.status.frameCount = prevFrameCount;
    }
  } catch {
    return null;
  }
}

function hexPC(pc) {
  if (pc == null) return null;
  return "$" + pc.toString(16).toUpperCase().padStart(4, "0");
}

function snap(host, region, offset, length) {
  return Array.from(host.readMemory(region, offset, length));
}

function diffSnapshots(before, after, baseOffset, label) {
  const changes = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) {
      changes.push({
        ...(label ? { label } : {}),
        offset: baseOffset + i,
        offsetHex: "0x" + (baseOffset + i).toString(16).toUpperCase().padStart(4, "0"),
        before: before[i],
        after: after[i],
      });
    }
  }
  return changes;
}

// Edge classifier — a single byte's transition relative to its previous value.
// "reset" is the canonical music-driver signal: a countdown counter that
// reloads (jumps UP) marks a note onset. Filtering to resets turns a 7000-event
// decrement stream into the ~few-hundred-event note list directly.
function edgeMatches(onChange, before, after) {
  switch (onChange) {
    case "increase": return after > before;
    case "decrease": return after < before;
    case "reset":    return after > before;   // counter reload = jump up
    case "any":
    default:         return true;
  }
}

function valueMatches(valueFilter, after) {
  if (!valueFilter) return true;
  if (valueFilter.min != null && after < valueFilter.min) return false;
  if (valueFilter.max != null && after > valueFilter.max) return false;
  return true;
}

// Downsample an array to at most `n` evenly-spaced elements, ALWAYS keeping the
// first and last (so a value-vs-frame curve still spans the whole window). For
// n>=length returns the array unchanged; for n<=1 returns just the last point.
function downsample(arr, n) {
  const len = arr.length;
  if (len <= n) return arr;
  if (n <= 1) return [arr[len - 1]];
  const out = [];
  const step = (len - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

// ── census enrichment (0.101.0): phantom-read flagging + routine grouping ──
//
// Phantom reads: on the 6502 family, `sta abs,X` / `sta abs,Y` (and the
// abs,X RMWs) always perform a DUMMY READ at the un-carried address
// `(base & $FF00) | ((base_lo + X) & $FF)` before the real access. On a
// cycle-accurate core those bus reads land in a READ census and look exactly
// like consumers of the watched range. The static tell: the instruction at
// the reporting PC is a WRITE-class indexed op whose operand base is OUTSIDE
// the range. That is decidable from the cart bytes alone — so decide it here
// and flag the row instead of letting it be written up as a consumer.
const PHANTOM_DUMMY_READ_OPCODES = new Set([
  0x9D, 0x99,                         // sta abs,X / sta abs,Y
  0xDE, 0xFE, 0x1E, 0x5E, 0x3E, 0x7E, // dec/inc/asl/lsr/rol/ror abs,X
]);
const PHANTOM_PLATFORMS = new Set(["nes", "c64", "atari2600", "atari7800"]);

/** Best-effort cart-byte reader at a CPU address (fixed-bank mapping). */
function makeRomByteReader(host, platform) {
  if (!PHANTOM_PLATFORMS.has(platform)) return null;
  let raw;
  try { raw = host.getCartRom()?.raw; } catch { return null; }
  if (!raw) return null;
  return (cpuAddr) => {
    try {
      switch (platform) {
        case "nes": return mapNesAddress(raw, cpuAddr, 1).bytes[0];
        case "c64": return mapC64Address(raw, cpuAddr, 1, 0).bytes[0];
        case "atari2600": return mapAtari2600Address(raw, cpuAddr, 1, 0).bytes[0];
        case "atari7800": return mapAtari7800Address(raw, cpuAddr, 1, 0).bytes[0];
        default: return null;
      }
    } catch { return null; }
  };
}

/**
 * Mutates byPCList rows in place; returns extra result fields + note lines.
 * - phantomRead/storeBase per row (read censuses, 6502 family)
 * - routine per row + a byRoutine rollup (when a dbg/map symbol file is given)
 */
async function enrichCensus(byPCList, { host, kind, start, end, dbg, map }) {
  const extra = {};
  const noteLines = [];
  const platform = host.status?.platform ?? null;

  if (kind === "read" && platform && PHANTOM_PLATFORMS.has(platform)) {
    const readB = makeRomByteReader(host, platform);
    if (readB) {
      let flagged = 0;
      for (const row of byPCList) {
        const pc = parseInt(row.pc.slice(1), 16);
        const op = readB(pc);
        if (op == null || !PHANTOM_DUMMY_READ_OPCODES.has(op)) continue;
        const lo = readB(pc + 1), hi = readB(pc + 2);
        if (lo == null || hi == null) continue;
        const base = lo | (hi << 8);
        if (base < start || base > end) {
          row.phantomRead = true;
          row.storeBase = "$" + base.toString(16).toUpperCase();
          flagged++;
        }
      }
      if (flagged) {
        noteLines.push(
          `${flagged} PC(s) flagged phantomRead: the instruction there is an indexed WRITE/RMW whose operand base ` +
          "(storeBase) is outside this range — its 6502 dummy-read cycle landed in the range, but the PROGRAM never " +
          "reads these bytes there. Don't write them up as consumers. (Fixed-bank decode; a PC in a switched bank may " +
          "escape the check — the write-census diff still catches it.)");
      }
    }
  }

  if (dbg || map) {
    try {
      const { symbols } = await loadSymbolList({ dbg, map });
      const sorted = symbols.filter((sym) => Number.isFinite(sym.addr)).sort((a, b) => a.addr - b.addr);
      const nameFor = (addr) => {
        let best = null;
        for (const sym of sorted) { if (sym.addr <= addr) best = sym; else break; }
        return best ? { name: best.name, offset: addr - best.addr } : null;
      };
      const roll = new Map();
      for (const row of byPCList) {
        const pc = parseInt(row.pc.slice(1), 16);
        const sym = nameFor(pc);
        if (!sym) continue;
        row.routine = sym.offset ? `${sym.name}+${sym.offset}` : sym.name;
        let g = roll.get(sym.name);
        if (!g) { g = { routine: sym.name, pcs: 0, count: 0 }; roll.set(sym.name, g); }
        g.pcs++; g.count += row.count;
      }
      if (roll.size) {
        extra.byRoutine = [...roll.values()].sort((a, b) => b.count - a.count);
        noteLines.push(
          "byRoutine groups the PCs by containing symbol — compare censuses in ROUTINE units, not PC units " +
          "(a read-modify-write logs two PCs in one routine; PC counts look like disagreements across runs when they aren't).");
      }
    } catch (e) {
      noteLines.push(`routine grouping skipped: ${e.message}`);
    }
  }

  return { extra, noteLines };
}

export function registerWatchMemoryTools(server, z, sessionKey) {
  const regionStr = makeRegionStr(z);
  const rangeShape = z.object({
    region: regionStr("memory region for THIS range (same canonical set `memory` uses)"),
    offset: z.number().int().min(0),
    length: z.number().int().min(1).max(4096).default(1),
    label: z.string().optional().describe("Name echoed on every event from this range — tells disjoint ranges apart in one stream."),
    // Per-range overrides of the call-wide filters. The whole point: in a
    // multi-range watch, keep EVERY transition of a slow state byte while
    // sampling/suppressing a fast free-running counter in the SAME pass.
    onChange: z.enum(["any", "increase", "decrease", "reset"]).optional().describe("Per-range edge filter; overrides the call-wide `onChange` for THIS range only."),
    sampleEvery: z.number().int().min(1).optional().describe("Per-range downsample: keep every Nth change from THIS range (e.g. 8 to thin a noisy counter while other ranges stay full)."),
    valueFilter: z.object({ min: z.number().int().min(0).max(255).optional(), max: z.number().int().min(0).max(255).optional() }).optional().describe("Per-range value window; overrides the call-wide `valueFilter` for THIS range."),
  });

  // watch({on:mem|range|pc}) LOG-ALL. on:mem=watchMem (the power tool below),
  // on:range=wRange, on:pc=wLogPC.
  async function watchMem({ region, offset = 0, length = 1, ranges, frames = 600, stopOnFirst = false, onChange = "any", valueFilter, maxEvents = 256, format = "events", sampleEvery = 1, groupByPC = false, outputPath, pressDuring, cheatLabels }) {
      const host = getHost(sessionKey);

      // Normalize to a list of ranges. Single-range mode requires `region`.
      const watchRanges = (ranges && ranges.length)
        ? ranges.map((r) => ({ length: 1, ...r }))
        : (() => {
            if (!region) throw new Error("watchMemory: pass `region` (single-range) or `ranges` (multi-range).");
            return [{ region, offset, length }];
          })();

      // Optional: auto-label watched RAM addresses from the cheat DB. Builds an
      // address→desc map from the matched game's RAM cheats and fills in `label`
      // for any range whose CPU address lines up (system_ram offset == address)
      // and that the caller didn't already label. Free semantic names; PROBABLE
      // match (see gameCheats) — labels are strong hints, not gospel.
      let cheatLabelInfo;
      if (cheatLabels) {
        try {
          const idMod = await import("../../rom-id/identifier.js");
          const { lookupCheats } = await import("../../cheats/lookup.js");
          const id = await idMod.identifyFile(cheatLabels).catch(() => null);
          const res = await lookupCheats({ platform: id?.platform, fileName: path.basename(cheatLabels), romName: id?.title || undefined });
          if (res.matched) {
            const addrToDesc = new Map();
            for (const e of res.entries) {
              for (const p of (e.parts || [])) {
                if (p && p.kind === "ram" && !addrToDesc.has(p.address)) addrToDesc.set(p.address, e.desc);
              }
            }
            for (const r of watchRanges) {
              if (r.label) continue;
              // Only RAM-class regions where offset maps 1:1 to CPU address.
              if (!/(^system_ram$|_ram$|_wram$|^gb_hram$)/.test(r.region)) continue;
              const desc = addrToDesc.get(r.offset);
              if (desc) r.label = desc;
            }
            cheatLabelInfo = { matched: true, game: res.game, confidence: res.confidence, labeled: watchRanges.filter((r) => r.label).length };
          } else {
            cheatLabelInfo = { matched: false };
          }
        } catch { cheatLabelInfo = { matched: false }; }
      }

      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      const startFrame = host.status.frameCount;

      // Per-range previous snapshots.
      let prevs = watchRanges.map((r) => snap(host, r.region, r.offset, r.length));
      const rangeSample = new Array(watchRanges.length).fill(0); // per-range sampleEvery counters

      const preview = [];          // bounded inline events
      let totalMatched = 0;        // ALL filter-passing events (file-backed)
      let sampleCounter = 0;       // for sampleEvery: keep every Nth match
      let truncated = false;       // inline preview hit maxEvents
      let stoppedEarly = false;
      const fileLines = [];        // NDJSON lines when outputPath set
      // groupByPC accumulator: pc -> {hits, firstFrame, lastFrame, offsets:Set}.
      // Collapses "which instructions touched this byte" — the canonical
      // "find the hot-path writer" question — into one row per PC regardless of
      // how many thousands of times each fired.
      const byPc = groupByPC ? new Map() : null;
      // format:"series" accumulator: offsetHex -> {offset, offsetHex, label,
      // region, frames:[], values:[]}. The compact value-vs-frame curve, with
      // the repeated boilerplate hoisted into the per-offset header (set once).
      const seriesMap = format === "series" ? new Map() : null;

      const pushEvent = (ev) => {
        totalMatched++;
        // sampleEvery: keep only every Nth filter-passing change (1 = all).
        if (sampleEvery > 1) {
          const keep = (sampleCounter % sampleEvery) === 0;
          sampleCounter++;
          if (!keep) return;
        }
        if (seriesMap) {
          const key = ev.offsetHex ?? String(ev.offset);
          let s = seriesMap.get(key);
          if (!s) {
            s = { offset: ev.offset, offsetHex: ev.offsetHex, region: ev.region, frames: [], values: [] };
            if (ev.label != null) s.label = ev.label;
            seriesMap.set(key, s);
          }
          s.frames.push(ev.frame);
          s.values.push(ev.after);
        }
        if (byPc) {
          const key = ev.pc ?? "(unknown)";
          let g = byPc.get(key);
          if (!g) { g = { pc: key, hits: 0, firstFrame: ev.frame, lastFrame: ev.frame, offsets: new Set() }; byPc.set(key, g); }
          g.hits++;
          g.lastFrame = ev.frame;
          g.offsets.add(ev.offsetHex ?? ev.offset);
        }
        if (outputPath) fileLines.push(JSON.stringify(ev));
        // When grouping, the per-event preview is redundant with the summary —
        // keep only a tiny sample for context (the byPC[] rows are the answer;
        // a 30-event watch shouldn't dump ~360 lines of raw events too).
        const cap = byPc ? Math.min(maxEvents, 8) : maxEvents;
        if (preview.length < cap) preview.push(ev);
        else { truncated = true; }
      };

      outer:
      for (let i = 0; i < frames; i++) {
        // Set held-button state for this frame BEFORE stepping (the loop owns
        // stepFrames; the driver only calls setInput).
        pressDriver.applyForFrame(i);
        host.stepFrames(1);
        const frameAbs = startFrame + i + 1;
        let pcCached;
        const pcOnce = () => (pcCached !== undefined ? pcCached : (pcCached = tryGetPC(host)));

        for (let ri = 0; ri < watchRanges.length; ri++) {
          const r = watchRanges[ri];
          const cur = snap(host, r.region, r.offset, r.length);
          const changes = diffSnapshots(prevs[ri], cur, r.offset, r.label);
          prevs[ri] = cur;
          // Per-range filter overrides fall back to the call-wide values.
          const rOnChange = r.onChange ?? onChange;
          const rValueFilter = r.valueFilter ?? valueFilter;
          const rSampleEvery = r.sampleEvery ?? 1;
          for (const c of changes) {
            if (!edgeMatches(rOnChange, c.before, c.after)) continue;
            if (!valueMatches(rValueFilter, c.after)) continue;
            // Per-range downsample (independent of the call-wide sampleEvery,
            // which still applies globally inside pushEvent).
            if (rSampleEvery > 1) {
              rangeSample[ri] = (rangeSample[ri] ?? 0) + 1;
              if ((rangeSample[ri] - 1) % rSampleEvery !== 0) continue;
            }
            const pc = pcOnce();
            pushEvent({
              frame: frameAbs,
              frameRelative: i + 1,
              region: r.region,
              ...c,
              pc: hexPC(pc),
              pcRaw: pc,
            });
            if (stopOnFirst) { stoppedEarly = true; break outer; }
            // Without a file, once the inline preview is full there's no point
            // continuing — EXCEPT when grouping (byPC[] needs every event) or in
            // series mode (the curve needs every point before its own downsample).
            if (!outputPath && !byPc && !seriesMap && truncated) break outer;
          }
        }
      }
      pressDriver.finish();   // release any still-held buttons

      // Build the grouped-by-PC summary (sorted by hit count, descending).
      const byPCSummary = byPc
        ? Array.from(byPc.values())
            .sort((a, b) => b.hits - a.hits)
            .map((g) => ({ pc: g.pc, hits: g.hits, firstFrame: g.firstFrame, lastFrame: g.lastFrame, offsets: Array.from(g.offsets) }))
        : undefined;

      const base = {
        framesStepped: stoppedEarly ? undefined : frames,
        watched: watchRanges,
        onChange,
        valueFilter: valueFilter ?? null,
        eventCount: totalMatched,
        ...(byPCSummary ? { byPC: byPCSummary, distinctPCs: byPCSummary.length } : {}),
        // When the caller scheduled input, ALWAYS report what landed — so a
        // press that never registered is visible, not a silent eventCount:0.
        ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
        ...(cheatLabelInfo ? { cheatLabels: cheatLabelInfo } : {}),
        stoppedEarly,
        truncated,
        note: totalMatched === 0
          ? "No matching changes in the watched window. Try (a) onChange:'any' to confirm the byte moves at all, (b) longer `frames`, (c) `pressDuring` to drive the game past the event, (d) a different region/offset. If the byte never moves even with onChange:'any', this region may be REBUILT as a block (sprite/OAM shadow, display list, VRAM) rather than written in place — watch the SOURCE struct the copy/DMA reads from instead (find it with memory({op:'search'}))."
          : (tryGetPC(host) == null ? "PC not available for this platform (getCPUState returned no pc field)." : undefined),
      };

      if (outputPath) {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, fileLines.length ? fileLines.join("\n") + "\n" : "");
        return jsonContent({
          ...base,
          path: outputPath,
          format: "ndjson",
          previewCount: preview.length,
          preview,
          previewNote: truncated
            ? `Inline preview capped at ${maxEvents} of ${totalMatched} events; the COMPLETE log is in the file.`
            : "All events fit inline AND are in the file.",
        });
      }

      // format:"series" — compact columnar value-vs-frame curve per offset.
      // maxEvents caps SAMPLES PER OFFSET by DOWNSAMPLING (evenly-spaced subset
      // that always keeps the first and last point) rather than truncating, so
      // the curve spans the whole window in one call.
      if (seriesMap) {
        let anyDownsampled = false;
        const series = Array.from(seriesMap.values()).map((s) => {
          const total = s.frames.length;
          let { frames: fr, values: va } = s;
          if (total > maxEvents) {
            anyDownsampled = true;
            fr = downsample(fr, maxEvents);
            va = downsample(va, maxEvents);
          }
          return {
            offset: s.offset, offsetHex: s.offsetHex, region: s.region,
            ...(s.label != null ? { label: s.label } : {}),
            points: fr.length, totalChanges: total,
            ...(total > maxEvents ? { downsampledFrom: total } : {}),
            frames: fr, values: va,
          };
        });
        return jsonContent({
          ...base,
          format: "series",
          ...(sampleEvery > 1 ? { sampleEvery } : {}),
          series,
          ...(anyDownsampled
            ? { seriesNote: `One or more offsets had >maxEvents (${maxEvents}) changes and were DOWNSAMPLED to an evenly-spaced subset spanning the full window (first+last kept). Raise maxEvents or lower sampleEvery for more resolution; use outputPath for every raw delta.` }
            : {}),
        });
      }

      return jsonContent({ ...base, events: preview, ...(sampleEvery > 1 ? { sampleEvery } : {}) });
  }

  // breakpoint({on:write|read|pc}) STOP-on-first. on:write precision:exact=bpFindWriter
  // (core watchpoint, true PC under IRQ), precision:sampled=bpRunUntilWrite (frame PC).
  async function bpFindWriter({ address, maxFrames = 600, pressDuring, settleFrames = 0, abortIf, condition, conditionValue, conditionWidth }) {
      const host = getHost(sessionKey);
      if (!host.watchpointSupported || !host.watchpointSupported()) {
        return jsonContent({
          found: false, notSupported: true, address: "$" + address.toString(16).toUpperCase(),
          note: "This core build has no instruction-level write watchpoint (shipped on all 14 platforms — update the core package if you see this; only PC Engine lacked it before 0.6.0). " +
            "Use watchMemory/runUntilWrite here — their pc is frame-sampled, so cross-check the value trace.",
        });
      }
      if (condition === "equals" && conditionValue == null) {
        throw new Error("breakpoint({on:'write', condition:'equals'}): `conditionValue` (the value to stop on) is required.");
      }
      // 16-BIT condition (v0.94.0 feedback): on 65816/68k the interesting state
      // is often a word written by one store. Explicit conditionWidth:16, or
      // inferred when conditionValue > 255 (a byte condition can't mean that).
      let width = conditionWidth ?? ((condition === "equals" && conditionValue != null && conditionValue > 0xFF) ? 16 : 8);
      if (width === 16 && condition == null) {
        throw new Error("breakpoint({on:'write', conditionWidth:16}): a 16-bit width needs a `condition` ('equals'|'increase'|'decrease').");
      }
      if (condition === "equals" && conditionValue != null && conditionValue > (width === 16 ? 0xFFFF : 0xFF)) {
        throw new Error(`breakpoint({on:'write', condition:'equals'}): conditionValue 0x${conditionValue.toString(16)} exceeds the ${width}-bit range.`);
      }
      // Best-effort CPU-address → work-RAM byte read for the host-side word
      // checks (same platform mapping backtraceForHit uses; SNES adds the
      // bank-$7E direct window; GBA maps EWRAM/IWRAM by address range).
      // Returns null when unmappable — the 16-bit paths then degrade
      // gracefully (documented in the result note).
      const platform0 = host.status?.platform;
      const readRamByteAt = (cpuAddr) => {
        try {
          let region = "system_ram";
          let off;
          if (platform0 === "snes") {
            if (cpuAddr >= 0x7E0000 && cpuAddr <= 0x7FFFFF) off = cpuAddr - 0x7E0000;
            else if ((cpuAddr & 0xFFFF) < 0x2000) off = cpuAddr & 0x1FFF;
            else return null;
          } else if (platform0 === "gb" || platform0 === "gbc" || platform0 === "sms" || platform0 === "gg" || platform0 === "msx") {
            off = cpuAddr & 0x1FFF;
          } else if (platform0 === "gba") {
            if (cpuAddr >= 0x02000000 && cpuAddr < 0x02040000) { off = cpuAddr - 0x02000000; }
            else if (cpuAddr >= 0x03000000 && cpuAddr < 0x03008000) { region = "iwram"; off = cpuAddr & 0x7FFF; }
            else return null;
          } else {
            off = cpuAddr & 0xFFFF;
          }
          const b = host.readMemory(region, off, 1);
          return b && b.length ? b[0] : null;
        } catch { return null; }
      };
      // Word ORDER follows the platform CPU: 68k (Genesis) words are
      // BIG-endian — the HIGH byte lives at `address`, not address+1. The
      // 6502/65816/Z80/SM83/ARM families are little-endian.
      const bigEndian0 = platform0 === "genesis";
      const readRamWordAt = (cpuAddr) => {
        const b0 = readRamByteAt(cpuAddr), b1 = readRamByteAt(cpuAddr + 1);
        if (b0 == null || b1 == null) return null;
        return bigEndian0 ? ((b0 << 8) | b1) : (b0 | (b1 << 8));
      };
      // Pass the condition to the core's watchpoint so its hook only COUNTS +
      // records writes that satisfy it (qualifying writes), ignoring restoring/
      // churn writes — and so the reported PC is a meaningful write, not just the
      // last write of the frame. Core support is feature-detected; if the loaded
      // core build predates condition support, we fall back to a host-side
      // 'equals' filter on the reported value (inc/dec need the core's old byte).
      const presses0 = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      // Flush a prior run's held input BEFORE arming, so a back-to-back driven run
      // starts from a neutral pad (see settleHeldInput / 213831 #1).
      settleHeldInput(host, settleFrames, presses0.length > 0);
      const wantCond = condition != null;
      // width 16, equals: the core hook compares ONE byte, so arm it on the HIGH
      // byte (address+1) with the value's high byte — a 16-bit store writes low
      // then high, and watching the LOW byte of a constant like $2000 is useless
      // ($00 matches everything). The low byte is then verified host-side.
      // width 16, increase/decrease: a byte-level delta lies about a word counter
      // (the carry), so arm an UNCONDITIONED watch for the writer PC and do the
      // word compare host-side each frame.
      const wide = width === 16;
      const wideEquals = wide && condition === "equals";
      const wideDelta = wide && (condition === "increase" || condition === "decrease");
      // The byte holding the word's HIGH half: address+1 on little-endian
      // families, address itself on big-endian (Genesis 68k).
      const hiByteAddr = bigEndian0 ? address : address + 1;
      const loByteAddr = bigEndian0 ? address + 1 : address;
      const watchAddr = wideEquals ? hiByteAddr : address;
      const coreCondSpec = wideEquals ? { condition: "equals", value: (conditionValue >> 8) & 0xFF }
        : wideDelta ? undefined
        : (wantCond ? { condition, value: conditionValue } : undefined);
      // SNES WRAM low-mirror transparency: the host canonicalizes the armed
      // address ($0218 → $7E0218) so any addressing form the writer uses is
      // caught; echo it so the agent sees which byte is really armed.
      const canonAddr = host._canonWatchAddress ? host._canonWatchAddress(watchAddr) : watchAddr;
      const coreCond = host.setWatchpoint(watchAddr, true, coreCondSpec);
      const coreHandledCond = !!coreCondSpec && coreCond && coreCond.conditionApplied === true;
      let prevWord = wideDelta ? readRamWordAt(address) : null;
      let wordAtHit = null, wordBeforeHit = null, lowByteVerified = null;
      const presses = presses0;
      const pressDriver = makePressDriver(host, presses);
      // Abort-guard: sample caller-named "still valid?" bytes each frame; if any
      // changes, a driven run that DERAILED (player died → title screen, scene
      // flipped, …) stops immediately instead of burning all maxFrames and
      // returning a meaningless found:false. (v0.15.0 feedback #2.)
      const guard = makeAbortGuard(host, abortIf);
      let result = null;
      let aborted = null;
      for (let i = 0; i < maxFrames; i++) {
        pressDriver.applyForFrame(i);
        host.stepFrames(1);
        const w = host.getWatchpoint(wideDelta); // wideDelta: clear per frame (plain watch counts churn)
        if (w.hits > 0) {
          if (wideDelta) {
            // 16-bit increase/decrease: word compare host-side. The core watch
            // (low byte, unconditioned) only tells us SOMETHING wrote the counter
            // this frame + the writer PC; the word delta decides if it counts.
            const word = readRamWordAt(address);
            if (word == null) {
              // Unmappable address → cannot do the word compare; fail loudly
              // rather than silently reporting byte-delta lies.
              host.setWatchpoint(watchAddr, false);
              pressDriver.finish();
              return jsonContent({
                found: false, address: "$" + address.toString(16).toUpperCase(),
                note: "conditionWidth:16 with 'increase'/'decrease' needs a host-readable work-RAM address for the word compare, and this address didn't map to system_ram on this platform. Use the 8-bit condition on the byte that actually changes, or watch with condition:'equals' width 16.",
              });
            }
            const moved = prevWord != null && (condition === "increase" ? word > prevWord : word < prevWord);
            if (!moved) { prevWord = word; continue; }
            wordBeforeHit = prevWord; wordAtHit = word;
            result = { ...w, framesStepped: i + 1 }; break;
          }
          // Host-side fallback for condition:'equals' on a core that didn't
          // apply the condition itself: only accept when the reported (last)
          // written value equals the target; otherwise keep waiting. (inc/dec
          // can't be faked host-side — they need the core's pre-write byte, so
          // we only reach here for them when the core DID handle the condition.)
          const eqTarget = wideEquals ? (conditionValue >> 8) & 0xFF : (conditionValue ?? 0) & 0xFF;
          if (wantCond && !coreHandledCond && condition === "equals" && (w.lastValue & 0xFF) !== eqTarget) {
            continue;
          }
          if (wideEquals) {
            // High byte matched in the core — verify the LOW byte host-side so
            // the WORD really equals the target (a $20xx write with the wrong
            // low byte keeps waiting). Unmappable low byte → accept + flag.
            const lo = readRamByteAt(loByteAddr);
            if (lo != null && lo !== (conditionValue & 0xFF)) continue;
            lowByteVerified = lo != null;
            wordAtHit = lo != null ? ((w.lastValue & 0xFF) << 8) | lo : null;
          }
          result = { ...w, framesStepped: i + 1 }; break;
        }
        const ab = guard.check();
        if (ab) { aborted = { ...ab, framesStepped: i + 1 }; break; }
      }
      pressDriver.finish();
      host.setWatchpoint(watchAddr, false); // disarm
      if (aborted) {
        return jsonContent({
          found: false, aborted: true, abortedBy: aborted.label,
          abortAddress: aborted.addr, before: aborted.before, after: aborted.after,
          framesStepped: aborted.framesStepped,
          ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
          note: `Run aborted early: the watched abort byte ${aborted.label} (${aborted.addr}) changed ` +
            `${aborted.before}→${aborted.after} at frame ${aborted.framesStepped}, so the driven scenario left the ` +
            `expected state (e.g. player died / scene changed) before the write fired. The found:false is NOT a real ` +
            `miss — fix the input plan or pick a different start state, then re-run.`,
        });
      }
      if (!result) {
        return jsonContent({
          found: false, address: "$" + address.toString(16).toUpperCase(),
          ...(canonAddr !== watchAddr ? { armedAddress: "$" + canonAddr.toString(16).toUpperCase() + " (WRAM low mirror canonicalized — a $7Exxxx-form writer would have been caught too)" } : {}),
          framesStepped: maxFrames,
          ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
          ...(abortIf && abortIf.length ? { abortIfArmed: guard.count } : {}),
          // One-line hint by default; the full "two reasons" explainer is verbose
          // boilerplate as a repeated payload (v0.15.0 feedback #2b) — gated to the
          // FIRST miss per session.
          note: noHitNote(sessionKey),
        });
      }
      // When the core reports a PRG-ROM offset for the PC (fceumm/NES), it
      // disambiguates the BANK — turn it into the iNES bank index + the prg.bin
      // offset so disassembleRom can target the exact bank, no $FF-padding from
      // the wrong (fixed) bank on a banked mapper.
      const prgOffset = result.prgOffset;
      const bankInfo = (prgOffset != null)
        ? { prgOffset: "0x" + prgOffset.toString(16).toUpperCase(), bank: Math.floor(prgOffset / 0x4000) }
        : null;
      // The core snapshots the FULL register file inside the write hook (kind 3,
      // all 14 platforms) — the break-instant truth; the live regs keep moving
      // after the hit.
      const wpSnap = host.getRegSnapshot ? host.getRegSnapshot(true) : null;
      const wpRegs = (wpSnap && wpSnap.kind === 3) ? wpSnap.named : null;
      return attachObserverFrame(jsonContent({
        found: true,
        address: "$" + address.toString(16).toUpperCase(),
        ...(canonAddr !== watchAddr ? { armedAddress: "$" + canonAddr.toString(16).toUpperCase() + " (WRAM low mirror canonicalized — all addressing forms of this byte are caught)" } : {}),
        pc: result.lastPC != null ? "$" + result.lastPC.toString(16).toUpperCase() : null,
        pcRaw: result.lastPC,
        // valueByte, not value: this is the ONE BYTE that landed on the watched
        // address — a word/long store shows only its byte here, not the operand
        // (a real session read 0x00 as "the move.l wrote zero").
        valueByte: "0x" + result.lastValue.toString(16).toUpperCase().padStart(2, "0"),
        ...(result.lastOldValue != null ? { oldValueByte: "0x" + (result.lastOldValue & 0xFF).toString(16).toUpperCase().padStart(2, "0") } : {}),
        ...(condition ? { condition, ...(coreHandledCond ? {} : { conditionAppliedBy: "host" }) } : {}),
        ...(wide ? { conditionWidth: 16 } : {}),
        ...(wideEquals ? { watchedByte: "$" + watchAddr.toString(16).toUpperCase() + " (word's high byte, " + (bigEndian0 ? "big" : "little") + "-endian)" } : {}),
        ...(wordAtHit != null ? { valueWord: "0x" + wordAtHit.toString(16).toUpperCase().padStart(4, "0") } : {}),
        ...(wordBeforeHit != null ? { oldValueWord: "0x" + wordBeforeHit.toString(16).toUpperCase().padStart(4, "0") } : {}),
        ...(wideEquals && lowByteVerified === false ? { lowByteVerified: false } : {}),
        hits: result.hits,
        framesStepped: result.framesStepped,
        ...(wpRegs ? { registersAtHit: wpRegs } : {}),
        ...((() => { const bt = backtraceForHit(host, wpRegs); return bt ? { callStack: bt } : {}; })()),
        ...(bankInfo ? bankInfo : {}),
        ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
        note: "pc is the EXACT writing instruction (captured in the CPU write path), not a frame sample. " +
          (wideEquals ? `conditionWidth:16 — the core watch sat on the word's HIGH byte ($${watchAddr.toString(16).toUpperCase()}, ${bigEndian0 ? "big" : "little"}-endian layout) for 0x${((conditionValue >> 8) & 0xFF).toString(16).padStart(2, "0")}, and the low byte was ${lowByteVerified === false ? "NOT host-verifiable at this address (accepted on the high byte alone)" : "verified host-side"} — so the hit means the WORD became 0x${conditionValue.toString(16).toUpperCase().padStart(4, "0")}. ` : "") +
          (wideDelta ? `conditionWidth:16 — the word at $${address.toString(16).toUpperCase()}/+1 (${bigEndian0 ? "big" : "little"}-endian) ${condition}d ${wordBeforeHit != null ? "0x" + wordBeforeHit.toString(16).toUpperCase().padStart(4, "0") + "→0x" + wordAtHit.toString(16).toUpperCase().padStart(4, "0") : ""} (host-side word compare; the pc is the frame's writer of the watched first byte). A write that only touches the OTHER byte won't trip the watch — rare for real 16-bit stores, which write both. ` : "") +
          (condition
            ? `condition:'${condition}' filtered to the MEANINGFUL write — pc/valueByte/hits reflect only qualifying writes${result.lastOldValue != null ? ` (oldValueByte→valueByte = ${"0x" + (result.lastOldValue & 0xFF).toString(16)}→${"0x" + result.lastValue.toString(16)})` : ""}. `
            : "Without a `condition`, on:'write' runs to END OF FRAME and reports the LAST matching write of the frame (NOT the first) — `hits` is the count of all matching writes that frame. If a restoring/churn write hides the change you want, pass condition:'increase'|'decrease'|'equals'. ") +
          "valueByte is the single byte written to the watched address (a 16/32-bit store shows only its byte here). " +
          "hits counts watched-byte writes during the hit frame — the same instruction looping twice in one frame is hits:2, one event. " +
          (wpRegs ? "registersAtHit is the register file frozen AT the write (the live regs drift for the rest of the frame — don't cpu({op:'read'}) instead). " : "") +
          (bankInfo
            ? `pc is in PRG bank ${bankInfo.bank} (prg offset ${bankInfo.prgOffset}) — disassembleRom({ startAddress: ${result.lastPC != null ? "0x" + result.lastPC.toString(16) : "pc"}, bank: ${bankInfo.bank} }) targets the exact bank (no fixed-bank $FF padding).`
            : `disassembleRom({ startAddress: ${result.lastPC != null ? "0x" + result.lastPC.toString(16) : "pc"} }) to see it. On a banked mapper a $8000-$BFFF pc may be in a switchable bank — pass the right \`bank\`.`),
      }), host);
  }

  async function bpRunUntilWrite({ region, offset, length = 1, maxFrames = 600, pressDuring }) {
      const host = getHost(sessionKey);
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      let prev = snap(host, region, offset, length);
      const startFrame = host.status.frameCount;

      for (let i = 0; i < maxFrames; i++) {
        // Hold scheduled input via setInput before stepping (loop owns stepFrames).
        pressDriver.applyForFrame(i);
        host.stepFrames(1);
        const cur = snap(host, region, offset, length);
        const changes = diffSnapshots(prev, cur, offset);
        if (changes.length > 0) {
          const pc = tryGetPC(host);
          const frameAbs = startFrame + i + 1;
          pressDriver.finish();
          return attachObserverFrame(jsonContent({
            written: true,
            frame: frameAbs,
            frameRelative: i + 1,
            changes,
            ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
            pc: hexPC(pc),
            pcRaw: pc,
            // NOTE: this PC is sampled at the frame boundary AFTER the write, not
            // captured at the writing instruction. For NMI/IRQ-driven writes
            // (the common case on NES/GB) it is usually the interrupted
            // main-thread PC (often an idle loop), NOT the writer. Treat it as a
            // lead, and confirm against the value trace / a manual disasm.
            pcCaveat: "pc is a frame-boundary sample, not the writing instruction; for ISR-driven writes it is typically the interrupted main-thread PC (e.g. an idle loop), not the code that wrote the byte.",
            hint: pc != null
              ? `disassembleRom near ${hexPC(pc)} is a STARTING point — but if this ROM writes from an NMI/IRQ handler, ${hexPC(pc)} is likely the interrupted idle loop, not the writer. Cross-check with the value trace.`
              : "PC was not available — check that getCPUState is wired for this platform.",
          }), host);
        }
        prev = cur;
      }
      pressDriver.finish();
      return jsonContent({
        written: false,
        framesStepped: maxFrames,
        ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
        note: "Target byte was not written within maxFrames. Try increasing maxFrames or driving the game with pressDuring.",
      });
  }

  async function bpRunUntilPC({ address, maxFrames = 600, pressDuring, settleFrames = 0, captureMemory }) {
      const host = getHost(sessionKey);
      if (!host.pcBreakSupported || !host.pcBreakSupported()) {
        return jsonContent({
          hit: false, notSupported: true, address: "$" + address.toString(16).toUpperCase(),
          note: "This core build has no PC breakpoint (shipped on all 14 platforms as of 0.5.0 — update the core package if you see this). " +
            "Interim: use runUntilWrite/findWriter to anchor on a write, or stepFrames + getCPUState sampling.",
        });
      }
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      // Flush a prior run's held-button shadow BEFORE arming (so the settle frames
      // don't trip the breakpoint) — prevents a back-to-back negative control from
      // false-positiving on frame 0. See settleHeldInput.
      settleHeldInput(host, settleFrames, presses.length > 0);
      const pressDriver = makePressDriver(host, presses);
      host.setPCBreak(address, true, false);
      let hit = false, framesRun = 0, last = null;
      try {
        for (let i = 0; i < maxFrames; i++) {
          pressDriver.applyForFrame(i);
          host.stepFrames(1);
          framesRun++;
          const st = host.getPCBreak(false);
          if (st.hit) { hit = true; last = st; break; }
        }
      } finally {
        pressDriver.finish();
        host.setPCBreak(0, false, false); // disarm
      }
      if (!hit) {
        // Diagnostics on a miss (0.27.0 feedback #8): a bare "drive it with
        // pressDuring" is useless when the caller DID supply input. Report
        // where the CPU actually is, and tailor the advice.
        const pcNow = tryGetPC(host);
        const drove = presses.length > 0;
        // The frame-boundary pcNow almost always lands on the NMI/idle handler,
        // which says nothing about where the main thread was. Single-step across
        // ~a frame and report the modal (busiest) PC as mainThreadPc — the main
        // loop dominates the histogram while the interrupt handler is a blip.
        // Save-state-wrapped, so it has ZERO side effects (state is restored).
        const mt = sampleMainThreadPc(host);
        return attachObserverFrame(jsonContent({
          hit: false, address: "$" + address.toString(16).toUpperCase(), framesRun,
          ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
          ...(pcNow != null ? { pcNow: "$" + pcNow.toString(16).toUpperCase() } : {}),
          ...(mt ? {
            mainThreadPc: "$" + mt.modalPc.toString(16).toUpperCase(),
            pcHistogram: mt.top.map((e) => ({ pc: "$" + e.pc.toString(16).toUpperCase(), hits: e.hits })),
          } : {}),
          note: (drove
            ? "PC never reached that address within maxFrames EVEN WITH the scheduled input. Either (a) this is " +
              "the WRONG ADDRESS for the path that actually ran (a different routine handles it), (b) the address " +
              "isn't an instruction boundary (mid-instruction never matches REG_PC), OR (c) the condition " +
              "LEGITIMATELY did not occur — i.e. this hit:false is the DESIRED result of a negative control " +
              "(you're proving input X does NOT reach this branch; e.g. an A-vs-B discriminator where only the " +
              "other button should hit). If you confirmed the address is reachable on the positive run, (c) is " +
              "the expected outcome, not a failure. "
            : "PC never reached that address within maxFrames. Either the code path didn't execute (drive " +
              "it with pressDuring to reach the right game state), or the address isn't an instruction " +
              "boundary (mid-instruction never matches REG_PC). ") +
            (mt ? "mainThreadPc is the BUSIEST PC over ~a frame of single-stepping (the main loop), not the " +
                  "frame-boundary idle/NMI snapshot in pcNow; pcHistogram shows the top PCs by hit count. " +
                  "(Sampling is save-state-wrapped — no side effects; the emulator is back where it was.) "
                : (pcNow != null ? "pcNow is the frame-boundary PC (usually the idle loop). " : "")) +
            "To find which code DID run, coverage-trace the suspect range: watch({on:'pc', start, end, frames}) " +
            "returns every distinct PC executed there; or anchor on a RAM effect with breakpoint({on:'write'}).",
        }), host);
      }
      // Snapshot the registers AT the hit BEFORE clearing (last already holds the
      // hit state; read it without clearing so registersAtHit survives). Two
      // snapshot transports: the fceumm-style inline pcbreak slots (A/X/Y/P/S)
      // and the gpgx regsnap export (full m68k/z80 file — kind 1=pc-break,
      // 2=watchdog).
      const snapAtHit = host.getRegSnapshot ? host.getRegSnapshot(false) : null;
      const atHit = last.registersAtHit
        ?? host.getPCBreak(false).registersAtHit
        ?? ((snapAtHit && (snapAtHit.kind === 1 || snapAtHit.kind === 2)) ? snapAtHit.named : null);
      // captureMemory: read the requested regions AT the hit (before we clear/step),
      // returned inline so break→read RAM collapses into ONE call. NOTE: registers
      // are the true break instant (core snapshot); these RAM reads are taken now —
      // i.e. after the hit frame finished — so on run-to-frame-end cores (fceumm)
      // they reflect the routine's RAM SIDE EFFECTS for that frame (which is what
      // RE wants: "what did this routine touch"), not necessarily the exact byte
      // mid-instruction. Stable + reliable; that's the property the report leaned on.
      let capturedMemory = null;
      if (Array.isArray(captureMemory) && captureMemory.length) {
        capturedMemory = {};
        for (const m of captureMemory) {
          const label = m.label ?? `${m.region}+${m.offset}`;
          try {
            const bytes = host.readMemory(m.region, m.offset, m.length ?? 1);
            capturedMemory[label] = {
              region: m.region, offset: m.offset, length: m.length ?? 1,
              hex: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
            };
          } catch (e) {
            capturedMemory[label] = { region: m.region, offset: m.offset, error: String(e?.message ?? e) };
          }
        }
      }
      const fin = host.getPCBreak(true); // clear hit
      // registersAtHit (NES/fceumm and any core that snapshots regs on hit) is the
      // RELIABLE break-instant register file. The LIVE register file (a follow-up
      // cpu({op:'read'})) is NOT reliable on fceumm: the core drains the cycle
      // budget on hit but retro_run still finishes the frame, so the live regs are
      // end-of-frame state. Prefer registersAtHit; only fall back to a live read on
      // cores that don't snapshot.
      // Terse per-hit note — the full explanation lives in the breakpoint tool
      // description (loaded once), so a hit doesn't re-charge ~600 chars of
      // boilerplate every time (field report: this repeated on all 3 pc-breaks).
      const frozenNote = atHit
        ? "Use registersAtHit (not a follow-up cpu read — that's end-of-frame). captureMemory:[…] reads RAM at the hit inline."
        : "No hit-snapshot on this core: prefer memory({op:'read'}) side effects; a live cpu read is end-of-frame on run-to-end cores (fceumm).";
      if (host.getRegSnapshot) host.getRegSnapshot(true); // consume the snapshot so a later bp can't read a stale one
      return attachObserverFrame(jsonContent({
        hit: true,
        address: "$" + address.toString(16).toUpperCase(),
        pc: last.lastPC != null ? "$" + last.lastPC.toString(16).toUpperCase() : null,
        pcRaw: last.lastPC,
        ...(atHit ? { registersAtHit: atHit } : {}),
        ...((() => { const bt = backtraceForHit(host, atHit); return bt ? { callStack: bt } : {}; })()),
        ...(capturedMemory ? { capturedMemory } : {}),
        frame: host.status.frameCount,
        framesRun,
        // The core's hits counter doesn't tick on a watchdog stop — normalize so
        // hit:true never reports hits:0 (a real session read that as contradictory).
        hits: fin.hits || 1,
        ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
        note: frozenNote,
      }), host);
  }

  // A4: Computed-jumptable recovery via the LIVE emulator. Static analysis follows
  // direct addressing only, so a `JMP (table,X)` / RTS-trick dispatcher collapses
  // to "Could not recover jumptable" — and those dispatchers (game-state machines,
  // script/event VMs, battle engines) are the routines you most want to read. We
  // resolve them dynamically: break at the dispatcher, single-step THROUGH the
  // indirect transfer, and record the PC it actually lands on. Run across many
  // frames/inputs to accumulate the distinct target set — the real switch arms.
  //
  // No standalone tool (IDA/Ghidra/Binary Ninja) can do this: they have no live
  // emulator to observe the computed target. The observed set can be fed back as
  // analysis hints (Rizin ahi/aho) so `decompile`/`cfg` recover the switch.
  async function bpResolveJumptable({ address, maxFrames = 1200, maxTargets = 64, stepLimit = 48, jumpThreshold = 5, pressDuring, fromState, fromStatePath }) {
      const host = getHost(sessionKey);
      if (!host.pcBreakSupported || !host.pcBreakSupported()) {
        return jsonContent({
          ok: false, notSupported: true, address: "$" + address.toString(16).toUpperCase(),
          note: "This core build has no PC breakpoint / single-step (shipped on all 14 platforms as of 0.5.0 — update the core package if you see this).",
        });
      }
      const restored = await maybeRestoreState(host, fromState, fromStatePath);
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);

      // We separate COMPUTED targets from FIXED trampolines by what VARIES. As we
      // single-step out of the dispatcher, normal flow is sequential (next PC =
      // prev + 1..4 on a 6502, wider on ARM); a computed JMP (table,X) / RTS-trick
      // makes the PC LEAP (delta > jumpThreshold or backward). But a real dispatch
      // path contains FIXED leaps too — cc65 lowers an indirect call to
      // JSR<callax>; JMP(ptr), so the trampoline addresses leap identically on
      // every hit. The handler ARM is the leap destination that DIFFERS hit-to-
      // hit. So: per hit, collect the set of leap destinations; across all hits,
      // a destination seen on EVERY hit is a fixed trampoline (drop it), and one
      // seen on only SOME hits is a real computed arm (keep it). leapSeen counts
      // how many hits each destination appeared in; perHitLeaps holds the firstFrame
      // + a sample fromPC for the keepers.
      const leapSeen = new Map();   // destPC -> hitCount
      const leapMeta = new Map();   // destPC -> { firstFrame, fromPC }
      let dispatcherHits = 0, framesRun = 0;

      try {
        for (let i = 0; i < maxFrames && leapMeta.size < maxTargets * 4; i++) {
          pressDriver.applyForFrame(i);
          host.setPCBreak(address, true, false);
          host.stepFrames(1);
          framesRun++;
          let st = host.getPCBreak(false);
          if (!st.hit) { host.setPCBreak(0, false, false); continue; }

          const fromPC = st.lastPC ?? address;
          host.getPCBreak(true); // clear the hit so the next arm is clean
          // Walk forward; collect the destination of EVERY control-flow leap in
          // this hit (deduped within the hit), plus the PC it leapt FROM.
          const seenThisHit = new Set();
          let prev = fromPC, prevLeapFrom = fromPC;
          for (let s = 0; s < stepLimit; s++) {
            const step = host.stepInstruction(); // { pc } AFTER one instr
            const pc = step.pc;
            if (pc == null) break;
            const delta = pc - prev;
            if (delta < 0 || delta > jumpThreshold) {
              if (!seenThisHit.has(pc)) {
                seenThisHit.add(pc);
                if (!leapMeta.has(pc)) leapMeta.set(pc, { firstFrame: framesRun, fromPC: prevLeapFrom });
              }
              prevLeapFrom = prev;
            }
            prev = pc;
          }
          for (const pc of seenThisHit) leapSeen.set(pc, (leapSeen.get(pc) ?? 0) + 1);
          dispatcherHits++;
        }
      } finally {
        pressDriver.finish();
        host.setPCBreak(0, false, false); // disarm
        if (host.getRegSnapshot) host.getRegSnapshot(true); // consume any stale snapshot
      }

      const hx = (v) => "$" + (v >>> 0).toString(16).toUpperCase();
      // Classify each leap destination. A COMPUTED arm VARIES across hits — it was
      // reached on some hits but not all (leapSeen < dispatcherHits). A FIXED
      // trampoline (cc65 callax, the post-handler return path) leaps identically
      // EVERY hit (leapSeen == dispatcherHits). Keep the variers as targets.
      const allLeaps = [...leapMeta.entries()].map(([pc, m]) => ({
        pc, hits: leapSeen.get(pc) ?? 0, firstFrame: m.firstFrame, fromPC: m.fromPC,
      }));
      let arms = allLeaps.filter((l) => l.hits < dispatcherHits);
      // Fallback: if NOTHING varied (the dispatcher only ever took one path under
      // this input — a single observed arm), report the non-trampoline leaps as
      // candidate targets rather than nothing. With only one hit, everything has
      // hits==1==dispatcherHits, so report all leaps as candidates.
      let singleArm = false;
      if (!arms.length && allLeaps.length) { arms = allLeaps; singleArm = true; }

      const sorted = arms
        .slice(0, maxTargets)
        .map((l) => ({ target: hx(l.pc), targetRaw: l.pc, hits: l.hits, firstFrame: l.firstFrame, fromPC: hx(l.fromPC) }))
        .sort((a, b) => b.hits - a.hits || a.targetRaw - b.targetRaw);

      if (!sorted.length) {
        const drove = presses.length > 0;
        return attachObserverFrame(jsonContent({
          ok: true, resolved: false,
          address: hx(address), framesRun, dispatcherHits,
          ...(restored ? { restoredFrom: restored } : {}),
          ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
          note: dispatcherHits === 0
            ? (drove
              ? "The dispatcher at this address never executed within maxFrames EVEN WITH the scheduled input — likely the WRONG address (a different routine dispatches), or not an instruction boundary. Confirm with breakpoint({on:'pc'}) that the PC reaches it at all."
              : "The dispatcher never executed — drive the game to the state that runs it (pressDuring / fromState), or increase maxFrames. Confirm reachability with breakpoint({on:'pc'}).")
            : "The dispatcher executed but no control-flow LEAP was observed in the next " + stepLimit + " instructions — so this address isn't (or isn't reaching) a computed jump. Confirm it's the indirect-jump instruction, or raise stepLimit if the dispatch does heavy setup first.",
        }), host);
      }

      return attachObserverFrame(jsonContent({
        ok: true, resolved: true,
        address: hx(address),
        targets: sorted,
        distinctTargets: sorted.length,
        dispatcherHits, framesRun,
        ...(singleArm ? { singleArmObserved: true } : {}),
        ...(arms.length > maxTargets ? { truncated: true, truncatedAt: maxTargets } : {}),
        ...(restored ? { restoredFrom: restored } : {}),
        ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
        note: (singleArm
            ? "Only ONE dispatch path ran under this input, so targets are the candidate leap destinations (couldn't separate the computed arm from fixed trampolines without a second arm to compare). Drive MORE game states (pressDuring / fromState) so the dispatcher takes different arms — then the varying one is isolated as the real target. "
            : "targets are the COMPUTED jump destinations that VARIED across dispatches — the real switch arms a static decompiler can't see (fixed trampolines were filtered out). ") +
          "Each is a routine the dispatcher branches to; decompile({address: target}) / disasm({target:'rom', startAddress: target}) to read them. " +
          "hits = how many dispatches took that arm under this input; drive more states to surface rarer arms. " +
          "This is the live-emulator advantage: no static-only tool can recover these.",
      }), host);
  }

  async function bpRunUntilRead({ address, maxFrames = 600, pressDuring }) {
      const host = getHost(sessionKey);
      if (!host.readWatchSupported || !host.readWatchSupported()) {
        return jsonContent({
          hit: false, notSupported: true, address: "$" + address.toString(16).toUpperCase(),
          note: "This core build has no read watchpoint (shipped on all 14 platforms as of 0.5.0 — update the core package if you see this).",
        });
      }
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      host.setReadWatch(address, true);
      let hit = false, framesRun = 0, last = null;
      try {
        for (let i = 0; i < maxFrames; i++) {
          pressDriver.applyForFrame(i);
          host.stepFrames(1);
          framesRun++;
          const st = host.getReadWatch(false);
          if (st.hits > 0) { hit = true; last = st; break; }
        }
      } finally {
        pressDriver.finish();
        host.setReadWatch(0, false);
      }
      if (!hit) {
        return jsonContent({
          hit: false, address: "$" + address.toString(16).toUpperCase(), framesRun,
          ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
          note: "Address was not read within maxFrames. Drive the game to the state that reads it (pressDuring), or increase maxFrames. If you're hunting the CONSUMER of a table/struct (any field of any record might be the one that's read), don't guess per-byte — watch({on:'range', kind:'read', start, end}) logs EVERY reading PC over the whole range in one call (distinctPCsOnly:true for just the digest).",
        });
      }
      const fin = host.getReadWatch(true);
      const rdSnap = host.getRegSnapshot ? host.getRegSnapshot(true) : null;
      const rdRegs = (rdSnap && rdSnap.kind === 4) ? rdSnap.named : null;
      return attachObserverFrame(jsonContent({
        hit: true,
        address: "$" + address.toString(16).toUpperCase(),
        pc: last.lastPC != null ? "$" + last.lastPC.toString(16).toUpperCase() : null,
        pcRaw: last.lastPC,
        valueByte: "0x" + (last.lastValue & 0xFF).toString(16).toUpperCase().padStart(2, "0"),
        frame: host.status.frameCount,
        framesRun,
        hits: fin.hits || 1,
        ...(rdRegs ? { registersAtHit: rdRegs } : {}),
        ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
        note: "pc is the EXACT instruction that read this address. disasm({ target:'rom', startAddress: pc }) to see it." +
          (rdRegs ? " registersAtHit is the register file frozen AT the read (the live regs drift for the rest of the frame)." : ""),
      }), host);
  }

  server.tool(
    "breakpoint",
    "STOP-on-first dynamic breakpoints — run until a condition hits, then stop. One tool keyed by `on`. (For LOG-ALL " +
    "coverage over many frames use `watch`; for a value-predicate closure use `runUntil`.)\n" +
    "• on:'write' — break when a CPU `address` is written. **`precision` is the key axis here:**\n" +
    "    – precision:'exact' (default) — arms a core-level WRITE WATCHPOINT and returns the writing instruction's PC " +
    "captured INSIDE the CPU write path — **correct even for NMI/IRQ-driven writes** (where a frame sample is just the idle loop). " +
    "The precise answer to 'which code wrote $XX?'. On banked NES mappers it also reports the prg bank.\n" +
    "    – precision:'sampled' — the cheap wrapper: steps until a memory `region`/`offset` byte changes and returns the PC " +
    "**sampled at the frame boundary**. **CAVEAT: that PC is NOT the writing instruction — under interrupts it's usually the " +
    "interrupted main-thread PC (an idle loop), a LIE. Use 'exact' when you need the real writer.**\n" +
    "• on:'read' — break when the CPU READS `address` (the read-side mirror of on:'write' exact): the EXACT instruction PC that " +
    "read the byte. Finds who CONSUMES a value. Does NOT freeze mid-frame — records the PC and finishes the frame.\n" +
    "• on:'pc' — break when the PC reaches `address` (a real execution breakpoint). " +
    "**The RE primitive for 'read the register at this instruction': break, then use the `registersAtHit` SNAPSHOT in the hit response** " +
    "(e.g. break at a decoder's load and read the index reg = the source offset). IMPORTANT: `registersAtHit` is the register file captured AT the break instant — " +
    "use it, NOT a follow-up cpu({op:'read'}). On some cores (notably NES/fceumm) the core drains the cycle budget on hit but the frame still finishes, " +
    "so a live cpu read afterward returns END-OF-FRAME registers, not the break instant. `registersAtHit` sidesteps that. The break PC is reported as `pc`/`pcRaw`; " +
    "the RAM side effects are also reliable via memory({op:'read'}). frame({op:'stepInstruction'}) to single-step from the break. (on:'read'/'write' finish the frame.)\n" +
    "• on:'jumptable' — **RESOLVE a computed-jump dispatcher the static decompiler can't follow.** Game-state machines, script/event VMs, and battle engines dispatch through `JMP (table,X)` / RTS-trick tables; `decompile`/`cfg` collapse them to `(*_IRQ)()` + 'Could not recover jumptable'. Break at the dispatcher `address`, single-step THROUGH the indirect transfer, and record the PC it lands on — repeated across frames/inputs to accumulate the DISTINCT target set (the real switch arms), ranked by hit count. Drive more game states (pressDuring / fromState) to surface rarer arms. Returns `{targets:[{target,hits,fromPC}], distinctTargets}`. **No static-only tool (IDA/Ghidra/Binary Ninja) can do this — it needs a live emulator in the loop, which is romdev's edge.** Feed the targets to decompile({address:target}) to read each arm.\n" +
    "All supported on every CPU core. **Every hit carries `registersAtHit` — the FULL register file frozen by the core AT the hit instant, on ALL 14 platforms and all three `on` kinds.** Use it instead of a follow-up cpu({op:'read'}): the live registers keep moving after a hit (per-scanline CPU scheduling / frame completion), so a post-hit read drifts — chasing pointer registers read that way burned a real session for hours. The hit `pc` is the EXECUTING instruction's first byte (mid-instruction hooks no longer report the operand-advanced PC). Out-of-date core packages return notSupported.\n" +
    "MENU-SCREEN INPUT TRICK: if a pressDuring schedule never registers (some menu screens poll input in a way scheduled taps miss), HOLD the button instead: input({op:'set', buttons:{...}}) BEFORE this call and OMIT pressDuring — the run inherits the held state, the menu sees the edge, and the breakpoint catches the event.",
    {
      on: z.enum(["write", "read", "pc", "jumptable"])
        .describe("write=break on a write to address (precision:exact=true writer PC / sampled=frame PC, a lie under IRQ); read=break on a read (exact PC, who consumes it); pc=break when PC reaches address — the hit returns `registersAtHit` (the break-instant register file, all 14 platforms) + the break PC; jumptable=RESOLVE a computed-jump dispatcher (JMP (tbl,X) / RTS-trick) by breaking at `address`, single-stepping THROUGH the indirect transfer, and recording every COMPUTED target PC live across frames/inputs — the switch arms a static decompiler reports as 'Could not recover jumptable'. (use registersAtHit, not a follow-up cpu read.)"),
      precision: z.enum(["exact", "sampled"]).default("exact")
        .describe("on:'write' ONLY. exact=core watchpoint, the real writing instruction PC even under interrupts (uses `address`). sampled=cheap frame-boundary PC (uses region/offset/length) — NOT the writer under IRQ. Ignored for on:read/pc (always exact)."),
      address: z.number().int().min(0).optional().describe("on:'write' exact / on:'read' / on:'pc' — CPU address to break on (write target, read target, or instruction boundary). Required for those."),
      region: regionStr("on:'write' precision:'sampled' — region whose byte to watch for change.").optional(),
      offset: z.number().int().min(0).optional().describe("on:'write' precision:'sampled' — offset within the region."),
      length: z.number().int().min(1).max(4096).default(1).describe("on:'write' precision:'sampled' — bytes to watch from offset."),
      condition: z.enum(["increase", "decrease", "equals"]).optional().describe("on:'write' precision:'exact' ONLY — stop only on the MEANINGFUL write, ignoring restoring/churn writes. 'decrease'/'increase' = the stored byte actually went down/up (e.g. a real lives−1, not a per-frame pointer-arithmetic restore); 'equals' = the byte became `value` (e.g. $00→$01 respawn re-arm). Without it, on:'write' reports the LAST matching write of the frame, which may be the churn, not the change you want."),
      conditionValue: z.number().int().min(0).max(65535).optional().describe("on:'write' condition:'equals' — the value to stop on (the NEW value written). > 255 implies conditionWidth:16."),
      conditionWidth: z.union([z.literal(8), z.literal(16)]).optional().describe("on:'write' precision:'exact' — condition width, default 8. 16 treats address/address+1 as one WORD in the platform CPU's byte order (little-endian on 6502/65816/Z80/SM83/ARM; BIG-endian on Genesis 68k): 'equals' arms the core watch on the word's HIGH byte (no useless $00-low-byte matches) + verifies the other byte host-side; 'increase'/'decrease' compare the word host-side so a 16-bit counter's carry can't lie. Inferred automatically when conditionValue > 255."),
      maxFrames: z.number().int().min(1).max(1_000_000).default(600).describe("Max frames to run while waiting for the condition."),
      pressDuring: z.array(z.object({
        frame: z.number().int().min(0),
        button: z.string(),
        port: z.number().int().min(0).max(3).default(0),
        holdFrames: z.number().int().min(1).default(2),
      })).optional().describe("Schedule input while waiting (drive the game to the state that triggers the condition). If OMITTED, this run inherits whatever input({op:'set'}) last held — same as frame({op:'step'}). If GIVEN, the schedule OWNS the pad for the whole run (a prior input({op:'set'}) is ignored); use it to drive the watched window itself. Entries with OVERLAPPING windows on the same port are OR'd into a chord (e.g. b+right held while a fires mid-window), not overwritten."),
      settleFrames: z.number().int().min(0).max(120).default(0).describe("on:'pc'/'write' with pressDuring — release the pad to NEUTRAL and step this many frames BEFORE the run, so the PRIOR run's held-button shadow (the game latches the pad into its own RAM each frame) doesn't bleed into this run's frame 0. Set ~10-30 for back-to-back A/B-discriminator / negative-control runs on the same live host (hold A to prove A does NOT reach a B-only branch) — without it the stale chord can false-positive on frame 1. No-op without pressDuring."),
      abortIf: z.array(z.object({
        region: regionStr("memory region (default system_ram)").optional(),
        offset: z.number().int().min(0).describe("byte offset within the region"),
        label: z.string().optional().describe("human name for this guard byte"),
      })).optional().describe("on:'write' exact — ABORT GUARD for a pressDuring run: caller-named 'is this scenario still valid?' bytes (e.g. the area/scene id, the player object-active flag). If ANY changes mid-run the watchpoint stops IMMEDIATELY and returns {aborted:true, abortedBy, before, after} — so a driven scenario that derailed (player died → title screen) doesn't burn all maxFrames and return a meaningless found:false. Each is sampled once per frame (cheap)."),
      captureMemory: z.array(z.object({
        region: regionStr("memory region to read"),
        offset: z.number().int().min(0).describe("byte offset within the region"),
        length: z.number().int().min(1).max(256).default(1).describe("bytes to read"),
        label: z.string().optional().describe("human name for this read (else 'region+offset')"),
      })).optional().describe("on:'pc' — read these memory regions AT the hit and return them inline as `capturedMemory` (collapses break→read-RAM into ONE call, the token win). Pair with `registersAtHit` to get the routine's register + RAM state in a single round trip (e.g. capture the ZP pointer bytes a decoder just wrote). NOTE: registersAtHit is the true break instant (core snapshot); these RAM reads are taken after the hit frame finishes, so on run-to-frame-end cores (fceumm) they're the routine's RAM side effects for that frame — stable + reliable, which is exactly what RE needs."),
      maxTargets: z.number().int().min(1).max(1024).default(64).describe("on:'jumptable' — stop once this many DISTINCT computed targets have been observed (the run also ends at maxFrames). Sets `truncated:true` if reached."),
      stepLimit: z.number().int().min(1).max(256).default(48).describe("on:'jumptable' — instructions to single-step after each dispatcher hit while collecting control-flow leaps. Must be deep enough to REACH the handler: a compiler-lowered indirect call (cc65 JSR<callax>; JMP(ptr)) runs the table load + trampoline + the indirect jump before the handler is entered — ~30 instructions here, so the default is 48. Too low and you only capture the fixed trampolines (the real arms never appear); raise it if a dispatch does heavy setup before the indirect jump."),
      jumpThreshold: z.number().int().min(1).max(64).default(5).describe("on:'jumptable' — a single-step whose PC delta exceeds this many bytes (or goes backward) counts as a control-flow LEAP (a taken jump/branch/call), vs sequential instruction flow. 5 suits 6502/Z80/SM83 (max ~3-byte instructions); raise for wider ISAs (ARM/m68k) so multi-byte sequential instructions aren't misread as leaps."),
      fromState: z.number().int().min(0).optional().describe("on:'jumptable'/'pc' (via the trace path) — restore this in-memory savestate SLOT before running, so the dispatcher is resolved from a known, repeatable moment (e.g. inside the battle/menu the dispatcher drives). Mutually exclusive with fromStatePath."),
      fromStatePath: z.string().optional().describe("on:'jumptable' — restore this savestate FILE before running (the disk equivalent of fromState). Mutually exclusive with fromState."),
    },
    safeTool(async (args) => {
      switch (args.on) {
        case "write": {
          if (args.precision === "sampled") {
            if (!args.region || args.offset == null) throw new Error("breakpoint({on:'write', precision:'sampled'}): `region` and `offset` are required.");
            return await bpRunUntilWrite(args);
          }
          if (args.address == null) throw new Error("breakpoint({on:'write', precision:'exact'}): `address` is required.");
          return await bpFindWriter(args);
        }
        case "read": {
          if (args.address == null) throw new Error("breakpoint({on:'read'}): `address` is required.");
          return await bpRunUntilRead(args);
        }
        case "pc": {
          if (args.address == null) throw new Error("breakpoint({on:'pc'}): `address` is required.");
          return await bpRunUntilPC(args);
        }
        case "jumptable": {
          if (args.address == null) throw new Error("breakpoint({on:'jumptable'}): `address` is required (the computed-jump dispatcher).");
          return await bpResolveJumptable(args);
        }
        default: throw new Error(`breakpoint: unknown on '${args.on}'`);
      }
    }),
  );

  // stepInstruction folded into frame({op:'stepInstruction'}) (frame.js, which
  // imports stepInstructionCore). Nothing registered here.

  // ── register write/read + callSubroutine / decompressWith (item 1) ──────────
  // reg-id convention (m68k family): 0..7=D0..D7, 8..15=A0..A7, 16=PC, 17=SR, 18=SP.

  // cpu({op:read|setReg|call|decompress}) router. op:read -> getCPUStateCore
  // (platform-tools.js). The other 3 are closure impls below (they need the
  // per-session host). regSchema is shared by the call op.
  const regSchema = z.record(z.string(), z.number().int()).optional().describe(
    "op:call — registers to set before the call, keyed by register NAME (preferred) or raw reg-id. " +
    "Names are per-CPU: 6502/65C02 = a,x,y,p,sp; 65816 (SNES) = a,x,y,p,s,db,d(=dp); m68k (Genesis) = raw ids. " +
    "e.g. {\"a\":848} presets the 65816 accumulator. Raw ids still work (m68k: 0-7=D0-D7, 8-15=A0-A7, 16=PC, 17=SR, 18=SP). " +
    "An unknown name errors with the valid list. PC is set from the `pc` arg, not here.");

  async function cpuSetReg({ regId, value }) {
      const host = getHost(sessionKey);
      if (!host.setRegSupported || !host.setRegSupported()) {
        return jsonContent({ notSupported: true, note: "This core build has no register-write (shipped on all 14 platforms as of 0.6.0 — update the core package if you see this)." });
      }
      host.setReg(regId, value >>> 0);
      const now = host.getReg(regId);
      return jsonContent({ regId, value: "0x" + (now >>> 0).toString(16).toUpperCase(), valueRaw: now });
  }

  async function cpuCall({ pc, regs, sentinelPC = 0, stopAtPC, presetMemory, maxFrames = 600, maxInstructions, sandbox = false, pure = false, callMode }) {
      const host = getHost(sessionKey);
      if (!host.setRegSupported || !host.setRegSupported()) {
        return jsonContent({ returned: false, notSupported: true,
          note: "This core build has no register-write (shipped on all 14 platforms as of 0.6.0 — update the core package). cpu({op:'call'}) needs it." });
      }
      // Pass regs THROUGH (names or numeric ids) — the host resolves names via the
      // platform's regNames map. (Was pre-numified here, which silently dropped
      // names; a 65816 caller couldn't preset A without a reg-id table.)
      const passRegs = {};
      for (const [k, v] of Object.entries(regs ?? {})) passRegs[k] = v >>> 0;
      const r = host.callSubroutine({
        pc, regs: passRegs, sentinelPC, stopAtPC,
        presetMemory: (presetMemory ?? []).map((m) => ({ addr: m.addr, hex: m.hex })),
        maxFrames, ...(maxInstructions ? { maxInstructions } : {}), sandbox, pure,
        ...(callMode ? { callMode } : {}),
      });
      // The poisoned-call caveat (a real session lost hours to this): when the
      // call spanned FRAMES of emulation, the game's own per-frame logic (VBlank
      // handlers via RAM vectors, music drivers) ran CONCURRENTLY and may have
      // written over the routine's output buffer. Loud, up front, with the fix.
      const frameLogicCaveat = (!pure && r.framesRun > 0 && (host.pureCallSupported ? host.pureCallSupported() : false))
        ? ` ⚠ framesRun:${r.framesRun} — the game's own frame logic (VBlank handler, music driver) ran DURING this call and may have modified RAM the routine wrote; treat the output buffer as suspect. Re-run with pure:true to step ONLY the CPU (no frame machinery).`
        : (!pure && r.framesRun > 0)
          ? ` ⚠ framesRun:${r.framesRun} — the game's own frame logic ran DURING this call and may have modified RAM the routine wrote; treat the output buffer as suspect (verify visually or against a known-good slice).`
          : "";
      const note = (r.returned
        ? "Routine RETURNED. readMemory the buffer it wrote (e.g. the decompressor's A1 dest) now — sandbox:false leaves it live. (regs by reg-id: m68k 8=A0,9=A1,0=D0.)"
        : r.watchdog
          ? "WATCHDOG tripped (ran the instruction budget without returning) — almost always a wrong entry setup, not a long routine. Check finalPC (where it's spinning) + finalRegs (is A0 where you set it, or did it walk off?). Common fixes: correct A0 to the real block start (with its length header), add a presetMemory the codec reads, or pass a WRAPPER entryPC that sets up dest. Raise maxInstructions only if you're sure it's legitimately huge."
          : r.stoppedAtPC
            ? `Stopped at ${r.stoppedAtPC} (your stopAtPC) with PARTIAL output — readMemory the dst to see what's been written so far.`
            : "Did not return within maxFrames AND the watchdog didn't trip — this usually means the entry FELL BACK INTO THE GAME (a wrapper PC with a wrong source, so it never reaches the sentinel) and the game is just free-running. finalPC is inside the main loop, not your routine. Re-check the entry PC (use the routine body, not a wrapper) and the source regs; or lower maxInstructions to fail fast while probing. Bump maxFrames/maxInstructions only if you're sure it's a legitimately huge decompress.")
        + frameLogicCaveat;
      return attachObserverFrame(jsonContent({
        returned: r.returned, framesRun: r.framesRun, sandbox,
        ...(r.pure ? { pure: true, pureMode: r.pureMode } : {}),
        ...(r.watchdog ? { watchdog: true, reason: r.reason } : {}),
        ...(r.stoppedAtPC ? { stoppedAtPC: r.stoppedAtPC } : {}),
        ...(r.finalPC ? { finalPC: r.finalPC } : {}),
        ...(r.finalRegs ? { finalRegs: r.finalRegs } : {}),
        note,
      }), host, "cpu call");
  }

  async function cpuDecompress({ entryPC, sourceAddress, destAddress, maxFrames = 600 }) {
      const host = getHost(sessionKey);
      if (!host.setRegSupported || !host.setRegSupported()) {
        return jsonContent({ returned: false, notSupported: true,
          note: "This core build has no register-write (shipped on all 14 platforms as of 0.6.0 — update the core package). decompressWith needs it." });
      }
      const regs = { 8: sourceAddress >>> 0 };
      if (destAddress !== undefined) regs[9] = destAddress >>> 0;
      const r = host.callSubroutine({ pc: entryPC, regs, sentinelPC: 0, maxFrames, sandbox: false });
      return jsonContent({
        returned: r.returned, framesRun: r.framesRun,
        ...(destAddress !== undefined ? { destAddress: "$" + (destAddress >>> 0).toString(16).toUpperCase() } : {}),
        note: r.returned
          ? `Decompressor returned. readMemory at ${destAddress !== undefined ? "$" + (destAddress >>> 0).toString(16).toUpperCase() : "the routine's dest"} to get the decompressed bytes (the live core ran the game's own codec — no codec reimplementation needed).`
          : "Decompressor did NOT return within maxFrames. Confirm entryPC is the routine start, A0=source is right, and bump maxFrames. (Some codecs expect more setup regs — use cpu({op:'call'}) with the full regs map.)",
      });
  }

  server.tool(
    "cpu",
    "Read or drive a CPU, one tool keyed by `op`.\n" +
    "OP CHEAT-SHEET (the params each op uses): " +
    "read → {cpu?, platform?}; " +
    "setReg → {regId, value}; " +
    "call → {pc, regs?, pure?, sandbox?, maxInstructions?, sentinelPC?, stopAtPC?, presetMemory?, maxFrames?}; " +
    "decompress → {entryPC, sourceAddress, destAddress?, maxFrames?}.\n" +
    "• op:'read' — read a CPU's {pc, registers, flags, sp}. Main CPU wired for all 14 tier-1 systems (nes, snes, " +
    "genesis, sms, gg, gb, gbc, atari2600, atari7800, c64, lynx, gba (ARM7TDMI: 16 gprs + cpsr/spsr + execPc for " +
    "pipeline prefetch), pce, msx). Secondary CPUs via `cpu`: 'spc700' (SNES audio — 'stuck in IPL' vs 'running' vs " +
    "'crashed'), 'z80' (Genesis sound — held in reset until the 68k releases it via $A11100, so a fresh boot reads all-zero).\n" +
    "• op:'setReg' — write a single register by romdev reg-id (the inverse of op:'read'). **m68k reg-ids: 0-7=D0-D7, " +
    "8-15=A0-A7, 16=PC, 17=SR, 18=SP.** Returns the value read back. notSupported where the core lacks register-write.\n" +
    "• op:'call' — drive the ROM's OWN subroutine and run until it returns — the RE primitive for compressed assets. Set " +
    "up the CPU (`regs` by reg-id, PC=`pc`), push a sentinel return, run until RTS. **SANDBOXED off by default so the dst " +
    "buffer it wrote stays live for memory({op:'read'}).** Classic use: drive a decompressor (A0=source, A1=dest) then read " +
    "the dst. **NEVER HANGS: an instruction WATCHDOG (`maxInstructions`) force-stops a runaway and returns PROGRESS — " +
    "finalPC + finalRegs + watchdog:true — so you can tell 'wrong A0' from 'needs a preset' from 'legitimately long'.** " +
    "`stopAtPC` halts mid-routine for partial output; `presetMemory` for codecs that read a global from RAM first. " +
    "**`pure:true` (ALL 14 platforms): the game's own VBlank/IRQ logic CANNOT run during the call and stomp the routine's " +
    "output buffer.** Mechanism per platform (reported as `pureMode`): Genesis/SMS/GG step ONLY the CPU ('cpu-only'); every " +
    "other core suppresses interrupt DELIVERY for the duration ('irq-blocked' — video/timers advance harmlessly, no game " +
    "handler executes); the 2600 has no interrupts at all ('no-interrupts'). Without pure, a call that spans frames runs " +
    "the game's frame logic alongside your routine (the result carries a ⚠ caveat) — a real session spent " +
    "hours diffing a CORRECT codec against that poisoned output. Prefer pure for every decompressor/codec call.\n" +
    "• op:'decompress' — convenience wrapper over op:'call' for the common decompressor shape: call `entryPC` with " +
    "A0=`sourceAddress` (and optionally A1=`destAddress`), run until it returns, then read `destAddress`. For the " +
    "the 'pre-rendered name + portrait are LZ-compressed' wall: point it at the game's own decompressor.",
    {
      op: z.enum(["read", "setReg", "call", "decompress"])
        .describe("read=CPU registers/flags; setReg=write one register; call=drive a subroutine until it returns; decompress=call shortcut (A0=source, A1=dest)."),
      // read
      platform: z.string().optional().describe("op:read — override platform; defaults to the loaded ROM."),
      cpu: z.enum(["main", "spc700", "z80"]).default("main").describe("op:read — which CPU: main (primary), spc700 (SNES audio), z80 (Genesis sound)."),
      // setReg
      regId: z.number().int().min(0).max(31).optional().describe("op:setReg — romdev reg-id (m68k: 0-7=D, 8-15=A, 16=PC, 17=SR, 18=SP)."),
      value: z.number().int().optional().describe("op:setReg — 32-bit value to write."),
      // call
      pc: z.number().int().min(0).optional().describe("op:call — entry PC of the subroutine (may be a WRAPPER that sets up regs then tail-calls; sentinel-return is detected from the final RTS regardless)."),
      regs: regSchema,
      sentinelPC: z.number().int().min(0).default(0).describe("op:call — return address pushed on the stack; run stops when PC reaches it. Default 0 (vector area); override if it collides with real code."),
      stopAtPC: z.number().int().min(0).optional().describe("op:call — STOP when PC reaches this address and return the partial output instead of waiting for the sentinel return."),
      presetMemory: z.array(z.object({
        addr: z.number().int().min(0).describe("CPU address to write before the call."),
        hex: z.string().describe("Bytes as hex (e.g. '00FF')."),
      })).optional().describe("op:call — memory writes applied before the call (codecs that read a global from RAM, not just registers)."),
      maxFrames: z.number().int().min(1).max(100000).default(600).describe("op:call/decompress — frame cap (the outer bound)."),
      maxInstructions: z.number().int().min(1000).optional().describe("op:call — instruction watchdog budget (the REAL cap; default ~maxFrames*500k). Raise for a huge decompress; lower to fail fast while probing the right A0."),
      sandbox: z.boolean().default(false).describe("op:call — snapshot+restore core state around the call (default FALSE — you want the dst buffer left live to read). True leaves the live game untouched."),
      pure: z.boolean().default(false).describe("op:call — guarantee the game's own frame logic CANNOT run during the call and stomp the routine's output (ALL 14 platforms; `pureMode` in the result says how: 'cpu-only' on Genesis/SMS/GG, 'irq-blocked' elsewhere, 'no-interrupts' on 2600). Prefer this for any decompressor/codec call."),
      callMode: z.enum(["jsr", "jsl"]).optional().describe("op:call (65816/SNES) — the callee's return type: 'jsr' = a near routine ending in RTS (2-byte return), 'jsl' = a long routine ending in RTL (3-byte return, the default). Set 'jsr' when driving a plain jsr-called helper — otherwise the sentinel is sized for a 3-byte return and the routine 'returns' one byte off into vector-stub land."),
      // decompress
      entryPC: z.number().int().min(0).optional().describe("op:decompress — decompressor entry PC."),
      sourceAddress: z.number().int().min(0).optional().describe("op:decompress — compressed-source address → A0 (reg-id 8 on m68k)."),
      destAddress: z.number().int().min(0).optional().describe("op:decompress — destination buffer address → A1 (reg-id 9). Omit if the routine picks its own dest."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "read":     return await getCPUStateCore(args, sessionKey);
        case "setReg": {
          if (args.regId == null || args.value == null) throw new Error("cpu({op:'setReg'}): `regId` and `value` are required.");
          return await cpuSetReg(args);
        }
        case "call": {
          if (args.pc == null) throw new Error("cpu({op:'call'}): `pc` (entry PC) is required.");
          return await cpuCall(args);
        }
        case "decompress": {
          if (args.entryPC == null || args.sourceAddress == null) throw new Error("cpu({op:'decompress'}): `entryPC` and `sourceAddress` are required.");
          return await cpuDecompress(args);
        }
        default: throw new Error(`cpu: unknown op '${args.op}'`);
      }
    }),
  );

  // ── Range watch + coverage trace (item 2, discovery) ────────────────────────

  async function wRange({ start, end, kind = "both", frames = 120, pressDuring, limit = 200, dedupe = false, distinctPCsOnly = false, fromState, fromStatePath, dbg, map, dbgPath, mapPath }) {
      const host = getHost(sessionKey);
      if (!host.rangeWatchSupported || !host.rangeWatchSupported()) {
        return jsonContent({ notSupported: true, events: [],
          note: "This core build has no range watch (shipped on all 14 platforms as of 0.6.0 — update the core package). Use breakpoint({on:'write'/'read'}) for a single address." });
      }
      if (end < start) throw new Error("watch({on:'range'}): end must be >= start.");
      // Optionally restore a savestate FIRST, so the trace runs from a known
      // moment (the deterministic "jump to the boss fight, then see what writes
      // HP" loop) instead of from wherever the live session happens to be.
      const stateInfo = await maybeRestoreState(host, fromState, fromStatePath);
      // pressDuring is driven inside the frame loop; watchRange's host method owns
      // stepping, so for now apply presses up front if any (simple: hold for the run).
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      if (presses.length) pressDriver.applyForFrame(0);
      const r = host.watchRange(start, end, kind, frames);
      pressDriver.finish();
      const hx = (n, w = 0) => "$" + n.toString(16).toUpperCase().padStart(w, "0");
      const hxv = (n) => "0x" + n.toString(16).toUpperCase().padStart(2, "0");

      // Per-PC digest — the actionable "which routines touch this range" answer.
      // Each writer's hit count + a sample address/value, sorted by frequency. This
      // is what a "who writes here?" query actually needs; the per-event flood (a
      // per-frame counter inc'd at one PC → hundreds of near-identical rows) is
      // ~95% wasted tokens for that question. (v0.41.0 feedback 133737 N1.)
      const byPC = new Map();
      for (const e of r.events) {
        let g = byPC.get(e.pc);
        if (!g) { g = { pc: e.pc, count: 0, sampleAddress: e.address, sampleValue: e.value }; byPC.set(e.pc, g); }
        g.count++;
      }
      const byPCList = [...byPC.values()].sort((a, b) => b.count - a.count).slice(0, 64)
        .map((g) => ({ pc: hx(g.pc), count: g.count, sampleAddress: hx(g.sampleAddress), sampleValue: hxv(g.sampleValue) }));
      const distinctPCs = byPCList.map((g) => g.pc);
      const dbgSrc = (dbg || map || dbgPath || mapPath) ? await loadDebugSource({ dbg, map, dbgPath, mapPath }) : {};
      const { extra: censusExtra, noteLines: censusNotes } = await enrichCensus(byPCList, { host, kind, start, end, dbg: dbgSrc.dbg, map: dbgSrc.map });
      const censusNoteSuffix = censusNotes.length ? " " + censusNotes.join(" ") : "";

      // distinctPCsOnly → return JUST the digest, suppress the raw event list (the
      // common "discover the writers" use; no per-event tokens spent).
      if (distinctPCsOnly) {
        return attachObserverFrame(jsonContent({
          range: hx(start) + ".." + hx(end), kind, total: r.total, truncated: r.truncated,
          ...(stateInfo ? { restoredFrom: stateInfo } : {}),
          distinctPCs, byPC: byPCList, ...censusExtra,
          note: "distinctPCsOnly: per-PC digest only (raw events suppressed). Each PC is a routine that touches the range; `count` is how often it fired, `sampleAddress`/`sampleValue` a representative hit. disasm({target:'rom'}) a PC to identify it. Drop distinctPCsOnly (or set dedupe:true) for the events." +
            (r.truncated ? " TRUNCATED: more events than the buffer held — narrow start..end/frames." : "") + censusNoteSuffix,
        }), host);
      }

      // dedupe → collapse identical (pc,address,value) rows to one with an
      // `occurrences` count, so a byte written the same way every frame is 1 row
      // not hundreds (parity with on:'dma's dedupe).
      let events;
      if (dedupe) {
        const seen = new Map();
        for (const e of r.events) {
          const k = `${e.pc}|${e.address}|${e.value}`;
          const g = seen.get(k);
          if (g) g.occurrences++;
          else seen.set(k, { pc: hx(e.pc), address: hx(e.address), value: hxv(e.value), occurrences: 1 });
        }
        events = [...seen.values()].sort((a, b) => b.occurrences - a.occurrences).slice(0, limit);
      } else {
        events = r.events.slice(0, limit).map((e) => ({ pc: hx(e.pc), address: hx(e.address), value: hxv(e.value) }));
      }
      return attachObserverFrame(jsonContent({
        range: hx(start) + ".." + hx(end),
        kind, total: r.total, returned: events.length, truncated: r.truncated,
        ...(dedupe ? { deduped: true, uniqueEvents: events.length } : {}),
        ...(stateInfo ? { restoredFrom: stateInfo } : {}),
        distinctPCs, byPC: byPCList, ...censusExtra, events,
        note: "distinctPCs/byPC is the actionable summary — each PC is a routine that touches this range; disasm({target:'rom'}) one to identify the renderer/reader. For a 'who writes here?' query, distinctPCsOnly:true returns JUST the digest (no per-event flood); dedupe:true collapses per-frame churn to unique (pc,address,value) rows with `occurrences`. " +
          (r.truncated ? "TRUNCATED: more events than the buffer held — narrow `start..end` or `frames` for the full set." : "") + censusNoteSuffix,
      }), host);
  }

  async function wLogPC({ start, end, frames = 120, pressDuring, limit = 512, fromState, fromStatePath }) {
      const host = getHost(sessionKey);
      if (!host.rangeWatchSupported || !host.rangeWatchSupported()) {
        return jsonContent({ notSupported: true, pcs: [],
          note: "This core build has no coverage trace (shipped on all 14 platforms as of 0.6.0 — update the core package)." });
      }
      if (end < start) throw new Error("watch({on:'pc'}): end must be >= start.");
      const stateInfo = await maybeRestoreState(host, fromState, fromStatePath);
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      if (presses.length) pressDriver.applyForFrame(0);
      const r = host.logPCRange(start, end, frames);
      pressDriver.finish();
      const pcs = r.pcs.slice(0, limit).map((p) => "$" + p.toString(16).toUpperCase());
      return attachObserverFrame(jsonContent({
        window: "$" + start.toString(16).toUpperCase() + "..$" + end.toString(16).toUpperCase(),
        distinct: r.distinct, total: r.total, returned: pcs.length, truncated: r.truncated,
        ...(stateInfo ? { restoredFrom: stateInfo } : {}),
        pcs,
        note: "Each PC is code that EXECUTED in this window. disasm({target:'rom'}) them to find the routine you're hunting. " +
          (r.truncated ? "TRUNCATED — narrow the window for the full distinct set." : ""),
      }), host);
  }

  server.tool(
    "watch",
    "LOG-ALL dynamic tracing — run N frames and log EVERY hit (not stop-on-first; for stop-on-first use `breakpoint`). One tool keyed by `on`.\n" +
    "• on:'mem' — the power tool: answer 'what code is touching this RAM byte?' OR extract a frame-accurate event timeline (music-driver note onsets, physics arcs). Reports every frame that changed a watched byte as {frame,offset,before,after,pc}. " +
    "Extras: `ranges:[{region,offset,length,label}]` watches MANY disjoint regions in ONE pass (identical frames); `onChange:'reset'|'increase'|'decrease'|'any'` edge filter (reset = counter-reload = the note-onset signal); `valueFilter:{min,max}`; `format:'series'` = compact columnar value-vs-frame curve (~10× smaller for a ramp); `sampleEvery`; `groupByPC` (collapse by sampled PC); `cheatLabels` (auto-name addresses from the cheat DB); `outputPath` streams all events as NDJSON; `stopOnFirst` exits on the first match. " +
    "**CAVEAT: frame-level, not instruction-level (last value per frame); the sampled `pc` is a frame-boundary sample — for ISR-driven writes use breakpoint({on:'write', precision:'exact'}) for the real writer.**\n" +
    "• on:'range' — DISCOVERY: log EVERY instruction that reads or writes ANYWHERE in [start,end]. The fix for 'I don't know which PC touches this'. Returns {pc,address,value}[] + the actionable distinctPCs + a per-PC digest (byPC). For a pure 'who writes here?' query, `distinctPCsOnly:true` returns JUST the digest (no per-event flood — a per-frame counter inc'd at one PC otherwise floods hundreds of near-identical rows); `dedupe:true` collapses identical (pc,address,value) events to one row with `occurrences`. (Ring-buffered: `truncated:true` if it overflows.) `fromState`/`fromStatePath` restores a savestate FIRST so the trace runs from a known moment (jump to the boss, then see what writes HP) — deterministic + repeatable.\n" +
    "• on:'pc' — DISCOVERY (coverage trace): record every DISTINCT PC executed within [start,end] — 'what code runs here?'. Log execution in the bank where you suspect the renderer lives during the moment it draws, then disassemble the PCs. Also takes `fromState`/`fromStatePath` to trace from a restored moment.\n" +
    "• on:'dma' — GENESIS ONLY: trace mem→VDP DMAs (the answer to 'this name/portrait/logo is a pre-rendered bitmap DMA'd into VRAM — WHERE in ROM?', which on:'write' can't catch). `precision:'exact'` (default) logs every mem→VDP DMA with its VRAM DESTINATION + ROM SOURCE + length (filter by `vramDest`±`destWindow`; `dedupe` collapses the per-frame refresh; `sourceFilter:'rom-only'` drops RAM→VRAM noise; catches a same-frame second DMA). `precision:'sampled'` is the cheap frame-sampled source-register read (may miss two DMAs in one frame, dest-agnostic). `perFrame:true` switches to FEEL/PERF MODE: a per-frame timeline of VDP-DMA WORK ({frame,dmas,bytes,romBytes,ramBytes} + peakFrame + `spikes`) — the cheap 'why does horizontal movement feel choppy?' diagnostic (a per-frame byte spike = too much VDP work in the loop, e.g. a tilemap rewrite). On non-Genesis cores returns `notSupported`.\n" +
    "• on:'copy' — ALL 14 PLATFORMS: log every write landing in a VRAM/dest address window [start,end] with the EXECUTING instruction's PC — the generic answer to 'this tile/nametable/portrait on screen: which routine uploads it?'. Port-based video memory (NES $2007, SNES $2118/19 — incl. the DMA path, PCE VWR, MSX/SMS/GG VDP data port, Genesis data port) is hooked INSIDE the core, so `start`/`end` are VRAM addresses (NES PPU $0000-$3FFF; SNES VRAM byte addr; PCE VRAM word addr; MSX/SMS/GG VRAM addr). Direct-mapped platforms (GB/GBC $8000-$9FFF, GBA 0x06000000+, C64/Lynx/7800 RAM framebuffers) route through the CPU-address range log automatically — pass CPU addresses there. Follow up with breakpoint({on:'pc', address: pc}) to get registersAtHit at the uploader.",
    {
      on: z.enum(["mem", "range", "pc", "dma", "copy"])
        .describe("mem=watch a RAM byte/ranges for value changes over frames (the power tool); range=log every read/write PC in [start,end]; pc=coverage trace of distinct PCs executed in [start,end]; dma=Genesis-only mem→VDP DMA source/dest trace; copy=log every write landing in a VRAM address window with the EXECUTING instruction's PC (all 14 platforms — the generic 'where does this graphic come from?')."),
      // on:'mem' — the ONE primary region enum kept on purpose (0.30.0 design):
      // where region IS the choice, the discoverable canonical list stays in the
      // schema. The secondary region sub-params use the lean regionStr instead.
      region: z.enum(MEMORY_REGIONS).optional().describe("on:'mem' single-range — the region to watch (same canonical set memory uses, incl. nes_apu_regs, genesis_ym2612, c64_sid_regs). Omit when using `ranges`."),
      offset: z.number().int().min(0).default(0).describe("on:'mem' single-range — first byte of the watched range."),
      length: z.number().int().min(1).max(4096).default(1).describe("on:'mem' single-range — bytes to watch (default 1)."),
      ranges: z.array(rangeShape).min(1).max(16).optional().describe("on:'mem' — watch several disjoint ranges in one pass (region/offset/length ignored). Each event carries its range's `label`; each range may OVERRIDE call-wide `onChange`/`sampleEvery`/`valueFilter` (keep a slow state byte while suppressing a noisy counter in the same pass)."),
      onChange: z.enum(["any", "increase", "decrease", "reset"]).default("any").describe("on:'mem' edge filter. 'any' (default); 'increase'/'decrease' directional; 'reset' = value jumped UP (counter reload — the note-onset signal)."),
      valueFilter: z.object({ min: z.number().int().min(0).max(255).optional(), max: z.number().int().min(0).max(255).optional() }).optional().describe("on:'mem' — keep only changes whose NEW value is within [min,max]."),
      maxEvents: z.number().int().min(1).max(100_000).default(256).describe("on:'mem' — cap RETURNED events (outputPath gets ALL). With format:'series' caps SAMPLES PER OFFSET and downsamples to span the full window."),
      format: z.enum(["events", "series"]).default("events").describe("on:'mem' — 'events' (verbose per change) or 'series' (compact columnar frames[]/values[] curve, ~10× smaller for a ramp; drops pc)."),
      sampleEvery: z.number().int().min(1).default(1).describe("on:'mem' — keep only every Nth filter-passing change (trend, not every delta)."),
      groupByPC: z.boolean().default(false).describe("on:'mem' — collapse events by sampled PC into byPC[]. CAVEAT: that PC is frame-boundary-sampled, NOT the writer under interrupts — use breakpoint({on:'write', precision:'exact'}) for the EXACT writer."),
      cheatLabels: z.string().optional().describe("on:'mem' — absolute path to the loaded ROM; auto-annotate watched RAM-region addresses (system_ram/*_ram/*_wram/gb_hram) from the bundled cheat DB (a PROBABLE match — strong hints, not gospel)."),
      stopOnFirst: z.boolean().default(false).describe("on:'mem' — stop on the first filter-passing change instead of running the full duration. (For a true stop-on-first breakpoint, prefer the `breakpoint` tool.)"),
      // on:'range'
      kind: z.enum(["read", "write", "both"]).default("both").describe("on:'range' — watch reads, writes, or both."),
      distinctPCsOnly: z.boolean().default(false).describe("on:'range' — return JUST the per-PC digest (distinctPCs + byPC[{pc,count,sampleAddress,sampleValue}]) and SUPPRESS the raw event list. The token-cheap form of the common 'which routines touch this range?' query — a per-frame counter inc'd at one PC floods hundreds of near-identical events otherwise."),
      dbg: z.string().optional().describe("on:'range' — cc65 .dbg TEXT: adds `routine` (nearest preceding symbol) to each byPC row + a byRoutine rollup, so censuses compare in ROUTINE units across sessions (an RMW logs 2 PCs in one routine; raw PC counts look like disagreements when they aren't). Prefer dbgPath — the map never enters your context."),
      map: z.string().optional().describe("on:'range' — sdld/GNU-ld .map TEXT: same routine grouping for Z80/SM83/Genesis symbol maps. Prefer mapPath."),
      dbgPath: z.string().optional().describe("on:'range' — path to the .dbg on disk (build({output:'romWithDebug'}) wrote it); read server-side."),
      mapPath: z.string().optional().describe("on:'range' — path to the .map on disk; read server-side."),
      // on:'range' / on:'pc' window
      start: z.number().int().min(0).optional().describe("on:'range'/'pc' — low CPU address of the window."),
      end: z.number().int().min(0).optional().describe("on:'range'/'pc' — high CPU address (inclusive)."),
      // shared
      frames: z.number().int().min(1).max(1_000_000).default(600).describe("Frames to run while logging (default 600). on:'range'/'pc' windows are usually short (~120) — pass a smaller value to keep the ring buffer from overflowing."),
      limit: z.number().int().min(1).max(4000).default(200).describe("on:'range'/'pc' — max events/PCs returned (default 200; full count is in `total`)."),
      outputPath: z.string().optional().describe("on:'mem' — stream every filter-passing event to this path as NDJSON + return a compact summary. Use for long watches so the full log never enters your context."),
      // on:'dma' (Genesis VDP DMA trace)
      perFrame: z.boolean().default(false).describe("on:'dma' — FEEL/PERF MODE: instead of one aggregated source/dest log, return a PER-FRAME timeline of VDP-DMA WORK [{frame, dmas, bytes, romBytes, ramBytes}] + peakFrame/peakBytes. This is the cheap 'why does horizontal movement feel choppy?' answer — a frame whose DMA bytes spike (esp. romBytes, an asset re-upload) is doing too much VDP work in the loop (the classic 'I rewrote a tilemap every frame' bug). A smooth hardware-scroll loop shows a low, flat curve. Combine with `pressDuring` to correlate the spike with input (hold RIGHT, see which frames burst). No core rebuild — re-arms the DMA counter each frame."),
      precision: z.enum(["exact", "sampled"]).default("exact").describe("on:'dma' — exact=per-DMA core log with VRAM dest + ROM source (catches same-frame DMAs); sampled=frame-sampled source-register read (cheaper, may miss two DMAs in one frame, dest-agnostic). Ignored when perFrame:true."),
      vramDest: z.number().int().min(0).optional().describe("on:'dma' precision:'exact' — keep only DMAs whose VRAM destination is within ±`destWindow` of this address."),
      destWindow: z.number().int().min(0).default(0x40).describe("on:'dma' precision:'exact' — match window around vramDest (default 64 bytes ≈ 1 tile)."),
      dedupe: z.boolean().optional().describe("Collapse identical events to one entry with an `occurrences` count. on:'dma' precision:'exact' — identical DMAs (same dest+source+length+code), DEFAULT ON. on:'range' — identical (pc,address,value) writes, DEFAULT OFF (turns per-frame churn from hundreds of rows into a few)."),
      sourceFilter: z.enum(["all", "rom-only", "ram-only"]).default("all").describe("on:'dma' precision:'exact' — 'rom-only' drops the RAM→VRAM per-frame refresh noise; 'ram-only' keeps only it."),
      romPreviewBytes: z.number().int().min(0).max(64).default(0).describe("on:'dma' — bytes of the ROM source to preview per DMA (exact default 0; sampled default 16)."),
      minLengthBytes: z.number().int().min(0).max(65536).default(0).describe("on:'dma' precision:'sampled' — ignore DMAs shorter than this many bytes (filters tiny scroll/sprite updates so graphic uploads stand out)."),
      pressDuring: z.array(z.object({
        frame: z.number().int().min(0),
        button: z.string(),
        port: z.number().int().min(0).max(3).default(0),
        holdFrames: z.number().int().min(1).default(2),
      })).optional().describe("Schedule input while watching (drive the game to the state that touches the watched bytes/range, or uploads the graphic for on:'dma'). If OMITTED, this run inherits whatever input({op:'set'}) last held — same as frame({op:'step'}). If GIVEN, the schedule OWNS the pad for the whole run (a prior input({op:'set'}) is ignored). Entries with OVERLAPPING windows on the same port are OR'd into a chord (e.g. b+right held while a fires mid-window), not overwritten. MENU SCREENS: if a schedule never registers (some menus poll input in a way scheduled taps miss), hold the button via input({op:'set'}) and OMIT pressDuring — the run inherits the held state and the menu sees the edge."),
      fromState: z.string().optional().describe("on:'range'/'pc' — restore an in-memory savestate SLOT (from state({op:'save', name})) BEFORE tracing, so the log runs from a known moment (jump to the boss fight, then see what writes HP). Deterministic + repeatable."),
      fromStatePath: z.string().optional().describe("on:'range'/'pc' — like fromState but restore from a savestate FILE on disk (state({op:'save', path})). Relative path resolves against the loaded ROM's dir."),
    },
    safeTool(async (args) => {
      switch (args.on) {
        case "mem":   return await watchMem(args);
        case "range": {
          if (args.start == null || args.end == null) throw new Error("watch({on:'range'}): `start` and `end` are required.");
          return await wRange({ ...args, frames: args.frames ?? 120, limit: args.limit ?? 200 });
        }
        case "pc": {
          if (args.start == null || args.end == null) throw new Error("watch({on:'pc'}): `start` and `end` are required.");
          return await wLogPC({ ...args, frames: args.frames ?? 120, limit: args.limit ?? 512 });
        }
        case "dma": {
          const a = { ...args, frames: args.frames ?? 120, limit: args.limit ?? 200 };
          if (a.perFrame) return await dmaPerFrame(a);
          if (a.precision === "sampled") {
            return await traceVramSourceCore({ ...a, romPreviewBytes: a.romPreviewBytes || 16, sessionKey });
          }
          return await dmaExact(a);
        }
        case "copy": {
          if (args.start == null || args.end == null) throw new Error("watch({on:'copy'}): `start` and `end` are required (the VRAM/dest address window).");
          return await wCopy({ ...args, frames: args.frames ?? 120, limit: args.limit ?? 200 });
        }
        default: throw new Error(`watch: unknown on '${args.on}'`);
      }
    }),
  );

  // ── watch({on:'copy'}) — the generic graphics source-trace ─────────────────
  async function wCopy({ start, end, frames = 120, limit = 200, pressDuring }) {
      const host = getHost(sessionKey);
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      if (host.vramWatchSupported && host.vramWatchSupported()) {
        // Port-based video memory: the core hook logs {vramAddr, pc, value}
        // with the EXECUTING instruction's PC (DMA-initiating instruction on
        // SNES). start/end are VRAM addresses.
        let i = 0;
        const r = host.watchVram(start, end, frames, () => { pressDriver.applyForFrame(i++); return false; });
        pressDriver.finish();
        const events = r.events.slice(0, limit).map((e) => ({
          vramAddr: "$" + e.vramAddr.toString(16).toUpperCase(),
          pc: "$" + e.pc.toString(16).toUpperCase(),
          pcRaw: e.pc,
          value: "0x" + e.value.toString(16).toUpperCase().padStart(2, "0"),
        }));
        const distinct = [...new Set(r.events.map((e) => e.pc))].slice(0, 32)
          .map((p) => "$" + p.toString(16).toUpperCase());
        return jsonContent({
          on: "copy", mode: "vram-port",
          window: { start: "$" + start.toString(16).toUpperCase(), end: "$" + end.toString(16).toUpperCase() },
          framesRun: frames,
          total: r.total, stored: r.stored, truncated: r.truncated,
          distinctPCs: distinct,
          events,
          note: "pc is the EXECUTING instruction that performed the upload (on SNES the instruction that " +
            "triggered the DMA). Addresses are VRAM-space. Next: breakpoint({on:'pc', address: <pc>}) to stop " +
            "there with registersAtHit (source pointer in the index/address regs), then disasm({target:'rom', " +
            "startAddress: <pc>}) to read the routine." +
            (r.truncated ? " Ring overflowed — narrow the window or lower frames." : ""),
        });
      }
      // Direct-mapped video memory (GB/GBC/GBA/C64/Lynx/7800): the same
      // question routes through the CPU-address range log — start/end are CPU
      // addresses (e.g. GB VRAM $8000-$9FFF).
      pressDriver.finish();
      const out = await wRange({ start, end, frames, limit, kind: "write", pressDuring });
      try {
        const parsed = JSON.parse(out.content.find((c) => c.type === "text").text);
        parsed.on = "copy";
        parsed.mode = "cpu-mapped";
        parsed.note = (parsed.note ? parsed.note + " " : "") +
          "This platform's video memory is CPU-mapped, so the copy trace IS the write-range log: " +
          "start/end are CPU addresses (GB/GBC VRAM $8000-$9FFF; GBA 0x06000000+; C64/Lynx/7800 use the " +
          "framebuffer/display-list RAM range). pc is the executing instruction; follow up with " +
          "breakpoint({on:'pc', address: pc}) for registersAtHit.";
        return jsonContent(parsed);
      } catch {
        return out;
      }
  }

  // ── watch({on:'dma'}) helpers (Genesis only) ────────────────────────────────
  // precision:exact = dmaExact (watchDma, per-DMA core log), precision:sampled =
  // traceVramSourceCore (frame-sampled, dest-agnostic). Routed by the `watch`
  // tool's switch (case 'dma'); folded in from the old standalone dmaTrace tool.
  async function dmaExact({ frames = 120, vramDest, destWindow = 0x40, dedupe = true, sourceFilter = "all", pressDuring, romPreviewBytes = 0, limit = 200 }) {
      const host = getHost(sessionKey);
      if (!host.dmaWatchSupported || !host.dmaWatchSupported()) {
        return jsonContent({ notSupported: true, dmas: [],
          note: "watch({on:'dma'}) is Genesis-only (VDP DMA). On other platforms use breakpoint({on:'write'}) (CPU writes) or the platform's source tracer." });
      }
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      if (presses.length) pressDriver.applyForFrame(0);
      const r = host.watchDma(frames);
      pressDriver.finish();
      let rom = null;
      if (romPreviewBytes > 0) { try { rom = host.getCartRom(); } catch { /* no preview */ } }
      // VDP code low bits: 1=VRAM, 3=CRAM, 5=VSRAM (write codes). Decode the target.
      const targetOf = (code) => { const c = code & 0x0F; return c === 1 ? "VRAM" : c === 3 ? "CRAM" : c === 5 ? "VSRAM" : "VRAM?"; };
      // Genesis 68k bus: ROM is the low address space (< $400000 typically), work
      // RAM is $E00000-$FFFFFF. A DMA `source` is a 68k byte address — split on the
      // RAM window so 'rom-only' drops the RAM→VRAM sprite/scroll refresh.
      const isRam = (src) => (src >>> 0) >= 0xE00000;
      let dmas = r.dmas;
      if (vramDest !== undefined) dmas = dmas.filter((d) => Math.abs((d.vramDest >>> 0) - vramDest) <= destWindow);
      if (sourceFilter === "rom-only") dmas = dmas.filter((d) => !isRam(d.source));
      else if (sourceFilter === "ram-only") dmas = dmas.filter((d) => isRam(d.source));
      let collapsedCount = 0;
      if (dedupe) {
        const seen = new Map();
        for (const d of dmas) {
          const k = `${d.vramDest >>> 0}:${d.source >>> 0}:${d.lengthWords}:${d.code}`;
          if (seen.has(k)) { seen.get(k).occurrences++; collapsedCount++; }
          else seen.set(k, { ...d, occurrences: 1 });
        }
        dmas = [...seen.values()];
      }
      const totalDistinct = dmas.length;
      const out = dmas.slice(0, limit).map((d) => {
        const o = {
          vramDest: "$" + (d.vramDest >>> 0).toString(16).toUpperCase(),
          source: "0x" + (d.source >>> 0).toString(16).toUpperCase(),
          lengthWords: d.lengthWords, lengthBytes: d.lengthWords * 2,
          target: targetOf(d.code),
          from: isRam(d.source) ? "RAM" : "ROM",
          ...(dedupe ? { occurrences: d.occurrences } : {}),
        };
        if (rom && rom.bytes && !isRam(d.source) && (d.source >>> 0) < rom.bytes.length) {
          const a = d.source >>> 0, e = Math.min(a + romPreviewBytes, rom.bytes.length);
          o.romPreview = Array.from(rom.bytes.subarray(a, e), (b) => b.toString(16).padStart(2, "0")).join("");
        }
        return o;
      });
      return attachObserverFrame(jsonContent({
        totalEvents: r.total, distinctDmas: totalDistinct, returned: out.length,
        ...(dedupe && collapsedCount ? { collapsed: collapsedCount } : {}),
        ...(r.truncated ? { coreBufferTruncated: true } : {}),
        ...(vramDest !== undefined ? { filteredToVramDest: "$" + vramDest.toString(16).toUpperCase(), destWindow } : {}),
        ...(sourceFilter !== "all" ? { sourceFilter } : {}),
        dmas: out,
        note: "`source` is the 68k byte address the tiles were copied from — for a ROM source (`from:ROM`) edit the tiles THERE. " +
          "dedupe collapses the per-frame refresh; sourceFilter:'rom-only' drops the RAM→VRAM sprite/scroll noise (use it to find a cart-ROM asset DMA). " +
          (totalDistinct > limit ? `Showing ${out.length}/${totalDistinct} distinct — raise limit or narrow vramDest.` : ""),
      }), host);
  }

  // watch({on:'dma', perFrame:true}) — FEEL/PERF timeline. Steps frame-by-frame,
  // re-arming the DMA counter each frame (the core resets on arm), and reports
  // VDP-DMA WORK per frame. The cheap, no-core-rebuild "why is movement choppy?"
  // diagnostic: a frame whose bytes (esp. romBytes — an asset re-upload) spike is
  // doing too much VDP work in the loop. Optionally driven by `pressDuring` so the
  // spike correlates with input. See genesis MENTAL_MODEL "feel trap".
  async function dmaPerFrame({ frames = 120, pressDuring, maxFrames = 600 }) {
    const host = getHost(sessionKey);
    if (!host.dmaWatchSupported || !host.dmaWatchSupported()) {
      return jsonContent({ notSupported: true, frames: [],
        note: "watch({on:'dma', perFrame}) is Genesis-only (VDP DMA). On other cores there's no VDP DMA to count." });
    }
    const n = Math.min(frames, maxFrames);
    const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
    const pressDriver = makePressDriver(host, presses);
    const r = host.watchDmaPerFrame(n, (i) => pressDriver.applyForFrame(i));
    pressDriver.finish();
    const tl = r.frames;
    // Compact: only KEEP frames that did any DMA, plus always the peak. A flat
    // hardware-scroll loop is mostly the steady SAT refresh — summarise it.
    const nonZero = tl.filter((f) => f.bytes > 0);
    const avgBytes = tl.length ? Math.round(r.totalBytes / tl.length) : 0;
    const peak = tl[r.peakFrame] || null;
    // A spike heuristic: a frame whose bytes are >3x the average AND carries ROM
    // source bytes (an asset upload, not the steady RAM refresh) is the smell.
    const spikes = tl.filter((f) => avgBytes > 0 && f.bytes > avgBytes * 3 && f.romBytes > 0)
                     .map((f) => ({ frame: f.frame, bytes: f.bytes, romBytes: f.romBytes, dmas: f.dmas }));
    // Cap the returned per-frame rows so a long run doesn't flood context.
    const rows = nonZero.slice(0, 240);
    return attachObserverFrame(jsonContent({
      perFrame: true,
      framesRun: n,
      totalDmas: r.totalDmas,
      totalBytes: r.totalBytes,
      avgBytesPerFrame: avgBytes,
      peakFrame: r.peakFrame,
      peakBytes: r.peakBytes,
      ...(peak ? { peakDetail: peak } : {}),
      framesWithDma: nonZero.length,
      ...(spikes.length ? { spikes } : {}),
      ...(presses.length ? { pressesApplied: pressDriver.applied() } : {}),
      timeline: rows,
      ...(nonZero.length > rows.length ? { timelineTruncated: nonZero.length } : {}),
      note: "Per-frame VDP-DMA WORK. `bytes` = VRAM/CRAM/VSRAM bytes DMA'd that frame; `romBytes` = bytes copied FROM cart ROM (an asset upload), `ramBytes` = the steady RAM→VRAM sprite/scroll refresh. " +
        "A smooth hardware-scroll loop shows a low, flat curve (mostly ramBytes ≈ the SAT refresh). " +
        "A `spikes` entry (bytes >3x avg WITH romBytes) is the 'I rewrote a tilemap / re-uploaded tiles in the frame loop' smell — move that work to setup or stream ONE column per 8-px scroll step instead. " +
        "Hold input with `pressDuring` to see which input bursts. CEILING: this counts DMA bytes; CPU writes to the VDP data port (VDP_setTileMapXY without DMA) are NOT DMA and aren't counted here — those need a core-side VDP-write hook (future).",
    }), host);
  }
  // dmaExact + dmaPerFrame + traceVramSourceCore are reached via watch({on:'dma'})
  // above — dmaTrace was folded into `watch` (it's a log-all VDP-DMA trace, same
  // family as on:'mem'/'range'/'pc'), so there's no separate top-level tool.
}
