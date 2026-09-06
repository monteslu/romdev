// runtime.js — overlay-aware runtime inspection for a decomp project:
//   overlays   which overlay is loaded at a shared VA, from the BYTES in RAM
//              compared with each candidate segment's ROM bytes (evidence,
//              not a guess)
//   symbolize  a live PC/VA → symbol + segment, using the detected overlay
//   state      is this session's emulator still there; if not, why
//   trace      arguments / return value / call targets of a function on a
//              live session, where the core can stop at a PC (probed, and
//              reported as unsupported with evidence when it cannot)
//   coverage   function-level observed/unobserved/unreferenced for a scenario
// Every observation carries ROM sha1, core identity, session key, frame count.
import fs from "node:fs";
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { callTool } from "./smoke.js";
import { hx } from "./splat-map.js";
import { profileFor } from "./platform.js";

async function registry(sessionKey) { const { buildToolRegistry } = await import("../http/tool-registry.js"); return buildToolRegistry(sessionKey); }

/** RDRAM is exposed as 32-bit little-endian words; ROM is big-endian. Swap to compare. */
function swapWords(buf) { const out = Buffer.alloc(buf.length); for (let i = 0; i + 3 < buf.length; i += 4) { out[i] = buf[i + 3]; out[i + 1] = buf[i + 2]; out[i + 2] = buf[i + 1]; out[i + 3] = buf[i]; } return out; }

async function readRam(reg, sessionKey, va, length, project) {
  const r = await callTool(reg, "memory", { op: "read", address: (va & 0x1fffffff) >>> 0, length }, sessionKey);
  const buf = Buffer.from(r.hex, "hex");
  const swap = project ? profileFor(project.m.splatPlatform ?? project.m.platform).ramWordSwap : true;
  return swap ? swapWords(buf) : buf;
}

async function provenance(project, reg, sessionKey) {
  const st = await callTool(reg, "catalog", { op: "status" }, sessionKey);
  const { CORES } = await import("../cores/registry.js");
  const pkg = CORES[project.m.platform]?.pkg ?? null;
  let coreVersion = null;
  try { coreVersion = JSON.parse(await readFile(new URL(`../../../${pkg}/package.json`, import.meta.url), "utf8")).version; } catch {}
  return { session: sessionKey, romSha1: project.m.rom.sha1, core: { name: CORES[project.m.platform]?.coreName ?? null, package: pkg, version: coreVersion }, frameCount: st?.frameCount ?? st?.status?.frameCount ?? null, serverPid: st?.serverPid ?? null, serverStartedAt: st?.serverStartedAt ?? null, at: new Date().toISOString() };
}

/**
 * Probe what the loaded core can do for instruction-level capture, on THIS
 * session, right now: single-step (does the PC advance and come back), and
 * a PC break on the current frame-boundary PC (does it ever report a hit).
 * Cheap, side-effect-free beyond a few instructions, and the evidence every
 * trace/coverage result carries.
 */
export async function probeCore(sessionKey) {
  const { getHostOrNull } = await import("../mcp/state.js");
  const host = getHostOrNull(sessionKey);
  if (!host) throw Object.assign(new Error(`no emulator in session '${sessionKey}' (loadMedia first)`), { code: "LOST_RUNTIME_STATE" });
  const out = { core: host.status?.platform ?? null, singleStep: { supported: false, evidence: null }, pcBreak: { supported: false, evidence: null } };
  try {
    if (host.pcBreakSupported?.()) {
      const pcs = []; for (let i = 0; i < 6; i++) { const r = host.stepInstruction(); pcs.push(r?.pc ?? null); }
      const real = pcs.filter((p) => p != null);
      const distinct = new Set(real);
      out.singleStep = { supported: real.length === pcs.length && distinct.size >= 2, evidence: `6 host.stepInstruction() calls returned pcs [${pcs.map((p) => p == null ? "null" : "0x" + p.toString(16)).join(", ")}]` };
      // PC break on a PC we know is executed every frame: the frame-boundary PC from the register file.
      let pcNow = real[0] ?? null;
      if (pcNow == null) { try { const reg = await registry(sessionKey); const cpu = await callTool(reg, "cpu", { op: "read" }, sessionKey); if (cpu?.pc != null) pcNow = cpu.pc >>> 0; } catch {} }
      if (pcNow != null) {
        host.setPCBreak(pcNow, true, false); host.stepFrames(2); const pb = host.getPCBreak(true); host.setPCBreak(0, false, false);
        out.pcBreak = { supported: !!pb?.hit, evidence: `setPCBreak(0x${pcNow.toString(16)}) then 2 frames: hit=${!!pb?.hit} hits=${pb?.hits ?? 0}` };
      } else out.pcBreak = { supported: false, evidence: "no PC available to arm a break on" };
    } else { out.singleStep.evidence = out.pcBreak.evidence = "host.pcBreakSupported() is false for this core"; }
  } catch (e) { out.error = String(e?.message ?? e).slice(0, 200); }
  return out;
}

