#!/usr/bin/env node
/**
 * Dreamcast WASM SH-4 JIT perf driver.
 *
 * Measures raw throughput of the flycast core on discs from your own library
 * and reads the profiling exports the JIT sprint added (romdev_jit_stats /
 * romdev_aica_prof_ms / romdev_gpu_prof_ms) to attribute frame time to SH-4 vs
 * the interpreted AICA (ARM7) vs the TA-parse/GL path.
 *
 * NOT a pass/fail unit test — a measurement harness. It drives LibretroHost
 * in-process (the same class, core and wasm the MCP server's loadMedia uses; see
 * src/mcp/tools/lifecycle.js) because those profiling counters are raw wasm
 * exports with no MCP tool surface. It lives in test/ rather than a scratchpad
 * because the previous run's driver was lost to a /tmp wipe.
 *
 *   ROMDEV_DC_DISCS=/path/to/your/dreamcast/discs \
 *     node test/dreamcast-jit-perf.js [--frames N] [name-substring ...]
 *
 * ROMDEV_DC_DISCS is a directory to scan (one level deep, so redump-style
 * per-disc folders work) or a colon-separated list of disc paths. No disc is
 * bundled or named here — supply your own.
 *
 * The staged core must be a JIT build — that is build-flycast.sh's default, so a
 * plain rebuild gives you one. Against an interpreter build
 * (ROMDEV_FLYCAST_INTERP=1) the jit counters read 0 and it says so.
 */

import crypto from "node:crypto";
import path from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { LibretroHost } from "romdev-core-host/index.js";
import { resolveCore } from "../src/cores/registry.js";

/** Hash the current framebuffer — the cheapest "did anything actually change?" probe. */
function fbSignature(host) {
  try {
    const fb = host.getFramebuffer();
    const buf = fb?.pixels ?? fb?.data;
    if (!ArrayBuffer.isView(buf)) return "nofb";
    // Hash the VIEW, not buf.buffer — on hwRender cores the backing ArrayBuffer
    // is a reused staging buffer, so hashing it can mask a real frame change.
    return crypto.createHash("md5")
      .update(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))
      .digest("hex").slice(0, 12);
  } catch (e) {
    return `err:${String(e.message).slice(0, 20)}`;
  }
}

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const FRAMES = Number(arg("--frames", 600));
const WARMUP = Number(arg("--warmup", 180));

// Discs come from YOUR library, named by env — nothing about a specific title
// is baked in here. Point ROMDEV_DC_DISCS at a directory (every .gdi/.chd/.cue
// under it is measured, labelled by filename) or give a colon-separated list of
// individual disc paths. Aim for a MIXED set: .gdi + .chd + .cue containers,
// and include a music/rhythm game if you have one — that is the worst case for
// the still-interpreted AICA.
const DC = process.env.ROMDEV_DC_DISCS;
const DISC_RE = /\.(gdi|chd|cue)$/i;

