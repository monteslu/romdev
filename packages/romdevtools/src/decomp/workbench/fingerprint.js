// fingerprint.js - redistributable compiler microcases and cross-revision
// lineage reports. A toolchain fingerprint compiles six bundled microcases
// with the project's own compile template and records the lowering,
// scheduling, frame and allocation idioms each produces; two fingerprints
// compare by feature. Lineage compares one symbol across object revisions
// without reading any ROM data.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEFAULT_STREAM_LIMIT, captureStreams } from "./artifacts.js";
import { CompilerTimeoutError, executableIdentity, fileSha256, renderCompileCommand, runCompiler, canonicalJson } from "./campaign.js";
import { compareObjects, frameSize, normalizeInstruction } from "./compare.js";
import { discoverObjdump, dumpObject } from "./objdump.js";
import { destinationRegister } from "./view.js";
import { ValueError, sorted, splitWs, strip } from "./py.js";
import { RuntimeError, FileNotFoundError } from "./py-extra.js";

export const FINGERPRINT_SCHEMA = "decomp-workbench-toolchain-fingerprint-v1";
export const LINEAGE_SCHEMA = "decomp-workbench-cross-rom-lineage-v1";
export const MICROCASES = Object.freeze([
  ["control-flow", "control_flow.c", "dkwb_fp_control_flow"],
  ["stack-home", "stack_home.c", "dkwb_fp_stack_home"],
  ["schedule", "schedule.c", "dkwb_fp_schedule"],
  ["allocation", "allocation.c", "dkwb_fp_allocation"],
  ["dense-switch-4", "dense_switch_4.c", "dkwb_fp_dense_switch_4"],
  ["dense-switch-5", "dense_switch_5.c", "dkwb_fp_dense_switch_5"],
]);
export const CASES_ROOT = fileURLToPath(new URL("./data/fingerprints/", import.meta.url));

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const sortedCounter = (items) => {
  const m = new Map();
  for (const x of items) m.set(x, (m.get(x) ?? 0) + 1);
  const out = {};
  for (const k of sorted([...m.keys()])) out[k] = m.get(k);
  return out;
};

/** Describe lowering, scheduling, frame, and register-allocation idioms. */
export function instructionFingerprint(instructions) {
  const opcodes = instructions.map((i) => i.opcode);
  const normalized = instructions.map((i) => normalizeInstruction(i.assembly));
  const destinations = instructions.map((i) => destinationRegister(i.assembly)).filter((r) => r !== null);
  const branchOps = instructions.filter((i) => i.opcode.startsWith("b") || ["j", "jr", "jal", "jalr"].includes(i.opcode)).map((i) => i.opcode);
  const calls = instructions.filter((i) => i.opcode === "jal" || i.opcode === "jalr").length;
  const computedJumps = [];
  for (const i of instructions) {
    if (i.opcode !== "jr") continue;
    const parts = splitWs(i.assembly, 1);
    const register = parts.length > 1 ? strip(parts[1].split(",")[0]).replace(/^\$+/, "") : "";
    if (register !== "ra" && register !== "31") computedJumps.push(i.assembly);
  }
  const ngrams = [];
  for (let k = 0; k < Math.max(0, opcodes.length - 2); k++) ngrams.push(opcodes.slice(k, k + 3).join("/"));
  return {
    instructions: instructions.length,
    frame_size: frameSize(instructions.map((i) => i.assembly).join("\n")),
    opcode_histogram: sortedCounter(opcodes),
    branch_skeleton: branchOps,
    call_count: calls,
    computed_jump: computedJumps.length > 0,
    computed_jumps: computedJumps,
    float_loads: instructions.filter((i) => i.opcode === "lwc1" || i.opcode === "ldc1").length,
    float_stores: instructions.filter((i) => i.opcode === "swc1" || i.opcode === "sdc1").length,
    destination_registers: destinations,
    schedule_ngrams: sortedCounter(ngrams),
    word_sha256: sha256(Buffer.from(instructions.map((i) => i.word).join(""), "ascii")),
    normalized_sha256: sha256(Buffer.from(normalized.join("\n"), "utf8")),
  };
}

