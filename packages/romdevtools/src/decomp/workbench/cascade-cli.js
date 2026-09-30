// cascade-cli.js - the allocator decision cascade journey over one CDX log:
// trace-cascade (every round of one site), trace-order (the p1 colouring
// order and its same-save ties), trace-blocks (occurrence-block sets and
// their intersection) and trace-frame (the frame ladder and its itable
// operation stream).
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import {
  RECORD_GRAMMAR, CascadeError, CdxLog, blockReport, colorOrderReport, costRows, parseFrameOffset, parseRowRange,
  romColorOccupancy, colorName, fmtF,
} from "./cascade.js";
import { SYMTAB_RECORD_GRAMMAR, frameLadder, ladderLines, opReport, parseSlotNames } from "./frame-ladder.js";
import { FP_COLOR_REGISTERS, formatG } from "./globalcolor.js";
import { emitLines } from "./terminal.js";
import { dumps } from "./pyjson.js";
import { pyInt, pyRound, pyEq, sorted, hex, isInputError, osErrorText, fixed, splitWs } from "./py.js";
import * as O from "./cli-options.js";

const CLASS_NAMES = new Map([[1, "integer"], [2, "float"]]);

export const ARITHMETIC_POINTER = "The arithmetic these fields carry is specified in "
  + "docs/p1-decision-arithmetic.md; the record grammar is "
  + "`trace-cascade --grammar`.";

function wrap(text, width) {
  const lines = [];
  let current = "";
  for (const word of splitWs(text)) {
    const candidate = `${current} ${word}`.trim();
    if (candidate.length > width && current) { lines.push(current); current = word; } else current = candidate;
  }
  if (current) lines.push(current);
  return lines;
}

/** The record grammar the cascade commands read, as `--grammar` prints it. */
export function grammarText() {
  const lines = [
    "CDX record grammar read by the cascade commands.",
    "",
    "SHIPPED records come from `decomp-workbench instrument-uopt`.",
    "CAMPAIGN-LOCAL records come from a uopt.c patch this project does",
    "not ship (WB-15): the workbench owns the reading, not the",
    "instrument. A log without them still gives rounds, colours, and",
    "the kill signal; the save arithmetic needs them.",
    "",
  ];
  for (const [kind, description] of [...Object.entries(RECORD_GRAMMAR), ...Object.entries(SYMTAB_RECORD_GRAMMAR)]) {
    lines.push(`[CDX] ${kind}`);
    for (const line of wrap(description, 68)) lines.push(`    ${line}`);
    lines.push("");
  }
  lines.push(ARITHMETIC_POINTER);
  return lines.join("\n");
}

const word32 = (n) => `0x${hex(Number(BigInt(n) & 0xFFFFFFFFn), 8)}`;

/** Turn the site options into exactly one keyed lookup. */
export function siteArguments(args) {
  if (args.frame_offset !== null && args.frame_offset !== undefined) {
    const named = parseFrameOffset(args.frame_offset);
    if (args.slot !== null && args.frame !== null) {
      const derived = args.slot + args.frame;
      if (derived !== named) {
        throw new CascadeError(`--frame-offset names frame offset ${named} (${word32(named)}), but --slot ${args.slot} `
          + `--frame ${args.frame} derives ${derived} (${word32(derived)}). Name one site: drop `
          + "--frame-offset, or drop --frame and let --slot narrow the screen line only.");
      }
    }
    return { frame_offset: named, symbol: args.symbol_id, web: args.web };
  }
  let offset = null;
  if (args.slot !== null && (args.frame !== null || (args.symbol_id === null && args.web === null))) {
    if (args.frame === null) {
      throw new CascadeError("--slot is an sp-relative offset, so it needs --frame to name a site: --slot 1184 --frame -1704 is frame offset -520 "
        + "(0xfffffdf8). The frame is the prologue's `addiu sp,sp,-N`, which `decomp-workbench score` prints. To use --slot only "
        + "for the screen line, name the site another way.");
    }
    offset = args.slot + args.frame;
  }
  return { frame_offset: offset, symbol: args.symbol_id, web: args.web };
}