function discoverGames(spec) {
  if (!spec) return [];
  if (spec.includes(":") && !existsSync(spec)) {
    return spec.split(":").filter(Boolean).map((p) => [path.basename(p).replace(DISC_RE, ""), p]);
  }
  if (!existsSync(spec)) return [];
  if (!statSync(spec).isDirectory()) return [[path.basename(spec).replace(DISC_RE, ""), spec]];
  // One level of nesting: redump-style sets put each disc in its own folder.
  const out = [];
  for (const e of readdirSync(spec, { withFileTypes: true })) {
    const full = path.join(spec, e.name);
    if (e.isFile() && DISC_RE.test(e.name)) out.push([e.name.replace(DISC_RE, ""), full]);
    else if (e.isDirectory()) {
      for (const inner of readdirSync(full)) {
        if (DISC_RE.test(inner)) out.push([inner.replace(DISC_RE, ""), path.join(full, inner)]);
      }
    }
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

const GAMES = discoverGames(DC);

/**
 * Read the JIT/AICA/GPU profiling counters off the core Module.
 * The *_prof_ms exports reset on read(1), so each call returns the delta since
 * the previous call. Missing exports report null rather than a misleading 0.
 */
function readProf(mod) {
  const call = (fn, a) => (typeof mod[`_${fn}`] === "function" ? mod[`_${fn}`](a) : null);
  return {
    fallbacks: call("romdev_jit_stats", 0),
    blocks: call("romdev_jit_stats", 1),
    aicaMs: call("romdev_aica_prof_ms", 1),
    gpuMs: call("romdev_gpu_prof_ms", 1),
  };
}

async function measure(label, path) {
  console.log(`\n=== ${label} ===`);
  const resolved = resolveCore("dreamcast");
  if (!resolved) throw new Error("no dreamcast core resolved");

  const host = new LibretroHost();
  try {
    await host.loadCore(resolved.jsPath, resolved.wasmPath, {
      hwRender: resolved.hwRender,
      noderawfs: resolved.noderawfs,
    });
    await host.loadMedia({ platform: "dreamcast", path });

    // Warm up: boot the disc and let the JIT compile its hot blocks. Timing the
    // first frames would measure block compilation, not steady-state execution.
    const w0 = Date.now();
    host.stepFrames(WARMUP);
    const warmMs = Date.now() - w0;

    readProf(host.mod); // clear the accumulators

    const t0 = Date.now();
    host.stepFrames(FRAMES);
    const wallMs = Date.now() - t0;

    const prof = readProf(host.mod);
    const fps = FRAMES / (wallMs / 1000);
    const pct = (ms) => `${((ms / wallMs) * 100).toFixed(1)}%`;

    console.log(`  warmup   ${WARMUP} frames in ${warmMs}ms (${(WARMUP / (warmMs / 1000)).toFixed(1)} fps)`);
    console.log(`  measured ${FRAMES} frames in ${wallMs}ms  ->  ${fps.toFixed(1)} fps  (${(wallMs / FRAMES).toFixed(2)} ms/frame)`);
    if (prof.blocks == null) {
      console.log(`  [no romdev_jit_stats export — interpreter build, or stale core]`);
    } else {
      console.log(`  JIT blocks executed:   ${prof.blocks}`);
      console.log(`  SHIL interp fallbacks: ${prof.fallbacks}`);
    }
    if (prof.aicaMs == null) console.log(`  [no romdev_aica_prof_ms export]`);
    else console.log(`  AICA (interpreted ARM7): ${Number(prof.aicaMs).toFixed(0)}ms  ${pct(prof.aicaMs)}`);
    if (prof.gpuMs == null) console.log(`  [no romdev_gpu_prof_ms export]`);
    else console.log(`  GPU  (TA-parse + GL):    ${Number(prof.gpuMs).toFixed(0)}ms  ${pct(prof.gpuMs)}`);

    // LIVENESS GATE — an fps number is meaningless if the core stopped executing.
    // A hung JIT "runs" 600 frames in 20ms and reads as 30000 fps, so we must
    // prove the core is doing work before quoting any number.
    //
    // The AUTHORITY here is the SH-4 block counter, NOT the framebuffer. A static
    // framebuffer does NOT imply a hang: discs that park on a VMU "create a new
    // file" prompt or sit on a license screen hold a fixed picture while the CPU
    // executes ~100M blocks per 300 frames. Judging those by pixels alone
    // reports a false "HUNG" for a core that is running fine.
    // Three distinct states, reported separately:
    //   RUNNING  — blocks advance and the picture changes.
    //   STATIC   — blocks advance, picture frozen: alive, waiting (input/disc).
    //              The fps number is REAL.
    //   HUNG     — blocks frozen: the SH-4 stopped. The fps number is garbage.
    const sigs = new Set();
    const blocksBefore = prof.blocks;
    for (let i = 0; i < 4; i++) {
      host.stepFrames(30);
      sigs.add(fbSignature(host));
    }
    const blocksAfter = typeof host.mod._romdev_jit_stats === "function"
      ? host.mod._romdev_jit_stats(1) : null;
    const cpuAlive = blocksAfter == null ? null : blocksAfter !== blocksBefore;
    const picMoving = sigs.size > 1;
    const state = cpuAlive === false ? "HUNG" : picMoving ? "RUNNING" : "STATIC";

    console.log(`  liveness: ${state} — ${sigs.size} distinct framebuffer(s) over 4 samples` +
      (blocksAfter != null ? `, SH-4 blocks ${cpuAlive ? "advancing" : "FROZEN"}` : ""));
    if (state === "HUNG") {
      console.log(`  *** The SH-4 stopped executing — ${fps.toFixed(0)} fps is an idle loop, NOT emulation speed.`);
    } else if (state === "STATIC") {
      console.log(`  (picture static but CPU running — waiting on input/disc; the fps above is real)`);
    }

    return { label, fps, wallMs, prof, state, alive: state !== "HUNG" };
  } finally {
    try { host.dispose?.(); } catch { /* best effort */ }
  }
}

if (!GAMES.length) {
  console.error(
    DC
      ? `No .gdi/.chd/.cue discs found under ROMDEV_DC_DISCS='${DC}'.`
      : "Set ROMDEV_DC_DISCS to a directory of Dreamcast discs (or a colon-separated\n"
        + "list of disc paths) to measure. This harness bundles no discs of its own.",
  );
  process.exit(1);
}

const want = argv.filter((a) => !a.startsWith("--") && !/^\d+$/.test(a));
const list = want.length
  ? GAMES.filter(([n]) => want.some((w) => n.toLowerCase().includes(w.toLowerCase())))
  : GAMES;

const results = [];
// `discPath`, not `path` — that name is the node:path import used by discovery.
for (const [label, discPath] of list) {
  try {
    results.push(await measure(label, discPath));
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}

console.log("\n=== SUMMARY ===");
for (const r of results) {
  const verdict = r.state === "HUNG"
    ? `HUNG (reported ${r.fps.toFixed(0)} fps is an idle loop, not speed)`
    : `${r.fps.toFixed(1)} fps${r.state === "STATIC" ? "  [picture static, CPU running]" : ""}`;
  console.log(`  ${r.label.padEnd(20)} ${verdict}`);
}
if (results.some((r) => r.state === "HUNG")) process.exitCode = 1;
