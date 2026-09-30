// permuter-compile.js - the compile step of a permuter search, run in-process:
// the TU's own compile argv (captured from the build recipe, with the
// candidate substituted for the source and the object) dispatched through
// recipe.js to romdev's WASM toolchain (IDO et al.). The permuter imports this
// module in each of its worker threads (romdev-permuter's compileModule
// contract), so no compile.sh / bash / host compiler is involved.
import fs from "node:fs";
import { runArgv } from "./recipe.js";

/**
 * @param {string} cPath candidate source
 * @param {string} oPath object to produce
 * @param {{argv: string[], cwd: string, tmpRoot: string}} config argv uses "$INPUT" / "$OUTPUT" placeholders
 * @returns {Promise<boolean>} true when the object was produced
 */
export async function compileCandidate(cPath, oPath, { argv, cwd, tmpRoot }) {
  const a = argv.map((x) => (x === "$INPUT" ? cPath : x === "$OUTPUT" ? oPath : x));
  const r = await runArgv(a, { cwd, tmpRoot });
  // A step romdev has no port for is an error, never a reason to try the host.
  if (r.unsupported) throw new Error(`compile step not supported by romdev's toolchain: ${r.unsupported}`);
  return r.code === 0 && fs.existsSync(oPath);
}
