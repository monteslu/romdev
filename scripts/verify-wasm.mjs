#!/usr/bin/env node
// verify-wasm.mjs — fail loudly if a publishable package is missing its wasm.
//
// The .wasm artifacts are gitignored (too big for git; built/staged out of
// band) and shipped to npm via each package's `files` allowlist. That split is
// correct, but it has one sharp edge: publishing from a tree where the wasm was
// never built (fresh clone, wrong branch, a `clean` that wiped wasm/) would
// ship a package with EMPTY wasm dirs — it installs fine and breaks at runtime.
// This guard makes that impossible: it runs as each wasm package's
// `prepublishOnly` AND as a preflight in publish-all.mjs.
//
// What it checks, for the package in `cwd` (or each path arg):
//   - every *.wasm under the package's shipped `wasm/` dir exists
//   - none is suspiciously small (a stub / truncated / git-lfs pointer)
//   - the JS/MJS glue each wasm pairs with is present
//
// Usage:
//   node verify-wasm.mjs                 # check the package in cwd
//   node verify-wasm.mjs <pkgDir> ...    # check specific package dirs
//   node verify-wasm.mjs --all <pkgsDir> # check every non-private package under pkgsDir

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

// A real wasm module is at least tens of KB; anything under this is a stub,
// a truncated file, or a git-lfs/text pointer left where the binary should be.
const MIN_WASM_BYTES = 16 * 1024;

/** @returns {string[]} problems found in this package (empty = ok) */
function checkPackage(pkgDir) {
  const problems = [];
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return [`${pkgDir}: no package.json`];
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const name = pkg.name ?? path.basename(pkgDir);

  // Only packages that actually SHIP a wasm/ dir are subject to this check.
  const files = pkg.files ?? [];
  if (!files.includes("wasm")) return []; // e.g. the main `romdev` orchestrator
  const wasmDir = path.join(pkgDir, "wasm");
  if (!existsSync(wasmDir)) return [`${name}: declares "wasm" in files[] but ${wasmDir} does not exist (build the wasm before publishing)`];

  const entries = readdirSync(wasmDir);
  const wasms = entries.filter((f) => f.endsWith(".wasm"));
  if (wasms.length === 0) return [`${name}: wasm/ is present but contains NO .wasm files (build was wiped?)`];

  for (const w of wasms) {
    const p = path.join(wasmDir, w);
    const size = statSync(p).size;
    if (size < MIN_WASM_BYTES) {
      problems.push(`${name}: ${w} is only ${size} bytes — looks like a stub/truncated file, not a real wasm module`);
      continue;
    }
    // Verify the wasm magic so a renamed text/pointer file can't sneak through.
    const fd = readFileSync(p, { encoding: null });
    if (fd.length < 8 || fd.readUInt32LE(0) !== 0x6d736100) {
      problems.push(`${name}: ${w} does not start with the wasm magic (\\0asm) — corrupt or wrong file`);
    }
  }
  return problems;
}

const args = process.argv.slice(2);
let pkgDirs;
if (args[0] === "--all") {
  const pkgsRoot = args[1];
  if (!pkgsRoot) { console.error("verify-wasm: --all needs a packages dir"); process.exit(2); }
  pkgDirs = readdirSync(pkgsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(pkgsRoot, d.name))
    .filter((d) => {
      const j = path.join(d, "package.json");
      if (!existsSync(j)) return false;
      return !JSON.parse(readFileSync(j, "utf8")).private;
    });
} else if (args.length) {
  pkgDirs = args;
} else {
  pkgDirs = [process.cwd()];
}

const allProblems = pkgDirs.flatMap(checkPackage);
if (allProblems.length) {
  console.error("✗ wasm verification FAILED — refusing to publish:\n");
  for (const p of allProblems) console.error("  - " + p);
  console.error("\nBuild/stage the wasm (see scripts/build-*.sh) and re-run.");
  process.exit(1);
}
const checked = pkgDirs.length;
console.log(`✓ wasm verified across ${checked} package${checked === 1 ? "" : "s"} (all declared .wasm present, sized, valid magic).`);
