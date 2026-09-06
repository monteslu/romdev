// m2c.js — compiler-aware candidate generation through m2c (mips-ido-c
// target) with the TU's preprocessed context. Output is a CANDIDATE: stored
// separately, never written into the project's source. The result separates
// what the context vouched for from what m2c guessed.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./mips-obj.js";
import { buildContext, scanContextDeclarations } from "./context.js";
import { sha256Text } from "./project.js";

export const TOOLS_HOME = process.env.ROMDEV_DECOMP_TOOLS || path.join(os.homedir(), ".romdev", "tools");
export const PINNED = {
  m2c: { repo: "https://github.com/matt-kempster/m2c.git", commit: "1d1c4454a445326541305f83f2b0cb680a9ecb2d" },
  permuter: { repo: "https://github.com/simonlindholm/decomp-permuter.git", commit: "41bd0bfc32aa5ea78de4cf28be603163256c2a4c" },
};

export function toolPaths() {
  const py = path.join(TOOLS_HOME, "venv", "bin", "python");
  return {
    python: fs.existsSync(py) ? py : "python3",
    m2c: path.join(TOOLS_HOME, "m2c", "m2c.py"),
    permuter: path.join(TOOLS_HOME, "decomp-permuter"),
  };
}

/** Identity + presence of the pinned backends (recorded in every result). */
export async function backendStatus() {
  const t = toolPaths();
  const out = { toolsHome: TOOLS_HOME, python: t.python, m2c: null, permuter: null };
  for (const [key, dir, pin] of [["m2c", path.dirname(t.m2c), PINNED.m2c], ["permuter", t.permuter, PINNED.permuter]]) {
    if (!fs.existsSync(dir)) { out[key] = { present: false, path: dir, pinned: pin.commit, setup: `git clone ${pin.repo} ${dir} && git -C ${dir} checkout ${pin.commit}` }; continue; }
    const r = await run("git", ["-C", dir, "rev-parse", "HEAD"]);
    const head = r.stdout.trim();
    out[key] = { present: true, path: dir, commit: head, pinned: pin.commit, atPin: head === pin.commit };
  }
  const pv = await run(t.python, ["-c", "import sys, toml; print(sys.version.split()[0])"]);
  out.pythonOk = pv.code === 0; out.pythonVersion = pv.stdout.trim() || null; out.pythonError = pv.code === 0 ? undefined : pv.stderr.slice(0, 200);
  return out;
}

/**
 * Generate a candidate for a function.
 * @param {import('./project.js').Project} project
 * @param {object} fn resolved function with source.asmPath
 * @param {{contextTu?:string, extraArgs?:string[]}} opts
 */
