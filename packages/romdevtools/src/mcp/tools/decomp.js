// decomp.js — the matching-decompilation domain: one tool, keyed by `op`, that
// runs the function-level generate → compile → compare → refine loop against a
// registered project's OWN compiler and build system, with the project's splat
// segment map as the single address resolver.
//
// Nothing here writes into the project's source tree except op:'integrate'
// with apply:true, which applies a reviewable patch and REVERTS it unless the
// full rebuilt ROM is byte-exact.
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { jsonContent, safeTool } from "../util.js";

const hexOrInt = (v) => (typeof v === "string" ? parseInt(v, 16) : v);

export function registerDecompTools(server, z, sessionKey) {
  server.tool(
    "decomp",
    "Matching decompilation: recover C that compiles to the ORIGINAL bytes with the project's ORIGINAL compiler (splat + IDO/GCC projects; proven on an N64/IDO 5.3 checkout). Keyed by `op`. " +
    "This is the user-authorized LOCAL-TOOLCHAIN path: a registered project's compiler, assembler and make are run as-is (never romdev's WASM toolchains, never a host install started by romdev). " +
    "LOOP: import (once) → resolve (segment-exact address, provenance) → generate (m2c candidate with the TU's real type context) → compare (compile the candidate INSIDE its translation unit with the TU's exact flags; strict per-instruction + relocation equality; ROM-linked word equality; other functions in the TU unchanged; a documented distance for ranking) → search (bounded decomp-permuter job; cancel/resume/best) → integrate (reviewable patch; apply + full-ROM byte verify, auto-revert on mismatch) → progress (code-byte progress from the build's objects, states kept separate). " +
    "Every result names the project, function {symbol, segment, va}, candidate sha, compiler fingerprint and artifact paths. `exactFunctionMatch` and `romLinked.status:'exact'` are the acceptance signals; `distance` is a ranking hint, never proof. " +
    "Ghidra pseudocode stays in disasm({target:'decompile'}) for understanding; it is never counted as matched.",
    {
      op: z.enum(["import", "status", "list", "resolve", "context", "generate", "compare", "search", "job", "jobs", "candidates", "integrate", "verify", "progress", "smoke"]).describe(
        "import=register a project (root; splat yaml auto-detected; ROM sha1 verified; toolchain fingerprinted; compile invocation captured from make); " +
        "status=manifest + backend identities + segment table; list=registered projects; " +
        "resolve=symbol/va → {segment, romOffset, va, size, tu, state, targetAsm, bytes sha1} (overlay VAs need `segment`; ambiguity returns the candidates, never a guess); " +
        "context=preprocess the function's TU into the m2c type context (cached by TU+headers+flags hash); " +
        "generate=m2c candidate with that context (stored as a candidate file; reports declarations it invented + type hypotheses with offsets); " +
        "compare=compile `candidatePath`/`candidateText` inside the TU with the captured flags → strict/ROM-linked/TU verdicts + classified diff (cached by dependency hash + candidate sha); " +
        "search=start a bounded decomp-permuter job from a base candidate; job=status/best/cancel one job (`jobId`, `action`); jobs=list jobs; candidates=every compared candidate for a function with its verdict; " +
        "integrate=write a unified patch for the TU (apply:true also applies it, runs the full build and verifies the ROM byte-for-byte, reverting on mismatch); verify=full build + ROM sha1 with no change; " +
        "progress=per-object code-byte progress (asm vs C, library, hasm, data refs) from the linker map; smoke=run base ROM vs rebuilt ROM for N frames on the pinned core in two isolated sessions and compare decoded pixels + CPU registers."),
      project: z.string().optional().describe("Project id (required by every op except list). op:'import' picks it."),
      root: z.string().optional().describe("op:'import' — absolute path of the decompilation checkout (the dir with the splat yaml + Makefile)."),
      splatYaml: z.string().optional().describe("op:'import' — splat yaml (relative to root) when auto-detection finds more than one."),
      rom: z.string().optional().describe("op:'import' — base ROM path when it differs from the yaml's target_path."),
      expectedSha1: z.string().optional().describe("op:'import' — expected base-ROM sha1 (default: the yaml's)."),
      buildCommand: z.array(z.string()).optional().describe("op:'import' — argv of the full-build command run from root (default: tools/matching-build.sh if present, else make)."),
      symbol: z.string().optional().describe("Function symbol name (func_801DEB08). Alternative to `va`."),
      va: z.union([z.number().int(), z.string()]).optional().describe("Virtual address (number, or hex string '0x801DEB08')."),
      segment: z.string().optional().describe("Segment name to disambiguate an overlay VA (the resolver lists candidates when ambiguous)."),
      candidatePath: z.string().optional().describe("op:'compare'/'search'/'integrate' — path to a C file holding the function definition (+ any local declarations it needs)."),
      candidateText: z.string().optional().describe("op:'compare'/'search'/'integrate' — the candidate C inline (alternative to candidatePath)."),
      declarations: z.string().optional().describe("op:'integrate' — extra declarations to place before the function in the TU."),
      label: z.string().optional().describe("Free label stored with the candidate/job."),
      maxDiffInstructions: z.number().int().min(4).max(400).default(40).describe("op:'compare' — lines in the inline diff preview (full diff always on disk)."),
      noCache: z.boolean().default(false).describe("op:'compare' — recompile even if this candidate was compared under the same dependency hash."),
      verifyTu: z.boolean().default(true).describe("op:'compare' — also check every OTHER function in the TU's object is unchanged."),
      timeLimitS: z.number().int().min(10).max(86400).default(300).describe("op:'search' — wall-clock budget."),
      threads: z.number().int().min(1).max(32).default(2).describe("op:'search' — permuter worker threads."),
      seed: z.string().optional().describe("op:'search' — permuter seed for reproducibility."),
      jobId: z.string().optional().describe("op:'job' — the job to inspect/cancel; op:'search' with `resumeFrom` — seed the new search from that job's best candidate."),
      resumeFrom: z.string().optional().describe("op:'search' — a previous jobId whose best candidate becomes the base."),
      action: z.enum(["status", "best", "cancel"]).default("status").describe("op:'job' — status (default), best (returns the best candidate's source), cancel (SIGINT the permuter; best result is kept)."),
      apply: z.boolean().default(false).describe("op:'integrate' — apply the patch to the TU (else only write it)."),
      verify: z.boolean().default(true).describe("op:'integrate' — after apply, run the full build and compare the ROM (revert on mismatch)."),
      jobs: z.number().int().min(1).max(64).default(8).describe("op:'integrate'/'verify' — make -j."),
      frames: z.number().int().min(1).max(100000).default(720).describe("op:'smoke' — frames to run both ROMs."),
      inputs: z.array(z.object({ frame: z.number().int().min(0), buttons: z.record(z.string(), z.boolean()) })).optional().describe("op:'smoke' — input script applied identically to both sessions."),
      session: z.string().optional().describe("The session handle (see loadMedia); op:'smoke' derives '<session>:orig' and '<session>:rebuilt'."),
    },
    safeTool(async (args) => {
      const { Project, importProject, listProjects } = await import("../../decomp/project.js");
      switch (args.op) {
        case "list": return jsonContent({ projects: await listProjects() });
        case "import": {
          if (!args.project || !args.root) throw new Error("decomp({op:'import'}): `project` (an id you choose) and `root` are required.");
          const m = await importProject({ id: args.project, root: args.root, splatYaml: args.splatYaml, rom: args.rom, expectedSha1: args.expectedSha1, buildCommand: args.buildCommand });
          const { backendStatus } = await import("../../decomp/m2c.js");
          const p = new Project(m);
          const map = await p.map();
          return jsonContent({
            registered: true, project: m.id, root: m.root, platform: m.platform, workspace: p.ws,
            rom: m.rom, toolchain: m.toolchain, build: m.build, built: m.built, git: m.git,
            segments: map.table(), backends: await backendStatus(),
            nextStep: `decomp({op:'resolve', project:'${m.id}', symbol:'<func>'}) then generate/compare. Nothing in ${m.root} was modified.`,
          });
        }
      }
      if (!args.project) throw new Error(`decomp({op:'${args.op}'}): \`project\` is required (decomp({op:'list'}) shows registered ids).`);
      const project = await Project.open(args.project);
      const resolveFn = async () => {
        if (!args.symbol && args.va == null) throw new Error(`decomp({op:'${args.op}'}): pass \`symbol\` or \`va\`.`);
        try { return await project.resolveFunction({ symbol: args.symbol, va: args.va != null ? hexOrInt(args.va) : undefined, segment: args.segment }); }
        catch (e) { if (e.candidates) e.message += ` candidates: ${e.candidates.map((c) => c.segment).join(", ")}`; throw e; }
      };
      const candidateSource = async () => {
        if (args.candidateText) return { text: args.candidateText, path: null };
        if (args.candidatePath) return { text: await readFile(args.candidatePath, "utf8"), path: args.candidatePath };
        throw new Error(`decomp({op:'${args.op}'}): pass candidatePath or candidateText.`);
      };
      switch (args.op) {
        case "status": {
          const { backendStatus } = await import("../../decomp/m2c.js");
          const map = await project.map();
          const romOk = fs.existsSync(project.abs(project.m.rom.path));
          return jsonContent({ project: project.id, root: project.root, platform: project.m.platform, workspace: project.ws, registeredAt: project.m.registeredAt, rom: { ...project.m.rom, present: romOk }, toolchain: project.m.toolchain, build: project.m.build, built: project.m.built, git: project.m.git, segments: map.table(), backends: await backendStatus() });
        }
        case "resolve": {
          const fn = await resolveFn();
          let bytes = null;
          if (fn.romOffset != null && fn.sizeBytes) { const s = await project.romSlice(fn.romOffset, Math.min(fn.sizeBytes, 4096)); bytes = { sha1: s.sha1, preview: s.preview, length: Math.min(fn.sizeBytes, 4096) }; }
          return jsonContent({ project: project.id, ...fn, romBytes: bytes, provenance: { resolver: "splat-segment-map", yaml: project.m.splat.yaml, rom: project.m.rom.path, romSha1: project.m.rom.sha1, byteOrder: project.m.rom.byteOrder } });
        }
        case "context": {
          const fn = await resolveFn();
          const { buildContext } = await import("../../decomp/context.js");
          const c = await buildContext(project, fn.source?.tu ?? (() => { throw new Error(`function '${fn.symbol}' is in no TU`); })(), { force: !!args.noCache });
          return jsonContent({ project: project.id, function: { symbol: fn.symbol, segment: fn.segment, va: fn.vaHex, tu: fn.source.tu }, context: c, note: "invalidates automatically when the TU, any included header, or the compile flags change (the hash is the cache key)" });
        }
        case "generate": {
          const fn = await resolveFn();
          const { generateCandidate } = await import("../../decomp/m2c.js");
          const g = await generateCandidate(project, fn);
          const { code, ...rest } = g;
          return jsonContent({ project: project.id, function: { symbol: fn.symbol, segment: fn.segment, va: fn.vaHex, tu: fn.source?.tu, state: fn.source?.state }, ...rest, code: code.length > 6000 ? code.slice(0, 6000) + `\n/* … ${code.length - 6000} more chars in ${g.candidatePath} */\n` : code,
            nextStep: `decomp({op:'compare', project:'${project.id}', symbol:'${fn.symbol}', candidatePath:'${g.candidatePath}'})` });
        }
        case "compare": {
          const fn = await resolveFn();
          const { compileAndCompare } = await import("../../decomp/compile.js");
          const c = await candidateSource();
          const r = await compileAndCompare(project, fn, { candidateText: c.text, candidatePath: c.path, label: args.label, maxDiffInstructions: args.maxDiffInstructions, noCache: args.noCache, verifyTu: args.verifyTu });
          const { evidence, ...rest } = r;
          return jsonContent({ ...rest, evidence, nextStep: r.exactFunctionMatch && r.romLinked?.status === "exact" ? `decomp({op:'integrate', project:'${project.id}', symbol:'${fn.symbol}', candidatePath:'${r.candidate.storedAt}', apply:true})` : r.compileSucceeded ? `fix the classified differences, or decomp({op:'search', project:'${project.id}', symbol:'${fn.symbol}', candidatePath:'${r.candidate.storedAt}'})` : "fix the diagnostics (declarations/types) and compare again" });
        }
        case "search": {
          const fn = await resolveFn();
          const { startSearch, jobStatus } = await import("../../decomp/jobs.js");
          let base;
          if (args.resumeFrom) {
            const prev = await jobStatus(project, args.resumeFrom);
            if (!prev.best?.path) throw new Error(`job '${args.resumeFrom}' has no best candidate to resume from`);
            base = { text: await readFile(prev.best.path, "utf8"), path: prev.best.path };
          } else base = await candidateSource();
          const j = await startSearch({ project, fn, baseCandidateText: base.text, timeLimitS: args.timeLimitS, threads: args.threads, seed: args.seed, label: args.label, resumeFrom: args.resumeFrom });
          return jsonContent({ started: true, jobId: j.jobId, project: project.id, function: j.function, timeLimitS: j.timeLimitS, threads: j.threads, permuterDir: j.permuterDir, log: j.log, backend: j.backend,
            nextStep: `decomp({op:'job', project:'${project.id}', jobId:'${j.jobId}'}) — poll; 'budget exhausted' is not 'decompiled': confirm any zero-score best with op:'compare'.` });
        }
        case "job": {
          if (!args.jobId) throw new Error("decomp({op:'job'}): jobId is required.");
          const { jobStatus, cancelJob } = await import("../../decomp/jobs.js");
          if (args.action === "cancel") return jsonContent(await cancelJob(project, args.jobId));
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
            try { const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); out.push({ candidate: r.candidate, compileSucceeded: r.compileSucceeded, exactFunctionMatch: r.exactFunctionMatch, romLinked: r.romLinked?.status, distance: r.distance?.value ?? null, kinds: r.differenceKinds, tu: r.verification?.translationUnit, dependencyHash: r.compiler?.dependencyHash }); } catch {}
          }
          const gens = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^gen-\d+\.c$/.test(f)).map((f) => path.join(dir, f)) : [];
          return jsonContent({ project: project.id, function: { symbol: fn.symbol, segment: fn.segment, va: fn.vaHex }, compared: out.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9)), generated: gens, dir });
        }
        case "integrate": {
          const fn = await resolveFn();
          const { integrateCandidate } = await import("../../decomp/integrate.js");
          const c = await candidateSource();
          return jsonContent({ project: project.id, ...(await integrateCandidate(project, fn, { candidateText: c.text, apply: args.apply, verify: args.verify, jobs: args.jobs, declarations: args.declarations })) });
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
          return jsonContent(await runSmoke(project, { frames: args.frames, inputs: args.inputs ?? [], sessionKey, sessionHandle: args.session }));
        }
        default: throw new Error(`decomp: unknown op '${args.op}'`);
      }
    }),
  );
}