const colors = (list) => (list.length ? list.map((c) => colorName(c)).join(" ") : "-");
const classText = (v) => (v === null ? "class=?" : `class=${v}(${CLASS_NAMES.get(v) ?? "unknown"})`);
const dash = (v) => (v === null || v === undefined ? "-" : String(v));
const pyS = (v) => (v === null || v === undefined ? "None" : v === true ? "True" : v === false ? "False" : String(v));

function detailLine(detail, { label }) {
  if (detail === null) return [`  ${label}: no savedetail record -- this log carries the shipped profile only, so the save arithmetic is not available`];
  const lines = [`  ${label}: gross ${fmtF(detail.gross, 3)} - chargeA ${fmtF(detail.charge_a, 3)} - chargeB ${fmtF(detail.charge_b, 3)} = net ${fmtF(detail.net, 3)}`
    + `   over ${detail.occurrence_count} occurrence(s), nocs ${detail.nocs}`];
  if (detail.charge_b > 0) {
    const contributors = detail.charge_b_contributors;
    if (detail.charge_b_accounted) {
      const named = contributors.map((i) => `occ${i.index}@bb${i.block}x${formatG(i.weight)}`).join(", ");
      lines.push(`    chargeB is a store-placement term (L92), paid by ${contributors.length} occurrence(s): ${named}`);
    } else if (detail.occurrences.length) {
      lines.push(`    chargeB gate (L92) does not reproduce the recorded ${fmtF(detail.charge_b, 3)} from this occurrence list; reporting `
        + "the pass's number, not a derived attribution");
    }
  }
  return lines;
}

function headroomLines(item) {
  const lines = [`  headroom: net must fall by ${fmtF(item.deficit, 3)} to reach bestcost ${fmtF(item.best_cost, 3)}. Only chargeA and chargeB can do it -- every `
    + "term in gross is non-negative."];
  const d = item.entering;
  if (d !== null && d.nocs) {
    lines.push(`    at nocs ${d.nocs}, removing occurrences lowers gross and therefore save (rank), and cannot raise it: the divisor floor is 2 (L29).`);
  }
  return lines;
}

function roundLines(item, { headroom }) {
  const lines = [
    `round ${item.index}  w${item.web}  ${classText(item.register_class)}  decision=${item.decision}  (trace decision #${item.ordinal})`,
    `  ${item.inequality}`,
    `  save ${fmtF(item.save, 6)}  nocs ${item.nocs}  regsleft ${dash(item.registers_left)}  numintf ${dash(item.interference)}`,
    `  natural ${colorName(item.natural_color)}   taken ${colorName(item.resolved_color)}`
      + (item.resolution_differs ? "   <- the natural colour is NOT what the web got; `bestcolor` is the pre-resolution field" : ""),
    `  forbidden ${colors(item.forbidden)}`,
    `  min-cost tie ${colors(item.mincost_tie)}`,
  ];
  lines.push(...detailLine(item.entering, { label: "entering" }));
  for (const p of item.pieces) {
    lines.push(`  piece left memory-resident: w${p.web} net ${fmtF(p.net, 3)} (gross ${fmtF(p.gross, 3)} chargeA ${fmtF(p.charge_a, 3)} `
      + `chargeB ${fmtF(p.charge_b, 3)}, ${p.occurrence_count} occ)`);
  }
  if (headroom && !item.declined && Number.isFinite(item.deficit)) lines.push(...headroomLines(item));
  return lines;
}

function occurrenceLines(detail) {
  if (!detail.occurrences.length) return ["  occurrences: no saveocc records for this round (campaign-local grammar; see --grammar)"];
  const lines = ["  occ   bb          uses defs weight term    nl o22 o23 w34  chargeB"];
  const L = (v, n) => String(v).padEnd(n);
  for (const i of detail.occurrences) {
    lines.push(`  ${L(i.index, 5)} ${L(i.block, 11)} ${L(i.uses, 4)} ${L(i.defs, 4)} ${formatG(i.weight).padEnd(6)} ${formatG(i.term).padEnd(7)} `
      + `${L(i.nl, 2)} ${L(i.o22, 3)} ${L(i.o23, 3)} ${L(i.w34, 3)}  ${i.charges_b ? "PAYS" : "-"}`);
  }
  return lines;
}

