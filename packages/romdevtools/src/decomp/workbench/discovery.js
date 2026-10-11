// discovery.js - the compact journey map, the grouped spellings (aliases for
// the stable flat command names), the network inventory, and the versioned
// self-describing command map every automation client reads.
//
// Plain JS ESM + JSDoc.

import { schemaFor } from "./reporting.js";

export const COMMAND_METAVAR = "COMMAND";

/** group -> [[operation, description], ...], in journey order. */
export const COMMAND_MAP = Object.freeze({
  "object": [
    ["next", "name the next diagnostic step, with the command and why"],
    ["score", "one headline number for how far this candidate is"],
    ["diagnose", "one-screen exactness, mechanism, and next lever"],
    ["compare", "exact object truth and ranked metrics"],
    ["align", "the edit script between two objects, tolerant of shifts"],
    ["phase", "the scratch-ring phase vector over named row slots"],
    ["view", "full aligned mechanism evidence"],
    ["window", "print named aligned rows side by side"],
    ["force-rows", "join an allocator force control to the rows it moved"],
    ["slots", "count the loads, stores and address-takes per frame offset"],
    ["rank", "triage prebuilt candidate objects"],
    ["relocation-aliases", "prove linked-address-equivalent spellings"],
    ["collateral", "expose whole-object changes outside an exact function"],
    ["staleness", "refuse a comparison against a build older than its inputs"],
    ["linked-compare", "classify a built image against the target, per range"],
    ["reloc-surface", "synthesize a module's placeholder values from the image"],
    ["reloc-proof", "bind static relocation identities to exact linked bytes"],
  ],
  "scratch": [
    ["fetch", "download one decomp.me export into the standard layout"],
    ["public-match-check", "gate 0: is this function already matched in public?"],
    ["check", "validate or site-faithfully compile a decomp.me export"],
    ["bundle", "build a deterministic manual-upload handoff"],
    ["doctor", "verify retained-dump, object, and compiler readiness"],
  ],
  "handoff": [
    ["audit", "catch missing, local-only, and untracked publication dependencies"],
  ],
  "campaign": [
    ["run", "compile, cache, rank, and record source candidates"],
    ["status", "show trajectory, failures, families, and basins"],
    ["survey", "read a campaign working directory that has no manifest"],
    ["resume", "run only manifest work absent from the ledger"],
    ["note", "persist the active hypothesis for status and handoff"],
    ["export", "write bounded shareable JSON or HTML evidence"],
    ["package", "promote a winner into a paste-ready scratch bundle"],
    ["finish", "freshly rebuild a winner and audit every integration gate"],
    ["checkpoint", "archive distinct current and deterministically ranked best"],
    ["restore-best", "materialize best with drift checks and a backup"],
    ["accept", "point the manifest at one immutable accepted artifact"],
    ["dossier-add", "append a tested hypothesis and do-not-repeat result"],
    ["dossier-list", "query tested hypotheses by function or result"],
    ["readiness", "split source work from identity and remeasurement queues"],
  ],
  "experiment": [
    ["validate", "check paths, parameter assignments, and region bounds"],
    ["inspect-source", "inventory suspicious constructs before cleanup"],
    ["review-mutation", "diff a sweep winner before adopting it"],
    ["compose", "generate bounded combinations of proven mechanisms"],
  ],
  "cache": [
    ["status", "inspect cache size and age"],
    ["prune", "dry-run or recoverably move old entries to trash"],
    ["restore", "restore a prune without overwriting entries"],
  ],
  "note": [
    ["reserve", "claim the next unused identifiers before filing under them"],
    ["add", "record a finding that a concurrent writer cannot lose"],
    ["list", "render the log's entries plus the pending sidecar notes"],
    ["merge", "append pending notes to the log under an exclusive lock"],
  ],
  "context": [
    ["lint", "audit #if/#elif guards for the undefined-identifier trap"],
    ["duplicates", "find file-scope definitions repeated across fragments"],
  ],
  "project": [
    ["init", "preview discovery and explicitly write durable defaults"],
    ["show", "show resolved target, candidate, symbol, and tool defaults"],
    ["next", "run next from the configured object pair"],
    ["compare", "run compare from the configured object pair"],
    ["diagnose", "run diagnose from the configured object pair"],
    ["campaign", "run a campaign from configured build and lineage inputs"],
  ],
  "trace": [
    ["a71", "inspect or diff IDO 7.1 final-color records"],
    ["cascade", "every round of one allocator site's decision cascade"],
    ["order", "the p1 colouring order, with the same-save ties named"],
    ["blocks", "which webs occur in which blocks, and where the sets meet"],
    ["frame", "the frame ladder: every stack slot one procedure owns"],
    ["summary", "summarize function and allocator trace events"],
    ["fifo", "replay ugen pool get/put state"],
    ["globalcolor", "inspect a focused allocator decision"],
    ["origin-probe", "classify one controlled edit's allocator-web delta"],
    ["copy-decisions", "show coalesced-versus-temporary copy decisions"],
    ["alias", "inspect base-provenance and alias-query traces"],
    ["scheduler", "inspect named ready-set decisions and tie-breaks"],
    ["pre", "inspect PRE and speculative-hoist decisions"],
    ["webs", "align allocator webs by semantic provenance"],
    ["source", "join web lines to preprocessor and listing evidence"],
    ["stack-homes", "query virtual and final stack-home ownership"],
  ],
  "instrument": [
    ["ugen", "add opt-in ugen function/free-list traces"],
    ["uopt", "apply pinned, fidelity-gated uopt profiles"],
    ["globalcolor", "add focused allocator color probes"],
    ["alias", "add base-provenance alias probes"],
    ["scheduler", "apply a hash-pinned external scheduler profile"],
    ["pre", "apply a hash-pinned PRE/hoist profile"],
    ["fidelity", "gate meaningful sections, relocations, and symbols"],
    ["gate", "prove an instrumented build reproduces stock, and stamp it"],
    ["drop-in", "plan one cc carrying both passes' profiles"],
    ["check", "report which profiles a built compiler actually carries"],
  ],
  "pass": [
    ["replay-as1", "calibrate and probe late assembler scheduling"],
    ["replay-ugen", "replay a Ucode stream through stock ugen and as1"],
    ["diff", "compare user-supplied original and static pass boundaries"],
    ["binasm", "inspect a retained ugen-to-as1 peephole boundary"],
    ["ucode", "inspect retained XJP ranges, selectors, and case tables"],
  ],
  "capture": [
    ["make", "wrap an IDO root so a build retains every pass boundary"],
    ["runs", "list collected runs with phase, argv, and stream sizes"],
  ],
  "ucode": [
    ["inspect", "inspect retained XJP ranges, selectors, and case tables"],
    ["window", "print the decoded records around one stream position"],
    ["patch", "insert, replace, or delete whole records safely"],
  ],
  "binasm": [
    ["inspect", "inspect a retained ugen-to-as1 peephole boundary"],
    ["window", "print the decoded records around one stream position"],
  ],
  "stream": [
    ["diff", "compare two phase streams record by record"],
  ],
  "probe": [
    ["lines", "probe whether statement line assignment owns a schedule"],
    ["equiv", "the ranges over which every read of a local is one value"],
    ["deadread", "positions where a zero-footprint discarded read can be tried"],
  ],
  "sweep": [
    ["build", "compile a wave of candidates and score them into one table"],
    ["regress", "price every accumulated construct by removing it"],
    ["carriers", "the locals that are dead at a site, and therefore free"],
    ["donors", "the locals whose live range avoids a fusion target's"],
    ["hoist", "hoist an operand into every available carrier"],
    ["commute", "exchange every commutative operand pair"],
    ["copies", "drop a copy and rehost its reads on the original"],
    ["fuse", "fuse a donor's live range into the target's"],
    ["ingest", "gate, score and rank a built variant family"],
  ],
  "toolchain": [
    ["init", "materialize a real-copy toolchain with calibration gates"],
    ["calibrate", "run replay, collateral, and project-output gates"],
    ["status", "verify hashes and show the strongest supported claim"],
    ["fingerprint", "compile redistributable behavioral microcases"],
    ["lineage", "compare symbol lineage across object revisions"],
  ],
  "shift": [
    ["audit", "inventory where a linked project's addresses come from"],
    ["rehearse", "relink against a padded script and explain every changed word"],
    ["config", "prove a linker-config edit reproduces the shipped link exactly"],
    ["plan", "merge the reports into one ranked, gated remediation queue"],
  ],
  "target": [
    ["audit", "verify a target object's ELF scope and literal-pool extent"],
  ],
  "permute": [
    ["sweep", "drive decomp-permuter over a queue with a faithful scratch"],
    ["doctor", "preflight one function's scratch before searching it"],
    ["classify", "assign each swept function a measured wall class"],
  ],
  "ranking": [
    ["stamp", "record the tree hash a closeness ranking was measured on"],
    ["check", "report whether a ranking still describes the current tree"],
  ],
  "oracle": [
    ["plan", "build a two-phase allocator force grid"],
    ["diff", "compare compiler decisions by semantic web provenance"],
    ["force", "run a calibrated causal force set plus its baseline"],
    ["sweep", "run the full measured force grid as a cached campaign"],
    ["status", "render the latest durable sweep without recompiling"],
    ["export", "write self-contained JSON or HTML oracle evidence"],
  ],
});

