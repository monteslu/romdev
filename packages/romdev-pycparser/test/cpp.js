// Upstream's cpp-backed tests (use_cpp=True) shell out to the host `cpp`.
// Here the preprocessor is romdev's WASM one: the mips gcc toolchain's cc1 in
// -E mode, driven by romdevtools' src/decomp/cpp.js. No host tool is spawned.
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { preprocess } from "../../romdevtools/src/decomp/cpp.js";
import { parse_file } from "../src/index.js";

export const C_FILES = fileURLToPath(new URL("./fixtures/c_files/", import.meta.url));
export const FAKE_LIBC = fileURLToPath(new URL("./fixtures/fake_libc_include/", import.meta.url));
export const cFile = (name) => path.join(C_FILES, name);

/**
 * Why the use_cpp cases cannot run here, or false. The preprocessor is the
 * mips gcc cc1 in romdev-toolchain-mips-gcc, whose wasm/ payload is gitignored
 * (built locally, or filled from npm by scripts/fetch-payloads.mjs). Without
 * it those cases skip with this reason instead of failing on a missing file,
 * like romdevtools' test/helpers/test-rom.js.
 */
export const CPP_SKIP = (() => {
  let dir = null;
  try { dir = path.dirname(fileURLToPath(import.meta.resolve("romdev-toolchain-mips-gcc"))); } catch {
    const sibling = fileURLToPath(new URL("../../romdev-toolchain-mips-gcc/", import.meta.url));
    if (existsSync(path.join(sibling, "package.json"))) dir = sibling;
  }
  if (!dir) return "romdev-toolchain-mips-gcc (the WASM cpp) is not installed";
  const absent = ["wasm/cc1.mjs", "wasm/cc1.wasm"].filter((f) => !existsSync(path.join(dir, f)));
  return absent.length ? `romdev-toolchain-mips-gcc payload absent (${absent.join(", ")}): gitignored WASM, built locally or filled from npm by scripts/fetch-payloads.mjs` : false;
})();

/**
 * pycparser.parse_file(filename, use_cpp=True, cpp_args=...) with the WASM cpp.
 * Like upstream's tests, the file is named relative to the working directory
 * (here: its own directory), so line markers carry that spelling.
 */
export async function parse_file_with_cpp(filename, cpp_args = []) {
  const cwd = path.dirname(filename);
  const r = await preprocess({ cwd, args: [...cpp_args, path.basename(filename)] });
  if (r.exitCode !== 0) throw new Error(`cpp failed (${r.exitCode}): ${r.log}`);
  const text = r.output.toString("utf8");
  return parse_file(filename, { use_cpp: true, preprocess: () => text });
}