const expandUser = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);
const resolvePath = (p) => { const abs = path.resolve(expandUser(String(p))); try { return fs.realpathSync(abs); } catch { return abs; } };

/** Fingerprint one object symbol with reproducibility hashes. */
export function objectFingerprint(p, { objdump, symbol, section = ".text" }) {
  const objectPath = resolvePath(p);
  const [, instructions] = dumpObject(objectPath, { objdump, symbol, section });
  return { object: objectPath, object_sha256: fileSha256(objectPath), symbol, features: instructionFingerprint(instructions) };
}

/** Compile the bundled microcases and combine their feature signatures. */
export async function runToolchainFingerprint(template, { compile_cwd, environment, objdump, timeout, stream_limit = DEFAULT_STREAM_LIMIT, artifact_dir = null }) {
  const cwd = resolvePath(compile_cwd);
  let isDir = false;
  try { isDir = fs.statSync(cwd).isDirectory(); } catch { /* missing */ }
  if (!isDir) throw Object.assign(new Error(`compiler working directory does not exist: ${cwd}`), { name: "NotADirectoryError", reported: true });
  const objdumpPath = discoverObjdump(objdump);
  const cases = [];
  let compilerIdentity = null;
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "decomp-workbench-fingerprint-"));
  try {
    for (const [name, filename, symbol] of MICROCASES) {
      const source = path.join(CASES_ROOT, filename);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new FileNotFoundError(`bundled fingerprint case missing: ${source}`);
      const output = path.join(outputRoot, `${name}.o`);
      const command = renderCompileCommand(template, source, output);
      compilerIdentity = executableIdentity(command, { cwd });
      const started = performance.now();
      let proc;
      try {
        proc = await runCompiler(command, { environment, compile_cwd: cwd, timeout });
      } catch (e) {
        if (e instanceof CompilerTimeoutError) throw new RuntimeError(`fingerprint case ${name} ${e.message}`);
        throw e;
      }
      const streams = captureStreams(proc.stdout, proc.stderr, { limit: stream_limit, artifact_dir, stem: `fingerprint-${name}` });
      if (proc.returncode) throw new RuntimeError(`fingerprint case ${name} failed with exit ${proc.returncode}: ${strip(streams.stderr) || strip(streams.stdout)}`);
      if (!fs.existsSync(output)) throw new RuntimeError(`fingerprint case ${name} did not create its object`);
      const item = objectFingerprint(output, { objdump: objdumpPath, symbol });
      Object.assign(item, { name, source_sha256: fileSha256(source), duration_seconds: (performance.now() - started) / 1000,
        stdout: streams.stdout, stderr: streams.stderr, stdout_truncated: streams.stdout_truncated, stderr_truncated: streams.stderr_truncated,
        artifacts: streams.artifacts });
      cases.push(item);
    }
  } finally { fs.rmSync(outputRoot, { recursive: true, force: true }); }
  const identityPayload = Object.fromEntries(cases.map((c) => [c.name, c.features]));
  const suitePayload = Object.fromEntries(cases.map((c) => [c.name, c.source_sha256]));
  return {
    schema: FINGERPRINT_SCHEMA,
    suite: sha256(Buffer.from(canonicalJson(suitePayload), "utf8")),
    fingerprint: sha256(Buffer.from(canonicalJson(identityPayload), "utf8")),
    compiler: compilerIdentity,
    objdump: executableIdentity([objdumpPath], { cwd }),
    working_directory: cwd,
    explicit_environment: environment,
    cases,
    proof: "Redistributable behavioral fingerprint, not a claim of compiler version identity unless compared with a separately established record.",
  };
}

const jsonEq = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

function reportSuite(cases) {
  const payload = {};
  for (const [name, item] of Object.entries(cases)) if (typeof item?.source_sha256 === "string") payload[name] = item.source_sha256;
  if (Object.keys(payload).length !== Object.keys(cases).length || !Object.keys(payload).length) return null;
  return sha256(Buffer.from(canonicalJson(payload), "utf8"));
}