function costLines(cascade, item) {
  const rows = costRows(cascade.costs.get(item.web) ?? []);
  if (!rows.length) return ["  costs: no p1cost records for this web"];
  const lines = ["  color      kind        cost"];
  for (const row of rows) {
    const text = typeof row.cost === "number" ? fixed(row.cost, 3) : String(row.cost);
    lines.push(`  ${colorName(row.color).padEnd(10)} ${pyS(row.kind).padEnd(11)} ${text}${row.eligible ? "" : "  (ineligible sentinel)"}`);
  }
  return lines;
}

function cascadeLines(cascade, { occurrences, costs, headroom }) {
  const site = cascade.site;
  const lines = [`cascade: ${cascade.name}  site=${site.key}  sym=${dash(site.symbol)}  webs=${site.webs.join(",")}`, cascade.killLine()];
  if (site.caution) lines.push(`CAUTION: ${site.caution}`);
  if (!cascade.rounds.length) lines.push("  no decision record for this site: the webs exist but p1 never reached them. That is a real outcome, not an empty result.");
  for (const item of cascade.rounds) {
    lines.push("");
    lines.push(...roundLines(item, { headroom }));
    if (occurrences && item.entering !== null) lines.push(...occurrenceLines(item.entering));
    if (costs) lines.push(...costLines(cascade, item));
  }
  for (const p of cascade.undecided) lines.push(`\nundecided piece: w${p.web} net ${fmtF(p.net, 3)} class=${pyS(p.piece_class)} -- carved out and never decided`);
  for (const n of cascade.warnings) lines.push(`\nwarning: ${n}`);
  return lines;
}

async function rows(file, args, ctx) {
  const { loadDumpRows, loadObjectRows } = await import("./row-source.js");
  if (args.dumps) return loadDumpRows(ctx.resolve(file), { symbol: args.symbol });
  let cache = null;
  if (args.disassembly_cache) {
    const { DisassemblyCache } = await import("./dis-cache.js");
    cache = new DisassemblyCache(ctx.resolve(args.disassembly_cache), { objdump: args.objdump, cwd: ctx.cwd, env: ctx.env });
  }
  return loadObjectRows(ctx.resolve(file), { objdump: args.objdump, symbol: args.symbol, section: args.section, cache, cwd: ctx.cwd, env: ctx.env });
}

async function romLines(args, cascade, ctx) {
  const range = args.rom_rows ? parseRowRange(args.rom_rows) : null;
  const instructions = await rows(args.rom, args, ctx);
  const report = romColorOccupancy(instructions, { colors: sorted([...FP_COLOR_REGISTERS.keys()]), rows: range });
  const lines = ["", `reference object: ${args.rom} rows ${report.rows[0]}..${report.rows[1]}`,
    "  float colours the reference uses:      " + (report.present.map((i) => colorName(i.color)).join(" ") || "-"),
    "  float colours the reference never uses: " + (report.absent.map((i) => colorName(i.color)).join(" ") || "-")];
  const absent = new Set(report.absent.map((i) => i.color));
  for (const item of cascade.rounds) {
    const free = item.mincost_tie.filter((c) => absent.has(c));
    const blocked = item.forbidden.filter((c) => absent.has(c));
    if (blocked.length) {
      lines.push(`  round ${item.index}: forbidden here but absent from the reference: ${colors(blocked)} -- the `
        + "reference's own decision at this site cannot have been blocked by those colours, so a barrier hunt aimed at them is aimed at nothing.");
    }
    if (free.length) lines.push(`  round ${item.index}: cheapest-tie colours the reference never uses: ${colors(free)}`);
  }
  lines.push(`  reading: ${report.reading}`);
  return lines;
}

async function screenLines(args, ctx) {
  const { buildScreenLine } = await import("./screen.js");
  const instructions = await rows(args.object, args, ctx);
  const line = await buildScreenLine(instructions, { label: args.object, path: args.dumps ? null : ctx.resolve(args.object), slot: args.slot });
  return ["", line.render()];
}

