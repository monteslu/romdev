// build-kit-parity — the GBA + Genesis build drivers live in their binary
// packages (romdev-platform-gba/build, romdev-toolchain-m68k-gcc/build) so a
// standalone SDK consumer deps ONE package. The tool-running kit they vendor
// (common/, _worker/, parse-errors.js, the arch gcc.js wrappers) is CANONICAL
// in romdevtools' src/toolchains — 12 other toolchains use it — and the
// package copies must stay byte-identical or the two pipelines drift apart.
//
// When this test fails: you edited a kit file. Run
//   bash scripts/sync-build-kit.sh
// to re-copy it into both packages, and re-run the suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src", "toolchains");
const PKGS = path.join(__dirname, "..", "..");

const KIT = [
  "common/ar.js",
  "common/c-build.js",
  "common/sdk-cache.js",
  "common/wasm-tool.js",
  "common/gcc-toolchain.js",
  "_worker/pool.js",
  "_worker/run.js",
  "_worker/wasm-worker.js",
  "parse-errors.js",
];

const VENDORED = {
  "romdev-platform-gba": [...KIT, "arm-none-eabi-gcc/gcc.js"],
  "romdev-toolchain-m68k-gcc": [...KIT, "m68k-elf-gcc/gcc.js"],
};

for (const [pkg, files] of Object.entries(VENDORED)) {
  test(`build kit in ${pkg} is byte-identical to src/toolchains`, () => {
    for (const rel of files) {
      const canonical = readFileSync(path.join(SRC, rel), "utf-8");
      const vendored = readFileSync(path.join(PKGS, pkg, "build", rel), "utf-8");
      assert.equal(
        vendored,
        canonical,
        `${pkg}/build/${rel} drifted from src/toolchains/${rel} — run scripts/sync-build-kit.sh`,
      );
    }
  });
}
