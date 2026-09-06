// decomp.js — the matching-decompilation domain: one tool, keyed by `op`, that
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
import { readFile } from "node:fs/promises";
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
      op: z.enum(["import", "status", "list", "map", "plan", "batch", "resolve", "context", "generate", "types", "compare", "search", "job", "jobs", "candidates", "integrate", "verify", "progress", "smoke", "overlays", "symbolize", "state", "trace", "coverage"]).describe(
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
      root: z.string().optional().describe("op:'import' — absolute path of the decompilation checkout (the dir with the splat yaml + Makefile)."),
      splatYaml: z.string().optional().describe("op:'import' — splat yaml (relative to root) when auto-detection finds more than one."),
      rom: z.string().optional().describe("op:'import' — base ROM path when it differs from the yaml's target_path."),
      expectedSha1: z.string().optional().describe("op:'import' — expected base-ROM sha1 (default: the yaml's)."),
      buildCommand: z.array(z.string()).optional().describe("op:'import' — argv of the full-build command run from root (default: tools/matching-build.sh if present, else make)."),
      symbol: z.string().optional().describe("Function symbol name (func_801DEB08). Alternative to `va`."),
      symbols: z.array(z.string()).optional().describe("op:'batch' — the functions to run (a batch from op:'plan')."),
      va: z.union([z.number().int(), z.string()]).optional().describe("Virtual address (number, or hex string '0x801DEB08')."),
      segment: z.string().optional().describe("Segment name to disambiguate an overlay VA (the resolver lists candidates when ambiguous)."),
      tu: z.string().optional().describe("op:'plan'/'map' — restrict to one translation unit (relative path)."),
      limit: z.number().int().min(1).max(500).default(40).describe("op:'plan' — queue length."),
      maxFunctions: z.number().int().min(1).max(64).default(12).describe("op:'batch' — cap on functions run."),
      timeBudgetS: z.number().int().min(10).max(7200).default(600).describe("op:'batch' — wall-clock budget."),
      candidatePath: z.string().optional().describe("op:'compare'/'search'/'integrate' — path to a C file holding the function definition (+ any local declarations it needs)."),
      candidateText: z.string().optional().describe("op:'compare'/'search'/'integrate' — the candidate C inline (alternative to candidatePath)."),
      contextHash: z.string().optional().describe("op:'compare' — the context hash the candidate was generated against; the result flags contextStale when the TU/headers/flags changed since."),
      declarations: z.string().optional().describe("op:'compare'/'integrate' — extra declarations (proposed structs/prototypes) placed before the function in the TU copy; pair with the same text passed to generate as extraContext."),
      extraContext: z.string().optional().describe("op:'generate' — C declarations (proposed structs/prototypes, e.g. decomp({op:'types', propose:true}).text) appended to the TU's context so the draft is generated with those types WITHOUT editing a header."),
      propose: z.boolean().default(false).describe("op:'types' — also propose struct typedefs + a prototype from the evidence (a proposal, not confirmed types)."),
      chunkFrames: z.number().int().min(1).max(600).default(10).describe("op:'coverage' — frames per coverage chunk (input events split chunks anyway). Only matters on a core build without the exact bitmap (every shipped core has it), whose 8192-distinct-PC ring is per chunk."),
      cpuCore: z.enum(["pure_interpreter", "cached_interpreter", "dynamic_recompiler"]).optional().describe("op:'smoke' — N64 CPU core option for both sessions (pure_interpreter enables PC breaks, single-step and the PC coverage log; default is the core's dynarec)."),
      label: z.string().optional().describe("Free label stored with the candidate/job."),
      maxDiffInstructions: z.number().int().min(4).max(400).default(40).describe("op:'compare' — lines in the inline diff preview (full diff always on disk)."),
      noCache: z.boolean().default(false).describe("op:'compare' — recompile even if this candidate was compared under the same dependency hash."),
      verifyTu: z.boolean().default(true).describe("op:'compare' — also check every OTHER function in the TU's object is unchanged."),
      timeLimitS: z.number().int().min(10).max(86400).default(300).describe("op:'search' — wall-clock budget."),
      threads: z.number().int().min(1).max(32).default(2).describe("op:'search' — permuter worker threads."),
      seed: z.string().optional().describe("op:'search' — permuter seed for reproducibility."),
      jobId: z.string().optional().describe("op:'job' — the job to inspect/cancel/report."),
      resumeFrom: z.string().optional().describe("op:'search' — a previous jobId whose best candidate becomes the base."),
      action: z.enum(["status", "best", "cancel", "report"]).default("status").describe("op:'job' — status (default), best (returns the best candidate's source), cancel (SIGINT the permuter; best result is kept), report (write + return a durable JSON/Markdown report of the job)."),
      apply: z.boolean().default(false).describe("op:'integrate' — apply the patch to the TU (else only write it)."),
      verify: z.boolean().default(true).describe("op:'integrate' — after apply, run the full build and compare the ROM (revert on mismatch)."),
      jobs: z.number().int().min(1).max(64).default(8).describe("op:'integrate'/'verify' — make -j."),
      frames: z.number().int().min(1).max(100000).default(720).describe("op:'smoke'/'coverage' — frames to run."),
      inputs: z.array(z.object({ frame: z.number().int().min(0), buttons: z.record(z.string(), z.boolean()) })).optional().describe("op:'smoke'/'coverage' — input script applied identically (persisted with the smoke report)."),
      scriptPath: z.string().optional().describe("op:'smoke' — replay a persisted inputs.json instead of `inputs`/`frames`."),
      maxFrames: z.number().int().min(1).max(100000).default(600).describe("op:'trace' — frames to wait for the function's entry."),
      pressDuring: z.any().optional().describe("op:'trace' — a breakpoint({on:'pc'}) pressDuring schedule to drive the scenario."),
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
            rom: m.rom, toolchain: m.toolchain, compilerMissing: m.toolchain?.compiler ? undefined : { code: "MISSING_COMPILER", note: "no IDO binary found under tools/ido-static-recomp/build/*/out/cc — compare/search will refuse until it is built" },
            build: m.build, built: m.built, git: m.git, segments: map.table(), backends: await backendStatus(),
            nextStep: `decomp({op:'plan', project:'${m.id}'}) for the payoff-ordered queue, then resolve/generate/compare. Nothing in ${m.root} was modified.`,
          });
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
          return jsonContent({ project: project.id, root: project.root, platform: project.m.platform, workspace: project.ws, registeredAt: project.m.registeredAt, rom: { ...project.m.rom, present: romOk }, toolchain: project.m.toolchain, build: project.m.build, built: project.m.built, git: project.m.git, segments: map.table(), backends: await backendStatus() });
        }
        case "map": {
          const ld = await project.linkerMap();
          if (!ld) throw Object.assign(new Error("no linker map — build the project first"), { code: "NO_BUILD" });
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
          return jsonContent({ project: project.id, ...(await planWork(project, { limit: args.limit, tu: args.tu })) });
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
          return jsonContent({ project: project.id, function: { symbol: fn.symbol, segment: fn.segment, va: fn.vaHex, tu: fn.source?.tu, state: fn.source?.state }, ...rest, typeEvidence: types, code: code.length > 6000 ? code.slice(0, 6000) + `\n/* … ${code.length - 6000} more chars in ${g.candidatePath} */\n` : code,
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
          const r = await compileAndCompare(project, fn, { candidateText: c.text, candidatePath: c.path, label: args.label, maxDiffInstructions: args.maxDiffInstructions, noCache: args.noCache, verifyTu: args.verifyTu, contextHash: args.contextHash, declarations: args.declarations });
          const { evidence, ...rest } = r;
          return jsonContent({ ...rest, evidence, nextStep: r.verdict?.functionLocal === "exact" ? `decomp({op:'integrate', project:'${project.id}', symbol:'${fn.symbol}', candidatePath:'${r.candidate.storedAt}', apply:true})` : r.code === "CANDIDATE_REJECTED" ? "remove the retained assembly / copied bytes: that is not a translation" : r.compileSucceeded ? `fix the classified differences, or decomp({op:'search', project:'${project.id}', symbol:'${fn.symbol}', candidatePath:'${r.candidate.storedAt}'})` : "fix the diagnostics (declarations/types) and compare again" });
        }
        case "search": {
          const fn = await resolveFn();
          const { startSearch, jobStatus } = await import("../../decomp/jobs.js");
          let base;
          if (args.resumeFrom) {
            const prev = await jobStatus(project, args.resumeFrom);
            if (!prev.best?.path) throw Object.assign(new Error(`job '${args.resumeFrom}' has no best candidate to resume from`), { code: "JOB_NOT_FOUND" });
            base = { text: await readFile(prev.best.path, "utf8"), path: prev.best.path };
          } else base = await candidateSource();
          const { lintCandidate } = await import("../../decomp/compile.js");
          const lint = lintCandidate(base.text);
          if (lint.rejected) throw Object.assign(new Error(`base candidate rejected: ${lint.reasons.join("; ")}`), { code: "CANDIDATE_REJECTED" });
          const j = await startSearch({ project, fn, baseCandidateText: base.text, timeLimitS: args.timeLimitS, threads: args.threads, seed: args.seed, label: args.label, resumeFrom: args.resumeFrom });
          return jsonContent({ started: true, jobId: j.jobId, project: project.id, function: j.function, timeLimitS: j.timeLimitS, threads: j.threads, permuterDir: j.permuterDir, log: j.log, backend: j.backend,
            nextStep: `decomp({op:'job', project:'${project.id}', jobId:'${j.jobId}'}) — poll; 'budget exhausted' is not 'decompiled': confirm any zero-score best with op:'compare'.` });
        }
        case "job": {
          if (!args.jobId) throw Object.assign(new Error("decomp({op:'job'}): jobId is required."), { code: "BAD_ARGS" });
          const { jobStatus, cancelJob, jobReport } = await import("../../decomp/jobs.js");
          if (args.action === "cancel") return jsonContent({ ...(await cancelJob(project, args.jobId)), code: "CANCELLED" });
          if (args.action === "report") return jsonContent(await jobReport(project, args.jobId));
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
