// decomp.js - the matching-decompilation domain: one tool, keyed by `op`, that
// runs the function-level generate → compile → compare → refine loop against a
// registered project's OWN compiler and build system, with the project's splat
// segment map as the single address resolver.
//
// Nothing here writes into the project's source tree except op:'integrate'
// with apply:true, which applies a reviewable patch and REVERTS it unless the
// full rebuilt ROM is byte-exact.
//
// Errors carry a typed `code` (AMBIGUOUS_OVERLAY, UNMAPPED_VA, SEGMENT_MISMATCH,
// PROJECT_NOT_REGISTERED, WRONG_ROM, MISSING_COMPILER, MISSING_BACKEND,
// NO_TARGET_ASM, FUNCTION_NOT_IN_TU, STALE_CONTEXT, COMPILE_FAILED,
// CANDIDATE_REJECTED, SEARCH_IMPORT_FAILED, JOB_NOT_FOUND, CANCELLED,
// LOST_RUNTIME_STATE, PC_BREAK_UNSUPPORTED, UNSUPPORTED_OP).
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { jsonContent, safeTool } from "../util.js";

const hexOrInt = (v) => (typeof v === "string" ? parseInt(v, 16) : v);

/** Wrap a handler so thrown errors with a `.code` come back as a typed error object. */
function typed(fn) {
  return async (args) => {
    try { return await fn(args); }
    catch (e) {
      const code = e?.code && /^[A-Z_]+$/.test(String(e.code)) ? e.code : "ERROR";
      const err = new Error(`[${code}] ${e?.message ?? e}${e?.candidates ? ` candidates: ${(Array.isArray(e.candidates) ? e.candidates : []).map((c) => c.segment ?? c).join(", ")}` : ""}`);
      err.code = code;
      throw err;
    }
  };
}

/**
 * Every op this tool serves. ONE source of truth: the schema builds from it and
 * the skill-staleness check reads it, so a shipped op cannot be missing from
 * the installed skill while the version number says everything is current.
 */
export const DECOMP_OPS = Object.freeze(["import", "status", "refresh", "list", "map", "plan", "batch", "resolve", "context", "generate", "types", "compare", "search", "job", "jobs", "candidates", "integrate", "verify", "progress", "smoke", "overlays", "symbolize", "state", "trace", "coverage", "workbench", "dispatch", "experiment", "gate", "typeGraph", "rank", "ledger", "scenario", "capabilities", "knownSource", "assets", "artifacts", "handoff", "skill", "diagnose", "research", "variants", "layout", "replay"]);

