// proc-child.js - runs one toolchain program (or one shell recipe line)
// through romdev's WASM/JS toolchain for proc.js, and exits with its status.
// Reads {argv, cwd, mode, env, stdin} as JSON on stdin; writes the program's
// stdout to stdout and its diagnostics to stderr.
//
// Plain JS ESM + JSDoc.

import path from "node:path";
import { DECOMP_HOME } from "../project.js";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { runArgv, runRecipeLine } from "../recipe.js";
import { execWasm, idoPrograms, idoDir, toolName } from "../toolchain.js";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const job = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const cwd = job.cwd ?? process.cwd();
const stdin = job.stdin ? Buffer.from(job.stdin, "base64") : undefined;
// Scratch for IDO's TMPDIR: romdev's own workspace, never the project
// checkout and never /tmp.
const scratchRoot = path.join(DECOMP_HOME, ".workbench-tmp");
mkdirSync(scratchRoot, { recursive: true });
const tmpRoot = mkdtempSync(path.join(scratchRoot, "run-"));

let code = 0;
try {
  if (job.mode === "make-n") {
    // What make would run, without running it: the JS Makefile reader.
    const { Makefile } = await import("../makefile.js");
    const overrides = {}, targets = [];
    let file = "Makefile";
    const a = job.argv.slice(1);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === "-f" || a[i] === "--file") { file = a[++i]; continue; }
      if (a[i] === "-C") { i++; continue; }
      if (a[i].startsWith("-")) continue;
      const eq = a[i].indexOf("=");
      if (eq > 0) overrides[a[i].slice(0, eq)] = a[i].slice(eq + 1); else targets.push(a[i]);
    }
    const mk = await Makefile.load(cwd, { makefile: file, overrides });
    for (const target of targets) {
      const found = mk.recipeFor(target);
      if (!found) { process.stderr.write(`make: *** No rule to make target '${target}'.  Stop.\n`); code = 2; break; }
      for (const l of found.lines) process.stdout.write(l.command + "\n");
    }
  } else if (job.mode === "line") {
    const r = await runRecipeLine(job.argv[0], { cwd, tmpRoot });
    if (r.unsupported) { process.stderr.write(`${r.unsupported}\n`); code = 127; }
    else { process.stderr.write(r.log ?? ""); code = r.code; }
  } else {
    const t = toolName(job.argv[0]);
    if (t?.kind === "ido" && t.program !== "cc") {
      // One IDO pass on its own (a replayed ugen/as1/...): its siblings are
      // available the way cc's are, with no cc remap.
      const r = await execWasm({ argv: [t.program, ...job.argv.slice(1)], cwd, programs: idoPrograms(t.version),
        env: { USR_LIB: idoDir(t.version), TMPDIR: tmpRoot, ...pick(job.env) }, stdin });
      process.stdout.write(typeof r.stdout === "string" ? Buffer.from(r.stdout, "latin1") : r.stdout ?? "");
      process.stderr.write(r.stderr ?? "");
      code = r.exitCode;
    } else {
      const r = await runArgv(job.argv, { cwd, tmpRoot, stdin, ido: { env: pick(job.env) } });
      if (r.unsupported) { process.stderr.write(`${r.unsupported}\n`); code = 127; }
      else {
        if (r.stdout) process.stdout.write(r.stdout);
        process.stderr.write(r.log ?? "");
        code = r.code;
      }
    }
  }
} catch (e) {
  process.stderr.write(`${e?.message ?? e}\n`);
  code = 2;
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
process.exitCode = code;

/** Diagnostic controls an IDO pass reads (CDX_*, DKWB_*); nothing else crosses. */
function pick(env) {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([k]) => /^(CDX_|DKWB_)/.test(k)));
}
