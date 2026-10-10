// Opt-in allocator (globalcolor) trace capture.
//
// The diagnostic uopt is a WASM module built from the IDO 5.3 static-recomp
// uopt.c by the workbench's pinned instrumentation profile
// (scripts/build-ido-globalcolor.sh -> the locally built romdev-toolchain-ido/wasm/5.3/
// uopt-globalcolor.mjs). The measured compile recipe runs unchanged through
// romdev's WASM toolchain with that module standing in for the uopt pass; the
// project's compiler is never replaced and no forced coloring is enabled.
// Tracing-disabled and tracing-enabled objects must both equal the originally
// compared object before any allocator attribution is supported.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, copyFile, rename } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { artifactWorkbenchInput, verifyTraceBundle } from "./workbench.js";
import { compilationEnvironment, fileIdentities, fileRevisions, hashRecord, atomicJson } from "./measurement.js";
import { dependencyHash } from "./project.js";
import { runArgv } from "./recipe.js";
import { idoDir, programFiles } from "./toolchain.js";

export const GLOBALCOLOR_PROGRAM = "uopt-globalcolor";

/** The shipped diagnostic uopt and the identity of every module the traced compile runs. */
async function instrumentedCompiler(r) {
  const dir = idoDir("5.3");
  const glue = path.join(dir, `${GLOBALCOLOR_PROGRAM}.mjs`), wasm = path.join(dir, `${GLOBALCOLOR_PROGRAM}.wasm`);
  if (!existsSync(glue) || !existsSync(wasm)) {
    throw Object.assign(new Error(`the diagnostic globalcolor uopt is not built (${wasm}); run scripts/build-ido-globalcolor.sh`), { code: "TOOLCHAIN_MISSING" });
  }
  const files = await fileIdentities([glue, wasm, ...programFiles(r.compiler.compiler.path)]);
  return { programs: { uopt: glue }, files,
    disclosure: "WASM IDO 5.3 with only the uopt pass replaced by the workbench's pinned globalcolor trace profile (uopt-globalcolor.wasm); no forced-color controls" };
}

/**
 * IDO -K writes the pass intermediates into cc's working directory, so cc
 * runs with the bundle as its cwd. Paths the recipe names relative to the
 * project root are made absolute so the recipe itself is unchanged.
 */
function relocate(argv, root) {
  return argv.map((a, i) => {
    if (argv[i - 1] === "-I" && !path.isAbsolute(a)) return path.resolve(root, a);
    if (a.startsWith("-I") && a.length > 2 && !path.isAbsolute(a.slice(2))) return `-I${path.resolve(root, a.slice(2))}`;
    if (!a.startsWith("-") && !path.isAbsolute(a) && existsSync(path.join(root, a))) return path.resolve(root, a);
    return a;
  });
}

