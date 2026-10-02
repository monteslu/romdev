// payloads.js - the WASM toolchains these tests compile with, or why they are
// absent.
//
// The binary packages (romdev-toolchain-mips-gcc, romdev-toolchain-ido)
// gitignore their wasm/ payloads; a dev box has them built, and CI fills them
// from the published npm tarballs (scripts/fetch-payloads.mjs). A checkout
// with neither must not fail with an opaque ENOENT deep inside a compile, so
// each test that needs a payload skips with the reason below, the same
// contract as romdevtools' test/helpers/test-rom.js.
//
//   import { MIPS_GCC, IDO } from "./helpers/payloads.js";
//   test("...", { skip: MIPS_GCC }, async () => { ... });

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The installed package's directory: node resolution first, then the monorepo sibling. */
function packageDir(name) {
  try { return path.dirname(fileURLToPath(import.meta.resolve(name))); } catch { /* not resolvable */ }
  const sibling = path.resolve(here, "..", "..", "..", name);
  return existsSync(path.join(sibling, "package.json")) ? sibling : null;
}

/**
 * false when every file is present, else the skip reason naming what is missing.
 * @param {string} pkg
 * @param {string[]} files package-relative paths
 */
export function missingPayload(pkg, files) {
  const dir = packageDir(pkg);
  if (!dir) return `${pkg} is not installed`;
  const absent = files.filter((f) => !existsSync(path.join(dir, f)));
  if (!absent.length) return false;
  return `${pkg} payload absent (${absent.join(", ")}): gitignored WASM, built locally or filled from npm by scripts/fetch-payloads.mjs`;
}

const glue = (names) => names.flatMap((n) => [`wasm/${n}.mjs`, `wasm/${n}.wasm`]);

/** cc1 + as, what helpers/wasm-gcc.js compiles with. */
export const MIPS_GCC = missingPayload("romdev-toolchain-mips-gcc", glue(["cc1", "mips-elf-as"]));

/** IDO 5.3, what the import/permuter@home scratch projects build with (plus cpp and binutils from mips-gcc). */
export const IDO = missingPayload("romdev-toolchain-ido", [...glue(["cc", "cfe", "uopt", "ugen", "as1"].map((p) => `5.3/${p}`)), "wasm/5.3/err.english.cc"])
  || missingPayload("romdev-toolchain-mips-gcc", glue(["cc1", "mips-linux-gnu-as", "mips-linux-gnu-objdump"]));

/**
 * Compile AND score: the scorer disassembles with mips-linux-gnu-objdump
 * (src/objdump.js). The npm tarball of romdev-toolchain-mips-gcc 0.1.2 does
 * not carry the mips-linux-gnu binutils the in-tree 0.1.2 does, so a tree
 * filled from npm can compile but not score until that package is
 * republished under a new version.
 */
export const MIPS_GCC_SCORER = MIPS_GCC || missingPayload("romdev-toolchain-mips-gcc", glue(["mips-linux-gnu-objdump"]));