const side = (item) => (item === null ? "-" : `w${item.web}:${item.decision}:${colorName(item.resolved_color)}`);

function changed(left, right) {
  if (left === null || right === null) return "present in one side only";
  const out = [];
  for (const [name, one, two] of [["decision", left.decision, right.decision], ["taken", left.resolved_color, right.resolved_color],
    ["net", pyRound(left.net, 6), pyRound(right.net, 6)], ["bestcost", pyRound(left.best_cost, 6), pyRound(right.best_cost, 6)],
    ["numintf", left.interference, right.interference], ["forbidden", left.forbidden, right.forbidden]]) {
    const same = typeof one === "number" && typeof two === "number" ? one === two : pyEq(one, two);
    if (!same) out.push(name);
  }
  return out.length ? out.join(",") : "same";
}

function diffLines(base, other) {
  const lines = [`cascade diff: ${base.name} -> ${other.name}  site=${base.site.key}`,
    `  symbol ${pyS(base.site.symbol)} -> ${pyS(other.site.symbol)}` + (base.site.symbol !== other.site.symbol ? "   (renumbered -- which is why the site is keyed by frame offset)" : ""),
    `  rounds ${base.rounds.length} -> ${other.rounds.length}`, `  ${base.killLine()}`, `  ${other.killLine()}`];
  if (base.killed !== other.killed) {
    lines.push(`  VERDICT: the kill signal changed -- ${base.killed ? "killed" : "coloured"} in ${base.name}, ${other.killed ? "killed" : "coloured"} in ${other.name}`);
  }
  const n = Math.max(base.rounds.length, other.rounds.length);
  const sides = [];
  for (let i = 0; i < n; i++) sides.push([i + 1, side(base.rounds[i] ?? null), side(other.rounds[i] ?? null)]);
  const width = sides.length ? Math.max(1, ...sides.map((s) => s[1].length)) : 1;
  const otherWidth = sides.length ? Math.max(1, ...sides.map((s) => s[2].length)) : 1;
  lines.push("", `  round  ${"A".padEnd(width)}  ${"B".padEnd(otherWidth)}  changed`);
  for (const [index, left, right] of sides) {
    lines.push(`  ${String(index).padEnd(6)} ${left.padEnd(width)}  ${right.padEnd(otherWidth)}  ${changed(base.rounds[index - 1] ?? null, other.rounds[index - 1] ?? null)}`);
  }
  return lines;
}

const reportable = (e) => e instanceof CascadeError || isInputError(e);
const errText = (e) => (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);

export async function cascadeCommand(args, io, ctx) {
  let cascade, against = null;
  try {
    const log = CdxLog.read(ctx.resolve(args.log));
    cascade = log.cascade(log.resolve(siteArguments(args)));
    if (args.against) {
      const other = CdxLog.read(ctx.resolve(args.against));
      against = other.cascade(other.resolve(siteArguments(args)));
    }
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.kill && !args.json) {
    io.print(cascade.killLine());
    if (against !== null) io.print(against.killLine());
    return 0;
  }
  const extra = [];
  try {
    if (args.rom) extra.push(...await romLines(args, cascade, ctx));
    if (args.object) extra.push(...await screenLines(args, ctx));
  } catch (e) {
    if (!reportable(e) && e?.name !== "RuntimeError" && e?.name !== "FileNotFoundError") throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) {
    const payload = cascade.asDict();
    if (against !== null) payload.against = against.asDict();
    io.print(dumps(payload));
    return 0;
  }
  const lines = against !== null ? diffLines(cascade, against)
    : cascadeLines(cascade, { occurrences: args.occurrences, costs: args.costs, headroom: args.headroom });
  lines.push(...extra);
  emitLines(io, lines, { width: args.width, pager: args.pager });
  return 0;
}