export async function generateCandidate(project, fn, opts = {}) {
  const t = toolPaths();
  if (!fs.existsSync(t.m2c)) throw Object.assign(new Error(`m2c not installed at ${t.m2c}. ${(await backendStatus()).m2c.setup}`), { code: "MISSING_BACKEND" });
  const asmRel = fn.targetAsm?.path ?? fn.source?.asmPath ?? null;
  if (!asmRel) throw Object.assign(new Error(`function '${fn.symbol}' has no extracted asm to decompile (state '${fn.source?.state ?? "unknown"}', nothing under ${project.m.splat.asmPath}/)`), { code: "NO_TARGET_ASM" });
  const tuRel = opts.contextTu ?? fn.source?.tu;
  if (!tuRel) throw Object.assign(new Error(`function '${fn.symbol}' is in no TU; pass contextTu`), { code: "FUNCTION_NOT_IN_TU" });
  const ctx = await buildContext(project, tuRel);
  const asmAbs = project.abs(asmRel);
  // Extra context: proposed structs/prototypes (from decomp({op:'types', propose:true}) or the
  // agent) appended to the TU's context so a draft can be regenerated with better types WITHOUT
  // editing a header first. Recorded with the candidate.
  let ctxPath = ctx.path;
  if (opts.extraContext) {
    ctxPath = ctx.path.replace(/\.ctx\.c$/, `.plus-${sha256Text(opts.extraContext).slice(0, 8)}.ctx.c`);
    await writeFile(ctxPath, (await readFile(ctx.path, "utf8")) + "\n/* --- extra context (proposed, unverified) --- */\n" + opts.extraContext + "\n");
  }
  const args = [t.m2c, "--target", "mips-ido-c", "--context", ctxPath, ...(opts.extraArgs ?? []), asmAbs];
  const t0 = Date.now();
  const r = await run(t.python, args, { cwd: project.root, env: project.env, timeoutMs: 120_000 });
  const ms = Date.now() - t0;
  const dir = path.join(project.ws, "candidates", fn.symbol);
  await mkdir(dir, { recursive: true });
  const raw = r.stdout;
  const stderr = r.stderr;
  if (r.code !== 0 && !raw.trim()) {
    throw Object.assign(new Error(`m2c failed for ${fn.symbol}: ${stderr.slice(-800)}`), { code: "GENERATION_FAILED", context: ctx });
  }
  const parsed = splitM2cOutput(raw);
  const ctxText = await readFile(ctx.path, "utf8");
  const known = scanContextDeclarations(ctxText);
  // Unknown declarations m2c had to invent: `? func(...)` prototypes and `extern ? D_...;`
  const missing = [];
  for (const d of parsed.declarations) {
    const fm = /^\?\s+([A-Za-z_]\w*)\s*\(/.exec(d) || /^extern\s+\?\s+([A-Za-z_]\w*)/.exec(d);
    if (fm) missing.push({ name: fm[1], declaration: d, inContext: known.funcs.has(fm[1]) || known.globals.has(fm[1]) });
  }
  // Type hypotheses: struct field accesses m2c could not type (M2C_FIELD / unkNN) with the access width it used.
  const hypotheses = [];
  for (const m of parsed.body.matchAll(/M2C_FIELD\(([^,]+),\s*([^,]+),\s*(0x[0-9A-Fa-f]+|\d+)\)/g)) hypotheses.push({ base: m[1].trim(), type: m[2].trim(), offset: Number(m[3]), evidence: "m2c untyped field access" });
  for (const m of parsed.body.matchAll(/\b(\w+)(?:->|\.)unk_?([0-9A-Fa-f]+)\b/g)) {
    // Used as a pointer base? `*(base->unkN + …)`, `base->unkN[…]`, `base->unkN->`
    const tail = parsed.body.slice(m.index + m[0].length, m.index + m[0].length + 6);
    const head = parsed.body.slice(Math.max(0, m.index - 3), m.index);
    const usedAsPointer = /^\s*(\[|->)/.test(tail) || (/\*\($/.test(head) && /^\s*\+/.test(tail));
    hypotheses.push({ base: m[1], offset: parseInt(m[2], 16), evidence: usedAsPointer ? "m2c unk field used as a POINTER base (dereferenced/indexed)" : "m2c unk field (width from the load/store, see asm)", pointer: usedAsPointer });
  }
  const seen = new Map(); for (const h of hypotheses) { const k = `${h.base}:${h.offset}:${h.type ?? ""}`; const prev = seen.get(k); if (!prev) seen.set(k, h); else if (h.pointer && !prev.pointer) seen.set(k, h); } const uniq = [...seen.values()];
  const errors = [...parsed.body.matchAll(/M2C_ERROR\(([^)]*)\)/g)].map((m) => m[1]);
  // Persist what this draft says about types (offsets + asm access widths), so evidence accumulates across attempts.
  try { const { recordTypeEvidence } = await import("./types.js"); await recordTypeEvidence(project, fn, { hypotheses: uniq, asmText: await readFile(asmAbs, "utf8"), source: "m2c" }); } catch {}
  const n = fs.readdirSync(dir).filter((f) => /^gen-\d+\.c$/.test(f)).length + 1;
  const candPath = path.join(dir, `gen-${n}.c`);
  const candidateText = parsed.body.trim() + "\n";
  await writeFile(candPath, candidateText);
  await writeFile(candPath.replace(/\.c$/, ".json"), JSON.stringify({ symbol: fn.symbol, asm: asmRel, context: ctx, backend: { name: "m2c", commit: (await backendStatus()).m2c?.commit, target: "mips-ido-c" }, args, stderr: stderr.slice(-2000), declarations: parsed.declarations }, null, 2));
  return {
    kind: "pseudocode-candidate", note: "m2c output is a DRAFT: compile it with decomp({op:'compare'}) before believing any of it.",
    candidatePath: candPath, candidateSha256: sha256Text(candidateText).slice(0, 16), code: candidateText,
    declarationsNeeded: parsed.declarations, missingDeclarations: missing.filter((m) => !m.inContext), typeHypotheses: uniq.slice(0, 40), errors,
    contextPrototype: contextPrototype(ctxText, fn.symbol),
    targetAsm: asmRel,
    context: { path: ctxPath, hash: ctx.hash, cacheHit: ctx.cacheHit, dependencies: ctx.deps, tu: tuRel, extraContext: opts.extraContext ? { chars: opts.extraContext.length, note: "proposed declarations were appended to the context; pass the same text as `declarations` to compare/integrate" } : undefined },
    backend: { name: "m2c", target: "mips-ido-c", commit: (await backendStatus()).m2c?.commit, python: t.python, ms },
    warnings: stderr.trim() ? stderr.trim().split("\n").slice(-8) : [],
  };
}

/** m2c prints invented declarations first (`? f(...)`, `extern ? x;`), then the function. */
export function splitM2cOutput(text) {
  const lines = text.split("\n");
  const declarations = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^\?\s+\w+\s*\(.*\)\s*;/.test(l) || /^extern\s+\?/.test(l) || /^extern\s+[^(]*;$/.test(l) && /\?/.test(l)) { declarations.push(l); continue; }
    break;
  }
  return { declarations, body: lines.slice(i).join("\n") };
}

/** The prototype the context declares for the function (m2c honours it — a placeholder like `u8*` makes m2c emit `->unkN` on a non-struct pointer). */
export function contextPrototype(ctxText, name) {
  const m = new RegExp(`^[^\\n;{}]*\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\([^;{}]*\\)\\s*;`, "m").exec(ctxText);
  if (!m) return { declared: false, note: "no prototype in the context: m2c inferred the signature from register use (an unmodified forwarded argument register is only weak evidence of an argument)" };
  const proto = m[0].trim();
  const placeholder = /\b(u8|s8|void)\s*\*/.test(proto);
  return { declared: true, prototype: proto, placeholderPointerTypes: placeholder, note: placeholder ? "the TU declares byte/void pointer parameters; m2c cannot type field accesses through them — fix the prototype (a struct type) and regenerate" : undefined };
}