export function registerDecompTools(server, z, sessionKey) {
  server.tool(
    "decomp",
    "Matching decompilation: recover C that compiles to the ORIGINAL bytes with the project's ORIGINAL compiler (splat + IDO/GCC projects; proven on an N64/IDO 5.3 checkout). Keyed by `op`. " +
    "This is the user-authorized LOCAL-TOOLCHAIN path: a registered project's compiler, assembler and make are run as-is (never romdev's WASM toolchains, never a host install started by romdev). " +
    "LOOP: import (once) → plan (payoff-ordered queue + batches over the call graph) → resolve (segment-exact address, provenance) → generate (m2c candidate with the TU's real type context) → compare (compile the candidate INSIDE its translation unit with the TU's exact flags; strict per-instruction + relocation equality; ROM-linked word equality; other functions in the TU unchanged; a documented distance for ranking) → search (bounded decomp-permuter job; cancel/resume/best/report) → integrate (reviewable patch; apply + full-ROM byte verify, auto-revert on mismatch) → progress (code-byte progress from the build's objects, states kept separate). " +
    "RUNTIME: smoke (base vs rebuilt, decoded pixels + CPU regs, replayable script), overlays (which overlay is resident, by bytes), symbolize (live PC → symbol with the resident overlay), state (is the session's emulator still there, and why not), trace (args/return of a function where the core can stop), coverage (sampled function-level observed/unobserved/unreferenced). " +
    "Every result names the project, function {symbol, segment, va}, candidate sha, compiler fingerprint and artifact paths; errors carry a typed [CODE]. `exactFunctionMatch` and `romLinked.status:'exact'` are the acceptance signals; `distance` is a ranking hint, never proof. " +
    "Ghidra pseudocode stays in disasm({target:'decompile'}) for understanding; it is never counted as matched.",
    {
      op: z.enum(DECOMP_OPS).describe(
        "import=register a project (root; splat yaml auto-detected; ROM sha1 verified; toolchain fingerprinted; compile invocation captured from make); " +
        "status=manifest + backend identities + segment table; list=registered projects; map=TU → object → segment → functions associations; " +
        "plan=payoff-ordered queue of remaining asm functions + batches that call each other inside one TU (call graph from the built objects' relocations); batch=generate+compare every function of a batch (`symbols`), sharing the context; " +
        "resolve=symbol/va → {segment, romOffset, va, size, tu, state, targetAsm, bytes sha1, compile invocation} (overlay VAs need `segment`; ambiguity returns the candidates, never a guess); " +
        "context=preprocess the function's TU into the m2c type context (cached by TU+headers+flags hash); " +
        "generate=m2c candidate with that context (stored as a candidate file; reports declarations it invented + type hypotheses with offsets + asm access widths, persisted); types=the persisted type evidence (hypotheses, never confirmed types); " +
        "compare=compile `candidatePath`/`candidateText` inside the TU with the captured flags → strict/ROM-linked/TU verdicts + classified diff + lint (cached by dependency hash + candidate sha); " +
        "search=start a bounded decomp-permuter job from a base candidate; job=status/best/cancel/report one job (`jobId`, `action`); jobs=list jobs; candidates=every compared candidate for a function with its verdict; " +
        "integrate=write a unified patch for the TU (apply:true also applies it, runs the full build and verifies the ROM byte-for-byte, reverting on mismatch); verify=full build + ROM sha1 with no change; " +
        "progress=per-object code-byte progress (asm vs C, library, hasm, data refs, retained inline asm) from the linker map; " +
        "smoke=run base ROM vs rebuilt ROM for N frames on the pinned core in two isolated sessions and compare decoded pixels + CPU registers (script persisted; `scriptPath` replays); " +
        "overlays=which overlay is resident at each shared VA in the live session (`session`), by comparing RAM with each candidate's ROM bytes; symbolize=live `va` → symbol/segment using the resident overlay; state=is `session`'s emulator alive, else a machine-readable loss reason + recovery; " +
        "trace=stop at a function's entry on the live session and read a0-a3/f12/f14/stack args, then v0/v1/f0 at return (N64: load the session with coreOptions {'parallel-n64-cpucore':'pure_interpreter'}; the result carries the core probe and says PC_BREAK_UNSUPPORTED with evidence otherwise); coverage=instruction-exact function + basic-block observed/unobserved/unreferenced over `frames` with `inputs` from the core's PC log (interpreter), else frame-boundary samples with the method stated."),
      project: z.string().optional().describe("Project id (required by every op except list). op:'import' picks it."),
      // op:'workbench' - the n64-decomp-workbench bridge.
      // op:'experiment' / op:'gate'
      // ONE `action` FOR EVERY OP THAT HAS ONE. This was declared twice and the
      // second declaration - the job-only set - overwrote the first, so every
      // other op's action vocabulary was rejected by the validator BEFORE its
      // handler ran: scenario save/run, experiment create/control/conclude,
      // skill preview/write and artifact prune/restore were all unreachable
      // through the public schema while their handlers sat there working.
      // `artifacts action:'status'` appeared to work only because 'status'
      // happened to be in the job enum.
      action: z.enum([
        // op:'job'
        "status", "best", "cancel", "report",
        // op:'experiment'
        "create", "control", "candidate", "conclude", "list", "families",
        // op:'scenario'
        "save", "run",
        // op:'assets'
        "unpack", "repack",
        // op:'skill'
        "preview", "write",
        // op:'artifacts'
        "prune", "restore", "pin",
        // op:'research'
        "import",
      ]).optional().describe(
        "op:'job' - status (default), best, cancel, report. "
        + "op:'experiment' - create, control, candidate, conclude, list, families. "
        + "op:'scenario' - save, run, list. "
        + "op:'assets' - unpack (decode one container to a file), repack (compress an edited payload back, verified by decoding it again). "
        + "op:'skill' - preview (default), write. "
        + "op:'artifacts' - status (default), prune, restore, pin. "
        + "op:'research' - list (default), import, status."),
      experimentId: z.string().optional().describe("op:'experiment' - the record to act on (from action:'create' or action:'list')."),
      hypothesis: z.string().optional().describe("op:'experiment' action:'create' - ONE falsifiable causal claim. Required: an experiment without one is a sweep, and a sweep is what produced 264 undifferentiated candidates for a single function."),
      lever: z.string().optional().describe("op:'experiment' action:'create' - the SINGLE source change being varied. Required: varying two things at once cannot attribute the result."),
      family: z.string().optional().describe("op:'experiment' action:'create' - the source family this belongs to (e.g. 'stack-homes', 'global-coloring'), so exhausted families are queryable."),
      controlKind: z.enum(["positive", "negative", "determinism"]).optional().describe("op:'experiment' action:'control' - positive MUST move the metric, negative MUST NOT, determinism runs the same input twice."),
      moved: z.boolean().optional().describe("op:'experiment' action:'control' - did the metric actually move?"),
      verdict: z.enum(["accepted", "rejected", "exhausted"]).optional().describe("op:'experiment' action:'conclude'."),
      scope: z.string().optional().describe("op:'experiment' action:'conclude' - what the conclusion covers."),
      rationale: z.string().optional().describe("op:'experiment' action:'conclude' - why."),
      exactFunctionMatch: z.boolean().default(false).describe("op:'gate'/'experiment' - did the compare report a byte-exact function match? The gate classifies source QUALITY and never overwrites this."),
      functionLocal: z.string().optional().describe("op:'gate'/'experiment' - the compare's function-local verdict ('exact', 'mismatch', ...)."),
      distance: z.number().optional().describe("op:'experiment' action:'candidate' - the candidate's distance metric."),
      notes: z.string().optional().describe("op:'experiment' - free-text detail for a control or the record."),
      baseline: z.record(z.any()).optional().describe("op:'experiment' action:'create' - baseline identities (source/object/target/toolchain) this experiment varies from."),
      parentId: z.string().optional().describe("op:'experiment' action:'create' - the experiment this one descends from."),
      workClass: z.union([z.string(), z.array(z.string())]).optional().describe("op:'plan' - restrict the queue to these work classes (game-matching-c, libultra-known-source, handwritten-asm-retain, rsp-source, asset-data). Default: game-matching-c. op:'knownSource' - hint the class so the response can say whether published SDK source should be searched first."),
      includeAllClasses: z.boolean().default(false).describe("op:'plan' - include EVERY work class in the queue, not just game targets."),
      forceGraph: z.boolean().default(false).describe("op:'plan' - rebuild the call graph instead of using the content-addressed cache."),

      inputPath: z.string().optional().describe("op:'assets' action:'repack' - the edited payload to compress back into a container."),
      outputPath: z.string().optional().describe("op:'assets' - unpack/repack destination. op:'workbench' - complete JSON report destination; oversized reports otherwise go to the workspace automatically, with a compact response."),
      batch: z.string().optional().describe("op:'artifacts' action:'restore' - which prune batch to put back (default: the most recent). A batch id comes from a prune's `trash` path."),
      romOffset: z.number().int().optional().describe("op:'assets' - ROM offset of a range to identify/round-trip. Omit to scan every bin range."),
      length: z.number().int().optional().describe("op:'assets' - byte length of the range at `romOffset`."),
      scenarioName: z.string().optional().describe("op:'scenario' - the scenario to run or save."),
      scenarioDef: z.record(z.any()).optional().describe("op:'scenario' action:'save' - {name, frames, inputs:[{frame,buttons,until}], checkpoints:[{frame,regions}], expectedOverlays}."),
      rebuild: z.boolean().default(false).describe("op:'typeGraph' - rebuild from every stored per-function record instead of using the cached graph."),
      base: z.string().optional().describe("op:'typeGraph' - propose a C struct for this base (from `bases[].base`)."),
      preferTemporaryPrefix: z.boolean().default(false).describe("op:'rank' - request temporary-prefix ranking. It is applied ONLY when its precondition holds (a single gap state); otherwise the safe fallback runs and the response says why."),
      candidates: z.array(z.record(z.any())).optional().describe("op:'rank' - candidate records to rank (workbench comparison blocks or romdev compare results)."),
      baselineText: z.string().optional().describe("op:'gate' - the source the candidate was derived from; enables the behaviour-delta checks (volatile, removed calls, short-circuit, signedness)."),
      // op:'dispatch' - parallel, memory-bounded triage.
      budgetMiB: z.number().int().min(512).optional().describe("op:'dispatch' - memory ceiling for the worker pool. Default: total RAM minus a reserve for the server and the build. Admission is by MEASURED peak RSS per worker class, not by a thread count."),
      maxWorkers: z.number().int().min(1).max(64).optional().describe("op:'dispatch' - hard cap on concurrent workers (default: cpus-2, max 12). The per-TU lock usually binds first."),
      wbGroup: z.string().optional().describe("op:'workbench' - command group (object, campaign, experiment, probe, trace, permute, sweep, oracle, pass, instrument, ...). Omit wbCommand to list the discovered catalog."),
      wbCommand: z.string().optional().describe("op:'workbench' - the command inside the group (e.g. 'diagnose', 'compare', 'collateral', 'staleness', 'linked-compare', 'reloc-proof'). Omit to get the catalog instead of running anything."),
      wbArgs: z.array(z.string()).optional().describe("op:'workbench' - positional args and flags passed through verbatim (e.g. [targetObj, candidateObj]). The project's --objdump is appended automatically when you do not pass one."),
      traceMode: z.enum(["scheduler", "globalcolor"]).optional().describe("op:'workbench' with artifactId: scheduler captures native IDO -Wa,-R; globalcolor explicitly opts into building a workspace-only diagnostic IDO 5.3 uopt with the existing workbench's pinned profile. No project compiler is replaced. Both tracing-disabled and tracing-enabled diagnostic objects must equal the compared object before allocator attribution. Baseline optimization flags stay unchanged."),
      allowDestructive: z.boolean().default(false).describe("op:'workbench' - required to run a command the workbench's OWN catalog marks destructive."),
      allowNetwork: z.boolean().default(false).describe("op:'workbench' - required to run a command the workbench's OWN catalog marks as reaching the network."),
      timeoutMs: z.number().int().min(1000).max(3_600_000).optional().describe("op:'workbench' - per-command timeout (default 600000)."),
      force: z.boolean().default(false).describe("op:'workbench' - re-read the command catalog instead of using the cached one."),
      root: z.string().optional().describe("op:'import' - absolute path of the decompilation checkout (the dir with the splat yaml + Makefile). op:'research' action:'import' - a directory of prior research (drafts and notes) to INDEX. op:'replay' - the research root holding the replay fixtures (default: <project>/docs/research). Indexing records what exists; it never turns a note into a verified result."),
      splatYaml: z.string().optional().describe("op:'import' - splat yaml (relative to root) when auto-detection finds more than one."),
      rom: z.string().optional().describe("op:'import' - base ROM path when it differs from the yaml's target_path."),
      expectedSha1: z.string().optional().describe("op:'import' - expected base-ROM sha1 (default: the yaml's)."),
      buildCommand: z.array(z.string()).optional().describe("op:'import' - argv of the full-build command run from root (default: tools/matching-build.sh if present, else make)."),
      symbol: z.string().optional().describe("Function symbol name (func_801DEB08). Alternative to `va`."),
      symbols: z.array(z.union([z.string(), z.object({ symbol: z.string(), segment: z.string().optional(), va: z.union([z.string(), z.number()]).optional(), targetId: z.string().optional() }).passthrough()])).optional().describe("op:'batch' - the functions to run (a batch from op:'plan'). op:'dispatch' - explicit symbols to triage; omit to take the top of the plan queue. op:'replay' - restrict the run to these case ids or symbols. Each entry is either a bare symbol name OR a target record {symbol, segment} - required when a VA is mapped by several overlays, since a bare name cannot say which overlay it belongs to. op:'plan' returns records in this shape, so a plan batch can be passed straight back."),
      va: z.union([z.number().int(), z.string()]).optional().describe("Virtual address (number, or hex string '0x801DEB08')."),
      segment: z.string().optional().describe("Segment name to disambiguate an overlay VA (the resolver lists candidates when ambiguous)."),
      tu: z.string().optional().describe("op:'plan'/'map' - restrict to one translation unit (relative path)."),
      limit: z.number().int().min(1).max(500).default(40).describe("op:'plan' - page size. The full ranked set is paged, so a small limit never silently excludes the rest: the response reports `page.hasMore` and `page.nextOffset`."),
      offset: z.number().int().min(0).default(0).describe("op:'plan' - start of the page into the ranked queue."),
      ignoreCooldown: z.boolean().default(false).describe("op:'plan': deliberately rank hard targets without the temporary no-progress penalty; recorded reasons remain visible."),
      cooldownBatches: z.number().int().min(1).max(100).default(3).describe("op:'plan': independent current-baseline no-progress batches before a temporary rank penalty."),
      cooldownMinutes: z.number().int().min(1).max(10080).default(60).describe("op:'plan': duration of the no-progress rank penalty; no target is excluded."),
      proposedLever: z.string().optional().describe("op:'plan': a genuinely new diagnosis lever bypasses cooldown; existing lever outcomes remain historical evidence, not family-wide exhaustion."),
      objective: z.enum(["byte-coverage", "function-count", "shared-type", "diagnostic-research"]).default("byte-coverage").describe("op:'plan' - what to optimise the queue FOR. byte-coverage ranks large routines first (default); function-count ranks small well-constrained targets first, which is the right queue for 'another N verified functions'; shared-type ranks functions whose typed neighbours already pin their structs; diagnostic-research ranks measured near-misses. Each row reports the factors behind its rank; no completion-time estimates are invented."),
      // DECLARED TWICE before: the op:'batch' version silently replaced the
      // op:'dispatch' one and narrowed its ceiling from 512 to 64. Same
      // duplicate-key bug that made five `action` vocabularies unreachable.
      maxFunctions: z.number().int().min(1).max(512).default(12).describe("op:'batch'/'dispatch': cap on functions. op:'variants': cap on variants. op:'job' action:'report': cap on saved search outputs recompiled for residual/output-identity verification (default 12). Truncation remains explicit."),
      timeBudgetS: z.number().int().min(10).max(86400).default(600).describe("op:'batch' - wall-clock budget (default 600). op:'dispatch' - wall-clock budget; remaining functions come back as `skipped`."),
      candidatePath: z.string().optional().describe("op:'compare'/'search'/'integrate'/'gate'/'variants'/'experiment' - path to a C file holding the function definition (+ any local declarations it needs). op:'artifacts' action:'pin' - the candidate to pin."),
      candidateText: z.string().optional().describe("op:'compare'/'search'/'integrate'/'gate'/'variants'/'experiment' - the candidate C inline (alternative to candidatePath)."),
      variants: z.array(z.object({
        id: z.string().describe("stable id for this variant, used in the results table"),
        hypothesis: z.string().optional().describe("the ONE thing this variant tests"),
        lever: z.string().optional().describe("op:'variants': diagnosis experiment id, e.g. declaration-order; links this exact measured input to prior outcomes without exhausting the whole lever"),
        find: z.string().optional().describe("literal text in the baseline to replace; must occur EXACTLY once"),
        replace: z.string().optional().describe("what to replace it with (omit to delete)"),
        candidateText: z.string().optional().describe("full replacement source, instead of find/replace"),
      })).optional().describe("op:'variants' - a bounded list of named source variants measured against one baseline under ONE dependency snapshot. Duplicate sources and byte-identical outputs are reported rather than silently dropped."),
      prefer: z.enum(["best", "newest"]).default("best").describe("op:'diagnose'/'layout' - which stored comparison a SYMBOL-ONLY call analyses. 'best' (default) = fewest ROM-linked mismatches, ties by recency; 'newest' = most recently compared. The chosen artifact, the policy and the alternatives are always reported, because a symbol-only call does not automatically describe your latest candidate."),
      artifactId: z.string().optional().describe("op:'diagnose'/'layout'/'workbench' - stored compare `.diff.json` path or cache key. Diagnose/layout reuse streams. Workbench object diagnose resolves and verifies retained objects; trace scheduler captures a verified native trace from the retained TU."),
      tracePath: z.string().optional().describe("op:'diagnose' - as1 trace with its .manifest.json bundle from workbench trace capture. Source attribution requires verified invocation and emitted-object equality; loose logs remain explicitly unverified."),
      ownerPath: z.string().optional().describe("op:'compare' - REPLAY FIXTURE: compile the candidate into this saved owner TU instead of the one in the current tree. Use the pre-integration backup to re-verify a function that has since been integrated; without it the accepted definition is already present and the compile fails with 'redeclaration'."),
      contextHash: z.string().optional().describe("op:'compare' - the context hash the candidate was generated against; the result flags contextStale when the TU/headers/flags changed since."),
      declarations: z.string().optional().describe("op:'compare'/'integrate'/'variants'/'generate' - extra declarations (proposed structs/prototypes) placed before the function in the TU copy; pair with the same text passed to generate as extraContext."),
      extraContext: z.string().optional().describe("op:'generate' - C declarations (proposed structs/prototypes, e.g. decomp({op:'types', propose:true}).text) appended to the TU's context so the draft is generated with those types WITHOUT editing a header."),
      propose: z.boolean().default(false).describe("op:'types' - also propose struct typedefs + a prototype from the evidence (a proposal, not confirmed types)."),
      chunkFrames: z.number().int().min(1).max(600).default(10).describe("op:'coverage' - frames per bitmap read between input events (input events split chunks anyway); the union is the same, smaller chunks only cost more reads."),
      cpuCore: z.enum(["pure_interpreter", "cached_interpreter", "dynamic_recompiler"]).optional().describe("op:'smoke' - N64 CPU core option for both sessions (pure_interpreter enables PC breaks, single-step and the PC coverage log; default is the core's dynarec)."),
      label: z.string().optional().describe("Free label stored with the candidate/job."),
      maxDiffInstructions: z.number().int().min(4).max(400).default(40).describe("op:'compare' - lines in the inline diff preview (full diff always on disk)."),
      noCache: z.boolean().default(false).describe("op:'compare'/'variants' - recompile even if this candidate was compared under the same dependency hash. op:'context' - rebuild the context cache."),
      verifyTu: z.boolean().default(true).describe("op:'compare'/'variants' - also check every OTHER function in the TU's object is unchanged."),
      timeLimitS: z.number().int().min(10).max(86400).default(300).describe("op:'search' - wall-clock budget."),
      purpose: z.string().min(1).optional().describe("op:'search': required statement of which residual/hypothesis justifies spending this budget."),
      mutationPasses: z.array(z.string()).min(1).optional().describe("op:'search': backend pass names to enable exclusively, e.g. perm_reorder_decls or perm_sameline. Validated against the installed backend; other randomization weights become zero."),
      noImprovementS: z.number().int().min(1).max(86400).default(30).describe("op:'search': stop after this many seconds without a better backend score. Process-local watchdog; total budget remains enforced across server restart."),
      repeatSearch: z.boolean().default(false).describe("op:'search': explicitly repeat an identical baseline/family/seed scope previously measured without improvement; previous jobs remain visible."),
      threads: z.number().int().min(1).max(32).optional().describe("op:'search' - permuter workers (default 2). op:'variants' - bounded compile workers, 1 or 2 only (default 1); baseline always runs first. Same option, no separate batch tool."),
      detail: z.boolean().default(false).describe("op:'compare' - return full evidence instead of the compact verdict/residuals. op:'workbench' - explicitly inline the full report even when large; default oversized reports are saved on disk with a bounded projection."),
      preflight: z.boolean().default(true).describe("op:'search' - compile and identify the base before spending search budget. A non-compiling, invalid or already-exact base is refused. Legacy false is rejected because an unidentified baseline cannot support measured search conclusions."),
      seed: z.string().optional().describe("op:'search' - permuter seed. The backend accepts ONLY integers: 'rngSeed' (e.g. '297') or 'permuterIndex,rngSeed' (e.g. '0,297'). A descriptive label ([A-Za-z0-9][A-Za-z0-9._-]*) is accepted too and mapped DETERMINISTICALLY onto that space; the response returns the mapping so the run can be reproduced. An unusable seed is refused synchronously, before any job directory or process exists. Seed identity fixes the mutation stream, NOT thread scheduling: with threads>1 the ORDER results arrive still varies."),
      jobId: z.string().optional().describe("op:'job' - the job to inspect/cancel/report."),
      resumeFrom: z.string().optional().describe("op:'search' - a previous jobId whose best candidate becomes the base."),

      // ONE declaration covering BOTH ops. Declared twice, the second silently
      // replaced the first and the per-op validator then refused `apply` on
      // artifacts - the same duplicate-key bug that made five `action`
      // vocabularies unreachable.
      apply: z.boolean().default(false).describe("op:'integrate' - apply the patch to the TU (else only write it). op:'artifacts' action:'prune' - actually move the duplicates to trash. Default is a DRY RUN; only byte-identical duplicates are ever proposed, files backing an accepted conclusion are always skipped, and a prune is recoverable with action:'restore'."),
      verify: z.boolean().default(true).describe("op:'integrate' - after apply, run the full build and compare the ROM (revert on mismatch)."),
      jobs: z.number().int().min(1).max(64).default(8).describe("op:'integrate'/'verify' - make -j."),
      frames: z.number().int().min(1).max(100000).default(720).describe("op:'smoke'/'coverage' - frames to run."),
      inputs: z.array(z.object({ frame: z.number().int().min(0), buttons: z.record(z.string(), z.boolean()) })).optional().describe("op:'smoke'/'coverage' - input script applied identically (persisted with the smoke report)."),
      scriptPath: z.string().optional().describe("op:'smoke' - replay a persisted inputs.json instead of `inputs`/`frames`."),
      maxFrames: z.number().int().min(1).max(100000).default(600).describe("op:'trace' - frames to wait for the function's entry."),
      pressDuring: z.any().optional().describe("op:'trace' - a breakpoint({on:'pc'}) pressDuring schedule to drive the scenario."),
      session: z.string().optional().describe("The session handle. op:'smoke' derives '<session>:orig' and '<session>:rebuilt'; overlays/symbolize/state/trace/coverage act on the session that loaded the ROM (default: this call's session)."),
    },
    safeTool(typed(async (args) => {
      const { Project, importProject, listProjects } = await import("../../decomp/project.js");
      switch (args.op) {
        case "list": return jsonContent({ projects: await listProjects() });
        case "import": {
          if (!args.project || !args.root) throw Object.assign(new Error("decomp({op:'import'}): `project` (an id you choose) and `root` are required."), { code: "BAD_ARGS" });
          let m;
          try { m = await importProject({ id: args.project, root: args.root, splatYaml: args.splatYaml, rom: args.rom, expectedSha1: args.expectedSha1, buildCommand: args.buildCommand }); }
          catch (e) { if (/sha1 .* != expected/.test(e.message)) e.code = "WRONG_ROM"; throw e; }
          const { backendStatus } = await import("../../decomp/m2c.js");
          const p = new Project(m);
          const map = await p.map();
          return jsonContent({
            registered: true, project: m.id, root: m.root, platform: m.platform, workspace: p.ws,
            rom: m.rom, toolchain: m.toolchain, compilerMissing: m.toolchain?.compiler ? undefined : { code: "MISSING_COMPILER", note: "no IDO binary found under tools/ido-static-recomp/build/*/out/cc - compare/search will refuse until it is built" },
            build: m.build, built: m.built, git: m.git, segments: map.table(), backends: await backendStatus(),
            nextStep: `decomp({op:'plan', project:'${m.id}'}) for the payoff-ordered queue, then resolve/generate/compare. Nothing in ${m.root} was modified.`,
          });
        }
        case "skill": {
          // A STALE SKILL IS WORSE THAN NO SKILL. An agent reading a
          // confidently wrong document stops; an agent with no document asks.
          // The installed skill declared ~14 platforms and never mentioned N64
          // while the server had full N64 support and a whole decomp domain.
          const SK = await import("../../decomp/skill-sync.js");
          const { CAPABILITIES } = await import("../../cores/capabilities.js");
          const pkgVersion = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")).version;
          const platforms = Object.keys(CAPABILITIES);
          const decompPlatforms = platforms.filter((p) => CAPABILITIES[p]?.ops?.decompile || CAPABILITIES[p]?.decomp);
          // The LIVE op list, read from this tool's own schema, so a skill that
          // omits a shipped op is detected as stale even when its version
          // number matches. Hardcoding the list here would drift the same way
          // the skill did.
          const server = { version: pkgVersion, platforms, hasDecomp: true, ops: [...DECOMP_OPS] };
          const status = await SK.skillStatus(server);
          if (args.action !== "write") {
            return jsonContent({ ...status, serverPlatforms: platforms.length,
              preview: "pass action:'write' to regenerate the skill from the live capability manifest (the previous file is backed up first)." });
          }
          const content = SK.generateSkill({
            version: pkgVersion, platforms, decompPlatforms,
            toolCount: null, ops: [...DECOMP_OPS],
            domains: [
              { name: "build + run", description: "compile for a platform, load media, step frames, screenshot, script controller input" },
              { name: "inspect", description: "memory regions, CPU and sound-chip state, sprites, palettes, tilemaps" },
              { name: "reverse-engineer", description: "value search, write/read watchpoints, disassembly, control-flow graphs, cross-references, Ghidra pseudocode, live jumptable recovery" },
              { name: "decomp", description: "matching decompilation against the project's own compiler and build system" },
              { name: "port engine", description: "static recompilation between consoles (6502 and Z80 sources today)" },
            ],
          });
          return jsonContent({ ...(await SK.writeSkill(content, { targetPath: args.outputPath })), previousStatus: status });
        }
      }
      if (!args.project) throw Object.assign(new Error(`decomp({op:'${args.op}'}): \`project\` is required (decomp({op:'list'}) shows registered ids).`), { code: "BAD_ARGS" });
      const project = await Project.open(args.project);
      const live = args.session ?? sessionKey;
      const resolveFn = async () => {
        if (!args.symbol && args.va == null) throw Object.assign(new Error(`decomp({op:'${args.op}'}): pass \`symbol\` or \`va\`.`), { code: "BAD_ARGS" });
        return project.resolveFunction({ symbol: args.symbol, va: args.va != null ? hexOrInt(args.va) : undefined, segment: args.segment });
      };
      const candidateSource = async () => {
        if (args.candidateText) return { text: args.candidateText, path: null };
        if (args.candidatePath) return { text: await readFile(args.candidatePath, "utf8"), path: args.candidatePath };
        throw Object.assign(new Error(`decomp({op:'${args.op}'}): pass candidatePath or candidateText.`), { code: "BAD_ARGS" });
      };
      switch (args.op) {
        case "status": {
          const { backendStatus } = await import("../../decomp/m2c.js");
          const map = await project.map();
          const romOk = fs.existsSync(project.abs(project.m.rom.path));
          const { projectFreshness } = await import("../../decomp/project.js");
          const fresh = await projectFreshness(project);
          return jsonContent({ project: project.id, root: project.root, platform: project.m.platform, workspace: project.ws, registeredAt: project.m.registeredAt, rom: { ...project.m.rom, present: romOk }, toolchain: project.m.toolchain, build: project.m.build, built: project.m.built,
            // `git` was the IMPORT-TIME snapshot presented as current state.
            // Both are reported now, and a difference is named rather than left
            // for the reader to notice.
            ...fresh,
            git: project.m.git,
            gitNote: "`git` is the snapshot taken at registration. `liveGit` is the checkout right now. Trust `manifestState`.",
            segments: map.table(), backends: await backendStatus() });
        }
        case "refresh": {
          // Re-capture the state that goes stale as the checkout moves, WITHOUT
          // touching stored campaign evidence. Every candidate result stays on
          // disk; what changes is the manifest's view of the world and the
          // derived caches keyed off it.
          const { gitState, projectFreshness, fingerprintToolchain, sha1File } = await import("../../decomp/project.js");
          const before = { git: project.m.git, compiler: project.m.toolchain?.compiler?.kind ?? null };
          const refreshed = [];

          project.m.git = await gitState(project.root);
          refreshed.push("git");

          // The ROM on disk may have been rebuilt.
          try {
            const romAbs = project.abs(project.m.rom.path);
            if (fs.existsSync(romAbs)) {
              const sha1 = await sha1File(romAbs);
              if (sha1 !== project.m.rom.sha1) { project.m.rom.sha1 = sha1; refreshed.push("rom.sha1"); }
            }
          } catch {}

          // Compiler identity can change when the toolchain is rebuilt.
          try { await fingerprintToolchain(project.m); refreshed.push("toolchain"); } catch {}

          // Derived caches: drop so they rebuild from the current tree. These
          // are CACHES, not evidence - the candidates/ tree is untouched.
          const dropped = [];
          for (const f of ["callgraph.json"]) {
            const fp = path.join(project.ws, f);
            if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); dropped.push(f); } catch {} }
          }
          project._map = null; project._syms = null; project._ld = null;
          refreshed.push("splatMap", "symbolAddrs", "linkerMap");

          const { writeFile: wf } = await import("node:fs/promises");
          await wf(path.join(project.ws, "manifest.json"), JSON.stringify(project.m, null, 2));

          const after = await projectFreshness(project);
          return jsonContent({
            project: project.id, refreshed, cachesDropped: dropped,
            before, ...after,
            evidencePreserved: "candidates/, jobs/ and every stored result file are untouched - refresh re-reads the world, it never discards campaign history.",
          });
        }
        case "workbench": {
          // The BRIDGE to n64-decomp-workbench: romdev's comparator is
          // first-pass triage and cannot diagnose allocator webs, uopt global
          // coloring, ugen temporary provenance, stack homes or as1 scheduling.
          // The workbench does, and it is the tool this campaign already uses
          // by hand - so romdev calls it rather than growing a second, shallower
          // copy that would disagree with it.
          const { workbenchCatalog, invokeWorkbench } = await import("../../decomp/workbench.js");
          const catalog = await workbenchCatalog({ force: !!args.force });
          if (!args.wbCommand) {
            // No command: report the discovered catalog. Discovery means the
            // workbench can grow without romdev being edited.
            return jsonContent({ workbench: catalog,
              usage: "decomp({op:'workbench', wbGroup:'object', wbCommand:'diagnose', wbArgs:[targetObj, candidateObj]}). "
                + "Objects are resolved against the project root; the project's objdump and LD_LIBRARY_PATH are supplied automatically. "
                + "Exit 1 means gate/no-result - a real answer, not an error.",
              note: catalog.available
                ? `${catalog.commandCount} commands in ${catalog.groupCount} groups, read from the workbench itself.`
                : "workbench not installed; see `setup`." });
          }
          if (!catalog.available) {
            throw Object.assign(new Error(`workbench unavailable: ${catalog.reason}. ${catalog.setup ?? ""}`), { code: "MISSING_WORKBENCH" });
          }
          // Supply what the workbench cannot know: this project's objdump and
          // its runtime library path. A project-local binutils fails to load
          // without them, with an error that reads like a workbench bug.
          let wbArgs = [...(args.wbArgs ?? [])], artifactProvenance = null, traceBundle = null;
          if (args.traceMode && !args.artifactId) throw new Error("traceMode requires artifactId to establish the measured baseline");
          if (args.artifactId) {
            const scheduler = args.wbGroup === "trace" && args.wbCommand === "scheduler";
            const globalcolor = args.wbGroup === "trace" && args.wbCommand === "globalcolor";
            if (!scheduler && !globalcolor && (args.wbGroup !== "object" || args.wbCommand !== "diagnose")) throw new Error("artifactId resolves object diagnose, trace scheduler or trace globalcolor inputs automatically");
            if (globalcolor && args.traceMode !== "globalcolor") throw new Error("trace globalcolor with artifactId requires traceMode:'globalcolor' to opt into a workspace diagnostic compiler build");
            if (scheduler && args.traceMode === "globalcolor") throw new Error("scheduler command cannot consume a globalcolor trace");
            const filters = wbArgs;
            const allowed = globalcolor ? ["--proc", "--web", "--top", "--desired-register", "--lineage-table", "--dtype"]
              : scheduler ? ["--proc", "--block", "--limit"] : [];
            for (let i = 0; i < filters.length; i += 2) if (!allowed.includes(filters[i]) || !filters[i + 1] || filters[i + 1].startsWith("--")) throw new Error("artifact-bound wbArgs accepts only paired report filters, not input/identity overrides");
            const artifact = args.artifactId.endsWith(".diff.json") || args.artifactId.endsWith(".result.json")
              ? args.artifactId : path.join(project.ws, "candidates", (await resolveFn()).symbol, `${args.artifactId}.diff.json`);
            const { artifactWorkbenchInput } = await import("../../decomp/workbench.js");
            const bound = await artifactWorkbenchInput(project, artifact);
            wbArgs = bound.args; artifactProvenance = bound.provenance;
            if (args.traceMode === "globalcolor") {
              const { captureGlobalcolorTrace } = await import("../../decomp/globalcolor-trace.js");
              traceBundle = await captureGlobalcolorTrace(project, artifact);
              if (traceBundle.verification?.equivalent) wbArgs = globalcolor
                ? [traceBundle.tracePath, ...filters] : [...wbArgs, "--trace", traceBundle.tracePath];
              else if (globalcolor) return jsonContent({ project: project.id, artifactProvenance, traceBundle,
                unavailable: "diagnostic compiler failed off/on fidelity verification; no allocator attribution is claimed" });
            } else if (args.traceMode === "scheduler" || scheduler) {
              const { captureSchedulerTrace } = await import("../../decomp/workbench.js");
              traceBundle = await captureSchedulerTrace(project, artifact);
              if (traceBundle.verification?.equivalent) wbArgs = scheduler
                ? [traceBundle.tracePath, "--from-as1-r", "--limit", "40", ...filters]
                : [...wbArgs, "--as1-trace", traceBundle.tracePath];
              else if (scheduler) return jsonContent({ project: project.id, artifactProvenance, traceBundle,
                unavailable: "trace failed equivalence verification; no scheduler attribution is claimed" });
            }
          }
          const objdump = project.m.toolchain?.objdump?.path;
          if (objdump && !wbArgs.includes("--objdump")) {
            // ASK THE COMMAND, do not assume. Appending --objdump
            // unconditionally is right for `object diagnose` and fatal for
            // `project show`, which has no such flag and exits 2.
            const { commandAcceptsFlag, workbenchCatalog, findCommand } = await import("../../decomp/workbench.js");
            const cat = await workbenchCatalog();
            const spec = findCommand(cat, args.wbGroup, args.wbCommand);
            const inv = Array.isArray(spec?.invocation) ? spec.invocation.slice(1) : [args.wbGroup, args.wbCommand].filter(Boolean);
            if (await commandAcceptsFlag(inv, "--objdump")) wbArgs.push("--objdump", objdump);
          }
          const { compactWorkbenchReport } = await import("../../decomp/workbench.js");
          const res = await compactWorkbenchReport(project, await invokeWorkbench({
            group: args.wbGroup, command: args.wbCommand, args: wbArgs,
            cwd: project.root, env: project.env, timeoutMs: args.timeoutMs ?? 600_000,
            allowDestructive: !!args.allowDestructive, allowNetwork: !!args.allowNetwork,
          }), { outputPath: args.outputPath, detail: args.detail });
          return jsonContent({ project: project.id, ...res, ...(artifactProvenance ? { artifactProvenance } : {}), ...(traceBundle ? { traceBundle } : {}),
            exitCodes: catalog.exitCodes,
            interpretation: res.isGate
              ? "exit 1 = gate/no-result: the workbench answered, and the answer is 'no'. This is NOT a failure."
              : res.exitCode === 0 ? "exit 0 = success; `report` is the workbench's own versioned document, unflattened."
              : "exit 2/3 = usage, capability or census failure; see `report.error` (schema decomp-workbench-error-v1)." });
        }
        case "dispatch": {
          // PARALLEL CANDIDATE PRODUCTION. Independent translation units run
          // concurrently under a measured memory ceiling; a per-TU lock keeps
          // two workers off the same owner. It NEVER integrates and never edits
          // the checkout - parallelism ends at evidence, and shared source
          // edits stay serialized behind the real gates.
          const { triage } = await import("../../decomp/dispatch.js");
          let symbols = args.symbols;
          if (!symbols?.length) {
            const { planWork } = await import("../../decomp/plan.js");
            const plan = await planWork(project, { limit: args.maxFunctions ?? 64 });
            symbols = plan.queue.map((q) => q.symbol);
          }
          if (!symbols.length) throw Object.assign(new Error("decomp({op:'dispatch'}): nothing to do - no symbols given and the plan queue is empty."), { code: "BAD_ARGS" });
          const out = await triage(project, symbols, {
            maxFunctions: args.maxFunctions ?? 64, budgetMiB: args.budgetMiB,
            maxWorkers: args.maxWorkers, timeBudgetS: args.timeBudgetS ?? 3600,
          });
          return jsonContent({ project: project.id, ...out });
        }
        case "replay": {
          // §12: a public-API replay suite over preserved candidates. Runs the
          // SAME endpoints a caller uses - no internal shortcuts - and never
          // mutates the production checkout.
          const RP = await import("../../decomp/replay.js");
          const researchRoot = args.root ?? path.join(project.root, "docs/research");
          const cases = RP.defaultCases({ researchRoot, workspace: project.ws });
          const only = args.symbols?.length ? new Set(args.symbols.map((x) => (typeof x === "string" ? x : x.symbol))) : null;
          const results = [];

          // An integrated function's owner must come from its PRE-INTEGRATION
          // backup; the current owner already contains the accepted source.
          const ownerFor = async (hint) => {
            if (!hint) return null;
            const dir = path.join(project.ws, path.dirname(hint));
            const re = new RegExp("^" + path.basename(hint).replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === "*" ? ".*" : "\\" + m)) + "$");
            try {
              const hits = (await readdir(dir)).filter((f) => re.test(f)).sort();
              return hits.length ? path.join(dir, hits[hits.length - 1]) : null;
            } catch { return null; }
          };

          for (const kase of cases) {
            if (only && !only.has(kase.id) && !only.has(kase.symbol)) continue;
            const t0 = Date.now();
            try {
              const actual = await runReplayCase(project, kase, { ownerFor, resolveFn, live });
              const fails = RP.checkExpectations(kase, actual);
              results.push({ id: kase.id, why: kase.why, passed: fails.length === 0, ms: Date.now() - t0,
                actual, ...(fails.length ? { failures: fails } : {}) });
            } catch (e) {
              const msg = String(e?.message ?? e);
              const missing = /ENOENT|no such file/i.test(msg);
              results.push({ id: kase.id, why: kase.why, passed: false, skipped: missing, ms: Date.now() - t0,
                error: `${e?.code ?? "ERROR"}: ${msg.slice(0, 220)}`,
                ...(missing ? { skipNote: "the fixture this case replays is not on disk; the case is SKIPPED rather than counted as a pass" } : {}) });
            }
          }
          return jsonContent({ project: project.id, researchRoot, ...RP.summarize(results, cases) });
        }
        case "layout": {
          // Stack map + data ownership. Reads a stored comparison, like
          // op:'diagnose' - the streams are already there and recompiling to
          // answer a layout question would risk describing a different build.
          const L = await import("../../decomp/layout.js");
          // `va` asks the OWNERSHIP question: what does this address already
          // belong to? That is a question about data, not about the function
          // being worked on, so it must not be resolved against the
          // function's segment - doing so rejected a global with
          // SEGMENT_MISMATCH for not living inside the overlay asking about it.
          if (args.va != null) {
            const ld = await project.linkerMap();
            const sa = await project.symbolAddrs();
            const syms = new Map();
            for (const [name, rec] of (sa ?? new Map())) syms.set(name, { va: rec.va, size: rec.size });
            for (const [name, rec] of (ld?.symbols ?? new Map())) if (!syms.has(name)) syms.set(name, { va: rec.va, size: rec.size });
            return jsonContent({ project: project.id, va: `0x${hexOrInt(args.va).toString(16)}`,
              ...L.resolveAddress(syms, hexOrInt(args.va)) });
          }
          const fn = await resolveFn();
          // Same selection policy as op:'diagnose': ranked by residual, and
          // the choice is always explained. A silent "newest file" default
          // diagnosed a superseded layout problem for the client.
          const { selectArtifact } = await import("../../decomp/artifact-select.js");
          let diffPath = args.artifactId ?? null;
          let selection;
          if (!diffPath) {
            selection = await selectArtifact(project, fn.symbol, { prefer: args.prefer, fn });
            diffPath = selection.path;
          } else {
            if (!String(diffPath).endsWith(".diff.json")) diffPath = path.join(project.ws, "candidates", fn.symbol, `${diffPath}.diff.json`);
            selection = { path: diffPath, policy: "explicit", why: "the caller named this artifact" };
          }
          const stored = JSON.parse(await readFile(diffPath, "utf8"));
          if (selection?.policy === "explicit") selection = await (await import("../../decomp/artifact-select.js")).describeExplicitArtifact(project, diffPath);
          return jsonContent({ project: project.id, symbol: fn.symbol, segment: fn.segment ?? null, artifact: diffPath,
            selection,
            ...L.layoutReport({ targetStream: stored.target ?? [], candidateStream: stored.candidate ?? [] }) });
        }
        case "variants": {
          // One baseline + named variants, one dependency snapshot, a compact
          // table. This is the ad-hoc Node script the reporter kept rewriting.
          const V = await import("../../decomp/variants.js");
          const fn = await resolveFn();
          const base = await candidateSource();
          if (!Array.isArray(args.variants) || !args.variants.length) {
            throw Object.assign(new Error("decomp({op:'variants'}): `variants` is a list of {id, hypothesis, find/replace | candidateText}."), { code: "BAD_ARGS" });
          }
          const { compileAndCompare } = await import("../../decomp/compile.js");
          const { semanticGate } = await import("../../decomp/semantic-gate.js");
          const compare = async ({ candidateText, label, ownerPath }) =>
            compileAndCompare(project, fn, { candidateText, label, ownerPath, noCache: args.noCache, verifyTu: args.verifyTu, declarations: args.declarations });
          const gate = async (text) => {
            const g = semanticGate({ candidateText: text, baselineText: base.text });
            return { classification: g.classification, counts: g.counts, findings: g.findings.slice(0, 4) };
          };
          const batch = await V.runVariantBatch(project, fn, { baselineText: base.text, variants: args.variants, compare, gate, maxVariants: args.maxFunctions ?? 12, ownerPath: args.ownerPath ?? null, threads: args.threads ?? 1 });
          const { recordVariantExperiment } = await import("../../decomp/experiment.js");
          const experiment = await recordVariantExperiment(project, batch, { hypothesis: args.hypothesis, lever: args.lever, family: args.family });
          return jsonContent({ project: project.id, ...batch, experiment });
        }
        case "research": {
          // DISCOVERY, kept apart from measurement. Nothing imported here is a
          // verified result: a note claiming exactness is a CLAIM, labelled
          // stale until re-measured, and can never override a failed build.
          const R = await import("../../decomp/research.js");
          const action = args.action ?? "list";
          if (action === "import") {
            // Symbols that already have a CURRENT-tree measurement, so a lead
            // for one of them is marked history rather than a refresh target.
            let measured = new Set();
            try {
              const { loadCandidateEvidence } = await import("../../decomp/plan.js");
              const ev = await loadCandidateEvidence(project, {});
              measured = new Set(Object.keys(ev ?? {}));
            } catch {}
            return jsonContent({ project: project.id, ...(await R.importResearch(project, { root: args.root, measuredSymbols: measured })) });
          }
          if (action === "list") {
            const docs = await R.loadResearch(project);
            return jsonContent({ project: project.id, indexes: docs.map((d) => ({ root: d.root, importedAt: d.importedAt, files: d.files, symbols: d.symbols, leads: d.leads?.length ?? 0, conflicts: d.conflicts?.length ?? 0 })),
              ...(docs.length ? {} : { note: "no research imported yet: decomp({op:'research', action:'import', root:'<directory>'})" }) });
          }
          if (action === "status") {
            const map = await R.researchBySymbol(project);
            const sym = args.symbol;
            if (sym) {
              const lead = map.get(sym);
              return jsonContent({ project: project.id, symbol: sym, ...(lead ?? { state: "none", stateReason: "no imported research mentions this symbol" }) });
            }
            const all = [...map.values()].sort((a, b) => (a.claimedBestDistance ?? 1e9) - (b.claimedBestDistance ?? 1e9));
            return jsonContent({ project: project.id, symbols: map.size, leads: all.slice(0, args.limit ?? 40) });
          }
          throw Object.assign(new Error(`decomp({op:'research'}): unknown action '${action}'. Use import, list or status.`), { code: "BAD_ARGS" });
        }
        case "diagnose": {
          // Reuse the STORED comparison rather than recompiling: the report's
          // ask was a one-request diagnosis from an existing artifact, and a
          // fresh compile would also risk diagnosing a different build than the
          // one the caller is looking at.
          const D = await import("../../decomp/diagnose.js");
          const { selectArtifact } = await import("../../decomp/artifact-select.js");
          let diffPath = args.artifactId ?? null;
          let selection = null;
          if (!diffPath) {
            const fn0 = await resolveFn();
            selection = await selectArtifact(project, fn0.symbol, { prefer: args.prefer, fn: fn0 });
            diffPath = selection.path;
          } else if (!diffPath.endsWith(".diff.json")) {
            const fn0 = await resolveFn();
            diffPath = path.join(project.ws, "candidates", fn0.symbol, `${diffPath}.diff.json`);
            selection = { path: diffPath, policy: "explicit", why: "the caller named this artifact" };
          } else {
            selection = { path: diffPath, policy: "explicit", why: "the caller named this artifact" };
          }
          let stored;
          try { stored = JSON.parse(await readFile(diffPath, "utf8")); }
          catch (e) { throw Object.assign(new Error(`cannot read the comparison artifact '${diffPath}': ${e.message}`), { code: "NO_ARTIFACT" }); }
          if (selection?.policy === "explicit") selection = await (await import("../../decomp/artifact-select.js")).describeExplicitArtifact(project, diffPath);

          // TRACE PROVENANCE. "Do not silently change optimization flags or
          // compiler binary to obtain a trace. First establish that the traced
          // compile emits the same candidate bytes." A trace whose words do
          // not match the compared candidate is describing a DIFFERENT build,
          // so it is reported as such rather than used.
          let traceText = null, traceProvenance = null;
          if (args.tracePath) {
            const { verifyTraceBundle } = await import("../../decomp/workbench.js");
            traceProvenance = await verifyTraceBundle(project, diffPath, args.tracePath);
            if (traceProvenance.equivalent) traceText = await readFile(args.tracePath, "utf8");
          }

          const diag = D.diagnoseResiduals({
            target: stored.target ?? [], candidate: stored.candidate ?? [],
            strict: stored.strict ?? { mismatches: [] },
            trace: traceText, traceProvenance,
          });
          const { listExperiments, annotateExperimentHistory } = await import("../../decomp/experiment.js");
          const { measurementSnapshot } = await import("../../decomp/measurement.js");
          let comparison = null;
          try { comparison = JSON.parse(await readFile(diffPath.replace(/\.diff\.json$/, ".result.json"), "utf8")); } catch {}
          annotateExperimentHistory(diag, await listExperiments(project, { symbol: args.symbol }), {
            symbol: comparison?.function?.symbol ?? args.symbol, segment: comparison?.function?.segment ?? args.segment,
            baselineInput: comparison?.inputIdentity?.sha256, baselineOutput: comparison?.outputIdentity,
            snapshot: comparison ? measurementSnapshot(comparison) : null,
          });
          return jsonContent({ project: project.id, symbol: args.symbol ?? null, artifact: diffPath,
            selection,
            ...(traceProvenance && !traceProvenance.equivalent ? { traceRejected: traceProvenance } : {}),
            ...diag });
        }
        case "gate": {
          // A byte-exact candidate is not automatically a correct one. This
          // classifies source quality WITHOUT ever erasing the exactness result.
          const { semanticGate } = await import("../../decomp/semantic-gate.js");
          const cand = await candidateSource();
          return jsonContent({ project: project.id, symbol: args.symbol ?? null,
            ...semanticGate({ candidateText: cand.text, baselineText: args.baselineText ?? null,
              exactFunctionMatch: !!args.exactFunctionMatch, functionLocal: args.functionLocal ?? null }) });
        }
        case "experiment": {
          const X = await import("../../decomp/experiment.js");
          const action = args.action ?? "list";
          switch (action) {
            case "create": {
              const rec = await X.createExperiment(project, {
                symbol: args.symbol, hypothesis: args.hypothesis, lever: args.lever, family: args.family,
                baseline: args.baseline ?? null, parentId: args.parentId ?? null, notes: args.notes });
              return jsonContent({ ...rec, controlsRequired: X.CONTROL_KINDS,
                nextStep: "run all three controls with action:'control' BEFORE concluding - a conclusion without them is refused, because a negative control that moves means the metric is responding to noise." });
            }
            case "control": {
              if (!args.experimentId || !args.controlKind) throw Object.assign(new Error("decomp({op:'experiment', action:'control'}): `experimentId` and `controlKind` are required."), { code: "BAD_ARGS" });
              return jsonContent(await X.recordControl(project, args.experimentId, { kind: args.controlKind, moved: args.moved, detail: args.notes }));
            }
            case "candidate": {
              if (!args.experimentId) throw Object.assign(new Error("decomp({op:'experiment', action:'candidate'}): `experimentId` is required."), { code: "BAD_ARGS" });
              const { semanticGate } = await import("../../decomp/semantic-gate.js");
              const cand = await candidateSource();
              const gate = semanticGate({ candidateText: cand.text, baselineText: args.baselineText ?? null,
                exactFunctionMatch: !!args.exactFunctionMatch, functionLocal: args.functionLocal ?? null });
              return jsonContent(await X.recordCandidate(project, args.experimentId, {
                candidatePath: cand.path, distance: args.distance ?? null,
                exactFunctionMatch: !!args.exactFunctionMatch, functionLocal: args.functionLocal ?? null, gate }));
            }
            case "conclude": {
              if (!args.experimentId || !args.verdict) throw Object.assign(new Error("decomp({op:'experiment', action:'conclude'}): `experimentId` and `verdict` are required."), { code: "BAD_ARGS" });
              return jsonContent(await X.concludeExperiment(project, args.experimentId, { verdict: args.verdict, scope: args.scope, rationale: args.rationale, force: !!args.force }));
            }
            case "families": {
              if (!args.symbol) throw Object.assign(new Error("decomp({op:'experiment', action:'families'}): `symbol` is required."), { code: "BAD_ARGS" });
              return jsonContent(await X.exhaustedFamilies(project, args.symbol));
            }
            default:
              return jsonContent({ experiments: await X.listExperiments(project, { symbol: args.symbol }) });
          }
        }
        case "typeGraph": {
          // PROJECT-WIDE type evidence. Per-function records are stranded: the
          // same struct is passed to a dozen functions and each rediscovers its
          // layout. Bases are ordered by LEVERAGE (how many functions share
          // them) because typing one of those lands the fix everywhere at once.
          const { loadTypeGraph, proposeStruct } = await import("../../decomp/type-graph.js");
          const { callGraph } = await import("../../decomp/plan.js");
          let cg = null;
          try { cg = await callGraph(project); } catch {}
          const g = await loadTypeGraph(project, { rebuild: !!args.rebuild, callGraph: cg });
          if (args.base) {
            const b = g.bases.find((x) => x.base === args.base);
            if (!b) throw Object.assign(new Error(`no base '${args.base}' in the type graph (${g.baseCount} bases). Call without \`base\` to list them.`), { code: "NO_SUCH_BASE" });
            return jsonContent({ project: project.id, ...proposeStruct(b), evidence: b });
          }
          // The full field list of 707 bases is enormous; return the shape plus
          // the high-leverage head, and let `base` fetch one in detail.
          return jsonContent({ project: project.id, schema: g.schema, builtAt: g.builtAt,
            baseCount: g.baseCount, totalFields: g.totalFields, conflictCount: g.conflictCount,
            bases: g.bases.slice(0, args.limit ?? 30).map(({ fields, ...rest }) => ({ ...rest, fieldsOmitted: fields.length })),
            confidenceLevels: g.confidenceLevels, policy: g.policy,
            nextStep: "decomp({op:'typeGraph', base:'<name>'}) returns that base's full evidence and a PROPOSED struct." });
        }
        case "rank": {
          // Mechanism-aware ranking. The rule that matters: aligned_total is
          // only comparable within ONE gap state.
          const { rankCandidates } = await import("../../decomp/ranking.js");
          if (!args.candidates?.length) throw Object.assign(new Error("decomp({op:'rank'}): `candidates` is required (workbench comparison blocks or romdev compare results)."), { code: "BAD_ARGS" });
          return jsonContent({ project: project.id, ...rankCandidates(args.candidates, { preferTemporaryPrefix: !!args.preferTemporaryPrefix }) });
        }
        case "ledger": {
          // What "100% decompiled" means, per dimension. Deliberately produces
          // NO single percentage: each dimension has its own denominator, and
          // collapsing them needs weights the project must declare.
          const { buildLedger } = await import("../../decomp/ledger.js");
          const { computeProgress } = await import("../../decomp/progress.js");
          const { planWork } = await import("../../decomp/plan.js");
          let prog = null, wc = null;
          try { prog = await computeProgress(project); } catch {}
          try { wc = (await planWork(project, { limit: 1 })).workClasses; } catch {}
          return jsonContent(await buildLedger(project, { progress: prog, workClasses: wc }));
        }
        case "capabilities": {
          // PROVE the runtime's debug capabilities against the running core
          // rather than describing them from three disagreeing sources.
          const { probeCapabilities } = await import("../../decomp/capability.js");
          const { getHost } = await import("../state.js");
          let host = null;
          try { host = getHost(live); } catch {}
          // Core identity comes from the runtime module, which already knows how
          // to map a platform to its core package and read that package's
          // version. Guessing it here would be a fourth source of truth.
          let info = { platform: project.m.platform };
          try {
            const rt = await import("../../decomp/runtime.js");
            const id = rt.runtimeIdentity ? await rt.runtimeIdentity(project, live) : null;
            if (id?.core) info = { ...info, package: id.core.package ?? null, version: id.core.version ?? null, coreName: id.core.name ?? null };
          } catch { /* identity is best-effort; the probe still reports capabilities */ }
          return jsonContent(await probeCapabilities(host, info));
        }
        case "knownSource": {
          // Look before you decompile: match by BYTES and SHAPE, never by name.
          const { findKnownSource } = await import("../../decomp/known-source.js");
          const fn = await resolveFn();
          // NO ensureTarget HERE. A structural fingerprint needs the .s TEXT and
          // nothing else; assembling the target was both unnecessary work and a
          // hard failure on library functions whose object cannot be built in
          // isolation. `resolve` already reports the path - and it is RELATIVE
          // to the project root, which is the ENOENT that made this lane
          // non-operational on every real function.
          const asmRel = fn.targetAsm?.path ?? fn.source?.asmPath ?? null;
          if (!asmRel) throw Object.assign(new Error(`'${fn.symbol}' has no extracted asm to fingerprint.`), { code: "NO_TARGET_ASM" });
          const asmText = await readFile(project.abs(asmRel), "utf8");
          // A fingerprint over ZERO instructions matches nothing and reports
          // `siblingHits: []` - indistinguishable from an honest "no match
          // found". Refuse instead: an empty search that LOOKS like a completed
          // search is the worst of the three outcomes.
          if (!/^\s*\/\*\s*[0-9A-Fa-f]+\s+[0-9A-Fa-f]{8}\s+[0-9A-Fa-f]{8}\s*\*\//m.test(asmText)) {
            throw Object.assign(new Error(`'${fn.symbol}': ${asmRel} contains no disassembled instruction words, so a structural fingerprint would search on nothing and return an empty result that looks like 'no match'.`), { code: "NO_TARGET_ASM" });
          }
          return jsonContent(await findKnownSource(project, { symbol: fn.symbol, asmText, workClass: args.workClass }));
        }
        case "scenario": {
          // SEMANTIC evidence, never byte matching. Kept in its own op so a
          // runtime agreement can never be mistaken for an exactness verdict.
          const S = await import("../../decomp/scenario.js");
          const action = args.action ?? "list";
          if (action === "save") return jsonContent(await S.saveScenario(project, args.scenarioDef ?? {}));
          if (action === "list") return jsonContent({ scenarios: await S.listScenarios(project) });
          if (!args.scenarioName) throw Object.assign(new Error("decomp({op:'scenario'}): `scenarioName` is required to run one."), { code: "BAD_ARGS" });
          const scenario = await S.loadScenario(project, args.scenarioName);
          const { getHost } = await import("../state.js");
          const { probeCapabilities } = await import("../../decomp/capability.js");
          const host = getHost(live);
          const cap = await probeCapabilities(host, { platform: project.m.platform });
          return jsonContent(await S.runScenario(host, scenario, { capability: cap }));
        }
        case "assets": {
          // Identify and ROUND-TRIP the non-code bytes. Round trip is the only
          // acceptance test: a decoder that produces plausible output from the
          // wrong offset is worse than none, because it looks like progress.
          const A = await import("../../decomp/assets.js");
          const rom = await readFile(project.abs(project.m.rom.path));

          // UNPACK / EDIT / REPACK, not just "identify". The audit's wording was
          // "the public schema exposes no repack action" - and it was right in a
          // way the encoder alone did not fix: a caller could see a sha of the
          // decoded payload but never obtain the BYTES, so there was nothing to
          // edit and nothing to feed back. These three actions are the loop.
          if (args.action === "unpack" || args.action === "repack") {
            if (args.romOffset == null) throw Object.assign(new Error(`decomp({op:'assets', action:'${args.action}'}): \`romOffset\` (and \`length\`) identify the range.`), { code: "BAD_ARGS" });
            const end = args.romOffset + (args.length ?? 0);
            const range = rom.subarray(args.romOffset, end || undefined);

            if (args.action === "unpack") {
              const decoded = A.decodeMio0Container(range);
              if (!decoded) throw Object.assign(new Error(`the range at 0x${args.romOffset.toString(16)} is not a decodable MIO0 container.`), { code: "NOT_DECODABLE" });
              const out = args.outputPath ?? path.join(project.ws, "assets", `0x${args.romOffset.toString(16)}.bin`);
              await mkdir(path.dirname(out), { recursive: true });
              await writeFile(out, Buffer.from(decoded));
              return jsonContent({ project: project.id, action: "unpack", romOffset: args.romOffset,
                decodedBytes: decoded.length, path: out,
                nextStep: `edit ${out}, then decomp({op:'assets', action:'repack', romOffset:${args.romOffset}, inputPath:'${out}'}) - repack VERIFIES by decoding its own output before returning.` });
            }

            const src = args.inputPath ?? args.outputPath;
            if (!src) throw Object.assign(new Error("decomp({op:'assets', action:'repack'}): `inputPath` (the edited payload) is required."), { code: "BAD_ARGS" });
            const payload = await readFile(src);
            const packed = A.encodeMio0(payload);
            // NEVER return a container without checking it decodes back. An
            // encoder that emits plausible bytes is the same failure as a
            // decoder that emits plausible pixels.
            const check = A.decodeMio0Container(packed);
            const faithful = !!check && Buffer.compare(Buffer.from(check), payload) === 0;
            const out = args.outputPath && args.outputPath !== src
              ? args.outputPath : path.join(project.ws, "assets", `0x${args.romOffset.toString(16)}.mio0`);
            if (faithful) { await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, packed); }
            return jsonContent({ project: project.id, action: "repack", romOffset: args.romOffset,
              payloadBytes: payload.length, containerBytes: packed.length,
              verified: faithful, ...(faithful ? { path: out } : {}),
              sameSizeAsOriginal: packed.length === range.length,
              note: faithful
                ? "the container was decoded back and matches the payload byte for byte. `sameSizeAsOriginal` says whether it can be dropped in place without relocating the range."
                : "REFUSED to write: the container did not decode back to the payload it was built from, so the encoder is not faithful for this input." });
          }

          if (args.romOffset != null) {
            const end = args.romOffset + (args.length ?? 0);
            return jsonContent({ project: project.id, ...A.roundTrip(rom.subarray(args.romOffset, end || undefined), { name: `0x${args.romOffset.toString(16)}` }) });
          }
          const map = await project.map();
          const ranges = [];
          for (const seg of map.segments) {
            if (!(seg.subsegments ?? []).length) ranges.push({ name: seg.name, romStart: seg.romStart, romEnd: seg.romEnd, type: seg.type });
            for (const sub of seg.subsegments ?? []) if (sub.type === "bin") ranges.push({ name: sub.name, romStart: sub.romStart, romEnd: sub.romEnd, type: sub.type });
          }
          return jsonContent({ project: project.id, ...A.scanRanges(rom, ranges) });
        }
        case "artifacts": {
          const A = await import("../../decomp/artifacts.js");
          if (args.action === "prune") return jsonContent(await A.pruneArtifacts(project, { apply: !!args.apply }));
          if (args.action === "restore") return jsonContent(await A.restoreArtifacts(project, { batch: args.batch }));
          if (args.action === "pin") {
            if (!args.candidatePath) throw Object.assign(new Error("decomp({op:'artifacts', action:'pin'}): `candidatePath` is required."), { code: "BAD_ARGS" });
            return jsonContent(await A.pinArtifact(project, args.candidatePath, { reason: args.notes }));
          }
          return jsonContent(await A.surveyArtifacts(project));
        }
        case "handoff": {
          // GENERATED from the workspace and the checkout, with every path it
          // references audited - a handoff whose references have rotted sends
          // the next agent to files that are gone.
          const { generateHandoff } = await import("../../decomp/handoff.js");
          return jsonContent(await generateHandoff(project, { limit: args.limit ?? 20 }));
        }
        case "map": {
          const ld = await project.linkerMap();
          if (!ld) throw Object.assign(new Error("no linker map - build the project first"), { code: "NO_BUILD" });
          const map = await project.map();
          const b = project.m.splat.buildPath + "/";
          const rows = [];
          for (const [obj, secs] of ld.objects) {
            if (!obj.startsWith(b + project.m.splat.srcPath + "/")) continue;
            const tu = obj.slice(b.length).replace(/\.o$/, ".c");
            if (args.tu && tu !== args.tu) continue;
            const text = secs.find((s) => s.section === ".text");
            const seg = text ? map.resolveVa(text.va) : null;
            const segName = seg?.ok ? seg.resolved.segment : seg?.candidates?.find((c) => path.basename(c.subsegment?.name ?? "") === path.basename(obj, ".o"))?.segment ?? (seg?.candidates?.map((c) => c.segment).join("|") ?? null);
            const fns = [...ld.symbols.values()].filter((s) => s.object === obj && s.section === ".text" && s.size && !s.name.endsWith(".NON_MATCHING"));
            const asm = new Set([...ld.symbols.keys()].filter((n) => n.endsWith(".NON_MATCHING")).map((n) => n.slice(0, -13)));
            rows.push({ tu, object: obj, segment: segName, textVa: text ? "0x" + text.va.toString(16).toUpperCase() : null, sections: secs.map((s) => `${s.section}:${s.size}`), functions: fns.length, asmFunctions: fns.filter((f) => asm.has(f.name)).length, ...(args.tu ? { symbols: fns.map((f) => ({ symbol: f.name, va: "0x" + f.va.toString(16).toUpperCase(), size: f.size, state: asm.has(f.name) ? "asm" : "c" })) } : {}) });
          }
          return jsonContent({ project: project.id, source: project.m.built.map, translationUnits: rows.length, rows });
        }
        case "plan": {
          const { planWork } = await import("../../decomp/plan.js");
          return jsonContent({ project: project.id, ...(await planWork(project, { limit: args.limit, offset: args.offset, objective: args.objective, tu: args.tu, workClass: args.workClass, includeAllClasses: !!args.includeAllClasses, forceGraph: !!args.forceGraph,
            ignoreCooldown: args.ignoreCooldown, cooldownBatches: args.cooldownBatches, cooldownMinutes: args.cooldownMinutes, proposedLever: args.proposedLever })) });
        }
        case "batch": {
          if (!args.symbols?.length) throw Object.assign(new Error("decomp({op:'batch'}): pass `symbols` (a batch from op:'plan')."), { code: "BAD_ARGS" });
          const { runBatch } = await import("../../decomp/plan.js");
          return jsonContent({ project: project.id, ...(await runBatch(project, args.symbols, { maxFunctions: args.maxFunctions, timeBudgetS: args.timeBudgetS })) });
        }
        case "resolve": {
          const fn = await resolveFn();
          let bytes = null;
          if (fn.romOffset != null && fn.sizeBytes) { const s = await project.romSlice(fn.romOffset, Math.min(fn.sizeBytes, 4096)); bytes = { sha1: s.sha1, preview: s.preview, length: Math.min(fn.sizeBytes, 4096) }; }
          let invocation = null;
          if (fn.source?.tu) { try { const inv = await project.compileInvocation(fn.source.tu); invocation = { compile: inv.compile, post: inv.post, fingerprint: inv.fingerprint, object: inv.object }; } catch (e) { invocation = { error: e.message.slice(0, 200) }; } }
          return jsonContent({ project: project.id, ...fn, romBytes: bytes, compileInvocation: invocation, provenance: { resolver: "splat-segment-map", yaml: project.m.splat.yaml, rom: project.m.rom.path, romSha1: project.m.rom.sha1, byteOrder: project.m.rom.byteOrder } });
        }
        case "context": {
          const fn = await resolveFn();
          const { buildContext } = await import("../../decomp/context.js");
          if (!fn.source?.tu) throw Object.assign(new Error(`function '${fn.symbol}' is in no TU`), { code: "FUNCTION_NOT_IN_TU" });
          const c = await buildContext(project, fn.source.tu, { force: !!args.noCache });
          return jsonContent({ project: project.id, function: { symbol: fn.symbol, segment: fn.segment, va: fn.vaHex, tu: fn.source.tu }, context: c, note: "invalidates automatically when the TU, any included header, or the compile flags change (the hash is the cache key)" });
        }
        case "generate": {
          const fn = await resolveFn();
          const { generateCandidate } = await import("../../decomp/m2c.js");
          const { recordTypeEvidence } = await import("../../decomp/types.js");
          const g = await generateCandidate(project, fn, { extraContext: args.extraContext });
          let types = null;
          try { const asmText = g.targetAsm ? await readFile(project.abs(g.targetAsm), "utf8") : null; const rec = await recordTypeEvidence(project, fn, { hypotheses: g.typeHypotheses, asmText }); types = { file: path.join(project.ws, "types", `${fn.symbol}.json`), bases: Object.keys(rec.bases).length }; } catch (e) { types = { error: e.message.slice(0, 120) }; }
          const { code, ...rest } = g;
          return jsonContent({ project: project.id, function: { symbol: fn.symbol, segment: fn.segment, va: fn.vaHex, tu: fn.source?.tu, state: fn.source?.state }, ...rest, typeEvidence: types, code: code.length > 6000 ? code.slice(0, 6000) + `\n/* ... ${code.length - 6000} more chars in ${g.candidatePath} */\n` : code,
            nextStep: `decomp({op:'compare', project:'${project.id}', symbol:'${fn.symbol}', candidatePath:'${g.candidatePath}', contextHash:'${g.context.hash}'})` });
        }
        case "types": {
          const { typeReport, proposeTypes } = await import("../../decomp/types.js");
          const rep = await typeReport(project, { symbol: args.symbol });
          if (args.propose) return jsonContent({ project: project.id, ...rep, proposal: await proposeTypes(project, { symbol: args.symbol }) });
          return jsonContent({ project: project.id, ...rep });
        }
        case "compare": {
          const fn = await resolveFn();
          const { compileAndCompare } = await import("../../decomp/compile.js");
          const c = await candidateSource();
          const r = await compileAndCompare(project, fn, { candidateText: c.text, candidatePath: c.path, label: args.label, maxDiffInstructions: args.maxDiffInstructions, noCache: args.noCache, verifyTu: args.verifyTu, contextHash: args.contextHash, declarations: args.declarations, ownerPath: args.ownerPath });
          const { evidence, ...rest } = r;
          // COMPACT BY DEFAULT. §11: "Repeating the full compiler argv and long
          // diff preview for every variant creates substantial context
          // overhead. Keep all raw details available by reference."
          //
          // Nothing is discarded - every field below is on disk in the stored
          // result and diff artifacts, whose paths are in `artifacts`. `detail`
          // returns the full object for the one call that needs it.
          if (args.detail !== true) {
            const { compiler, diffPreview, romLinked, changedRanges, rodata, translationUnitCheck, ...core } = rest;
            const { residualSummary } = await import("../../decomp/measurement.js");
            return jsonContent({
              ...core,
              // The residual summary a caller acts on, without the word lists.
              residuals: residualSummary(r),
              romLinked: romLinked ? { status: romLinked.status, mismatches: romLinked.mismatches, target: romLinked.target ?? null, ...(romLinked.sizeDelta ? { sizeDelta: romLinked.sizeDelta } : {}), ...(romLinked.overflow ? { overflow: { candidateBytes: romLinked.overflow.candidateBytes, targetBytes: romLinked.overflow.targetBytes } } : {}) } : null,
              rodata: rodata ? { compared: rodata.compared ?? null, equal: rodata.equal ?? null, applicable: rodata.applicable ?? null, ...(rodata.limitation ? { limitation: rodata.limitation } : {}) } : null,
              translationUnit: translationUnitCheck?.status ?? rest.verification?.translationUnit ?? null,
              compiler: { fingerprint: compiler?.fingerprint ?? null, dependencyHash: compiler?.dependencyHash ?? null },
              detail: "compact by default. `detail:true` returns the full compiler invocation, per-word evidence, changed ranges and diff preview - all of which are also on disk at the paths in `artifacts`.",
              nextStep: r.verdict?.functionLocal === "exact" ? `decomp({op:'integrate', project:'${project.id}', symbol:'${fn.symbol}', candidatePath:'${r.candidate.storedAt}', apply:true})` : r.code === "CANDIDATE_REJECTED" ? "remove the retained assembly / copied bytes: that is not a translation" : r.compileSucceeded ? `decomp({op:'diagnose', project:'${project.id}', symbol:'${fn.symbol}'}) to group these residuals by mechanism, or decomp({op:'search', ...})` : "fix the diagnostics (declarations/types) and compare again",
            });
          }
          return jsonContent({ ...rest, evidence, nextStep: r.verdict?.functionLocal === "exact" ? `decomp({op:'integrate', project:'${project.id}', symbol:'${fn.symbol}', candidatePath:'${r.candidate.storedAt}', apply:true})` : r.code === "CANDIDATE_REJECTED" ? "remove the retained assembly / copied bytes: that is not a translation" : r.compileSucceeded ? `fix the classified differences, or decomp({op:'search', project:'${project.id}', symbol:'${fn.symbol}', candidatePath:'${r.candidate.storedAt}'})` : "fix the diagnostics (declarations/types) and compare again" });
        }
        case "search": {
          const fn = await resolveFn();
          const { startSearch, jobStatus, searchBaseline } = await import("../../decomp/jobs.js");
          let base;
          if (args.resumeFrom) {
            const prev = await jobStatus(project, args.resumeFrom);
            if (!prev.best?.path) throw Object.assign(new Error(`job '${args.resumeFrom}' has no best candidate to resume from`), { code: "JOB_NOT_FOUND" });
            base = { text: await readFile(prev.best.path, "utf8"), path: prev.best.path };
          } else base = await candidateSource();
          const { lintCandidate } = await import("../../decomp/compile.js");
          const lint = lintCandidate(base.text);
          if (lint.rejected) throw Object.assign(new Error(`base candidate rejected: ${lint.reasons.join("; ")}`), { code: "CANDIDATE_REJECTED" });
          // PREFLIGHT: one compile before committing minutes of CPU. A base
          // that does not compile cannot be permuted, and one that is already
          // exact needs no search - both were previously discovered only after
          // the budget ran out.
          let pre = null;
          if (args.preflight !== false) {
            const { compileAndCompare } = await import("../../decomp/compile.js");
            try {
              const r = await compileAndCompare(project, fn, { candidateText: base.text, candidatePath: base.path, label: "search-preflight" });
              pre = searchBaseline(r);
            } catch (e) {
              pre = { compileSucceeded: false, firstDiagnostic: String(e?.message ?? e).slice(0, 200) };
            }
          }
          const j = await startSearch({ project, fn, baseCandidateText: base.text, timeLimitS: args.timeLimitS, threads: args.threads, seed: args.seed, label: args.label, resumeFrom: args.resumeFrom, preflight: pre,
            purpose: args.purpose, family: args.family, mutationPasses: args.mutationPasses, noImprovementS: args.noImprovementS, repeatSearch: args.repeatSearch });
          return jsonContent({ started: true, jobId: j.jobId, project: project.id, function: j.function, timeLimitS: j.timeLimitS, threads: j.threads, permuterDir: j.permuterDir, log: j.log, backend: j.backend,
            ...(j.seed ? { seed: j.seed, ...(j.seedFrom === "label" ? { seedRequested: j.seedRequested, seedMapping: j.seedMapping } : {}) } : {}),
            ...(pre ? { preflight: { compileSucceeded: pre.compileSucceeded, strictMismatches: pre.strictMismatches, linkedMismatches: pre.linkedMismatches, note: "the base was compiled and compared BEFORE the search launched, so a non-compiling or already-exact base costs one compile instead of the whole budget" } } : {}),
            nextStep: `decomp({op:'job', project:'${project.id}', jobId:'${j.jobId}'}) - poll; 'budget exhausted' is not 'decompiled': confirm any zero-score best with op:'compare'.` });
        }
        case "job": {
          if (!args.jobId) throw Object.assign(new Error("decomp({op:'job'}): jobId is required."), { code: "BAD_ARGS" });
          const { jobStatus, cancelJob, jobReport } = await import("../../decomp/jobs.js");
          if (args.action === "cancel") return jsonContent({ ...(await cancelJob(project, args.jobId)), code: "CANCELLED" });
          if (args.action === "report") return jsonContent(await jobReport(project, args.jobId, { maxOutputs: args.maxFunctions ?? 12 }));
          const s = await jobStatus(project, args.jobId);
          if (args.action === "best") {
            if (!s.best?.path) return jsonContent({ jobId: args.jobId, status: s.status, best: null, note: "no candidate written yet" });
            return jsonContent({ jobId: args.jobId, status: s.status, best: s.best, source: await readFile(s.best.path, "utf8"), nextStep: `decomp({op:'compare', project:'${project.id}', symbol:'${s.function.symbol}', candidatePath:'${s.best.path}'})` });
          }
          return jsonContent(s);
        }
        case "jobs": {
          const { listJobs } = await import("../../decomp/jobs.js");
          return jsonContent({ project: project.id, jobs: await listJobs(project, args.symbol) });
        }
        case "candidates": {
          const fn = await resolveFn();
          const dir = path.join(project.ws, "candidates", fn.symbol);
          const out = [];
          if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".result.json"))) {
            try { const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); const { VERIFIER_VERSION } = await import("../../decomp/verdict.js"); const stale = r.verifierVersion !== VERIFIER_VERSION; out.push({ candidate: r.candidate, compileSucceeded: r.compileSucceeded, exactFunctionMatch: stale ? false : r.exactFunctionMatch, functionLocal: stale ? "stale-verifier" : (r.verdict?.functionLocal ?? r.verification?.functionLocal ?? null), textExact: r.textExact, romLinked: r.romLinked?.status, rodata: r.rodata?.compared === true ? (r.rodata.applicable === false ? "not-applicable" : r.rodata.equal ? "equal" : "different") : r.rodata?.error ? "error" : r.rodata ? "unavailable" : "missing", distance: r.distance?.value ?? null, kinds: r.differenceKinds, tu: r.verification?.translationUnit, dependencyHash: r.compiler?.dependencyHash, countsAsRecoveredC: r.countsAsRecoveredC, verifierVersion: r.verifierVersion ?? 1, stale: stale || undefined }); } catch {}
          }
          const gens = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^gen-\d+\.c$/.test(f)).map((f) => path.join(dir, f)) : [];
          return jsonContent({ project: project.id, function: { symbol: fn.symbol, segment: fn.segment, va: fn.vaHex }, compared: out.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9)), generated: gens, dir });
        }
        case "integrate": {
          const fn = await resolveFn();
          const { integrateCandidate } = await import("../../decomp/integrate.js");
          const { lintCandidate } = await import("../../decomp/compile.js");
          const c = await candidateSource();
          const lint = lintCandidate(c.text);
          if (lint.rejected) throw Object.assign(new Error(`candidate rejected: ${lint.reasons.join("; ")}`), { code: "CANDIDATE_REJECTED" });
          return jsonContent({ project: project.id, lint: lint.flags.length ? lint : undefined, ...(await integrateCandidate(project, fn, { candidateText: c.text, apply: args.apply, verify: args.verify, jobs: args.jobs, declarations: args.declarations })) });
        }
        case "verify": {
          const { fullRomVerify } = await import("../../decomp/integrate.js");
          return jsonContent({ project: project.id, ...(await fullRomVerify(project, { jobs: args.jobs })) });
        }
        case "progress": {
          const { computeProgress } = await import("../../decomp/progress.js");
          return jsonContent({ project: project.id, ...(await computeProgress(project)) });
        }
        case "smoke": {
          const { runSmoke } = await import("../../decomp/smoke.js");
          return jsonContent(await runSmoke(project, { frames: args.frames, inputs: args.inputs ?? [], sessionKey, sessionHandle: args.session, scriptPath: args.scriptPath, cpuCore: args.cpuCore }));
        }
        case "overlays": {
          const { detectOverlays } = await import("../../decomp/runtime.js");
          return jsonContent({ project: project.id, ...(await detectOverlays(project, { sessionKey: live })) });
        }
        case "symbolize": {
          if (args.va == null) throw Object.assign(new Error("decomp({op:'symbolize'}): pass `va`."), { code: "BAD_ARGS" });
          const { symbolizeLive } = await import("../../decomp/runtime.js");
          return jsonContent({ project: project.id, ...(await symbolizeLive(project, { sessionKey: live, va: hexOrInt(args.va) })) });
        }
        case "state": {
          const { runtimeState } = await import("../../decomp/runtime.js");
          return jsonContent({ project: project.id, ...(await runtimeState(project, { sessionKey: live })) });
        }
        case "trace": {
          const { traceFunction } = await import("../../decomp/runtime.js");
          return jsonContent({ project: project.id, ...(await traceFunction(project, { sessionKey: live, symbol: args.symbol, va: args.va != null ? hexOrInt(args.va) : undefined, segment: args.segment, maxFrames: args.maxFrames, pressDuring: args.pressDuring })) });
        }
        case "coverage": {
          const { coverage } = await import("../../decomp/runtime.js");
          return jsonContent({ project: project.id, ...(await coverage(project, { sessionKey: live, frames: args.frames, inputs: args.inputs ?? [], chunkFrames: args.chunkFrames })) });
        }
        default: throw Object.assign(new Error(`decomp: unknown op '${args.op}'`), { code: "UNSUPPORTED_OP" });
      }
    })),
  );
}

