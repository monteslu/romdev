// Fake compiler and objdump programs for campaign tests: node scripts run by
// absolute interpreter path, so a sealed (empty) compiler environment still
// finds them.
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const NODE = process.execPath;

/** A temporary directory removed after `fn` (sync or async). */
export async function withTemp(fn, prefix = "romdev-wb-campaign-") {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A compiler script; `body` runs with `src` and `out` in scope. */
export function writeCompiler(root, body = "fs.writeFileSync(out, fs.readFileSync(src));", name = "compile.mjs") {
  const p = path.join(root, name);
  writeFileSync(p, `import fs from "node:fs";\nconst [src, out] = process.argv.slice(2);\n${body}\n`);
  return p;
}

export const template = (compiler) => `${NODE} ${compiler} {source} {output}`;

/** An executable objdump printing one two-instruction function. `prelude` runs first. */
export function writeObjdump(root, prelude = "", name = "objdump") {
  const p = path.join(root, name);
  writeFileSync(p, `#!${NODE}\nimport fs from "node:fs";\n${prelude}\nprocess.stdout.write("00000000 <demo>:\\n   0: 03e00008  jr $ra\\n   4: 00000000  nop\\n");\n`);
  chmodSync(p, 0o755);
  return p;
}

/** An objdump that appends one line to `counter` per run. */
export function writeCountingObjdump(root, counter) {
  return writeObjdump(root, `fs.appendFileSync(${JSON.stringify(counter)}, "run\\n");`);
}