/** Compare two previously captured toolchain fingerprints. */
export function compareFingerprintReports(target, candidate) {
  const byName = (r) => { const o = {}; for (const item of r.cases ?? []) o[item.name] = item; return o; };
  const targetCases = byName(target), candidateCases = byName(candidate);
  const targetSuite = target.suite || reportSuite(targetCases);
  const candidateSuite = candidate.suite || reportSuite(candidateCases);
  const compatible = targetSuite !== null && targetSuite !== undefined && targetSuite === candidateSuite;
  const differences = [];
  for (const name of sorted([...new Set([...Object.keys(targetCases), ...Object.keys(candidateCases)])])) {
    const expected = targetCases[name], actual = candidateCases[name];
    if (jsonEq(expected, actual)) continue;
    const ef = expected ? expected.features ?? {} : {}, af = actual ? actual.features ?? {} : {};
    const changed = sorted([...new Set([...Object.keys(ef), ...Object.keys(af)])].filter((k) => !jsonEq(ef[k], af[k])));
    differences.push({ case: name, changed_features: changed });
  }
  return {
    schema: "decomp-workbench-toolchain-fingerprint-diff-v1", compatible,
    identical: compatible && target.fingerprint === candidate.fingerprint,
    target_suite: targetSuite ?? null, candidate_suite: candidateSuite ?? null,
    target_fingerprint: target.fingerprint ?? null, candidate_fingerprint: candidate.fingerprint ?? null, differences,
  };
}

/** Compare equivalent symbols across revisions without reading ROM data. */
export function crossRomLineage(revisionsIn, { objdump, symbol, section = ".text", rom_hashes = null }) {
  const revisions = Object.fromEntries(revisionsIn instanceof Map ? revisionsIn : Object.entries(revisionsIn));
  const labels0 = revisionsIn instanceof Map ? [...revisionsIn.keys()] : Object.keys(revisionsIn);
  if (labels0.length < 2) throw new ValueError("lineage requires at least two label=object revisions");
  if (labels0.length > 16) throw new ValueError("lineage accepts at most 16 revisions per report");
  const supplied = rom_hashes ?? {};
  const unknown = sorted(Object.keys(supplied).filter((l) => !(l in revisions)));
  if (unknown.length) throw new ValueError("ROM hash label(s) have no matching revision: " + unknown.join(", "));
  const invalid = sorted(Object.entries(supplied).filter(([, d]) => !/^[0-9a-fA-F]{64}$/.test(d)).map(([l]) => l));
  if (invalid.length) throw new ValueError("ROM hashes must be 64 hexadecimal characters: " + invalid.join(", "));
  const normalizedRom = Object.fromEntries(Object.entries(supplied).map(([l, d]) => [l, d.toLowerCase()]));
  const items = new Map(labels0.map((label) => [label, objectFingerprint(revisions[label], { objdump, symbol, section })]));
  const pairs = [];
  const labels = sorted(labels0);
  labels.forEach((left, i) => {
    for (const right of labels.slice(i + 1)) {
      const c = compareObjects(revisions[left], revisions[right], { objdump, symbol, section });
      pairs.push({ left, right, exact: c.exact, structural_exact: c.structural_exact, verdict: c.verdict, aligned_total: c.aligned_total, words: c.word_mismatches });
    }
  });
  const groupsMap = new Map();
  for (const [label, item] of items) {
    const k = item.features.normalized_sha256;
    if (!groupsMap.has(k)) groupsMap.set(k, []);
    groupsMap.get(k).push(label);
  }
  const groups = sorted([...groupsMap].map(([digest, group]) => ({ normalized_sha256: digest, revisions: sorted(group) })),
    (g) => [-g.revisions.length, g.normalized_sha256]);
  const revisionsOut = {};
  for (const [label, item] of items) revisionsOut[label] = { ...item, rom_sha256: normalizedRom[label] ?? null };
  return {
    schema: LINEAGE_SCHEMA, symbol, revisions: revisionsOut, pairs, normalized_lineage_groups: groups,
    anomalies: groups.filter((g) => g.revisions.length === 1).map((g) => g.revisions[0]),
    proof: "Object-derived lineage evidence. ROM hashes are caller-supplied identities; this command never reads or redistributes ROM data.",
  };
}