/** Which overlay(s) are resident: compare RAM at each shared VA with every candidate's ROM bytes. */
export async function detectOverlays(project, { sessionKey, probeBytes = 512 }) {
  const map = await project.map();
  const reg = await registry(sessionKey);
  const rom = await readFile(project.abs(project.m.rom.path));
  const groups = new Map(); // vram → [segments]
  for (const s of map.segments) if (s.overlay && s.vram != null) { if (!groups.has(s.vram)) groups.set(s.vram, []); groups.get(s.vram).push(s); }
  const out = [];
  for (const [vram, segs] of groups) {
    const ram = await readRam(reg, sessionKey, vram, probeBytes, project);
    const matches = [];
    for (const s of segs) {
      const n = Math.min(probeBytes, s.romEnd - s.romStart);
      const romBytes = rom.subarray(s.romStart, s.romStart + n);
      let same = 0; for (let i = 0; i < n; i++) if (romBytes[i] === ram[i]) same++;
      matches.push({ segment: s.segment ?? s.name, romStart: hx(s.romStart), bytesCompared: n, bytesEqual: same, fraction: Math.round((same / n) * 1000) / 1000 });
    }
    matches.sort((a, b) => b.fraction - a.fraction);
    const best = matches[0];
    const loaded = best && best.fraction === 1 ? best.segment : null;
    const partial = !loaded && best && best.fraction > 0.9 ? best.segment : null;
    out.push({ vram: hx(vram), candidates: segs.length, loaded, partial, ramSha1: createHash("sha1").update(ram).digest("hex"), allZero: ram.every((b) => b === 0), matches: matches.slice(0, 4),
      evidence: loaded ? `RAM[${hx(vram)}..+${best.bytesCompared}] equals ${loaded}'s ROM bytes at ${best.romStart} byte-for-byte` : partial ? `RAM matches ${partial} for ${best.bytesEqual}/${best.bytesCompared} bytes (data section modified at runtime, or a different revision)` : ram.every((b) => b === 0) ? "RAM at the overlay VA is all zero: no overlay loaded yet" : "RAM at the overlay VA matches none of the segments' ROM bytes (self-modified, relocated, or a segment splat does not list)" });
  }
  return { overlays: out, provenance: await provenance(project, reg, sessionKey), note: "detection is by bytes, not by an overlay table: the loaded segment's first bytes must equal its ROM bytes" };
}

/** A live address → symbol, choosing the resident overlay when the VA is shared. */
export async function symbolizeLive(project, { sessionKey, va }) {
  const map = await project.map();
  const r = map.resolveVa(va);
  const isExceptionVa = (va >>> 0) >= 0x80000000 && (va >>> 0) < 0x80000400;
  const exceptionNote = isExceptionVa ? "this PC is in the exception/interrupt vector area (0x80000000-0x800003FF): a frame-boundary sample lands here because the VI interrupt is being serviced; it is NOT the main loop or the code responsible for a memory change" : undefined;
  let segment = null, evidence = null, ambiguous = false;
  if (!r.ok && isExceptionVa) return { va: hx(va), resolved: false, code: "EXCEPTION_VECTOR", exceptionVector: exceptionNote, note: "the exception vectors are not part of any splat segment (the boot code copies them to 0x80000000)" };
  if (r.ok) segment = r.resolved.segment;
  else if (r.code === "AMBIGUOUS_OVERLAY") {
    ambiguous = true;
    const det = await detectOverlays(project, { sessionKey });
    const g = det.overlays.find((o) => r.candidates.some((c) => hx(c.segmentVram) === o.vram));
    if (g?.loaded) { segment = g.loaded; evidence = g.evidence; }
    else return { va: hx(va), resolved: false, code: "AMBIGUOUS_OVERLAY", candidates: r.candidates.map((c) => c.segment), overlayDetection: g, note: "no resident overlay could be identified from RAM; the address stays unresolved rather than guessed" };
  } else return { va: hx(va), resolved: false, code: r.code, error: r.error };
  const fn = await project.resolveFunction({ va, segment }).catch((e) => ({ error: e.message }));
  return { va: hx(va), resolved: true, segment, overlayResolvedBy: ambiguous ? "bytes-in-RAM" : "unique-segment", evidence, symbol: fn.symbol ?? null, romOffset: fn.romOffsetHex ?? null, tu: fn.source?.tu ?? null, state: fn.source?.state ?? null, exceptionVector: exceptionNote };
}

