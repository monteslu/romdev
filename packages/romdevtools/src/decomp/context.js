// context.js — the reusable type context for candidate generation: the real
// translation unit preprocessed with the build's own include paths and
// defines, GLOBAL_ASM pragmas stripped, cached by a dependency hash (TU +
// every header it pulls in + the compile fingerprint) so a header edit
// invalidates it and an unchanged TU never re-runs cpp.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { run } from "./mips-obj.js";
import { dependencyHash } from "./project.js";

/**
 * Preprocess a TU into an m2c-style context file.
 * @returns {{path:string, hash:string, cacheHit:boolean, deps:number, bytes:number}}
 */
export async function buildContext(project, tuRel, { force = false } = {}) {
  const inv = await project.compileInvocation(tuRel);
  const dep = await dependencyHash(project, tuRel, inv);
  const dir = path.join(project.ws, "context");
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, `${tuRel.replace(/[\/\\]/g, "__").replace(/\.c$/, "")}.${dep.hash}.ctx.c`);
  if (!force && fs.existsSync(out)) {
    const st = fs.statSync(out);
    return { path: out, hash: dep.hash, cacheHit: true, deps: dep.deps.length, bytes: st.size, fingerprint: inv.fingerprint };
  }
  const inc = inv.compile.reduce((acc, a, i, arr) => { if (arr[i - 1] === "-I") acc.push("-I", a); return acc; }, []);
  const defs = inv.compile.filter((a) => /^-D/.test(a));
  // The decomp-community m2ctx recipe: gcc -E with the project's flags, no host
  // headers, IDO-specific pragmas neutralized, GNU-only builtins hidden.
  const src = await readFile(project.abs(tuRel), "utf8");
  const stripped = src.replace(/^[ \t]*#pragma\s+GLOBAL_ASM\([^)]*\)[ \t]*$/gm, "");
  const tmp = path.join(dir, `.${path.basename(out)}.in.c`);
  await writeFile(tmp, stripped);
  const args = ["-E", "-P", "-nostdinc", "-fno-builtin", "-std=gnu89", "-x", "c", ...inc, "-I", path.dirname(project.abs(tuRel)), ...defs, "-D_LANGUAGE_C", "-DM2CTX", "-D__attribute__(x)=", "-D__asm__(x)=", "-U__GNUC__", tmp];
  const r = await run("gcc", args, { cwd: project.root, env: project.env, timeoutMs: 60_000 });
  try { fs.unlinkSync(tmp); } catch {}
  if (r.code !== 0) throw Object.assign(new Error(`preprocessing ${tuRel} for context failed: ${r.stderr.slice(0, 800)}`), { code: "CONTEXT_FAILED" });
  // Collapse blank runs; keep everything else (m2c wants declarations AND typedefs).
  const text = r.stdout.replace(/\n{3,}/g, "\n\n");
  await writeFile(out, text);
  return { path: out, hash: dep.hash, cacheHit: false, deps: dep.deps.length, bytes: text.length, fingerprint: inv.fingerprint };
}

/** Declarations the context knows: function prototypes and extern globals, by name. */
export function scanContextDeclarations(ctxText) {
  const funcs = new Set(), globals = new Set(), types = new Set();
  for (const m of ctxText.matchAll(/\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*;/g)) funcs.add(m[1]);
  for (const m of ctxText.matchAll(/^\s*extern\s+[^;(]*?\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\])*\s*;/gm)) globals.add(m[1]);
  for (const m of ctxText.matchAll(/\btypedef\b[^;{]*?\b([A-Za-z_]\w*)\s*;/g)) types.add(m[1]);
  for (const m of ctxText.matchAll(/\}\s*([A-Za-z_]\w*)\s*;/g)) types.add(m[1]);
  return { funcs, globals, types };
}