/**
 * Run ONE replay case through the same code paths the public ops use.
 *
 * Deliberately calls the shared modules rather than re-implementing checks:
 * a replay suite that tested its own logic instead of the product's would
 * confirm itself and prove nothing about what a caller experiences.
 */
async function runReplayCase(project, kase, { ownerFor }) {
  const { readFile: rf } = await import("node:fs/promises");

  switch (kase.op) {
    case "compare": {
      const { compileAndCompare } = await import("../../decomp/compile.js");
      const fn = await project.resolveFunction({ symbol: kase.symbol, segment: kase.segment });
      const ownerPath = await ownerFor(kase.ownerPathHint);
      const text = await rf(kase.candidatePath, "utf8");
      const r = await compileAndCompare(project, fn, { candidateText: text, candidatePath: kase.candidatePath, label: `replay:${kase.id}`, noCache: true, ownerPath });
      return { compileSucceeded: r.compileSucceeded, exactFunctionMatch: r.exactFunctionMatch,
        strictMismatches: r.strictMismatches ?? null, linkedMismatches: r.romLinked?.mismatches ?? null,
        rodataState: r.verdict?.checks?.rodata?.state ?? null,
        ownerPath: ownerPath ?? "(current tree)" };
    }
    case "diagnose": {
      const D = await import("../../decomp/diagnose.js");
      const { compileAndCompare } = await import("../../decomp/compile.js");
      const fn = await project.resolveFunction({ symbol: kase.symbol, segment: kase.segment });
      const text = await rf(kase.candidatePath, "utf8");
      const r = await compileAndCompare(project, fn, { candidateText: text, candidatePath: kase.candidatePath, label: `replay:${kase.id}`, noCache: true });
      const stored = JSON.parse(await rf(r.artifacts.diff, "utf8"));
      const WB = await import("../../decomp/workbench.js");
      const tracePath = kase.traceMode === "scheduler"
        ? (await WB.captureSchedulerTrace(project, r.artifacts.diff)).tracePath : kase.tracePath;
      const traceText = tracePath ? await rf(tracePath, "utf8") : null;
      let traceAccepted = false, useTrace = null;
      if (traceText) {
        traceAccepted = (await WB.verifyTraceBundle(project, r.artifacts.diff, tracePath)).equivalent === true;
        useTrace = traceAccepted ? traceText : null;
      }
      const diag = D.diagnoseResiduals({ target: stored.target ?? [], candidate: stored.candidate ?? [], strict: stored.strict ?? { mismatches: [] }, trace: useTrace });
      return { mechanisms: diag.groups.map((g) => g.mechanism), groupCount: diag.groupCount, traceAccepted };
    }
    case "variants": {
      const V = await import("../../decomp/variants.js");
      const { compileAndCompare } = await import("../../decomp/compile.js");
      const fn = await project.resolveFunction({ symbol: kase.symbol, segment: kase.segment });
      const baselineText = await rf(kase.candidatePath, "utf8");
      const compare = async ({ candidateText, label }) => compileAndCompare(project, fn, { candidateText, label, noCache: true });
      const out = await V.runVariantBatch(project, fn, { baselineText, variants: kase.variants, compare });
      const row = out.rows.find((r) => r.id === kase.variants[0].id);
      return { variantDeltaLinked: row?.delta?.linked ?? null, variantDeltaStrict: row?.delta?.strict ?? null,
        snapshotStable: out.snapshotStable };
    }
    case "layout": {
      const L = await import("../../decomp/layout.js");
      const { compileAndCompare } = await import("../../decomp/compile.js");
      const fn = await project.resolveFunction({ symbol: kase.symbol, segment: kase.segment });
      const text = await rf(kase.candidatePath, "utf8");
      const r = await compileAndCompare(project, fn, { candidateText: text, candidatePath: kase.candidatePath, label: `replay:${kase.id}`, noCache: true });
      const stored = JSON.parse(await rf(r.artifacts.diff, "utf8"));
      const rep = L.layoutReport({ targetStream: stored.target ?? [], candidateStream: stored.candidate ?? [] });
      return { frameDelta: rep.comparison.frame.delta, layoutShape: rep.comparison.shape, movedSlots: rep.comparison.moved.length };
    }
    case "batch": {
      const { targetId } = await import("../../decomp/plan.js");
      const seen = [];
      for (const t of kase.symbols) {
        const fn = await project.resolveFunction({ symbol: t.symbol, segment: t.segment });
        seen.push({ targetId: targetId(fn), tu: fn.source?.tu ?? null, sizeBytes: fn.sizeBytes, romOffset: fn.romOffset });
      }
      return { distinctTargets: new Set(seen.map((s) => s.targetId)).size,
        distinctTus: new Set(seen.map((s) => s.tu)).size, targets: seen };
    }
    case "research-status": {
      const R = await import("../../decomp/research.js");
      const map = await R.researchBySymbol(project);
      const lead = map.get(kase.symbol);
      return { hasDrafts: !!lead?.drafts?.length, drafts: lead?.drafts?.length ?? 0,
        claimedBestDistance: lead?.claimedBestDistance ?? null, state: lead?.state ?? "none" };
    }
    case "gate": {
      const { semanticGate } = await import("../../decomp/semantic-gate.js");
      const g = semanticGate({ candidateText: kase.candidateText, baselineText: kase.baselineText ?? null });
      return { findingIds: g.findings.map((f) => f.id), classification: g.classification };
    }
    case "search-launch": {
      // A REAL bounded search through the public path: preflight, seed
      // mapping, launch, budget termination, accounting. Short on purpose --
      // proving the path does not require re-spending the client's 300s.
      const { startSearch, jobStatus, jobReport, searchBaseline } = await import("../../decomp/jobs.js");
      const { compileAndCompare } = await import("../../decomp/compile.js");
      const fn = await project.resolveFunction({ symbol: kase.symbol, segment: kase.segment });
      const text = await rf(kase.candidatePath, "utf8");
      const pre = await compileAndCompare(project, fn, { candidateText: text, label: "replay-preflight" })
        .then(searchBaseline)
        .catch((e) => ({ compileSucceeded: false, firstDiagnostic: String(e?.message ?? e).slice(0, 160) }));
      const j = await startSearch({ project, fn, baseCandidateText: text,
        timeLimitS: kase.timeLimitS ?? 20, threads: kase.threads ?? 2, seed: kase.seed, label: "replay", preflight: pre,
        purpose: "regression replay of preserved search transport/termination", repeatSearch: true });
      // Wait for the budget, then a moment for the process to reap.
      const deadline = Date.now() + (kase.timeLimitS ?? 20) * 1000 + 20_000;
      let st = null;
      while (Date.now() < deadline) {
        st = await jobStatus(project, j.jobId);
        if (!st.alive) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      const rep = await jobReport(project, j.jobId);
      const log = await rf(rep.artifacts?.log ?? "", "utf8").catch(() => "");
      return { jobId: j.jobId, artifact: rep.reportJson ?? null,
        preflightRan: !!rep.preflight && rep.preflight.compileSucceeded === true,
        seedMapped: j.seedFrom === "label" && /^\d+$/.test(String(j.seed ?? "")),
        seed: j.seed, seedRequested: j.seedRequested ?? null,
        terminatedOnBudget: /budget/i.test(rep.accounting?.terminationReason ?? ""),
        terminationReason: rep.accounting?.terminationReason ?? null,
        backendTraceback: /traceback|invalid literal/i.test(log),
        elapsedS: rep.elapsedS };
    }
    case "job-accounting": {
      // Exercises the REPORT over a recorded job, not a fresh search launch.
      // The distinction is the point: this case is labelled `partial`.
      const { jobReport } = await import("../../decomp/jobs.js");
      // The case names ONE job. Resolving a prefix to "whichever matched most
      // recently" let a 10s/2-thread job stand in for the recorded 300s run.
      if (!kase.jobId) throw Object.assign(new Error("a job-accounting case must name an exact `jobId`; a prefix can be silently substituted."), { code: "BAD_ARGS" });
      let rep;
      try { rep = await jobReport(project, kase.jobId); }
      catch (e) {
        throw Object.assign(new Error(`the pinned job '${kase.jobId}' is not on disk, so this case CANNOT be verified. It is not satisfied by a different job with the same prefix. (${String(e?.message ?? e).slice(0, 120)})`), { code: "ENOENT" });
      }
      const acc = rep.accounting ?? null;
      return { jobId: rep.jobId, artifact: rep.reportJson ?? null,
        timeLimitS: rep.timeLimitS ?? null, threads: rep.threads ?? null,
        hasAccounting: !!acc,
        terminationReasonPresent: !!acc?.terminationReason,
        terminationReason: acc?.terminationReason ?? null,
        mutationFamilies: acc?.mutationFamilies ?? null,
        recommendsSwitchingMechanism: /switch mechanism/i.test(rep.recommendation ?? ""),
        elapsedS: rep.elapsedS, improvements: (rep.improvements ?? []).length };
    }
    default:
      throw Object.assign(new Error(`replay: unknown case op '${kase.op}'`), { code: "UNSUPPORTED_OP" });
  }
}
