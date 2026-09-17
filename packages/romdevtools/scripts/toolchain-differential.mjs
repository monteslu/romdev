#!/usr/bin/env node
// toolchain-differential.mjs - compare a PUBLISHED toolchain binary against a
// known-clean copy by what it PRODUCES, not by its bytes.
//
// Byte-level hazard counting tells you a string tail changed; it cannot tell
// you whether anything reads that address. This runs both copies on the same
// input and diffs the output.
//
// THE TRAP THIS GUARDS AGAINST (hit by the sms-wat client, and the same shape
// as a seed-hash test of mine that passed vacuously): if the compile FAILS on
// both sides, both outputs are short and identical, and a naive diff reports
// "IDENTICAL" - a diff of two failures is indistinguishable from a diff of two
// successes. So every comparison here asserts the output is substantive FIRST
// and refuses to report a verdict otherwise.
import { readFileSync } from "node:fs";

/** Minimum believable output before a diff means anything. */
const MIN_LINES = 20;

export async function runCc1({ glue, wasm, source, args = ["-O1"] }) {
  const mod = (await import(glue)).default;
  const log = [];
  const M = await mod({ noInitialRun: true, locateFile: () => wasm,
    print: (s) => log.push(s), printErr: (s) => log.push("E:" + s) });
  M.FS.writeFile("/t.c", source);
  try { M.callMain(["/t.c", ...args, "-o", "/t.s"]); } catch (e) { log.push("THROW:" + e.message); }
  let asm = null;
  try { asm = new TextDecoder().decode(M.FS.readFile("/t.s")); } catch { /* no output */ }
  return { asm, log };
}

/**
 * @returns {{verdict:string, detail:string}} verdict is one of
 *   "identical" | "differs" | "inconclusive"
 */
export function compareAsm(a, b, { minLines = MIN_LINES } = {}) {
  // Refuse to grade a comparison where either side did not really compile.
  for (const [name, r] of [["clean", a], ["published", b]]) {
    if (!r.asm) return { verdict: "inconclusive", detail: `${name} produced no output: ${r.log.slice(-3).join(" | ")}` };
    const lines = r.asm.split("\n").filter(Boolean).length;
    if (lines < minLines) {
      return { verdict: "inconclusive", detail: `${name} emitted only ${lines} lines (< ${minLines}); a failed compile diffs clean against another failed compile` };
    }
    if (/\berror\b/i.test(r.log.join("\n"))) {
      return { verdict: "inconclusive", detail: `${name} reported an error: ${r.log.filter((l) => /error/i.test(l)).slice(0, 2).join(" | ")}` };
    }
  }
  // .ident carries the compiler version string, which suffix-shares with build
  // paths - report it separately from generated code.
  const strip = (s) => s.split("\n").filter((l) => !l.includes(".ident")).join("\n");
  const identA = (a.asm.match(/\.ident\s+"([^"]*)"/) || [])[1] ?? null;
  const identB = (b.asm.match(/\.ident\s+"([^"]*)"/) || [])[1] ?? null;
  const codeSame = strip(a.asm) === strip(b.asm);
  return {
    verdict: codeSame ? "identical" : "differs",
    detail: `code ${codeSame ? "identical" : "DIFFERS"}; .ident clean=${JSON.stringify(identA)} published=${JSON.stringify(identB)}`,
    identDiffers: identA !== identB,
  };
}