/** "group operation" -> stable flat command. */
export const GROUP_ALIASES = Object.freeze({
  "object next": "next",
  "object next-dumps": "next-dumps",
  "object score": "score",
  "object compare": "compare",
  "object compare-dumps": "compare-dumps",
  "object align": "align",
  "object align-dumps": "align-dumps",
  "object phase": "phase",
  "object phase-dumps": "phase-dumps",
  "object diagnose": "diagnose",
  "object diagnose-dumps": "diagnose-dumps",
  "object view": "view",
  "object view-dumps": "view-dumps",
  "object window": "window",
  "object window-dumps": "window-dumps",
  "object force-rows": "force-rows",
  "object force-rows-dumps": "force-rows-dumps",
  "object slots": "slots",
  "object rank": "rank",
  "object relocation-aliases": "relocation-aliases",
  "object collateral": "object-collateral",
  "object staleness": "check-staleness",
  "object linked-compare": "linked-compare",
  "object reloc-surface": "reloc-surface",
  "object reloc-proof": "reloc-proof",
  "scratch fetch": "fetch-scratch",
  "scratch public-match-check": "public-match-check",
  "scratch check": "check-scratch",
  "scratch bundle": "bundle-scratch",
  "scratch doctor": "doctor",
  "handoff audit": "audit-handoff",
  "campaign run": "campaign",
  "campaign status": "campaign-status",
  "campaign survey": "campaign-survey",
  "campaign resume": "campaign-resume",
  "campaign note": "campaign-note",
  "campaign export": "campaign-export",
  "campaign package": "campaign-package",
  "campaign finish": "campaign-finish",
  "campaign checkpoint": "campaign-checkpoint",
  "campaign restore-best": "campaign-restore-best",
  "campaign accept": "campaign-accept",
  "campaign dossier-add": "campaign-dossier-add",
  "campaign dossier-list": "campaign-dossier-list",
  "campaign readiness": "target-readiness",
  "note add": "note-add",
  "note reserve": "note-reserve",
  "note list": "note-list",
  "note merge": "note-merge",
  "trace blocks": "trace-blocks",
  "trace a71": "trace-a71",
  "trace cascade": "trace-cascade",
  "trace frame": "trace-frame",
  "trace order": "trace-order",
  "trace summary": "trace-summary",
  "trace fifo": "trace-fifo",
  "trace globalcolor": "trace-globalcolor",
  "trace origin-probe": "trace-origin-probe",
  "trace copy-decisions": "trace-copy-decisions",
  "trace alias": "trace-alias",
  "trace scheduler": "trace-scheduler",
  "trace pre": "trace-pre",
  "trace webs": "trace-webs",
  "trace source": "trace-source",
  "trace stack-homes": "trace-stack-homes",
  "instrument ugen": "instrument-ugen",
  "instrument uopt": "instrument-uopt",
  "instrument globalcolor": "instrument-uopt-globalcolor",
  "instrument alias": "instrument-uopt-alias",
  "instrument scheduler": "instrument-scheduler",
  "instrument pre": "instrument-pre",
  "instrument fidelity": "fidelity",
  "instrument gate": "instrument-gate",
  "instrument drop-in": "instrument-drop-in",
  "instrument check": "check-drop-in",
  "pass replay-as1": "replay-as1",
  "pass replay-ugen": "replay-ugen",
  "pass diff": "pass-diff",
  "pass binasm": "inspect-binasm",
  "pass ucode": "inspect-ucode",
  "capture make": "capture-make",
  "capture runs": "capture-runs",
  "ucode inspect": "inspect-ucode",
  "ucode window": "ucode-window",
  "ucode patch": "ucode-patch",
  "binasm inspect": "inspect-binasm",
  "binasm window": "binasm-window",
  "stream diff": "stream-diff",
  "probe deadread": "probe-deadread",
  "probe equiv": "probe-equiv",
  "probe lines": "probe-lines",
  "sweep build": "sweep-build",
  "sweep carriers": "sweep-carriers",
  "sweep commute": "sweep-commute",
  "sweep copies": "sweep-copies",
  "sweep donors": "sweep-donors",
  "sweep fuse": "sweep-fuse",
  "sweep hoist": "sweep-hoist",
  "sweep ingest": "sweep-ingest",
  "sweep regress": "sweep-regress",
  "toolchain fingerprint": "fingerprint-toolchain",
  "toolchain lineage": "lineage",
  "toolchain init": "toolchain-init",
  "toolchain calibrate": "toolchain-calibrate",
  "toolchain status": "toolchain-status",
});

