// frame({op:'traceInstructions'}) - the instruction stream a host REALLY
// executes over N frames, in one call.
//
// On a core: the free-running instruction trace (romdev_trace_*): every
// executed pc and the core's clock at its dispatch, recorded while the
// machine runs normally. stepInstructions cannot give this: each stepped
// instruction freezes the CPU while the rest of the machine finishes the
// frame. On a recompiled wasmcart: the trace ring its romdev.recompile
// section declares, armed for the run and read back in execution order.
//
// Replaces the earlier Python reference/cart pc dumpers (refdump.py, refseq.py,
// snes_reftrace.py, snes_pcdump.py, cosim reference captures).

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getHost, getHostBOrNull } from "../state.js";
import { jsonContent } from "../util.js";
import { readRecompileLayout } from "../../analysis/recompile/recompile-section.js";
import { traceDescriptor, armCartTrace, readCartTrace } from "../../host/instruction-diverge.js";

const hex = (v, w) => (v >>> 0).toString(16).toUpperCase().padStart(w, "0");

/** Visited pcs folded into ranges with hit counts (the loop map). */
function pcRanges(pcs, width, gap = 4) {
  const counts = new Map();
  for (const p of pcs) counts.set(p, (counts.get(p) || 0) + 1);
  const ranges = [];
  for (const pc of [...counts.keys()].sort((a, b) => a - b)) {
    const last = ranges[ranges.length - 1];
    if (last && pc <= last.end + gap) { last.end = pc; last.hits += counts.get(pc); }
    else ranges.push({ start: pc, end: pc, hits: counts.get(pc) });
  }
  return ranges.map((r) => ({ from: "$" + hex(r.start, width), to: "$" + hex(r.end, width), hits: r.hits }));
}

/**
 * @param {string} sessionKey
 * @param {{frames?:number, slot?:'a'|'b', maxEntries?:number, fromPc?:number, outputPath?:string, head?:number}} a
 */
export async function traceInstructionsCore(sessionKey, a = {}) {
  const host = a.slot === "b" ? getHostBOrNull(sessionKey) : getHost(sessionKey);
  if (!host) throw new Error("frame({op:'traceInstructions', slot:'b'}): no host in slot B (loadMedia({slot:'b'}) first)");
  const frames = a.frames ?? 1;
  if (frames > 600) throw new Error("frame({op:'traceInstructions'}): frames is capped at 600 per call (a trace is ~10-300k instructions per frame); trace in pieces, or step to the window first with frame({op:'step'})");
  const platform = host.status?.platform;
  let pcs, clocks, recorded, lost = 0, source, width = 4;
  if (platform === "wasmcart") {
    const layout = host.status?.mediaPath ? readRecompileLayout(host.status.mediaPath) : null;
    if (!layout) throw new Error("frame({op:'traceInstructions'}) on a wasmcart needs a recompiled cart whose romdev.recompile section declares its trace ring");
    const d = traceDescriptor(layout, layout.reference ?? layout.platform);
    const st = armCartTrace(host, d);
    await host.stepFrames(frames);
    const ct = readCartTrace(host, d, st);
    pcs = ct.entries.map((e) => e.pc); clocks = ct.entries.map((e) => e.clock);
    recorded = ct.recorded; lost = ct.recorded - ct.kept;
    source = `cart ring (${d.source}: ${d.entries} entries)`;
    width = d.pc.mask && d.pc.mask <= 0xffff ? 4 : 6;
  } else {
    if (!host.traceSupported?.()) throw new Error(`frame({op:'traceInstructions'}): the ${platform} core build does not record an instruction trace (romdev_trace_*). Rebuilt so far: fceumm (nes), gambatte (gb/gbc), snes9x (snes), genesis_plus_gx (genesis/sms/gg), mgba (gba).`);
    const cap = Math.max(4096, Math.min(1 << 22, a.maxEntries ?? (1 << 21)));
    host.setTrace({ capacity: cap });
    try { await host.stepFrames(frames); }
    finally {
      const t = host.readTrace(0);
      host.setTrace({ enabled: false });
      pcs = Array.from(t.pc); clocks = Array.from(t.clock); recorded = t.to - t.from + t.lost; lost = t.lost;
    }
    source = "core instruction trace (free-running)";
    width = ["genesis", "snes"].includes(platform) ? 6 : platform === "gba" ? 8 : 4;
  }
  let start = 0;
  if (a.fromPc != null) {
    start = pcs.indexOf(a.fromPc >>> 0);
    if (start < 0) return jsonContent({ traced: true, frames, recorded, found: false, note: `pc $${hex(a.fromPc, width)} was not executed in these ${frames} frame(s)`, pcRanges: pcRanges(pcs, width).slice(0, 64) });
  }
  const outPcs = pcs.slice(start), outClk = clocks.slice(start);
  const head = Math.min(a.head ?? 64, outPcs.length);
  let written = null;
  if (a.outputPath) {
    mkdirSync(path.dirname(path.resolve(a.outputPath)), { recursive: true });
    const lines = new Array(outPcs.length);
    for (let k = 0; k < outPcs.length; k++) lines[k] = outClk[k] != null ? `${hex(outPcs[k], width)} ${outClk[k]}` : hex(outPcs[k], width);
    writeFileSync(a.outputPath, lines.join("\n") + "\n");
    written = path.resolve(a.outputPath);
  }
  const ranges = pcRanges(outPcs, width);
  return jsonContent({
    traced: true, source, platform, frames,
    recorded, ...(lost ? { lost, lostNote: `the oldest ${lost} entries were overwritten (ring capacity); raise maxEntries or trace fewer frames` } : {}),
    count: outPcs.length, ...(a.fromPc != null ? { fromIndex: start } : {}),
    head: outPcs.slice(0, head).map((p, k) => (outClk[k] != null ? `$${hex(p, width)} @${outClk[k]}` : `$${hex(p, width)}`)),
    pcRanges: ranges.length > 128 ? ranges.slice(0, 128) : ranges, ...(ranges.length > 128 ? { pcRangesTruncated: ranges.length } : {}),
    ...(written ? { outputPath: written, fileFormat: "one line per executed instruction: HEXPC [clock]" } : { note: "pass outputPath to write every entry to a file (one line per instruction)" }),
  });
}
