// payload.mjs - is romdev-rabbitizer's WASM here, or why not.
//
// spimdisasm decodes every instruction through romdev-rabbitizer, whose
// wasm/ payload is gitignored: a dev box builds it, CI fills it from the
// published npm tarball (scripts/fetch-payloads.mjs). Loading src/index.js
// without it throws ENOENT before a single test is registered, which reads
// like a broken port. Tests that need it import the package dynamically and
// skip with this reason instead, the contract romdevtools' test-rom.js set.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RABBITIZER_VERSIONS = ["1.16.2", "1.14.3", "1.13.0"];

function rabbitizerDir() {
  try { return path.resolve(path.dirname(fileURLToPath(import.meta.resolve("romdev-rabbitizer"))), ".."); } catch { return null; }
}

/** false when every shipped rabbitizer WASM is present, else the skip reason. */
export const RABBITIZER_SKIP = (() => {
  const dir = rabbitizerDir();
  if (!dir) return "romdev-rabbitizer is not installed";
  const absent = RABBITIZER_VERSIONS.map((v) => `wasm/rabbitizer-${v}.wasm`).filter((f) => !existsSync(path.join(dir, f)));
  return absent.length ? `romdev-rabbitizer payload absent (${absent.join(", ")}): gitignored WASM, built by packages/romdevtools/scripts/build-rabbitizer.sh or filled from npm by scripts/fetch-payloads.mjs` : false;
})();