export async function captureGlobalcolorTrace(project, artifactPath) {
  const { result: r } = await artifactWorkbenchInput(project, artifactPath);
  if (r.compiler.compiler?.kind !== "ido" || r.compiler.compiler?.version !== "5.3") throw new Error("allocator trace capture supports the workbench's pinned IDO 5.3 profile only");
  if (!r.artifacts.translationUnit || !r.compileContext) throw new Error("refresh comparison to retain its compiled TU");
  if (Object.keys(compilationEnvironment(project)).some(k => /^(CDX_|DKWB_)/.test(k))) throw new Error("allocator trace capture requires an uninstrumented baseline environment; existing CDX/DKWB controls must not be mixed with this trace-only run");
  const inv = await project.compileInvocation(r.function.tu);
  if (hashRecord({ compile: inv.compile, post: inv.post }) !== hashRecord(r.inputIdentity.invocation)
    || hashRecord(compilationEnvironment(project)) !== hashRecord(r.inputIdentity.env)
    || hashRecord(await fileIdentities(r.inputIdentity.toolchain.map(t => t.path))) !== hashRecord(r.inputIdentity.toolchain)) throw new Error("compiler invocation/environment/toolchain changed since comparison");
  const dep = await dependencyHash(project, r.artifacts.translationUnit, inv);
  if (!dep.depsOk || dep.hash !== r.inputIdentity.candidateDependencies) throw new Error("retained TU/header dependencies changed since comparison");
  const compiler = await instrumentedCompiler(r);
  const key = hashRecord({ input: r.inputIdentity.sha256, output: r.objectIdentity.sha256, compiler, mode: "globalcolor-wasm-v1-retained-passes" });
  const dir = path.join(project.ws, "traces", key), index = path.join(dir, "bundle.json");
  await mkdir(dir, { recursive: true });
  try {
    const cached = JSON.parse(await readFile(index, "utf8"));
    const verification = await verifyTraceBundle(project, artifactPath, cached.tracePath);
    if (verification.equivalent) return { ...cached, verification, cacheHit: true };
  } catch { /* build a new private bundle */ }
  const work = path.join(dir, randomUUID());
  const source = path.join(work, r.function.tu);
  await mkdir(path.dirname(source), { recursive: true });
  await copyFile(r.artifacts.translationUnit, source);
  const watched = [r.artifacts.translationUnit, ...dep.deps.map(p => project.abs(p)),
    ...r.inputIdentity.toolchain.map(t => t.path), ...compiler.files.map(t => t.path)];
  const before = await fileRevisions(watched);
  const originalDriver = r.compiler.compiler.path;
  const traceEnvironment = { CDX_LOG: "1", CDX_DETAIL_WEB: "all" };
  const tmpRoot = path.join(work, ".tmp");
  const controls = [];
  for (const enabled of [false, true]) {
    const object = path.join(work, enabled ? "trace.o" : "disabled.o");
    const argv = r.compiler.invocation.map(a => a === r.compileContext.source ? source : a === r.compileContext.object ? object : a);
    argv.splice(argv.indexOf(source), 0, "-K"); // retain pass inputs for procedure provenance; equality is still mandatory
    const listed = new Set(await readdir(work));
    // asm-processor runs in the project root (its GLOBAL_ASM paths are
    // project-relative); cc runs in the bundle so -K lands there.
    const result = await runArgv(relocate(argv, project.root), { cwd: project.root, tmpRoot,
      ido: { programs: compiler.programs, env: enabled ? traceEnvironment : {}, cwd: work } });
    const log = path.join(work, enabled ? "globalcolor.log" : "disabled.log");
    await writeFile(log, result.log ?? "");
    if (result.unsupported) throw new Error(`the measured compile step has no WASM/JS equivalent: ${result.unsupported}`);
    if (result.code !== 0) return { tracePath: log, verification: { equivalent: false, reason: "diagnostic compiler failed", exitCode: result.code }, compiler };
    // Keep the -K intermediates of THIS run beside its object.
    const passes = `${object}.passes`;
    await mkdir(passes, { recursive: true });
    for (const f of await readdir(work, { withFileTypes: true })) {
      if (!f.isFile() || listed.has(f.name) || f.name === path.basename(object) || f.name.endsWith(".log")) continue;
      if (/^preprocessed_/.test(f.name)) await rename(path.join(work, f.name), path.join(passes, `input${path.extname(f.name)}`));
    }
    for (const post of inv.post) {
      const args = post.map(a => a === inv.object ? object : a === r.function.tu ? source : a);
      const step = await runArgv(args, { cwd: project.root, tmpRoot });
      if (step.unsupported || step.code !== 0) throw new Error(`diagnostic compile post-processing failed${step.unsupported ? `: ${step.unsupported}` : ""}`);
    }
    controls.push({ object, sha256: (await fileIdentities([object]))[0].sha256, invocation: argv, context: { source, object }, log });
  }
  if (hashRecord(before) !== hashRecord(await fileRevisions(watched))) throw new Error("inputs changed during allocator trace capture");
  const [off, on] = controls;
  const passesDir = `${on.object}.passes`;
  const manifest = { schema: "romdev-compiler-trace-v1", inputIdentity: r.inputIdentity.sha256,
    invocation: on.invocation, context: on.context, env: r.inputIdentity.env, toolchain: r.inputIdentity.toolchain,
    objectPath: on.object, objectSha256: on.sha256, traceSha256: (await fileIdentities([on.log]))[0].sha256,
    instrumentation: { kind: "ido-5.3-globalcolor", ...compiler, originalDriver, traceEnvironment, disabledControl: off },
    retainedPasses: await fileIdentities((await readdir(passesDir)).sort().map(f => path.join(passesDir, f))) };
  await atomicJson(`${on.log}.manifest.json`, manifest);
  const verification = await verifyTraceBundle(project, artifactPath, on.log);
  const bundle = { tracePath: on.log, manifestPath: `${on.log}.manifest.json`, verification, cacheHit: false,
    retainedPasses: manifest.retainedPasses,
    instrumentation: { kind: manifest.instrumentation.kind, programs: compiler.programs, disclosure: compiler.disclosure,
      disabledObject: off.object, disabledObjectSha256: off.sha256, traceEnvironment },
    limitations: "Observed candidate allocator decisions, not the unknown original source. Procedure ordinals require explicit mapping; no force controls and no inferred target allocator trace." };
  if (verification.equivalent) await atomicJson(index, bundle);
  return bundle;
}
