// browser-surface-imports — the modules a browser Web Worker bundle loads for
// the GBA/Genesis build pipelines must have NO top-level node-builtin imports
// and must not statically pull the child-process worker layer. Node bits are
// allowed only behind lazy `await import(...)` on the default (no-env) paths.
// This is what keeps the env-injectable pipeline (0.95.0) actually bundleable:
// one stray top-level `import fs from "node:fs"` breaks every browser IDE.
//
// (`Buffer` as a global is tolerated where a pure fallback exists — see
// common/io.js — and ar.js is documented as needing a Buffer shim.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKGS = path.join(__dirname, "..", "..");

// The transitive static-import closure of `buildGbaC` / `buildGenesisC`.
const BROWSER_SURFACE = [
  "romdev-platform-gba/build/gba-c/gba-c.js",
  "romdev-platform-gba/build/arm-none-eabi-gcc/gcc.js",
  "romdev-toolchain-m68k-gcc/build/genesis-c/genesis-c.js",
  "romdev-toolchain-m68k-gcc/build/m68k-elf-gcc/gcc.js",
  "romdev-toolchain-m68k-gcc/build/sjasm/sjasm.js",
  // the shared kit (canonical copies — the vendored ones are parity-tested equal)
  "romdevtools/src/toolchains/common/gcc-toolchain.js",
  "romdevtools/src/toolchains/common/io.js",
  "romdevtools/src/toolchains/common/share-fs.js",
  "romdevtools/src/toolchains/common/sdk-cache.js",
  "romdevtools/src/toolchains/common/c-build.js",
  "romdevtools/src/toolchains/common/ar.js",
  "romdevtools/src/toolchains/parse-errors.js",
];

// Top-level static imports only — dynamic `await import("node:fs")` inside a
// function body is the sanctioned lazy pattern and must NOT match.
const STATIC_IMPORT = /^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm;
const BANNED = [/^node:/, /_worker\//];

for (const rel of BROWSER_SURFACE) {
  test(`browser surface: ${rel} has no top-level node imports`, () => {
    const src = readFileSync(path.join(PKGS, rel), "utf-8");
    const offenders = [];
    for (const m of src.matchAll(STATIC_IMPORT)) {
      const spec = m[1];
      if (BANNED.some((re) => re.test(spec))) offenders.push(spec);
    }
    assert.deepEqual(offenders, [], `${rel} statically imports: ${offenders.join(", ")}`);
  });
}
