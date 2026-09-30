// Upstream's cpp-backed tests (use_cpp=True) shell out to the host `cpp`.
// Here the preprocessor is romdev's WASM one: the mips gcc toolchain's cc1 in
// -E mode, driven by romdevtools' src/decomp/cpp.js. No host tool is spawned.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preprocess } from "../../romdevtools/src/decomp/cpp.js";
import { parse_file } from "../src/index.js";

export const C_FILES = fileURLToPath(new URL("./fixtures/c_files/", import.meta.url));
export const FAKE_LIBC = fileURLToPath(new URL("./fixtures/fake_libc_include/", import.meta.url));
export const cFile = (name) => path.join(C_FILES, name);

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
