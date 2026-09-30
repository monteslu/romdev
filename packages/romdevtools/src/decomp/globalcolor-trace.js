// Opt-in adapter for the workbench's pinned uopt instrumentation profile.
// Builds a diagnostic compiler copy in the workspace; never replaces the
// project's compiler or enables forced coloring. Off/on output must both equal
// the original compared object before this can support allocator attribution.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, copyFile, symlink, writeFile } from "node:fs/promises";
import { artifactWorkbenchInput, runWorkbench, verifyTraceBundle, WORKBENCH_SOURCE_DIR } from "./workbench.js";
import { compilationEnvironment, fileIdentities, fileRevisions, hashRecord, atomicJson, resolveToolFile } from "./measurement.js";
import { dependencyHash } from "./project.js";
import { run } from "./mips-obj.js";
import { fileURLToPath } from "node:url";
// The modules that define the instrumentation profile and the command that applies it.
const PROFILE_MODULES = ["instrument-uopt.js", "instrument-uopt-cli.js", "globalcolor.js", "py.js", "cli.js"];
const runner = fileURLToPath(new URL("./ido-trace-driver.mjs", import.meta.url));

async function instrumentedCompiler(project, r) {
  const cc = project.abs(r.compiler.compiler.path), out = path.dirname(cc);
  const build = path.dirname(out), sourceRoot = path.resolve(build, "../..");
  const source = path.join(build, "uopt.c");
  // The instrumentation profile is romdev's own workbench code: fingerprint it
  // so a changed profile builds a new diagnostic compiler.
  const wbSource = WORKBENCH_SOURCE_DIR;
  const gcc = await resolveToolFile(project, "gcc");
  const paths = [source, cc, gcc, runner, process.execPath, ...["header.h", "helpers.h", "libc_impl.h"].map(f => path.join(sourceRoot, f)),
    ...["libc_impl.o", "version_info.o"].map(f => path.join(build, f)),
    ...(await readdir(wbSource)).filter(f => PROFILE_MODULES.includes(f)).sort().map(f => path.join(wbSource, f))];
  const inputs = await fileIdentities(paths);
  if (inputs.some(i => i.missing)) throw new Error("IDO generated source/runtime or host gcc unavailable; allocator instrumentation was not built");
  const key = hashRecord({ inputs, recipe: "globalcolor-trace-only-v1-gcc-Os-c11" });
  const dir = path.join(project.ws, "trace-compilers", key);
  await mkdir(dir, { recursive: true });
  const index = path.join(dir, "compiler.json");
  try {
    const cached = JSON.parse(await readFile(index, "utf8"));
    if (hashRecord(await fileIdentities(cached.files.map(f => f.path))) === hashRecord(cached.files)) return cached;
  } catch { /* build a private immutable copy */ }
  const work = path.join(dir, randomUUID()), bin = path.join(work, "bin");
  await mkdir(bin, { recursive: true });
  const generated = path.join(work, "uopt.c"), obj = path.join(work, "uopt.o");
  // No --allow-unverified-source: profile itself must accept this source hash.
  const patch = await runWorkbench(["instrument-uopt-globalcolor", source, generated], { json: false, cwd: project.root });
  if (patch.code !== 0) throw new Error(`workbench refused allocator profile: ${patch.stderr || patch.stdout}`);
  for (const entry of await readdir(out)) {
    if (entry === "uopt") continue;
    if (entry === "cc") await copyFile(cc, path.join(bin, entry));
    else await symlink(path.join(out, entry), path.join(bin, entry));
  }
  const argv = [gcc, "-std=c11", "-Os", "-fno-strict-aliasing", "-I", sourceRoot, "-c", generated, "-o", obj];
  const compile = await run(argv[0], argv.slice(1), { cwd: project.root, env: project.env, timeoutMs: 180_000 });
  await writeFile(path.join(work, "build.log"), compile.stdout + compile.stderr);
  if (compile.code !== 0) throw new Error(`instrumented uopt build failed; see ${path.join(work, "build.log")}`);
  const link = [gcc, "-o", path.join(bin, "uopt"), obj, path.join(build, "libc_impl.o"), path.join(build, "version_info.o"), "-lm"];
  const linked = await run(link[0], link.slice(1), { cwd: project.root, env: project.env, timeoutMs: 60_000 });
  if (linked.code !== 0) throw new Error(`instrumented uopt link failed: ${linked.stderr}`);
  if (hashRecord(await fileIdentities(paths)) !== hashRecord(inputs)) throw new Error("compiler/profile inputs moved during diagnostic compiler build");
  const files = await fileIdentities([generated, runner, process.execPath, ...await readdir(bin).then(names => names.map(n => path.join(bin, n)))]);
  const result = { driver: path.join(bin, "cc"), files, inputs, buildInvocation: argv, linkInvocation: link,
    disclosure: "workspace copy of IDO driver; only uopt is replaced by the workbench's pinned globalcolor trace profile; no forced-color controls" };
  await atomicJson(index, result);
  return result;
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
  const compiler = await instrumentedCompiler(project, r);
  const key = hashRecord({ input: r.inputIdentity.sha256, output: r.objectIdentity.sha256, compiler, mode: "globalcolor-v3-retained-passes" });
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
  const controls = [];
  for (const enabled of [false, true]) {
    const object = path.join(work, enabled ? "trace.o" : "disabled.o");
    const argv = r.compiler.invocation.flatMap(a => a === r.compileContext.source ? source : a === r.compileContext.object ? object
      : a === originalDriver ? [process.execPath, runner, compiler.driver] : a);
    argv.splice(argv.indexOf(source), 0, "-K"); // retain pass inputs for procedure provenance; equality is still mandatory
    if (!argv.includes(compiler.driver)) throw new Error("could not identify original compiler driver in the measured invocation");
    const result = await run(argv[0], argv.slice(1), { cwd: project.root, env: { ...project.env, ...(enabled ? traceEnvironment : {}) }, timeoutMs: 180_000 });
    const log = path.join(work, enabled ? "globalcolor.log" : "disabled.log");
    await writeFile(log, result.stdout + "\n" + result.stderr);
    if (result.code !== 0) return { tracePath: log, verification: { equivalent: false, reason: "diagnostic compiler failed", exitCode: result.code }, compiler };
    for (const post of inv.post) {
      const args = post.map(a => a === inv.object ? object : a === r.function.tu ? source : a);
      const step = await run(args[0], args.slice(1), { cwd: project.root, env: project.env });
      if (step.code !== 0) throw new Error("diagnostic compile post-processing failed");
    }
    controls.push({ object, sha256: (await fileIdentities([object]))[0].sha256, invocation: argv, context: { source, object }, log });
  }
  if (hashRecord(before) !== hashRecord(await fileRevisions(watched))) throw new Error("inputs changed during allocator trace capture");
  const [off, on] = controls;
  const manifest = { schema: "romdev-compiler-trace-v1", inputIdentity: r.inputIdentity.sha256,
    invocation: on.invocation, context: on.context, env: r.inputIdentity.env, toolchain: r.inputIdentity.toolchain,
    objectPath: on.object, objectSha256: on.sha256, traceSha256: (await fileIdentities([on.log]))[0].sha256,
    instrumentation: { kind: "ido-5.3-globalcolor", ...compiler, originalDriver, traceEnvironment,
      driverRunner: [process.execPath, runner, compiler.driver], disabledControl: off },
    retainedPasses: await fileIdentities((await readdir(`${on.object}.passes`)).map(f => path.join(`${on.object}.passes`, f))) };
  await atomicJson(`${on.log}.manifest.json`, manifest);
  const verification = await verifyTraceBundle(project, artifactPath, on.log);
  const bundle = { tracePath: on.log, manifestPath: `${on.log}.manifest.json`, verification, cacheHit: false,
    retainedPasses: manifest.retainedPasses,
    instrumentation: { kind: manifest.instrumentation.kind, driver: compiler.driver, disclosure: compiler.disclosure,
      disabledObject: off.object, disabledObjectSha256: off.sha256, traceEnvironment },
    limitations: "Observed candidate allocator decisions, not the unknown original source. Procedure ordinals require explicit mapping; no force controls and no inferred target allocator trace." };
  if (verification.equivalent) await atomicJson(index, bundle);
  return bundle;
}
