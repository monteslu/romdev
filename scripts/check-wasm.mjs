#!/usr/bin/env node
// check-wasm.mjs — prepublish guard for the binary packages.
//
// The wasm/glue blobs are NOT committed to git; they only exist as built files
// in a working tree. `npm pack`/`npm publish` reads the working tree, so a
// publish from a machine that HAS the built wasm is correct — but a publish
// from a fresh `git clone` (e.g. a CI runner) would ship empty `wasm/` dirs =
// broken packages users can't run. This guard runs from each binary package's
// `prepublishOnly` and ABORTS the publish if the wasm looks missing/stubbed.
//
// It does NOT build anything (the wasm build is a heavy Emscripten job); it
// only verifies the artifacts are present and real.
//
// Run from a package dir (npm sets cwd to the package on prepublishOnly):
//   node ../../scripts/check-wasm.mjs
//
// Checks, relative to cwd:
//   - a `wasm/` directory exists and is non-empty
//   - every file in it is >= MIN_BYTES (catches 0-byte files and ~130-byte
//     git-LFS pointer stubs, the two ways "looks present but isn't" happens)

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Smallest legit blob we ship is the glue .js (~600 B) and LFS pointers are
// ~130 B, so 400 B cleanly separates "real glue" from "stub". Real .wasm are
// hundreds of KB to 135 MB, far above this.
const MIN_BYTES = 400;

const cwd = process.cwd();
const pkgName = (() => {
  try {
    return JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")).name ?? path.basename(cwd);
  } catch {
    return path.basename(cwd);
  }
})();

function fail(msg) {
  console.error(`\n✖ check-wasm: ${pkgName} — ${msg}`);
  console.error("  Refusing to publish a package with missing/stub wasm.");
  console.error("  Build the wasm first (see packages/romdevtools/scripts/build-*.sh)");
  console.error("  and publish from a working tree that has the built artifacts.\n");
  process.exit(1);
}

const wasmDir = path.join(cwd, "wasm");
if (!existsSync(wasmDir)) fail("no `wasm/` directory found");

let files;
try { files = readdirSync(wasmDir); }
catch (e) { fail(`could not read wasm/: ${e.message}`); }

if (!files.length) fail("`wasm/` directory is empty");

const tooSmall = [];
for (const f of files) {
  const full = path.join(wasmDir, f);
  let s;
  try { s = statSync(full); } catch (e) { fail(`could not stat wasm/${f}: ${e.message}`); }
  if (s.isFile() && s.size < MIN_BYTES) tooSmall.push(`${f} (${s.size} B)`);
}
if (tooSmall.length) {
  fail(`these wasm files look like stubs / empties:\n    ${tooSmall.join("\n    ")}`);
}

console.log(`✓ check-wasm: ${pkgName} — ${files.length} wasm file(s) present and non-stub`);
