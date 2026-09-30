// Shared measurement identities and projections. Missing evidence is unknown,
// never a measured zero or proof that two outputs are identical.
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, stat, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { VERIFIER_VERSION } from "./verdict.js";

export const INPUT_SCHEMA = "romdev-compilation-input-v1";
export const MEASUREMENT_SCHEMA = "romdev-measurement-v2";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const stable = (x) => Array.isArray(x) ? x.map(stable)
  : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, stable(x[k])])) : x;
export const hashRecord = (x) => hash(JSON.stringify(stable(x)));

export function compilationEnvironment(project) {
  const relevant = ["PATH", "LD_LIBRARY_PATH", "LIBRARY_PATH", "CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "LANG", "LC_ALL", "SOURCE_DATE_EPOCH"];
  const inherited = Object.fromEntries(relevant.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  // Instrumentation controls can alter compiler output; do not silently omit
  // them. General process secrets/unrelated service settings are not recorded.
  for (const [k, v] of Object.entries(process.env)) if (/^(CDX_|DKWB_)/.test(k)) inherited[k] = v;
  return { ...inherited, ...project.env };
}

export async function resolveToolFile(project, command) {
  if (command.includes("/")) return project.abs(command);
  for (const dir of (compilationEnvironment(project).PATH ?? "").split(path.delimiter)) {
    const file = path.resolve(project.root, dir, command);
    try { await access(file, constants.X_OK); if ((await stat(file)).isFile()) return file; } catch {}
  }
  return project.abs(command); // explicit missing-file identity, never a guessed executable
}

export async function compilerFiles(project, invocation) {
  const tc = project.m.toolchain;
  const { programFiles } = await import("./toolchain.js");
  // Programs run as WASM/JS: their identity is the module that runs, not a
  // host path of the same name.
  const files = [];
  // A tool romdev runs as WASM/JS hashes as its module; any other named tool
  // (a compiler with no WASM equivalent) still hashes as the file it names.
  const identify = async (cmd, argv = []) => {
    if (!cmd) return;
    const own = programFiles(cmd, argv);
    if (own.length) files.push(...own);
    else files.push(await resolveToolFile(project, cmd));
  };
  for (const argv of [invocation.compile, ...(invocation.post ?? [])]) {
    if (!argv?.length) continue;
    await identify(argv[0], argv);
    // asm-processor's compiler and assembler are named inside its argv.
    const sep = argv.indexOf("--");
    if (sep > 0) { await identify(argv[sep - 1]); if (argv[sep + 1]) await identify(argv[sep + 1]); }
  }
  for (const c of [tc.compiler?.path, tc.assembler?.path, tc.objdump?.path, tc.objcopy?.path]) await identify(c);
  if (tc.asmProcessor?.path) files.push(project.abs(tc.asmProcessor.path));
  // Python/Node/shell wrappers are executable inputs too, not merely strings
  // in argv. This includes asm-processor/build.py and recorded custom drivers.
  for (const argv of [invocation.compile, ...(invocation.post ?? [])]) for (const arg of (argv ?? []).slice(1)) {
    if (!/\.(?:py|mjs|cjs|js|sh)$/.test(arg) || arg.startsWith("-")) continue;
    const file = project.abs(arg);
    try { if ((await stat(file)).isFile()) files.push(file); } catch {}
  }
  // IDO's cc is a driver: programFiles already lists every pass module of the version.
  return [...new Set(files)];
}

/** Compare consumers must validate all producer input dimensions, not only a
 * TU dependency hash. Candidate-added headers and replaced compiler passes
 * can change while that original TU hash stays identical. */
export async function storedMeasurementFreshness(project, r, { dependencyHash, memo = new Map() } = {}) {
  if (!dependencyHash) return { state: "unknown", reason: "current dependency identity unavailable" };
  if (r?.compiler?.dependencyHash !== dependencyHash) return { state: "historical", reason: "owner dependency identity differs" };
  if (r?.producerSchema !== MEASUREMENT_SCHEMA || r.measurementValidity?.state !== "valid") return { state: "unknown", reason: "missing complete producer identity or invalid measurement" };
  if (r.verifierVersion !== VERIFIER_VERSION) return { state: "historical", reason: "measurement uses an older verifier policy" };
  if (r.inputIdentity?.ownerMode !== "live") return { state: "historical", reason: "saved-owner replay, not current live-tree evidence" };
  try {
    const tu = r.inputIdentity.tu;
    if (!memo.has(tu)) memo.set(tu, (async () => {
      const inv = await project.compileInvocation(tu);
      return { invocation: { compile: inv.compile, post: inv.post },
        toolchain: await fileIdentities(await compilerFiles(project, inv)),
        owner: (await fileIdentities([project.abs(tu)]))[0] };
    })());
    const current = await memo.get(tu);
    if (hashRecord(current.invocation) !== hashRecord(r.inputIdentity.invocation)
      || hashRecord(current.toolchain) !== hashRecord(r.inputIdentity.toolchain)
      || hashRecord(compilationEnvironment(project)) !== hashRecord(r.inputIdentity.env)
      || current.owner.sha256 !== r.inputIdentity.ownerSha256) return { state: "historical", reason: "owner, invocation, compiler/toolchain or environment differs" };
    for (const files of [r.referenceFiles, r.candidateDependencyFiles]) {
      if (!Array.isArray(files)) return { state: "unknown", reason: "reference or candidate-header identities missing" };
      if (hashRecord(await fileIdentities(files.map(f => f.path))) !== hashRecord(files)) return { state: "historical", reason: "reference or candidate-added header contents differ" };
    }
    return { state: "current", reason: "dependency, owner, invocation, environment, toolchain, candidate headers and reference contents match" };
  } catch (e) { return { state: "unknown", reason: `could not establish current identity: ${e.message}` }; }
}

export function compilationIdentity({ symbol, segment, tu, dependencyHash, candidateText,
  declarations = "", ownerText, savedOwner = false, invocation, toolchain, env, candidateDependencies }) {
  const inputs = { schema: INPUT_SCHEMA, symbol, segment: segment ?? null, tu,
    dependencyHash, candidateSha256: hash(candidateText), declarationsSha256: hash(declarations),
    ownerSha256: hash(ownerText), ownerMode: savedOwner ? "saved" : "live",
    invocation, toolchain, env, candidateDependencies };
  return { ...inputs, sha256: hashRecord(inputs) };
}

// Include actual reference contents, not only their paths or registration-time hashes.
const contentHashes = new Map();
const revisionKey = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
export async function fileIdentities(paths) {
  return Promise.all([...new Set(paths.filter(Boolean))].sort().map(async (path) => {
    try {
      const before = revisionKey(await stat(path, { bigint: true }));
      const cached = contentHashes.get(path);
      if (cached?.revision === before) return { path, sha256: cached.sha256 };
      const sha256 = hash(await readFile(path));
      const after = revisionKey(await stat(path, { bigint: true }));
      if (before === after) {
        if (contentHashes.size >= 512) contentHashes.delete(contentHashes.keys().next().value);
        contentHashes.set(path, { revision: after, sha256 });
      }
      return { path, sha256 };
    }
    catch (e) { if (e.code !== "ENOENT") throw e; return { path, missing: true }; }
  }));
}

export async function atomicJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value, null, 2)); await rename(tmp, path); }
  finally { await rm(tmp, { force: true }); }
}

