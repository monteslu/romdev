// sweep-cli.js - the sweep family: generate sources (regress, hoist, commute,
// copies, fuse), answer the two read-only questions (carriers, donors), build
// a wave (build), and read a built sweep back (ingest). Generation stops at
// the source; the project's own compile-one wrapper builds the objects.
//
// Plain JS ESM + JSDoc.

import { ComposeError, parseZone } from "./compose.js";
import { CSourceError } from "./csource.js";
import { GENERATOR_CLASSES, SweepError, readManifest, writeFamily } from "./sweep.js";
import { DEFAULT_JOBS, DEFAULT_NICE, SORT_ORDERS, buildLines, collectSources, runSweepBuild } from "./sweep-build.js";
import { carrierPool, commutativeFamily, copyFamily, fusionDonors, fusionFamily, hoistFamily, parseConstruct, removalFamily } from "./sweep-generators.js";
import { emitLines } from "./terminal.js";
import { WatchRowError, parseWatchRows } from "./watch-rows.js";
import * as O from "./cli-options.js";
import { dumps } from "./pyjson.js";
import { isReportedError } from "./py-extra.js";
import { sorted, strip, isInputError, osErrorText } from "./py.js";

/** Errors a sweep command reports as `error: ...` with exit 2 (including a failed objdump). */
function isSweepError(e) {
  return e instanceof SweepError || e instanceof ComposeError || e instanceof CSourceError || e instanceof WatchRowError
    || isInputError(e) || isReportedError(e);
}

function fail(io, e) {
  io.eprint(`error: ${e.code && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message}`);
  return 2;
}

const frozenOf = (args) => (args.frozen ?? []).map((z) => parseZone(z));

/** Write the family, then say what was written and what comes next. */
function emitManifest(args, io, ctx, manifest) {
  const placed = writeFamily(manifest, { directory: args.write, overwrite: args.overwrite, cwd: ctx.cwd });
  if (args.json) { io.print(dumps(placed.asDict())); return 0; }
  const lines = [
    `sweep ${placed.generator}: ${placed.variants.length} variant source(s) in ${placed.directory}`,
    `base: ${placed.base}  sha256 ${placed.base_sha256.slice(0, 16)}`,
    "",
  ];
  const classes = new Map();
  for (const v of placed.variants) classes.set(v.key.generator_class, (classes.get(v.key.generator_class) ?? 0) + 1);
  for (const [letter, count] of sorted([...classes])) {
    const entry = GENERATOR_CLASSES[letter];
    lines.push(`  ${letter}  ${String(count).padStart(4)}  ${entry.name} -- ${entry.description}`);
  }
  if (placed.dropped.length) {
    lines.push("", `refused (${placed.dropped.length}), each with its reason:`);
    for (const r of placed.dropped.slice(0, args.limit || placed.dropped.length)) lines.push(`  ${r.site ?? "?"}  ${r.reason ?? ""}`);
    if (args.limit && placed.dropped.length > args.limit) lines.push(`  ... ${placed.dropped.length - args.limit} more`);
  }
  lines.push("", placed.coverage.sentence(), "",
    "next: build each source with the project's compile-one wrapper, writing OBJDIR/<name>.o, then",
    `      decomp-workbench sweep ingest ${placed.directory} --objects OBJDIR --target target.o`);
  emitLines(io, lines, { width: args.width, pager: args.pager });
  return 0;
}

/** Run a body, turning the sweep family's errors into `error:` and exit 2. */
async function guarded(io, body) {
  try { return await body(); } catch (e) {
    if (!isSweepError(e)) throw e;
    return fail(io, e);
  }
}

export function sweepCarriersCommand(args, io, ctx) {
  let pool;
  try { pool = carrierPool(args.source, { at: args.at, wanted_type: args.type, cwd: ctx.cwd }); } catch (e) {
    if (!isSweepError(e)) throw e;
    return fail(io, e);
  }
  if (args.json) { io.print(dumps(pool.asDict())); return 0; }
  const lines = [
    `carrier pool: ${pool.source} at line ${pool.at}`,
    `${pool.declared} declared local(s); ${pool.usable.length} dead here and therefore free`,
    "",
    " idx  line  verdict    name                 type",
  ];
  for (const item of pool.carriers) {
    lines.push(` ${String(item.declaration_index).padEnd(4)} ${String(item.declaration_line).padEnd(5)} ${item.verdict.padEnd(10)} ${item.name.slice(0, 20).padEnd(20)} ${item.type_text}`);
    if (!item.usable || args.verbose) lines.push(`        ${item.reason}`);
  }
  lines.push("",
    "A carrier is an existing local that is dead here. A fresh declaration mints a frame slot (8 bytes for an f32 on the one compiler "
    + "this was measured on) and the frame gate rejects it, so the pool never proposes one -- and an unused pad has no web to merge into, "
    + "which is why declared symbols come first.",
    "",
    `next: decomp-workbench sweep hoist ${pool.source} --line ${pool.at} --write variants/`);
  emitLines(io, lines, { width: args.width, pager: args.pager });
  return 0;
}