/** Is the session's emulator still there; if not, a machine-readable reason. */
export async function runtimeState(project, { sessionKey }) {
  const { peekSession, hostLifetimeStats } = await import("../mcp/state.js");
  const peek = peekSession(sessionKey);
  const stats = hostLifetimeStats();
  const reg = await registry(sessionKey);
  const st = await callTool(reg, "catalog", { op: "status" }, sessionKey).catch((e) => ({ error: e.message }));
  const loaded = !!st?.loaded;
  let reason = null;
  if (!loaded) reason = peek?.lastMedia ? (st?.serverRecentlyStarted ? "server-restart" : "evicted") : "never-loaded";
  return { session: sessionKey, loaded, lost: !loaded && !!peek?.lastMedia, reason, code: !loaded && peek?.lastMedia ? "LOST_RUNTIME_STATE" : undefined, lastMedia: peek?.lastMedia ?? null, frameCount: st?.frameCount ?? null, romSha1: loaded ? project.m.rom.sha1 : null,
    server: { pid: st?.serverPid ?? null, startedAt: st?.serverStartedAt ?? null, uptimeSeconds: st?.serverUptimeSeconds ?? null, liveHosts: stats?.liveHosts ?? st?.serverHealth?.liveHosts ?? null },
    recovery: !loaded && peek?.lastMedia ? `loadMedia(${JSON.stringify({ platform: peek.lastMedia.platform, path: peek.lastMedia.path })}) then replay the input script (decomp({op:'smoke', scriptPath}) or your own)` : undefined };
}

/**
 * Trace a function on a live session: stop at its entry (PC break), read
 * a0-a3 / f12 / f14 and the stack args, note ra, then stop at ra and read
 * v0/v1/f0. Reports UNSUPPORTED with evidence when the core never stops.
 */