export async function orderCommand(args, io, ctx) {
  let report;
  try {
    report = colorOrderReport(CdxLog.read(ctx.resolve(args.log)), { limit: args.limit, register_class: args.register_class });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) { io.print(dumps(report)); return 0; }
  const lines = [`colour order: ${report.log}  ${report.shown} of ${report.decision_count} decision(s)`
    + (report.register_class !== null ? `  class=${report.register_class}(${CLASS_NAMES.get(report.register_class) ?? "?"})` : ""),
  " pos    web    sym   save        nocs  net       bestcost  colour       numintf  decision"];
  for (const item of report.order) {
    const num = (v, n, w) => (typeof v === "string" ? v : fixed(v, n).padEnd(w));
    lines.push(` ${String(item.position).padEnd(6)} ${pyS(item.web).padEnd(6)} ${pyS(item.symbol).padEnd(5)} ${num(item.save, 6, 11)} `
      + `${pyS(item.nocs).padEnd(5)} ${num(item.net, 3, 9)} ${num(item.best_cost, 3, 9)} ${colorName(item.color).padEnd(12)} `
      + `${pyS(item.interference).padEnd(8)} ${item.decision}`);
  }
  if (report.tie_groups.length) {
    lines.push("", "ties (p1 breaks these by ASCENDING web number, so a threshold against a lower-numbered web is >=, not > -- L31):");
    for (const g of report.tie_groups) lines.push(`  save=${fixed(g.save, 6)}: ${g.members.map((i) => `pos${i.position}/w${pyS(i.web)}`).join(", ")}`);
  } else lines.push("", "ties: none in the shown range");
  emitLines(io, lines, { width: args.width, pager: args.pager });
  return 0;
}

export async function blocksCommand(args, io, ctx) {
  let report;
  try {
    report = blockReport(CdxLog.read(ctx.resolve(args.log)), { webs: args.web, blocks: args.block });
  } catch (e) {
    if (!reportable(e)) throw e;
    io.eprint(`error: ${errText(e)}`);
    return 2;
  }
  if (args.json) { io.print(dumps(report)); return 0; }
  const queried = report.queried_blocks.join(",");
  const lines = [`web blocks: ${report.log}  ${report.webs.length} web(s)` + (queried ? `  queried blocks ${queried}` : "")];
  for (const e of report.webs) lines.push(`  w${e.web}  ${e.block_count} block(s): ${e.blocks.join(" ")}`);
  if (report.webs.length > 1) {
    if (report.intersection.length) {
      lines.push(`  intersection: ${report.intersection.length} block(s): ${report.intersection.join(" ")}`);
      lines.push("  These webs occur in the same blocks. Interference argued from a numintf delta alone is argued from a summary; this is the set.");
    } else {
      lines.push("  intersection: EMPTY -- these webs share no occurrence block, so neither can be blocking the other through a shared block.");
    }
  }
  emitLines(io, lines, { width: args.width, pager: args.pager });
  return 0;
}

export async function frameCommand(args, io, ctx) {
  let ladder, operations = null;
  try {
    const log = CdxLog.read(ctx.resolve(args.log));
    let names = new Map();
    if (args.names) {
      let text;
      try { text = readFileSync(ctx.resolve(args.names), "utf8"); } catch (e) { throw new CascadeError(`cannot read ${args.names}: ${osErrorText(e)}`); }
      names = parseSlotNames(text, { frame: args.frame });
    }
    ladder = frameLadder(log, { frame: args.frame, proc: args.proc, names });
    if (args.ops) operations = opReport(ladder, { names });
  } catch (e) {
    if (!(e instanceof CascadeError)) throw e;
    io.eprint(`error: ${e.message}`);
    return 2;
  }
  if (args.json) {
    const doc = ladder.asDict();
    if (operations !== null) doc.operations = operations;
    io.print(dumps(doc));
    return 0;
  }
  if (args.summary) {
    const lines = [
      `frame ladder: ${ladder.log}  ${ladder.slots.length} slot(s)  named=${ladder.named.length} unnamed=${ladder.slots.length - ladder.named.length}  source=${ladder.sources.join("+")}`,
      `  lowest offset ${ladder.slots.length ? ladder.slots[0].offset : "-"}  lowest named ${ladder.named.length ? ladder.lowest_named_offset : "-"}  temps below it ${ladder.below_named.length}`,
      `  itable entries ${ladder.entries.length}, of which ${ladder.entries.filter((e) => e.is_operation).length} operation(s)`,
      ...ladder.warnings.map((w) => `warning: ${w}`),
    ];
    emitLines(io, lines, { width: args.width, pager: args.pager });
    return 0;
  }
  const lines = [...ladderLines(ladder)];
  if (operations !== null) {
    lines.push(`itable operations: ${operations.selected_count} of ${operations.entry_count} entries, in first-occurrence order`);
    for (const row of operations.operations.slice(0, args.limit)) {
      lines.push(`  op${String(row.index).padEnd(5)} ${row.opcode_name.padEnd(6)} l=${row.left_name.padEnd(20)} r=${row.right_name.padEnd(20)} dt=${pyS(row.dtype)}`);
    }
    if (operations.selected_count > args.limit) lines.push(`  ... ${operations.selected_count - args.limit} more operation(s); raise --limit`);
  }
  emitLines(io, lines, { width: args.width, pager: args.pager });
  return 0;
}