export function sweepDonorsCommand(args, io, ctx) {
  let donors;
  try { donors = fusionDonors(args.source, { target: args.target, cwd: ctx.cwd }); } catch (e) {
    if (!isSweepError(e)) throw e;
    return fail(io, e);
  }
  const payload = { schema: "decomp-workbench-fusion-donors-v1", source: String(args.source), target: args.target,
    donors: donors.map((d) => d.asDict()), disjoint_count: donors.filter((d) => d.disjoint).length };
  if (args.json) { io.print(dumps(payload)); return 0; }
  const lines = [
    `fusion donors for ${args.target}: ${args.source}`,
    `${payload.disjoint_count} of ${donors.length} local(s) have a live range that avoids the target's`,
    "",
    " idx  live      name                 verdict",
  ];
  for (const item of donors) {
    lines.push(` ${String(item.declaration_index).padEnd(4)} ${`${item.first}..${item.last}`.padEnd(9)} ${item.name.slice(0, 20).padEnd(20)} ${item.disjoint ? "FUSABLE" : "no"}`);
    lines.push(`        ${item.reason}`);
  }
  lines.push("",
    "This is the half of the donor table that needs no build. The other half is the donor's price -- how many rows touch its stack slot "
    + "-- and that is `decomp-workbench slots OBJECT`.",
    "",
    `next: decomp-workbench sweep fuse ${args.source} --target ${args.target} --write variants/`);
  emitLines(io, lines, { width: args.width, pager: args.pager });
  return 0;
}

export const sweepRegressCommand = (args, io, ctx) => guarded(io, () => emitManifest(args, io, ctx,
  removalFamily(args.source, { constructs: args.construct.map((c) => parseConstruct(c)), order: args.order, frozen: frozenOf(args), cwd: ctx.cwd })));

export const sweepHoistCommand = (args, io, ctx) => guarded(io, () => {
  const classes = args.classes.split(",").filter((x) => strip(x)).map((x) => strip(x).toUpperCase());
  return emitManifest(args, io, ctx, hoistFamily(args.source, { line: args.line, classes, carriers: [...args.carrier], frozen: frozenOf(args), cwd: ctx.cwd }));
});

export const sweepCommuteCommand = (args, io, ctx) => guarded(io, () => emitManifest(args, io, ctx,
  commutativeFamily(args.source, { lines: [...args.line], frozen: frozenOf(args), cwd: ctx.cwd })));

export const sweepCopiesCommand = (args, io, ctx) => guarded(io, () => emitManifest(args, io, ctx,
  copyFamily(args.source, { frozen: frozenOf(args), cwd: ctx.cwd })));

export const sweepFuseCommand = (args, io, ctx) => guarded(io, () => emitManifest(args, io, ctx,
  fusionFamily(args.source, { target: args.target, donors: [...args.donor], frozen: frozenOf(args), cwd: ctx.cwd })));

export async function sweepBuildCommand(args, io, ctx) {
  let wave;
  try {
    const sources = collectSources(args.sources, { suffix: args.source_suffix, cwd: ctx.cwd });
    const watch = parseWatchRows(args.watch_rows, { cwd: ctx.cwd });
    wave = await runSweepBuild(sources, { target: args.target, template: args.compile_command, objects: args.objects, jobs: args.jobs,
      niceness: args.nice, watch, objdump: args.objdump, symbol: args.symbol, section: args.section, object_suffix: args.object_suffix,
      environment: ctx.env, compile_cwd: args.compile_cwd, timeout: args.timeout, order: args.sort, refresh: args.refresh, cwd: ctx.cwd });
  } catch (e) {
    if (!isSweepError(e)) throw e;
    return fail(io, e);
  }
  if (args.json) io.print(dumps(wave.asDict()));
  else emitLines(io, buildLines(wave, { limit: args.limit ? args.limit : (wave.results.length || 1) }), { width: args.width, pager: args.pager });
  return wave.ranked.length ? 0 : 1;
}

