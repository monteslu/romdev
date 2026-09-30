// binasm-cli.js - `inspect-binasm` (pass binasm / binasm inspect): one
// retained IDO Binasm peephole boundary, with optional -peepdbg and barrier
// probe evidence.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { buildBinasmBoundaryReport } from "./binasm.js";
import { ArgumentTypeError } from "./argparse.js";
import { dumps } from "./pyjson.js";
import { isInputError, osErrorText, pyInt, strRepr } from "./py.js";

function integer(value) {
  try { return pyInt(value, 0); } catch { throw new ArgumentTypeError(`expected a decimal or 0x-prefixed integer, got ${strRepr(value)}`); }
}
integer.displayName = "_integer";

const pyDictText = (d) => (Object.keys(d).length ? "{" + Object.entries(d).map(([k, v]) => `${strRepr(k)}: ${v}`).join(", ") + "}" : "none");

export function binasmBoundaryCommand(args, io) {
  let report;
  try {
    const peepText = args.peep_log ? readFileSync(args.peep_log, "utf8") : null;
    let probe = null;
    if (args.probe_results) {
      const text = readFileSync(args.probe_results, "utf8");
      try { probe = JSON.parse(text); } catch (e) { io.eprint(`error: ${e.message}`); return 2; }
    }
    report = buildBinasmBoundaryReport(args.stream, { boundary: args.boundary, radius: args.radius, byteorder: args.byteorder, peep_text: peepText, probe_results: probe, limit: args.limit });
  } catch (e) {
    if (!isInputError(e)) throw e;
    io.eprint(`error: ${e?.code ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) { io.print(dumps(report)); return 0; }
  const s = report.stream, b = report.boundary;
  io.print(`Binasm: ${s.record_count} record(s), ${s.bytes} bytes, sha256=${s.sha256.slice(0, 12)}`);
  io.print(`boundary: ${b.offset_hex} before record ${b.record_index}`);
  for (const item of b.window) {
    const lever = item.source_lever ? `; lever=${item.source_lever}` : "";
    io.print(`${item.boundary_before ? ">" : " "} ${item.offset_hex.padStart(8)} #${String(item.index).padStart(4, "0")} ${item.raw_hex}  ${item.name}: ${item.detail}${lever}`);
  }
  const p = report.peephole;
  if (p) {
    io.print(`peephole: events=${p.event_count} replacement+NOP pairs=${p.replacement_nop_pair_count} unparsed=${p.unparsed_debug_line_count}`);
    for (const pair of p.replacement_nop_pairs) {
      const r = pair.replacement, removed = pair.removed_copy;
      io.print(`  ${r.family} INST ${r.inst} registers ${r.register}/${r.with_register}; INST ${removed.inst} -> NOP`);
    }
    io.print(`  scope: ${p.correlation_scope}`);
  }
  const probes = report.barrier_probes;
  if (probes) {
    io.print(`barrier probes: ${probes.exact_count}/${probes.probe_count} exact; families=${pyDictText(probes.family_counts)}; sites=${pyDictText(probes.site_counts)}`);
    for (const l of probes.source_search) io.print(`  next (${l.family}, ${l.exact_count} exact): ${l.next}`);
    io.print(`  claim: ${probes.strongest_claim}`);
  }
  io.print(`proof: ${report.proof}`);
  return 0;
}

export const COMMAND_SPECS = [{
  path: ["inspect-binasm"], handler: binasmBoundaryCommand,
  help: "inspect one retained IDO Binasm peephole boundary",
  description: "Read IDO's fixed 16-byte ugen-to-as1 stream around one insertion boundary, optionally summarize -peepdbg output and exact barrier probe results. This command is static and does not run a compiler.",
  arguments: [
    { dest: "stream", help: "retained Binasm stream (commonly .G)" },
    { flags: ["--boundary"], required: true, type: integer, help: "aligned byte insertion offset, decimal or 0x-prefixed" },
    { flags: ["--radius"], type: "int", default: 4, help: "records shown before and after the boundary (default: 4)" },
    { flags: ["--byteorder"], choices: ["big", "little"], default: "big", help: "word byte order (default: big, as used by N64 IDO streams)" },
    { flags: ["--peep-log"], help: "optional IDO 7.1 -peepdbg stdout/stderr capture" },
    { flags: ["--probe-results"], help: "optional barrier sweep JSON containing results[].exact/name" },
    { flags: ["--limit"], type: "int", default: 50, help: "maximum peephole/probe evidence rows retained (default: 50)" },
    { flags: ["--json"], action: "store_true", help: "emit JSON" },
  ],
}];
