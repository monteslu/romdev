// romdev-toolchain-m68k-gcc — binary package: m68k-elf gcc backend
// (cc1-m68k), assembler, linker, objcopy (WASM). emcc emits ESM
// (EXPORT_ES6=1) so the glue uses .mjs extensions.
// Exports absolute paths to the bundled WASM so romdev's resolver can load
// them via the package.
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

// share/genesis/lib/{sgdk,c,*.s} — the Genesis C library tree: the full SGDK
// tree (include headers, sources + prebuilt seeds for libmd, sega crt0, md.ld,
// rom_header, Z80 driver sources/blobs, res) + the minimal-runtime `c/` tree +
// the standalone crt0/vector/util .s files. The Genesis build driver + the
// createGame scaffolder read these at compile time; they ship WITH this
// toolchain package because it's the only consumer (same shape as
// romdev-toolchain-cc65's share/). The inner `lib/` mirrors the original
// src/platforms/genesis/lib/ layout. A future m68k platform (Neo Geo, Amiga,
// X68000) would add its SDK alongside under share/.
export const shareDir = path.join(__dirname, "share", "genesis");

// Compiler backend / assembler / linker / objcopy — m68k-elf gcc family.
// Plus SGDK's Z80 toolchain (sjasm + bintos): the Genesis sound drivers are
// Z80 assembly assembled by sjasm and embedded into the m68k ROM by bintos, so
// they belong to the same Genesis build toolchain.
export const toolchain = {
  "cc1-m68k": { gluePath: path.join(WASM, "cc1-m68k.mjs") },
  "m68k-elf-as": { gluePath: path.join(WASM, "m68k-elf-as.mjs") },
  "m68k-elf-ld": { gluePath: path.join(WASM, "m68k-elf-ld.mjs") },
  "m68k-elf-objcopy": { gluePath: path.join(WASM, "m68k-elf-objcopy.mjs") },
  "m68k-elf-objdump": { gluePath: path.join(WASM, "m68k-elf-objdump.mjs") },
  "sjasm": { gluePath: path.join(WASM, "sjasm.js") },
  "bintos": { gluePath: path.join(WASM, "bintos.js") },
};

// ── The Genesis C build pipeline (build/) ──────────────────────────────────
// The full driver lives in this package so ONE dep compiles everything for
// the target: `import { buildGenesisC } from "romdev-toolchain-m68k-gcc"`.
// The import chain is inert at load (the worker pool forks only when a tool
// actually runs; WASM glue resolves lazily), so static re-exports cost only
// a few ms of JS parse. The vendored build/common + build/_worker kit is
// byte-identical to romdevtools' canonical copy (enforced by romdevtools'
// build-kit parity test; re-sync with romdevtools scripts/sync-build-kit.sh).
export { buildGenesisC, finalizeGenesisRom } from "./build/genesis-c/genesis-c.js";
export { runSjasm, runBintos } from "./build/sjasm/sjasm.js";
export { parseBuildLog } from "./build/parse-errors.js";