/** Every command that may open a network connection. */
export const NETWORK_COMMANDS = Object.freeze([["scratch", "fetch"], ["scratch", "public-match-check"]]);

export const NETWORK_HOSTS = Object.freeze([
  { host: "decomp.me", why: "public scratch export download and public scratch search, over HTTPS, read-only, one request per term" },
]);

export const NETWORK_POLICY = Object.freeze([
  "Offline-first: every analysis command reads local files only.",
  "A network command never runs implicitly; a user names it explicitly.",
  "A network command is never a step inside another command.",
  "Requests identify the workbench and its version, and are serialized, timed out, retried at most once, and cached on disk.",
]);

/** Flat names kept parseable but left out of help and completion. */
export const HIDDEN_FLAT_COMMANDS = Object.freeze(new Set(["campaign-accept","campaign-checkpoint","campaign-dossier-add","campaign-dossier-list","campaign-export","campaign-finish","campaign-note","campaign-package","campaign-resume","campaign-restore-best","campaign-status","campaign-survey","next-dumps","binasm-window","capture-make","capture-runs","inspect-binasm","inspect-ucode","stream-diff","ucode-patch","ucode-window","note-add","note-list","note-merge","note-reserve","sweep-build","sweep-carriers","sweep-commute","sweep-copies","sweep-donors","sweep-fuse","sweep-hoist","sweep-ingest","sweep-regress","toolchain-calibrate","toolchain-init","toolchain-status"]));