export async function traceFunction(project, { sessionKey, symbol, va, segment, maxFrames = 600, pressDuring }) {
  const reg = await registry(sessionKey);
  const fn = await project.resolveFunction({ symbol, va, segment });
  const prov = await provenance(project, reg, sessionKey);
  const t0 = Date.now();
  const probe = await probeCore(sessionKey);
  if (!probe.pcBreak.supported) {
    return { function: { symbol: fn.symbol, segment: fn.segment, va: fn.vaHex }, captured: false, code: "PC_BREAK_UNSUPPORTED", coreProbe: probe,
      recipe: project.m.platform === "n64" ? "N64 PC breaks need romdev-core-parallel-n64 >= 0.3.0 (the hook is in the default cached-interpreter CPU; no core option needed) — check catalog({op:'status'}) for the core version and update the package" : undefined,
      evidence: `the loaded core does not stop at a PC break (${probe.pcBreak.evidence}) and ${probe.singleStep.supported ? "single-steps" : "does not single-step (" + probe.singleStep.evidence + ")"}: argument/return capture is not available on this core. What IS available: overlays (bytes in RAM), symbolize (live VA), state, smoke (pixels + registers at frame boundaries), and the static call targets below.`,
      staticCallTargets: await staticCallTargets(project, fn), provenance: prov, ms: Date.now() - t0 };
  }
  const hit = await callTool(reg, "breakpoint", { on: "pc", address: fn.va, maxFrames, ...(pressDuring ? { pressDuring } : {}) }, sessionKey);
  const sampledHere = (hit.pcHistogram ?? []).some((h) => parseInt(String(h.pc).replace("$", ""), 16) === fn.va);
  if (!hit.hit) {
    return { function: { symbol: fn.symbol, segment: fn.segment, va: fn.vaHex }, captured: false, code: sampledHere ? "PC_BREAK_UNSUPPORTED" : "NOT_REACHED",
      evidence: sampledHere ? `the frame sampler saw PC=${fn.vaHex} (${hit.pcHistogram.find((h) => parseInt(String(h.pc).replace("$", ""), 16) === fn.va)?.hits} samples) but the core's PC break never fired: parallel_n64's recompiled CPU does not honour PC breaks reliably — argument/return capture is not available on this core` : `PC never reached ${fn.vaHex} within ${hit.framesRun ?? maxFrames} frames (drive the scenario with pressDuring)`,
      framesRun: hit.framesRun, pcHistogram: hit.pcHistogram, mainThreadPc: hit.mainThreadPc, provenance: prov, ms: Date.now() - t0 };
  }
  const cpu = await callTool(reg, "cpu", { op: "read" }, sessionKey);
  const regs = cpu.registers ?? {};
  const val = (n) => regs[n] != null ? parseInt(String(regs[n]).replace("$", ""), 16) >>> 0 : null;
  const sp = val("sp");
  const stackArgs = [];
  if (sp != null) { const b = await readRam(reg, sessionKey, sp + 16, 16, project); for (let i = 0; i < 4; i++) stackArgs.push(hx(b.readUInt32BE(i * 4))); }
  const ra = val("ra");
  const args = { a0: hx(val("a0")), a1: hx(val("a1")), a2: hx(val("a2")), a3: hx(val("a3")), f12: regs.f12 ?? null, f14: regs.f14 ?? null, stack: stackArgs };
  const callTargets = await staticCallTargets(project, fn);
  let ret = null;
  if (ra) {
    const back = await callTool(reg, "breakpoint", { on: "pc", address: ra, maxFrames: 2 }, sessionKey);
    if (back.hit) { const c2 = await callTool(reg, "cpu", { op: "read" }, sessionKey); const r2 = c2.registers ?? {}; ret = { v0: r2.v0, v1: r2.v1, f0: r2.f0 ?? null, atPc: c2.pcHex }; }
    else ret = { captured: false, note: "the return-address break did not fire" };
  }
  return { function: { symbol: fn.symbol, segment: fn.segment, va: fn.vaHex }, captured: true, coreProbe: probe, entry: { pc: cpu.pcHex, args, ra: ra ? hx(ra) : null, frame: hit.framesRun }, returned: ret, staticCallTargets: callTargets, provenance: prov, ms: Date.now() - t0,
    caveats: ["arguments are the register/stack values at entry, typed by nothing: whether a3 or 16(sp) is an argument is the function's business", "the value trace covers one call, not the function"] };
}

/** Static call targets of a function from its asm (jal) or, for a C function, its object's relocations. */
async function staticCallTargets(project, fn) {
  try {
    const asmRel = fn.targetAsm?.path ?? fn.source?.asmPath;
    if (asmRel) { const asm = await readFile(project.abs(asmRel), "utf8"); return [...new Set([...asm.matchAll(/\bjal\s+(\w+)/g)].map((m) => m[1]))]; }
    const { callGraph } = await import("./plan.js");
    const g = await callGraph(project);
    return g.edges[fn.symbol] ?? [];
  } catch { return []; }
}

/**
 * Coverage for a scenario. Instruction-exact when the core exposes its PC
 * coverage log (romdev_cov: every executed PC in a window, distinct-capped
 * per call, so the scenario is run in chunks and unioned) or single-step;
 * otherwise the frame-boundary PC only, and the method line says so.
 * Basic blocks are derived from each function's instruction stream (leaders:
 * entry, branch/jump targets, the instruction after a branch's delay slot).
 * observed = a PC inside the function was executed; unobserved = referenced
 * by a static jal but never executed; unreferenced = no static caller at all.
 */