// Separate mutation detection from content identity: restoring a file's old
// bytes should permit later reuse, but must invalidate a compile spanning edits.
export async function fileRevisions(paths) {
  return Promise.all([...new Set(paths.filter(Boolean))].sort().map(async (path) => {
    try {
      const s = await stat(path, { bigint: true });
      return { path, dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) };
    } catch (e) { if (e.code !== "ENOENT") throw e; return { path, missing: true }; }
  }));
}

// This identity deliberately claims ONLY function instruction bytes and their
// relocations. It is NOT identity of rodata, the whole object, or semantics.
export function instructionIdentity(stream) {
  if (!Array.isArray(stream) || stream.some((i) => !Number.isInteger(i.word))) return null;
  return { schema: "romdev-function-instructions-v1", scope: "function-instructions-and-relocations",
    sha256: hashRecord(stream.map((i) => ({ word: i.word >>> 0, reloc: i.reloc ?? null }))) };
}

export function linkedMismatchCount(r) {
  const linked = r?.romLinked;
  if (!["exact", "mismatch"].includes(linked?.status)
      || linked.uncheckableWords > 0 || linked.unresolvedSymbols?.length) return null;
  return Number.isFinite(linked.mismatches) ? linked.mismatches : null;
}

export function residualSummary(r) {
  const ev = r.evidence;
  return {
    strictMismatches: r.strictMismatches ?? null,
    linkedMismatches: linkedMismatchCount(r),
    kinds: r.differenceKinds ?? [], changedRanges: r.changedRanges?.count ?? null,
    registerSubstitutions: ev?.registerSubstitutions?.count ?? null,
    branchDifferences: ev?.branchTargetDifferences?.count ?? null,
    frame: ev?.stackFrame ?? null, instructionCount: ev?.instructionCount ?? null,
    scheduling: ev?.reordered ?? null,
    measured: ev != null,
  };
}

export function measurementSnapshot(r) {
  return { dependencyHash: r?.compiler?.dependencyHash ?? null,
    ownerSha256: r?.inputIdentity?.ownerSha256 ?? null,
    ownerMode: r?.inputIdentity?.ownerMode ?? null,
    compilerFingerprint: r?.compiler?.fingerprint ?? null,
    toolchainHash: r?.inputIdentity?.toolchain ? hashRecord(r.inputIdentity.toolchain) : null,
    environmentHash: r?.inputIdentity?.env ? hashRecord(r.inputIdentity.env) : null,
    referenceHash: r?.referenceHash ?? null,
    validity: r?.measurementValidity?.state ?? "unknown" };
}

export function batchSnapshot(rows) {
  const snapshots = rows.filter((r) => r.metrics).map((r) => r.snapshot);
  const hashes = new Set(snapshots.map((s) => s?.dependencyHash).filter(Boolean));
  const contextFields = ["ownerSha256", "ownerMode", "compilerFingerprint", "referenceHash", "toolchainHash", "environmentHash"];
  const known = snapshots.length > 0 && snapshots.every((s) => s?.dependencyHash && s.validity === "valid" && contextFields.every(k => s[k] != null));
  const changed = hashes.size > 1 || snapshots.some((s) => s?.validity === "invalid")
    || contextFields.some((k) =>
      new Set(snapshots.map((s) => s?.[k]).filter((v) => v != null)).size > 1);
  return { dependencySnapshot: snapshots[0]?.dependencyHash ?? null,
    snapshotStable: changed ? false : known ? true : null,
    snapshotValidity: changed ? "invalid" : known ? "valid" : "unknown" };
}
