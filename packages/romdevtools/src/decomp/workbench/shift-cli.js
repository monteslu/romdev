// shift-cli.js - the `shift` command group: `audit` (the static
// inventory), `rehearse analyze` / `rehearse orchestrate` (the empirical
// referee), `config verify` (the gate a configuration edit has to pass) and
// `plan` (one ranked, gated remediation queue from all of their reports).
//
// Plain JS ESM + JSDoc.

import { readFileSync, existsSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { ValueError, isInputError, osErrorText, pyInt } from "./py.js";
import { dumps } from "./pyjson.js";
import { censusStatus, evaluateCensus, parseCensus } from "./census.js";
import { SHIFT_CENSUS_KEYS } from "./schema.js";
import { emitLines } from "./terminal.js";
import { listingSpec } from "./cli.js";
import { censusArgument, explainKeysArgument, terminalArguments } from "./cli-options.js";
import { readElfSymbols, readLdMap } from "./ldmap.js";
import { PinCatalogue, defaultPinModel, parseWhitelistText, readPinFiles } from "./pins.js";
import { MAP_SNIFF_BYTES, buildShiftAudit, requireParsedMap, resolveBlobs, shiftAuditLines } from "./shift-audit.js";
import { verifyFaithful, verifyLines } from "./shift-config.js";
import { AUDIT_SCHEMA, REHEARSE_SCHEMA, buildPlan, planLines, planMarkdown, readReport } from "./shift-plan.js";
import { WRAPPER_CONTRACT, buildRehearsal, orchestrate, orchestrateLines, parseMapping, parseOffsets, rehearseLines } from "./shift-rehearse.js";

export const DEFAULT_LIMIT = 40;

function fail(io, error) {
  io.eprint(`error: ${typeof error === "string" ? error : error.code ? osErrorText(error) : error.message}`);
  return 2;
}

const guard = (e) => { if (!isInputError(e) && !(e instanceof SyntaxError)) throw e; };
const printCensus = (io, results) => { for (const r of results) io.print(r.line); };

function report(io, args, payload, census, lines) {
  if (args.json) {
    if (census.length) payload.census = census.map((c) => c.asDict());
    io.print(dumps(payload));
  } else {
    emitLines(io, lines(), { width: args.width, pager: args.pager });
    printCensus(io, census);
  }
}

function whitelistModel(args, ctx) {
  const whitelist = [];
  for (const p of args.whitelist) whitelist.push(...parseWhitelistText(readFileSync(ctx.resolve(p), "utf8")));
  return defaultPinModel({ whitelist });
}

function emitWhitelist(io, audit, destination, ctx) {
  if (existsSync(ctx.resolve(destination))) {
    throw new ValueError(`--emit-whitelist refuses to overwrite ${destination}: it already exists, and a reviewed whitelist and a fresh skeleton have the `
      + "same natural filename. Move it aside or name a new file");
  }
  writeFileSync(ctx.resolve(destination), audit.whitelistTemplate(), "utf8");
  io.eprint(`wrote whitelist skeleton: ${destination}`);
}

function sniff(file) {
  const fd = openSync(file, "r");
  try { const buf = Buffer.alloc(MAP_SNIFF_BYTES); const n = readSync(fd, buf, 0, MAP_SNIFF_BYTES, 0); return buf.subarray(0, n); } finally { closeSync(fd); }
}

/** Report where a linked project's addresses come from. */
export async function shiftAuditCommand(args, io, ctx) {
  let predicates;
  try { predicates = parseCensus(args.census, { allowed: SHIFT_CENSUS_KEYS }); } catch (e) { guard(e); return fail(io, e); }
  let audit;
  try {
    const model = whitelistModel(args, ctx);
    const pinFiles = [...args.pins, ...args.symbol_addrs];
    const named = pinFiles.length ? readPinFiles(pinFiles.map((p) => ctx.resolve(p)), { model, display: pinFiles }) : new PinCatalogue({ entries: [], sources: [] });
    const elf = args.elf ? readElfSymbols(ctx.resolve(args.elf), { display: args.elf }) : null;
    const ldmap = readLdMap(ctx.resolve(args.map), { display: args.map });
    if (!ldmap.sections.length) requireParsedMap(ldmap, { path: String(args.map), sample: sniff(ctx.resolve(args.map)) });
    const image = readFileSync(ctx.resolve(args.image));
    audit = buildShiftAudit({ ldmap, image, pins: named, model, blobs: args.blob, auto_blobs: args.blobs === "auto", excluded_blobs: args.no_blob, elf,
      map_path: String(args.map), image_path: String(args.image), elf_path: args.elf ? String(args.elf) : null });
    if (args.emit_whitelist) emitWhitelist(io, audit, args.emit_whitelist, ctx);
  } catch (e) { guard(e); return fail(io, e); }
  const payload = audit.asDict({ limit: args.limit });
  let census;
  try { census = evaluateCensus(predicates, payload); } catch (e) { guard(e); return fail(io, e); }
  report(io, args, payload, census, () => shiftAuditLines(audit, { limit: args.limit }));
  return censusStatus(census, { otherwise: 0 });
}

function blobsFor(ldmap, args) {
  return resolveBlobs(ldmap, { blobs: args.blob, auto: args.blobs === "auto", excluded: args.no_blob }).applied;
}

/** Explain every difference between a base link and a shifted relink. */
export async function shiftRehearseCommand(args, io, ctx) {
  let predicates;
  try { predicates = parseCensus(args.census, { allowed: SHIFT_CENSUS_KEYS }); } catch (e) { guard(e); return fail(io, e); }
  let rehearsal;
  try {
    const model = whitelistModel(args, ctx);
    const pairs = parseMapping(args.checksum_pair);
    const crcWords = parseOffsets(args.crc_words);
    const baseLdmap = readLdMap(ctx.resolve(args.base_map), { display: args.base_map });
    const baseImage = readFileSync(ctx.resolve(args.base_image));
    const shiftedLdmap = readLdMap(ctx.resolve(args.shifted_map), { display: args.shifted_map });
    const shiftedImage = readFileSync(ctx.resolve(args.shifted_image));
    const delta = pyInt(args.delta, 0);
    if (!!args.base_elf !== !!args.shifted_elf) {
      throw new ValueError("--base-elf and --shifted-elf go together: whether a symbol moved is a question about two links, and one of them cannot answer it");
    }
    rehearsal = buildRehearsal({ base_ldmap: baseLdmap, base_image: baseImage, shifted_ldmap: shiftedLdmap, shifted_image: shiftedImage, delta,
      anchor: args.anchor === "auto" ? null : args.anchor, blobs: blobsFor(baseLdmap, args), crc_words: crcWords, checksum_pairs: pairs,
      base_elf: args.base_elf ? readElfSymbols(ctx.resolve(args.base_elf), { display: args.base_elf }) : null, shifted_elf: args.shifted_elf ? readElfSymbols(ctx.resolve(args.shifted_elf), { display: args.shifted_elf }) : null,
      model, base_map_path: String(args.base_map), base_image_path: String(args.base_image), shifted_map_path: String(args.shifted_map),
      shifted_image_path: String(args.shifted_image) });
  } catch (e) { guard(e); return fail(io, e); }
  const payload = rehearsal.asDict({ limit: args.limit });
  let census;
  try { census = evaluateCensus(predicates, payload); } catch (e) { guard(e); return fail(io, e); }
  report(io, args, payload, census, () => rehearseLines(rehearsal, { limit: args.limit }));
  return censusStatus(census, { otherwise: 0 });
}

/** Relink once per delta through the caller's wrapper, then analyze each. */
export async function shiftOrchestrateCommand(args, io, ctx) {
  let predicates;
  try { predicates = parseCensus(args.census, { allowed: SHIFT_CENSUS_KEYS }); } catch (e) { guard(e); return fail(io, e); }
  let orchestration;
  try {
    const model = whitelistModel(args, ctx);
    const pairs = parseMapping(args.checksum_pair);
    const crcWords = parseOffsets(args.crc_words);
    const deltas = parseOffsets(args.deltas);
    if (!deltas.length) throw new ValueError("--deltas names no shift amount");
    const analyze = ({ base_map, base_image, shifted_map, shifted_image, delta }) => {
      const baseLdmap = readLdMap(ctx.resolve(base_map), { display: base_map });
      return buildRehearsal({ base_ldmap: baseLdmap, base_image: readFileSync(ctx.resolve(base_image)), shifted_ldmap: readLdMap(ctx.resolve(shifted_map), { display: shifted_map }),
        shifted_image: readFileSync(ctx.resolve(shifted_image)), delta, anchor: args.anchor === "auto" ? null : args.anchor, blobs: blobsFor(baseLdmap, args),
        crc_words: crcWords, checksum_pairs: pairs, model, base_map_path: String(base_map), base_image_path: String(base_image),
        shifted_map_path: String(shifted_map), shifted_image_path: String(shifted_image) });
    };
    orchestration = orchestrate({ wrapper: args.wrapper, ld_script: args.ld_script, anchor_object: args.anchor_object, deltas, workdir: args.workdir,
      image_name: args.image_name, map_name: args.map_name, analyze, cwd: ctx.cwd, env: ctx.env });
  } catch (e) { guard(e); return fail(io, e); }
  const payload = orchestration.asDict({ limit: args.limit });
  let census;
  try { census = evaluateCensus(predicates, payload); } catch (e) { guard(e); return fail(io, e); }
  report(io, args, payload, census, () => orchestrateLines(orchestration, { limit: args.limit }));
  return censusStatus(census, { otherwise: 0 });
}

/** Prove a config edit changed the linker script and nothing else. */
export async function shiftConfigVerifyCommand(args, io, ctx) {
  let predicates;
  try { predicates = parseCensus(args.census, { allowed: SHIFT_CENSUS_KEYS }); } catch (e) { guard(e); return fail(io, e); }
  let verification;
  try {
    if (!!args.pinned_image !== !!args.candidate_image) {
      throw new ValueError("--pinned-image and --candidate-image go together: byte-identity is a question about two images, and one of them cannot answer it");
    }
    verification = verifyFaithful({ pinned: readLdMap(ctx.resolve(args.pinned_map), { display: args.pinned_map }), candidate: readLdMap(ctx.resolve(args.candidate_map), { display: args.candidate_map }),
      pinned_image: args.pinned_image ? readFileSync(ctx.resolve(args.pinned_image)) : null,
      candidate_image: args.candidate_image ? readFileSync(ctx.resolve(args.candidate_image)) : null,
      pinned_image_path: args.pinned_image, candidate_image_path: args.candidate_image });
  } catch (e) { guard(e); return fail(io, e); }
  const payload = verification.asDict({ limit: args.limit });
  let census;
  try { census = evaluateCensus(predicates, payload); } catch (e) { guard(e); return fail(io, e); }
  report(io, args, payload, census, () => verifyLines(verification, { limit: args.limit }));
  return censusStatus(census, { otherwise: verification.faithful ? 0 : 3 });
}

/** Merge every shift report into one ranked, gated remediation queue. */
export async function shiftPlanCommand(args, io, ctx) {
  let predicates;
  try { predicates = parseCensus(args.census, { allowed: SHIFT_CENSUS_KEYS }); } catch (e) { guard(e); return fail(io, e); }
  let plan;
  try {
    const audit = readReport(ctx.resolve(args.audit), { expected: AUDIT_SCHEMA });
    const rehearsals = args.rehearse.map((p) => readReport(ctx.resolve(p), { expected: REHEARSE_SCHEMA }));
    plan = buildPlan({ audit, rehearsals, audit_path: String(args.audit), rehearse_paths: args.rehearse.map(String) });
    if (args.markdown) {
      writeFileSync(ctx.resolve(args.markdown), planMarkdown(plan), "utf8");
      io.eprint(`wrote work order: ${args.markdown}`);
    }
  } catch (e) { guard(e); return fail(io, e); }
  const payload = plan.asDict({ limit: args.limit });
  let census;
  try { census = evaluateCensus(predicates, payload); } catch (e) { guard(e); return fail(io, e); }
  report(io, args, payload, census, () => planLines(plan, { limit: args.limit }));
  return censusStatus(census, { otherwise: 0 });
}

const limitArg = (help = `rows per capped detail list (default: ${DEFAULT_LIMIT}); every list prints its cap beside its total`) =>
  ({ flags: ["--limit"], type: "int", default: DEFAULT_LIMIT, metavar: "N", help });
const commonTail = () => [...censusArgument(), ...explainKeysArgument(), ...terminalArguments()];

function rehearsalArguments() {
  return [
    { flags: ["--anchor"], default: "auto", metavar: "SYMBOL", help: "the symbol the pad was inserted at. The default, `auto`, derives "
      + "it from the two maps -- the lowest VRAM inside the movable window at which shared symbols start differing by --delta -- "
      + "which removes the footgun: an anchor wrong by one word reclassifies the whole image" },
    { flags: ["--blob"], action: "append", default: [], metavar: "SECTION", help: "treat this output section as opaque bytes: paired and counted, "
      + "but never split by its input records and never attributed to a symbol. Repeatable. Same meaning as `shift audit --blob`" },
    { flags: ["--blobs"], choices: ["auto"], default: null, help: "`auto` adopts the blob set the base map's own input records "
      + "imply -- the same derivation `shift audit --blobs auto` uses, read from the base link's map. --blob still adds on top and --no-blob subtracts" },
    { flags: ["--no-blob"], action: "append", default: [], metavar: "SECTION", help: "keep this output section out of the blob set whatever `--blobs "
      + "auto` suggested. Repeatable. Naming the same section with --blob and --no-blob is refused rather than resolved by precedence" },
    { flags: ["--crc-words"], default: "", metavar: "OFFSETS", help: "comma-separated ROM offsets a post-link CRC step writes "
      + "(N64: 0x10,0x14). Recognised before any decode or value test, so a checksum word is never explained as an address" },
    { flags: ["--checksum-pair"], action: "append", default: [], metavar: "FUNC=VAR", help: "a checksum-protected function and the variable its byte-sum is "
      + "patched into. Repeatable. Each pair is checked against the consistency rule: if any word in FUNC's body changed, VAR must "
      + "have changed too. Every pair reports a status, passes included" },
    { flags: ["--whitelist"], action: "append", default: [], metavar: "FILE", help: "addresses to accept as authentic, one `0xADDR reason` or "
      + "`0xLO-0xHI reason` per line. Repeatable. Same file `shift audit` reads" },
    limitArg(),
    { flags: ["--json"], action: "store_true", help: "emit a `decomp-workbench-shift-rehearse-v1` report" },
    ...commonTail(),
  ];
}

const AUDIT_DESCRIPTION = "Inventory a linked project's addresses without building anything. The "
  + "pin half reads the project's own linker-input symbol files and says "
  + "which addresses follow the layout (`gMainMemoryPool = main_BSS_END`) "
  + "and which are written down (`D_B0000574 = 0xB0000574`). The scan half "
  + "reads the image's data and blob regions and reports every word holding "
  + "a value inside the movable VRAM window -- with the features that "
  + "discriminate a real address reference from a packed field, a repeated "
  + "struct constant, a fixed-point table value, or build-machine garbage. "
  + "Tiers rank how confidently a word is a reference, never how dangerous "
  + "it is: a linked ROM keeps no relocations, so only a shifted relink "
  + "(`shift rehearse`) can say which references actually move.";

const REHEARSE_DESCRIPTION = "The empirical referee. Build the same objects twice against linker "
  + "scripts that differ by an inserted pad, and explain every byte of the "
  + "difference: which words tracked the shift and how, which build step "
  + "wrote the ones neither the compiler nor the linker did, and -- the "
  + "finding -- which address-shaped words stayed exactly where they were. "
  + "`analyze` explains two links you already have. `orchestrate` produces "
  + "them by calling your own relink script. Run "
  + "`decomp-workbench shift rehearse analyze --help` for the analysis.";

const ANALYZE_DESCRIPTION = "Explain the difference between one base link and one shifted relink of "
  + "the same objects. Words below the insertion pair positionally and words "
  + "at or above it pair with a delta correction, so the report counts the "
  + "thousands of words a shift really changes rather than the millions a "
  + "naive diff would. Every changed word is classified (jump targets, %hi/"
  + "%lo halves, absolute pointers, CRC and checksum storage) and every "
  + "changed word that fits no class is `unexplained` -- the gate. Every "
  + "address-shaped word that did *not* change is judged against `shift "
  + "audit`'s own confidence tiers: ranked high and unmoved is "
  + "`stale-confirmed`, the strongest available evidence for a hardcoded "
  + "pointer. The headline is that pair, and both numbers are evidence with "
  + "coordinates attached, not a verdict about your project.";

const ORCHESTRATE_DESCRIPTION = "Generate the padded linker scripts, relink through your wrapper once "
  + "per delta, analyze each result, and compare the analyses. The pad is "
  + "one line -- `. += DELTA;` after the object you name -- because the "
  + "objects are this experiment's controlled constant: relink only, never "
  + "recompile, or the question changes. Two deltas rather than one, "
  + "because a partially symbolized reference can encode correctly at one "
  + "shift by coincidence; a class count that differs between deltas is "
  + "reported as a finding.";

const CONFIG_DESCRIPTION = "Making a project shiftable means editing its linker configuration, and "
  + "the one thing that edit must not do is change the build. `verify` is "
  + "that gate as a command: every shared symbol at an identical address, "
  + "every output section placed identically, and -- when you hand it both "
  + "images -- byte-identical output. Three checks rather than one, because "
  + "a byte-identical image can coexist with a symbol that moved into a hole.";

const VERIFY_DESCRIPTION = "Compare the link your project ships against the link your configuration "
  + "edit produces, and report every way they differ. A faithful pair exits "
  + "0; anything else exits 3 and names the first divergent symbol and the "
  + "first divergent section, because the first one is the one you debug. "
  + "Note what this does *not* answer: a genuinely shifted pair fails all "
  + "three checks by construction, and that is `shift rehearse`'s question.";

const PLAN_DESCRIPTION = "Merge the audit and the rehearsals into one ranked queue, where every "
  + "item carries a remediation class, the evidence behind it, and the exact "
  + "command to run after the fix. Merged by subject rather than concatenated "
  + "by report -- a pin four reports mention is one job -- and ranked by what "
  + "the evidence cost and then by what the fix costs: convictions a relink "
  + "demonstrated, then the free wins an object already defines, then the "
  + "mechanical symbolizations, then the real migrations grouped by owning "
  + "section, with the structural classes named and parked at the bottom. The "
  + "deliverable a shiftability campaign needs is not ten thousand "
  + "address-shaped words; it is a finite queue somebody can finish.";

const SHIFT_DESCRIPTION = "Matching proves the bytes at one layout; shiftability is whether "
  + "the addresses in them are references. `audit` is the static "
  + "inventory -- one map, one image, no build. `rehearse` is the "
  + "empirical referee -- the same objects relinked against a padded "
  + "script, with every changed word explained. `config verify` is "
  + "the gate a configuration edit has to pass before either number "
  + "means anything: the candidate link must reproduce the shipped "
  + "one exactly. `plan` merges the reports into one ranked, gated "
  + "remediation queue. Run `decomp-workbench shift audit --help` "
  + "and its neighbours.";

export const COMMAND_SPECS = [
  listingSpec(["shift"], { help: "inventory and rehearse a project's shiftability", description: SHIFT_DESCRIPTION }),
  {
    path: ["shift", "audit"], handler: shiftAuditCommand, defaults: { report_command: "shift-audit" },
    help: "report where a linked project's addresses come from", description: AUDIT_DESCRIPTION,
    epilog: "example: decomp-workbench shift audit --map build/game.map --image build/game.z64 --pins ver/symbols/undefined_syms.txt --blob .assets",
    arguments: [
      { flags: ["--map"], required: true, metavar: "FILE", help: "the linked `ld -Map` file" },
      { flags: ["--image"], required: true, metavar: "FILE", help: "the linked image the map describes" },
      { flags: ["--elf"], metavar: "FILE", help: "the linked ELF this map and image came from. Optional, and it "
        + "buys two things the map cannot see. A pin an object in the link already defines: GNU ld lets a script assignment override "
        + "an object's definition with no warning, and keeps the losing definition's size on the surviving absolute symbol -- so the "
        + "check is exact rather than a heuristic, and needs no shift. Those pins are `shadowing-pin`, and deleting one is "
        + "byte-identical at the current layout. And whether --pins/--symbol-addrs itself is complete: an absolute symbol the link "
        + "carries that no supplied file names is `pins_missing_sources` -- the -T file nobody handed this run" },
      { flags: ["--pins"], action: "append", default: [], metavar: "FILE", help: "an ld-script symbol-assignment file such as ver/symbols/undefined_syms.txt; repeatable" },
      { flags: ["--symbol-addrs"], action: "append", default: [], metavar: "FILE", help: "a splat `symbol_addrs` file; repeatable. Read with the same "
        + "grammar as --pins, plus the `key:value` attributes splat writes in the trailing comment" },
      { flags: ["--blob"], action: "append", default: [], metavar: "SECTION", help: "treat this output section as opaque bytes: scanned, but never "
        + "split by its input records and never attributed to a symbol. Repeatable. Use it for DMA'd segments and boot code, whose VMA "
        + "is a load target rather than a place code lives" },
      { flags: ["--blobs"], choices: ["auto"], default: null, help: "`auto` adopts the blob set the map's own input records imply -- "
        + "every section all of whose objects are raw binaries. The report prints that suggestion either way; this is what says yes to it. "
        + "--blob still adds on top and --no-blob subtracts" },
      { flags: ["--no-blob"], action: "append", default: [], metavar: "SECTION", help: "keep this output section out of the blob set whatever `--blobs "
        + "auto` suggested. Repeatable. Naming the same section with --blob and --no-blob is refused rather than resolved by precedence" },
      { flags: ["--emit-whitelist"], metavar: "FILE", help: "write a whitelist skeleton drafted from this run's own evidence "
        + "-- hardware-window pins and kseg0 pins below the movable window floor -- each entry commented out, marked `# REVIEW:`, and "
        + "carrying the pin it came from. Refuses to overwrite an existing file; the audit runs and reports normally either way" },
      { flags: ["--whitelist"], action: "append", default: [], metavar: "FILE", help: "addresses to accept as authentic, one `0xADDR reason` or "
        + "`0xLO-0xHI reason` per line (# comments ignored, high bound inclusive). Repeatable. A reason is required: an address with "
        + "no reason is one somebody re-derives later" },
      limitArg(),
      { flags: ["--json"], action: "store_true", help: "emit a `decomp-workbench-shift-audit-v1` report" },
      ...commonTail(),
    ],
  },
  listingSpec(["shift", "rehearse"], { help: "explain a real shifted relink, word by word", description: REHEARSE_DESCRIPTION }),
  {
    path: ["shift", "rehearse", "analyze"], handler: shiftRehearseCommand, defaults: { report_command: "shift-rehearse" },
    help: "explain the difference between two prebuilt links", description: ANALYZE_DESCRIPTION,
    epilog: "example: decomp-workbench shift rehearse analyze --base-map build/base.map --base-image build/base.z64 "
      + "--shifted-map build/shift/game.map --shifted-image build/shift/game.z64 --delta 0x10 --base-elf build/base.elf "
      + "--shifted-elf build/shift/game.elf --blob .assets --crc-words 0x10,0x14 --checksum-pair race_check_finish=gRaceCheckFinishChecksum "
      + "--census unexplained_changed=0,stale_confirmed=0",
    arguments: [
      { flags: ["--base-map"], required: true, metavar: "FILE", help: "the unshifted `ld -Map` file" },
      { flags: ["--base-image"], required: true, metavar: "FILE", help: "the unshifted linked image" },
      { flags: ["--shifted-map"], required: true, metavar: "FILE", help: "the relinked build's `ld -Map` file" },
      { flags: ["--shifted-image"], required: true, metavar: "FILE", help: "the relinked build's linked image" },
      { flags: ["--delta"], required: true, metavar: "HEX", help: "bytes the pad inserted; the relinked image must be exactly this "
        + "much larger than the base, and a mismatch is refused rather than paired anyway" },
      { flags: ["--base-elf"], metavar: "FILE", help: "the unshifted link's ELF. With --shifted-elf this turns on the "
        + "symbol-side census: every symbol naming an address above the insertion must have moved by --delta. It answers the half the "
        + "word-by-word referee structurally cannot -- a reference consumed only from a lui/%lo pair in text is invisible to a value test, "
        + "and on the reference campaign the symbol side found 13x more blockers than the data side did" },
      { flags: ["--shifted-elf"], metavar: "FILE", help: "the relinked build's ELF. Goes with --base-elf; one alone is refused, because movement is a question about two links" },
      ...rehearsalArguments(),
    ],
  },
  {
    path: ["shift", "rehearse", "orchestrate"], handler: shiftOrchestrateCommand, defaults: { report_command: "shift-orchestrate" },
    help: "relink once per delta through your own script, then analyze each", description: ORCHESTRATE_DESCRIPTION,
    epilog: "example: decomp-workbench shift rehearse orchestrate --wrapper tools/relink.sh --ld-script mods/game.custom.ld "
      + "--anchor-object build/src/hasm/entrypoint.s.o --deltas 0x10,0x40 --workdir .workbench/rehearsal --image-name game.z64 --map-name game.map --blob .assets",
    arguments: [
      { flags: ["--wrapper"], required: true, metavar: "SCRIPT", help: `your project's relink script. Contract: ${WRAPPER_CONTRACT}` },
      { flags: ["--ld-script"], required: true, metavar: "FILE", help: "the project's own linker script, read but never modified in place" },
      { flags: ["--anchor-object"], required: true, metavar: "PATH", help: "the object path the pad line goes after. Exactly one line of the "
        + "linker script must mention it: zero is a typo and two is ambiguous, and both refuse before anything is built" },
      { flags: ["--deltas"], required: true, metavar: "HEX,HEX", help: "comma-separated shift amounts. Two, not one: a partially "
        + "symbolized reference can encode correctly at one delta by coincidence and cannot at two" },
      { flags: ["--workdir"], required: true, metavar: "DIR", help: "where the padded scripts and each run's output directory go" },
      { flags: ["--image-name"], default: "image", metavar: "NAME", help: "the file name the wrapper leaves the image under (default: image)" },
      { flags: ["--map-name"], default: "map", metavar: "NAME", help: "the file name the wrapper leaves the map under (default: map)" },
      ...rehearsalArguments(),
    ],
  },
  listingSpec(["shift", "config"], { help: "check a linker-configuration change against the build it must not move", description: CONFIG_DESCRIPTION }),
  {
    path: ["shift", "config", "verify"], handler: shiftConfigVerifyCommand, defaults: { report_command: "shift-config-verify" },
    help: "prove a config edit changed the script and nothing else", description: VERIFY_DESCRIPTION,
    epilog: "example: decomp-workbench shift config verify --pinned-map build/game.map --candidate-map scratch/symbolic.map "
      + "--pinned-image build/game.z64 --candidate-image scratch/symbolic.z64",
    arguments: [
      { flags: ["--pinned-map"], required: true, metavar: "FILE", help: "the `ld -Map` of the link your project ships today" },
      { flags: ["--candidate-map"], required: true, metavar: "FILE", help: "the `ld -Map` of the link your configuration edit produces" },
      { flags: ["--pinned-image"], metavar: "FILE", help: "the shipped link's image. Optional and paired: naming one image "
        + "and not the other is refused, because an identity check that silently did not run is worse than one that says so" },
      { flags: ["--candidate-image"], metavar: "FILE", help: "the candidate link's image; goes with --pinned-image" },
      limitArg(),
      { flags: ["--json"], action: "store_true", help: "emit a `decomp-workbench-shift-config-v1` report" },
      ...commonTail(),
    ],
  },
  {
    path: ["shift", "plan"], handler: shiftPlanCommand, defaults: { report_command: "shift-plan" },
    help: "merge the audit and rehearsal reports into one ranked queue", description: PLAN_DESCRIPTION,
    epilog: "example: decomp-workbench shift plan --audit audit.json --rehearse rehearse-10.json --rehearse rehearse-40.json "
      + "--markdown WORK-ORDER.md --census plan_convictions=0",
    arguments: [
      { flags: ["--audit"], required: true, metavar: "FILE", help: "a `shift audit --json` report; the static half of the queue" },
      { flags: ["--rehearse"], action: "append", default: [], metavar: "FILE", help: "a `shift rehearse --json` report, repeatable -- one per delta. "
        + "Optional: a plan from the audit alone is a plan of suspicions, and every item a rehearsal contributes outranks all of them" },
      { flags: ["--markdown"], metavar: "FILE", help: "also write the queue as a human work order: a grouped checklist "
        + "with the loop stated at the top and every item's gate command beside it" },
      limitArg(`rows the queue prints (default: ${DEFAULT_LIMIT}); the total is printed beside the cap, and --markdown exports every item`),
      { flags: ["--json"], action: "store_true", help: "emit a `decomp-workbench-shift-plan-v1` report" },
      ...commonTail(),
    ],
  },
];