export async function sweepIngestCommand(args, io, ctx) {
  // Loaded on use: the ingest reads the gate line from screen.js, and a
  // missing optional module must never take every other command down.
  const { ingestLines, ingestSweep } = await import("./sweep-ingest.js");
  let result;
  try {
    const manifest = readManifest(args.manifest, { cwd: ctx.cwd });
    result = await ingestSweep(manifest, { objects: args.objects, target: args.target, suffix: args.object_suffix, dumps: args.dumps,
      target_dumps: args.target_dumps, objdump: args.objdump, symbol: args.symbol, section: args.section, slot: args.slot,
      cache_directory: args.disassembly_cache, cwd: ctx.cwd, env: ctx.env });
  } catch (e) {
    if (!isSweepError(e)) throw e;
    return fail(io, e);
  }
  if (args.json) { io.print(dumps(result.asDict())); return 0; }
  emitLines(io, ingestLines(result, { limit: args.limit ? args.limit : (result.results.length || 1) }), { width: args.width, pager: args.pager });
  return 0;
}

function generatorArguments() {
  return [
    { flags: ["--write"], required: true, metavar: "DIR", help: "write the variant sources and sweep.json here" },
    { flags: ["--overwrite"], action: "store_true", help: "replace a non-empty --write directory" },
    { flags: ["--frozen"], action: "append", default: [], metavar: "LO..HI", help: "lines no edit may touch -- another construction's protected zone; repeatable" },
    ...O.listFileArgument({ option: "frozen", dest: "frozen", noun: "frozen zones" }),
    { flags: ["--limit"], type: "int", default: 20, metavar: "N", help: "refused rows to print before eliding (default: 20; 0 prints all)" },
    { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ...O.terminalArguments(),
  ];
}

export const COMMAND_SPECS = [
  {
    path: ["sweep-carriers"], handler: sweepCarriersCommand, hidden: true, defaults: { report_command: "sweep-carriers" },
    description: "List the locals that are dead at one line and can therefore carry a hoisted value for free. A fresh declaration mints a frame slot the frame gate rejects, and an unused pad has no web to merge into -- so the pool is existing declared locals, in declaration order, and every refusal names its reason.",
    epilog: "example: decomp-workbench sweep carriers examples/fixtures/value-equality.c --at 13",
    arguments: [
      { dest: "source", help: "the C source to read" },
      { flags: ["--at", "--line"], type: "int", required: true, metavar: "LINE", help: "the site line; --line is the same option" },
      { flags: ["--type"], metavar: "TYPE", help: "only carriers declared with this type" },
      { flags: ["--verbose"], action: "store_true", help: "print the reason for every carrier" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
      ...O.terminalArguments(),
    ],
  },
  {
    path: ["sweep-donors"], handler: sweepDonorsCommand, hidden: true, defaults: { report_command: "sweep-donors" },
    description: "Rank every local by whether its live range avoids the target's. That is the half of the fusion question that needs no build; the other half -- how many rows touch the donor's stack slot, which is its price -- is `slots`.",
    epilog: "example: decomp-workbench sweep donors examples/fixtures/value-equality.c --target sp4A0",
    arguments: [
      { dest: "source", help: "the C source to read" },
      { flags: ["--target"], required: true, metavar: "NAME", help: "the local to fuse into" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
      ...O.terminalArguments(),
    ],
  },
  {
    path: ["sweep-regress"], handler: sweepRegressCommand, hidden: true, defaults: { report_command: "sweep-regress" },
    description: "Emit the removal lattice: the base unedited (the control), then each accumulated construct deleted, singly and jointly. This is the experiment nobody runs -- every stage inherits its predecessor's construction and attacks only the residue -- and the one time one campaign ran it, twelve builds showed a four-atom supplier set was dead weight costing ten rows on the live base. Run it first, not last.",
    epilog: "example: decomp-workbench sweep regress work.c --construct 920..921=hoist --construct 977=deadread --write regress/",
    arguments: [
      { dest: "source", help: "the C source the levers were added to" },
      { flags: ["--construct"], action: "append", default: [], metavar: "LO..HI[=LABEL]", help: "one accumulated lever, by the lines that spell it; repeatable" },
      ...O.listFileArgument({ option: "construct", dest: "construct", noun: "constructs" }),
      { flags: ["--order"], type: "int", default: 1, metavar: "N", help: "remove up to N constructs jointly (default: 1; the all-removed point is always included)" },
      ...generatorArguments(),
    ],
  },
  {
    path: ["sweep-hoist"], handler: sweepHoistCommand, hidden: true, defaults: { report_command: "sweep-hoist" },
    description: "Emit one variant per (operand, carrier) pair at one statement. Class O hoists a leaf out of a nested subexpression -- a different price from splitting the top-level operator, because a deep hoist can leave the local ring rotation undisturbed. P and A cover the compound assignment and the call argument, which no generator library had. The carrier is part of the key: at one line, two carriers from different declaration indices produced two entirely different cost deltas.",
    epilog: "example: decomp-workbench sweep hoist work.c --line 920 --class O,P --write hoists/",
    arguments: [
      { dest: "source", help: "the C source to read" },
      { flags: ["--line", "--at"], type: "int", required: true, metavar: "LINE", help: "the statement to hoist; --at is the same option" },
      { flags: ["--class"], dest: "classes", default: "O", metavar: "LETTERS", help: "comma-separated hoist classes: H, O, P, A (default: O)" },
      { flags: ["--carrier"], action: "append", default: [], metavar: "NAME", help: "use these carriers instead of every dead local; repeatable" },
      ...O.listFileArgument({ option: "carrier", dest: "carrier", noun: "carriers" }),
      ...generatorArguments(),
    ],
  },
  {
    path: ["sweep-commute"], handler: sweepCommuteCommand, hidden: true, defaults: { report_command: "sweep-commute" },
    description: "Emit one variant per commutative operand pair, exchanged. The classifier that names a commutative row is shipped; this is the lever it never had. Only textually pure exchanges are emitted: a swap that would need new parentheses to stay associative-safe is refused and named, because the parentheses would be a second, untested edit.",
    epilog: "example: decomp-workbench sweep commute examples/fixtures/value-equality.c --write commute/",
    arguments: [
      { dest: "source", help: "the C source to read" },
      { flags: ["--line", "--at"], action: "append", default: [], type: "int", metavar: "LINE", help: "restrict to these lines; repeatable, and --at is the same option (default: the whole file)" },
      ...O.listFileArgument({ option: "line", dest: "line", noun: "line numbers", itemType: "int" }),
      ...generatorArguments(),
    ],
  },
  {
    path: ["sweep-copies"], handler: sweepCopiesCommand, hidden: true, defaults: { report_command: "sweep-copies" },
    description: "Find every copy `Y = X;` between two declared locals and emit the variant that drops it, rehosting Y's later reads onto X. Worth nine rows in one campaign case and fifteen in another. A copy whose rehosting the text cannot prove -- X written again, Y written again, either address taken -- is refused and named.",
    epilog: "example: decomp-workbench sweep copies work.c --write copies/",
    arguments: [{ dest: "source", help: "the C source to read" }, ...generatorArguments()],
  },
  {
    path: ["sweep-fuse"], handler: sweepFuseCommand, hidden: true, defaults: { report_command: "sweep-fuse" },
    description: "Emit one variant per donor fused into the target: the donor's declaration goes and its occurrences read the target instead, so two webs become one and a stack slot is reclaimed. Only donors whose live range provably avoids the target's are emitted. Every edit states the base sha it was written against and refuses a frozen zone, because a composer that edits another stage's protected lines is how two constructions merge silently.",
    epilog: "example: decomp-workbench sweep fuse work.c --target sp4B8 --frozen 900..940 --write fuse/",
    arguments: [
      { dest: "source", help: "the C source to read" },
      { flags: ["--target"], required: true, metavar: "NAME", help: "the local to fuse into" },
      { flags: ["--donor"], action: "append", default: [], metavar: "NAME", help: "fuse only these donors; repeatable (default: every fusable one)" },
      ...O.listFileArgument({ option: "donor", dest: "donor", noun: "donors" }),
      ...generatorArguments(),
    ],
  },
  {
    path: ["sweep-build"], handler: sweepBuildCommand, hidden: true, defaults: { report_command: "sweep-build" },
    description: "Compile a wave of candidate sources and score them into one table. This is the middle of the search loop the generators and `sweep ingest` already bracketed, and the piece three successive ad hoc scorers rebuilt in one endgame: a bounded pool at nice, a skip for any object whose source and compile command are unchanged, and one row per candidate carrying the standard metric columns plus a watch-row heal signature. The signature is the column that converged when words and opcodes misled -- opcodes conflates schedule with allocation, and words over-charges a block permutation by three orders of magnitude.",
    epilog: "example: decomp-workbench sweep build variants/ --target target.o --objects objects/ --compile-command 'cc -c -O2 -o {output} {source}' --watch-rows r49=49,cx2=1620,sx3=1677",
    arguments: [
      { dest: "sources", nargs: "+", help: "candidate sources: files, directories of them, or a generated sweep directory holding sweep.json" },
      { flags: ["--target"], required: true, metavar: "OBJ", help: "the reference object every candidate is scored against" },
      { flags: ["--compile-command"], required: true, metavar: "TEMPLATE", help: "command template containing {source} and {output}" },
      { flags: ["--objects"], required: true, metavar: "DIR", help: "write (and reuse) the built objects here" },
      { flags: ["--jobs"], type: "int", default: DEFAULT_JOBS, metavar: "N", help: `parallel compiler processes (default: ${DEFAULT_JOBS}). Small on purpose: a wave runs beside the session reading its table` },
      { flags: ["--nice"], type: "int", default: DEFAULT_NICE, metavar: "N", help: `niceness for every compiler process (default: ${DEFAULT_NICE}; 0 disables). Ignored where the platform has no nice(1)` },
      { flags: ["--refresh"], action: "store_true", help: "rebuild every candidate, ignoring objects that are already current" },
      { flags: ["--sort"], default: "words", choices: [...SORT_ORDERS], help: "row order (default: words). `watch` ranks by healed columns first, `rows-away` by the shift-tolerant distance where one was computed, `name` not at all. Every order breaks ties on the label, so re-running a wave never reshuffles equal rows" },
      { flags: ["--source-suffix"], default: ".c", metavar: "EXT", help: "which files a named directory contributes (default: .c)" },
      { flags: ["--object-suffix"], default: ".o", metavar: "EXT", help: "built object name is <source stem><EXT> (default: .o)" },
      { flags: ["--compile-cwd"], metavar: "DIR", help: "run the compiler here (default: the current directory)" },
      { flags: ["--timeout"], type: "float", default: 300.0, metavar: "SECONDS", help: "per-candidate compiler deadline (default: 300)" },
      { flags: ["--section"], default: ".text", help: "object section (default: .text)" },
      { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" },
      ...O.symbolArgument({ help: "score only this exact symbol" }),
      ...O.watchRowsArgument(),
      { flags: ["--limit"], type: "int", default: 40, metavar: "N", help: "scored rows to print before eliding (default: 40; 0 prints all)" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
      ...O.explainKeysArgument(),
      ...O.terminalArguments(),
    ],
  },
  {
    path: ["sweep-ingest"], handler: sweepIngestCommand, hidden: true, defaults: { report_command: "sweep-ingest" },
    description: "Read a built sweep back: locate each variant's object, print its gate line (sha, ni, frame, load/store traffic, ring coset) and its shift-tolerant distance from the target, and rank the family. A wrong instruction count is a column, never a rejection -- position-indexed scoring turned one inserted instruction into a four-figure mismatch and cost eleven stages their candidates. A variant with no object is a row naming the path that was looked for, and the coverage line says what the family's negative result is entitled to claim.",
    epilog: "example: decomp-workbench sweep ingest regress/ --objects o/ --target target.o",
    arguments: [
      { dest: "manifest", help: "the sweep directory, or its sweep.json" },
      { flags: ["--objects"], required: true, metavar: "DIR", help: "directory the wrapper wrote the built variants into" },
      { flags: ["--target"], required: true, metavar: "OBJ", help: "the reference object the variants are scored against. An object path, not a variable name: `--target` on the generator side (`sweep donors`, `sweep fuse`) is the C local being fused into" },
      { flags: ["--object-suffix"], default: ".o", metavar: "EXT", help: "built object name is <variant stem><EXT> (default: .o)" },
      { flags: ["--dumps"], action: "store_true", help: "the built variants are retained `objdump -d -r` text" },
      { flags: ["--target-dumps"], action: "store_true", help: "the target is retained `objdump -d -r` text" },
      { flags: ["--slot"], type: "int", metavar: "OFFSET", help: "count loads and stores at this sp-relative stack slot only -- the 1184 in `lwc1 $f10,1184(sp)`, which `slots` lists. It is not the frame offset `trace-cascade` keys a site by; that is this number plus the frame size" },
      { flags: ["--section"], default: ".text", help: "object section (default: .text)" },
      { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" },
      { flags: ["--disassembly-cache"], metavar: "DIR", help: "reuse disassemblies from this directory across runs" },
      ...O.symbolArgument({ help: "read only this exact symbol" }),
      { flags: ["--limit"], type: "int", default: 20, metavar: "N", help: "ranked rows to print before eliding (default: 20; 0 prints all)" },
      { flags: ["--json"], action: "store_true", help: "emit JSON" },
      ...O.explainKeysArgument(),
      ...O.terminalArguments(),
    ],
  },
];