/** `int(value, 0)` as an argument type. */
export function intBase0(value) { return pyInt(value, 0); }
intBase0.displayName = "<lambda>";

/** The "site" argument group: exactly one site, by frame offset if possible. */
const SITE_GROUP = { title: "site", description: "Name exactly one site. Prefer the frame offset: it is the only identity in the grammar that a rebase does not move." };
const SITE_ARGUMENTS = [
  { group: "site", flags: ["--frame-offset"], metavar: "OFFSET", help: "the web's frame offset, as the trace prints it (0xfffffdf8) or signed (-520)" },
  { group: "site", flags: ["--slot"], type: intBase0, metavar: "OFFSET", help: "sp-relative slot offset; needs --frame to become a frame offset" },
  { group: "site", flags: ["--frame"], type: intBase0, metavar: "SIZE", help: "the frame size, signed, as the prologue's addiu sp,sp,-N writes it" },
  { group: "site", flags: ["--web"], type: "int", metavar: "N", help: "a trace-local web number (changes with any edit that adds a live range)" },
  { group: "site", flags: ["--symbol-id"], type: "int", metavar: "N", help: "a trace-local symbol number. Accepted, and cautioned: one campaign's sym=1042 became sym=1039 on a rebase and the script that grepped the old number reported a kill that never happened" },
];