export async function coverage(project, { sessionKey, frames = 600, inputs = [], stepBudget = 200000, chunkFrames = 10 }) {
  const reg = await registry(sessionKey);
  const { callGraph } = await import("./plan.js");
  const g = await callGraph(project);
  const ld = await project.linkerMap();
  const prov = await provenance(project, reg, sessionKey);
  const probe = await probeCore(sessionKey);
  const { getHostOrNull } = await import("../mcp/state.js");
  const host = getHostOrNull(sessionKey);
  const covBitmap = !!host?.pcBitmapSupported?.();
  const covLog = covBitmap || !!host?.rangeWatchSupported?.();
  const funcs = [...ld.symbols.values()].filter((s) => s.section === ".text" && s.size && !s.name.endsWith(".NON_MATCHING")).sort((a, b) => a.va - b.va);
  const findFn = (pc) => { let lo = 0, hi = funcs.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; const f = funcs[m]; if (pc < f.va) hi = m - 1; else if (pc >= f.va + f.size) lo = m + 1; else return f; } return null; };
  const script = [...inputs].sort((a, b) => a.frame - b.frame);
  const pcs = new Set(); const hits = new Map(); let samples = 0, exceptionSamples = 0, instructionSamples = 0, truncatedChunks = 0;
  const t0 = Date.now();
  const record = (pc) => { samples++; if (pc >= 0x80000000 && pc < 0x80000400) { exceptionSamples++; return; } pcs.add(pc); const f = findFn(pc); if (f) hits.set(f.name, (hits.get(f.name) ?? 0) + 1); };
  // Code window for the PC log: every .text VA of the map.
  const lo = funcs[0]?.va ?? 0x80000000, hi = funcs.length ? funcs[funcs.length - 1].va + funcs[funcs.length - 1].size : 0x80400000;
  let si = 0, at = 0;
  while (at < frames) {
    while (si < script.length && script[si].frame <= at) { await callTool(reg, "input", { op: "set", ports: [script[si].buttons] }, sessionKey); si++; }
    const nextInput = si < script.length ? script[si].frame : frames;
    const step = Math.max(1, Math.min(covLog ? chunkFrames : 1, nextInput - at, frames - at));
    if (covBitmap) {
      // Exact: one bit per word over the whole code window, no cap.
      const r = host.logPCBitmap(lo, hi, step);
      for (const pc of r.pcs) record(pc >>> 0);
      instructionSamples += r.total;
    } else if (covLog) {
      const r = host.logPCRange(lo, hi, step);
      for (const pc of r.pcs) record(pc >>> 0);
      instructionSamples += r.total ?? r.pcs.length;
      // The core's distinct-PC ring holds 8192 entries; a chunk that fills it exactly lost PCs too.
      if (r.truncated || r.distinct >= 8192 || r.pcs.length >= 8192) truncatedChunks++;
    } else {
      await callTool(reg, "frame", { op: "step", frames: step }, sessionKey);
      const cpu = await callTool(reg, "cpu", { op: "read" }, sessionKey);
      if (cpu?.pc != null) record(cpu.pc >>> 0);
      if (probe.singleStep.supported && instructionSamples < stepBudget) {
        const n = Math.min(4096, stepBudget - instructionSamples);
        for (let i = 0; i < n; i++) { const r = host.stepInstruction(); if (r?.pc == null) break; record(r.pc >>> 0); instructionSamples++; }
      }
    }
    at += step;
  }
  // Basic blocks for the observed functions (asm from the .s; C from the build object).
  const blocks = [];
  let blocksTotal = 0, blocksObserved = 0;
  for (const [name] of hits) {
    try {
      const fn = await project.resolveFunction({ symbol: name });
      const stream = await instructionStream(project, fn);
      if (!stream.length) continue;
      const bb = basicBlocks(stream, fn.va);
      const obs = bb.map((b) => ({ ...b, observed: [...pcs].some((pc) => pc >= b.start && pc < b.end) }));
      blocksTotal += bb.length; blocksObserved += obs.filter((b) => b.observed).length;
      blocks.push({ symbol: name, blocks: obs.length, observed: obs.filter((b) => b.observed).length, unobserved: obs.filter((b) => !b.observed).map((b) => hx(b.start)).slice(0, 12) });
    } catch {}
  }
  const observed = [...hits.entries()].map(([name, n]) => ({ symbol: name, samples: n, state: g.state[name] ?? null, bytes: g.sizes[name] ?? null })).sort((a, b) => b.samples - a.samples);
  const referenced = new Set(Object.keys(g.callers));
  const unobserved = funcs.filter((f) => !hits.has(f.name) && referenced.has(f.name)).map((f) => f.name);
  const unreferenced = funcs.filter((f) => !hits.has(f.name) && !referenced.has(f.name)).map((f) => f.name);
  const outDir = path.join(project.ws, "coverage");
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const method = covBitmap
    ? `instruction-exact: the core's PC coverage BITMAP (one bit per word over [${hx(lo)}, ${hx(hi)}), uncapped) — every executed instruction in the scenario is recorded`
    : covLog
    ? `instruction-exact within the ring: the core's PC coverage log (romdev_cov) over [${hx(lo)}, ${hx(hi)}) in ${chunkFrames}-frame chunks, distinct PCs unioned${truncatedChunks ? ` — ${truncatedChunks} chunk(s) filled the core's 8192-distinct-PC ring: PCs beyond the ring were lost in those chunks (use chunkFrames:1, or a narrower window)` : ""}`
    : probe.singleStep.supported
      ? `frame-boundary PC every frame + up to ${stepBudget} single-stepped instructions`
      : `frame-boundary PC only: this core does not single-step (${probe.singleStep.evidence}) and does not stop at a PC break (${probe.pcBreak.evidence}); in-frame execution is INVISIBLE to this measurement`;
  const report = { method, coreProbe: probe, coverageSource: covBitmap ? "bitmap" : covLog ? "ring" : "frame-boundary", frames, inputs: script.length, samples, distinctPcs: pcs.size, instructionSamples, exceptionVectorSamples: exceptionSamples, truncatedChunks,
    functions: { total: funcs.length, observed: observed.length, unobserved: unobserved.length, unreferenced: unreferenced.length },
    basicBlocks: covLog || probe.singleStep.supported ? { available: true, total: blocksTotal, observed: blocksObserved, perFunction: blocks.sort((a, b) => b.blocks - a.blocks).slice(0, 40) } : { available: false, reason: "no instruction-level PC source on this core" },
    observed: observed.slice(0, 60), unobservedTop: unobserved.slice(0, 40), unreferencedTop: unreferenced.slice(0, 40),
    distinction: "unobserved = has a static caller (R_MIPS_26) and was never executed in this scenario; unreferenced = no static caller anywhere (jump-table/function-pointer target or dead code) — neither is proof of unreachability",
    honesty: samples > 0 && exceptionSamples === samples ? "every sample was the exception vector: this scenario observed NO game function" : undefined,
    provenance: prov, ms: Date.now() - t0, file };
  await writeFile(file, JSON.stringify(report, null, 2));
  return report;
}