const isNetwork = (g, c) => NETWORK_COMMANDS.some(([a, b]) => a === g && b === c);

/** Translate a journey spelling to its stable flat implementation. */
export function rewriteGroupAlias(argv) {
  if (argv.length === 1 && Object.prototype.hasOwnProperty.call(COMMAND_MAP, argv[0])) return ["commands", "--group", argv[0]];
  if (argv.length < 2) return argv;
  const command = GROUP_ALIASES[`${argv[0]} ${argv[1]}`];
  return command ? [command, ...argv.slice(2)] : argv;
}

const STATEFUL = new Set(["cache restore", "campaign finish", "campaign checkpoint", "campaign restore-best", "campaign accept", "campaign dossier-add", "campaign note", "campaign package", "campaign resume", "campaign run", "note add", "note merge", "note reserve", "oracle force", "oracle sweep", "project campaign", "toolchain calibrate", "toolchain init"]);
const EXPLICIT_OUTPUT = new Set(["campaign export", "permute doctor", "permute sweep", "capture make", "experiment compose", "instrument alias", "instrument fidelity", "instrument gate", "instrument globalcolor", "instrument scheduler", "instrument pre", "instrument ugen", "instrument uopt", "oracle export", "pass replay-as1", "project init", "scratch bundle", "shift plan", "sweep commute", "sweep copies", "sweep fuse", "sweep hoist", "sweep regress"]);
const DRY_RUN_DEFAULT = new Set(["cache prune", "project init"]);
const EXTERNAL = new Set(["campaign finish", "permute doctor", "permute sweep", "campaign resume", "campaign run", "instrument fidelity", "instrument gate", "oracle force", "oracle sweep", "pass replay-as1", "project compare", "project diagnose", "project next", "project campaign", "scratch check", "scratch doctor", "shift rehearse", "sweep ingest", "toolchain calibrate", "toolchain fingerprint"]);

export function commandSafety(group, command) {
  const k = `${group} ${command}`;
  return {
    default: DRY_RUN_DEFAULT.has(k) ? "dry-run" : STATEFUL.has(k) ? "stateful" : EXPLICIT_OUTPUT.has(k) ? "writes-explicit-output" : "read-only",
    external_process: group === "object" || EXTERNAL.has(k),
    network: isNetwork(group, command),
    destructive: false,
  };
}

const REPORT_OVERRIDES = { "project campaign": "campaign", "project compare": "compare", "project diagnose": "diagnose", "project next": "next" };