export const COMMAND_SPECS = [
  {
    path: ["trace-cascade"], handler: cascadeCommand, defaults: { report_command: "trace-cascade" }, groups: [SITE_GROUP],
    help: "every round of one allocator site's decision cascade",
    description: "Print the whole decision trail for one web family from a CDX log: every round of an f_split cascade, not just the last; the "
      + "colour the web actually received, not the pre-resolution `bestcolor`; and the decision as the one inequality it is. "
      + "Sites are located by frame offset, which survives the renumbering that made a hard-coded symbol number report false "
      + "kills for seven stages of one campaign. " + ARITHMETIC_POINTER,
    epilog: "example: decomp-workbench trace-cascade build.ilog --frame-offset 0xfffffdf8 --occurrences",
    arguments: [
      { dest: "log", help: "CDX log from an instrumented build" },
      { flags: ["--against"], metavar: "LOG", help: "second log; report the same site's cascade in both, round by round" },
      ...SITE_ARGUMENTS,
      { flags: ["--occurrences"], action: "store_true", help: "also print each round's occurrence table with the chargeB gate marked (bb weight nl o22 o23 w34 uses defs)" },
      { flags: ["--costs"], action: "store_true", help: "also print the per-colour cost sweep behind each decision" },
      { flags: ["--headroom"], action: "store_true", help: "also print how far net must fall for each coloured web to be declined" },
      { flags: ["--kill"], action: "store_true", help: "print only the one-line kill signal, for a sweep column. --json is unaffected: it always emits the whole cascade document, whose `killed` and `kill_line` fields carry this same signal" },
      { flags: ["--rom"], metavar: "OBJECT", help: "reference object -- a compiled `.o`, not a ROM image; the command that reads a ROM image is `score --rom`. Report which float colours it never uses, so a forbidden set can be checked against the allocation the reference actually made" },
      { flags: ["--rom-rows"], metavar: "LO..HI", help: "restrict the reference reading to these rows (inclusive)" },
      { flags: ["--object"], metavar: "OBJECT", help: "candidate object; print its screen line, loads and stores apart" },
      { flags: ["--dumps"], action: "store_true", help: "--rom and --object name retained `objdump -d -r` text rather than objects, for a reader who kept the dumps" },
      { flags: ["--section"], default: ".text", help: "object section (default: .text)" },
      { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" },
      { flags: ["--disassembly-cache"], metavar: "DIR", help: "reuse disassemblies from this directory across runs" },
      ...O.symbolArgument({ help: "read only this exact symbol from --rom/--object" }),
      { flags: ["--grammar"], action: "print_exit", output: grammarText, help: "print the CDX record grammar these commands read, and exit" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
      ...O.terminalArguments(),
    ],
  },
  {
    path: ["trace-order"], handler: orderCommand, defaults: { report_command: "trace-order" },
    help: "rank the p1 colouring order, with the same-save ties named",
    description: "Print the order p1 decides webs in, with each web's save, net, bestcost, colour and interference count, and the groups that "
      + "tie on save. `--class 2` is the float census: every float web in the object, in decision order, in one pass. " + ARITHMETIC_POINTER,
    epilog: "example: decomp-workbench trace-order build.ilog --class 2 --limit 40",
    arguments: [
      { dest: "log", help: "CDX log from an instrumented build" },
      { flags: ["--limit"], type: "int", default: 40, metavar: "N", help: "rows to show (default: 40)" },
      { flags: ["--class"], dest: "register_class", type: "int", choices: [1, 2], help: "restrict to one register class: 1 integer, 2 float" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
      ...O.terminalArguments(),
    ],
  },
  {
    path: ["trace-blocks"], handler: blocksCommand, defaults: { report_command: "trace-blocks" },
    help: "which webs occur in which basic blocks, and where the sets meet",
    description: "Print each web's occurrence-block set and their intersection. 'Which web interferes with which' is a set intersection over "
      + "`saveocc bb=` values; one campaign argued it from numintf deltas across five stages and resolved it in one command once the sets were printed.",
    epilog: "example: decomp-workbench trace-blocks build.ilog --web 255 --web 260",
    arguments: [
      { dest: "log", help: "CDX log from an instrumented build" },
      { flags: ["--web"], type: "int", action: "append", default: [], metavar: "N", help: "a web to report; repeatable" },
      { flags: ["--block"], type: intBase0, action: "append", default: [], metavar: "BB", help: "report every web occurring in this block; repeatable" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
      ...O.terminalArguments(),
    ],
  },
  {
    path: ["trace-frame"], handler: frameCommand, defaults: { report_command: "trace-frame" },
    help: "the frame ladder: every stack slot one procedure owns",
    description: "Print one procedure's stack slots, lowest offset first, with the sp-relative home each one has, the itable index stamped at it, "
      + "and the allocator webs that reached it. Names are yours to supply with --names: the input ucode carries none, so no instrument can print one. "
      + "--ops adds the itable's operation stream in first-occurrence order, which is where a pooled compiler temp's birth site can be read.",
    epilog: "example: decomp-workbench trace-frame build.ilog --frame -216 --names locals.txt",
    arguments: [
      { dest: "log", help: "CDX log from an instrumented build" },
      { flags: ["--frame"], type: intBase0, metavar: "SIZE", help: "the frame size, signed, as the prologue's addiu sp,sp,-N writes it; turns each offset into the sp-relative home a disassembly shows" },
      { flags: ["--proc"], type: "int", metavar: "N", help: "restrict to one procedure ordinal (default: every procedure)" },
      { flags: ["--names"], metavar: "FILE", help: "reader-supplied slot names, one `OFFSET NAME` per line; `-140 colour` is a frame offset and `sp:76 colour` an sp-relative slot" },
      { flags: ["--ops"], action: "store_true", help: "also print the itable's operation stream with symbolic operands (needs CDX_SYMTAB records)" },
      { flags: ["--summary"], action: "store_true", help: "print the slot counts only, for a sweep column" },
      { flags: ["--limit"], type: "int", default: 80, metavar: "N", help: "operations to show" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
      ...O.terminalArguments(),
    ],
  },
];