/** The function's instruction stream: from its extracted asm, else from the build object. */
async function instructionStream(project, fn) {
  const asmRel = fn.targetAsm?.path ?? fn.source?.asmPath;
  if (asmRel) { const { parseSplatAsm } = await import("./splat-map.js"); return parseSplatAsm(await readFile(project.abs(asmRel), "utf8")).instructions.map((i) => ({ va: i.va, word: i.word, text: i.text })); }
  if (!fn.object) return [];
  const { dumpObject, findSymbol, symbolTable, trimToSize } = await import("./mips-obj.js");
  const objdump = project.m.toolchain.objdump?.path ?? "mips-linux-gnu-objdump";
  const d = await dumpObject({ objdump, objPath: project.abs(fn.object), cwd: project.root, env: project.env });
  const sym = findSymbol(d, fn.symbol); if (!sym) return [];
  const syms = await symbolTable({ objdump, objPath: project.abs(fn.object), cwd: project.root, env: project.env });
  return trimToSize(sym.instructions, syms.get(fn.symbol)?.size ?? 0).map((i) => ({ va: fn.va + (i.offset - sym.offset), word: i.word, text: `${i.mnemonic} ${i.operands}` }));
}

/** Basic blocks from a MIPS instruction stream: leaders = entry, branch targets, post-delay-slot successors. */
export function basicBlocks(stream, baseVa) {
  const n = stream.length;
  const leaders = new Set([0]);
  for (let i = 0; i < n; i++) {
    const w = stream[i].word >>> 0;
    const op = w >>> 26;
    const isBranch = (op >= 1 && op <= 7) || (op >= 20 && op <= 23) || (op === 17 && ((w >>> 21) & 0x1f) === 8); // REGIMM/beq/bne/blez/bgtz/…l, bc1
    const isJ = op === 2 || op === 3;
    const isJr = op === 0 && ((w & 0x3f) === 8 || (w & 0x3f) === 9);
    if (isBranch) { const off = (w << 16) >> 16; const t = i + 1 + off; if (t >= 0 && t < n) leaders.add(t); if (i + 2 < n) leaders.add(i + 2); }
    else if (isJ || isJr) { if (i + 2 < n) leaders.add(i + 2); if (isJ) { const target = (((baseVa + (i + 1) * 4) & 0xf0000000) | ((w & 0x03ffffff) << 2)) >>> 0; const idx = (target - baseVa) / 4; if (idx >= 0 && idx < n) leaders.add(idx); } }
  }
  const idx = [...leaders].sort((a, b) => a - b);
  return idx.map((s, k) => ({ start: baseVa + s * 4, end: baseVa + (idx[k + 1] ?? n) * 4, instructions: (idx[k + 1] ?? n) - s }));
}