/** The versioned, self-describing command map. */
export function commandMapPayload() {
  const groups = {};
  for (const [group, entries] of Object.entries(COMMAND_MAP)) {
    groups[group] = entries.map(([command, description]) => ({
      command, invocation: ["decomp-workbench", group, command], description,
      report_schema: schemaFor(REPORT_OVERRIDES[`${group} ${command}`] ?? GROUP_ALIASES[`${group} ${command}`] ?? `${group}-${command}`),
      safety: commandSafety(group, command),
    }));
  }
  return {
    schema: "decomp-workbench-command-map-v1",
    groups,
    automation: {
      success: "one versioned JSON document when --json is supported",
      failure_schema: "decomp-workbench-error-v1",
      exit_codes: { 0: "success", 1: "gate/no-result", 2: "usage/capability/process", 3: "census-failed" },
      next_actions: "next reports command_argv, safety, and expected_signal",
    },
    network: {
      policy: [...NETWORK_POLICY],
      commands: [...NETWORK_COMMANDS].sort().map(([g, c]) => ({ invocation: ["decomp-workbench", g, c], command: `${g} ${c}` })),
      hosts: NETWORK_HOSTS.map((h) => ({ ...h })),
    },
    compatibility: "Existing flat command names remain supported; grouped spellings are aliases.",
  };
}

/** The terminal journey map. */
export function renderCommandMap({ group = null } = {}) {
  let groups = Object.entries(COMMAND_MAP);
  if (group) {
    if (!Object.prototype.hasOwnProperty.call(COMMAND_MAP, group)) throw new Error(`unknown command group: ${group}`);
    groups = [[group, COMMAND_MAP[group]]];
  }
  const lines = ["Journey command map", "Grouped spellings and existing flat commands are both supported."];
  for (const [name, entries] of groups) {
    lines.push("", name);
    const width = Math.max(...entries.map(([c]) => c.length));
    for (const [c, desc] of entries) lines.push(`  ${name} ${c.padEnd(width)}  ${desc}`);
  }
  lines.push("", "Start here: decomp-workbench doctor",
    "Common diagnosis: decomp-workbench diagnose target.o candidate.o",
    "Next lever: decomp-workbench guide <playbook|verdict|lever>",
    "Late-stage loop: ranking check -> permute doctor -> permute sweep",
    "                 -> permute classify -> diagnose --trace -> compare --built-from",
    "                 (docs/permute-sweep.md)");
  return lines;
}

/**
 * Every top-level command word in the order the parser registers it, which
 * is the order the top-level help lists them.
 */
export const TOP_LEVEL_ORDER = Object.freeze(["compare","compare-dumps","view","view-dumps","diagnose","diagnose-dumps","window","window-dumps","align","align-dumps","phase","phase-dumps","shift","target","object-collateral","rank","guide","audit-handoff","commands","completion","object","scratch","handoff","note","probe","sweep","trace","instrument","pass","capture","ucode","binasm","stream","toolchain","trace-scheduler","trace-emit","instrument-scheduler","trace-pre","instrument-pre","trace-copy-decisions","trace-webs","trace-origin-probe","trace-stack-homes","trace-a71","trace-cascade","trace-order","trace-blocks","trace-frame","force-rows","force-rows-dumps","trace-source","pass-diff","inspect-binasm","inspect-ucode","capture-make","capture-runs","ucode-window","binasm-window","stream-diff","ucode-patch","replay-ugen","permute-sweep","permute-doctor","permute-classify","permute","ranking","target-readiness","probe-lines","probe-equiv","probe-deadread","slots","sweep-carriers","sweep-donors","sweep-regress","sweep-hoist","sweep-commute","sweep-copies","sweep-fuse","sweep-build","sweep-ingest","check-staleness","fingerprint-toolchain","lineage","relocation-aliases","reloc-surface","linked-compare","reloc-proof","fidelity","instrument-gate","toolchain-init","toolchain-calibrate","toolchain-status","oracle","experiment","score","matrix","note-add","note-reserve","note-list","note-merge","next","next-dumps","check-scratch","doctor","install-skill","compile-rank","campaign","campaign-survey","campaign-status","campaign-resume","campaign-export","campaign-package","campaign-finish","campaign-note","campaign-checkpoint","campaign-restore-best","campaign-accept","campaign-dossier-add","campaign-dossier-list","cache","context","fetch-scratch","public-match-check","project","instrument-ugen","instrument-uopt-globalcolor","instrument-uopt-alias","instrument-uopt","instrument-drop-in","check-drop-in","trace-summary","trace-alias","trace-fifo","trace-globalcolor","replay-as1","bundle-scratch"]);
