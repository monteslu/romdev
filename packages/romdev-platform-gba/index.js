// romdev-platform-gba — binary package: mGBA core + arm-none-eabi-gcc
// toolchain (cc1-arm + as + ld + objcopy). These ship together because the
// GBA platform is the only consumer of the toolchain. emcc emits ESM
// (EXPORT_ES6=1) for the gcc tools so their glue uses .mjs extensions.
// Exports absolute paths to the bundled WASM so romdev's resolvers can load
// them via the package (instead of reaching into romdev's own src/).
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(__dirname, "wasm");

export const platform = "gba";

// share/gba/lib/{libtonc,libgba,maxmod,sysbase,c,arm-archives} — the GBA C
// library tree (libtonc/libgba sources + headers, maxmod archives/seeds, crt0,
// ld scripts, prebuilt CRT objects, arm-none-eabi archive seeds). The GBA build
// driver + the createGame scaffolder read these at compile time; they ship WITH
// the platform package because it's the only consumer (same shape as
// romdev-toolchain-cc65's share/). The inner `lib/` mirrors the original
// src/platforms/gba/lib/ layout so nothing else has to change its paths.
export const shareDir = path.join(__dirname, "share", "gba");

// Emulator core (libretro) — glue .js + .wasm.
export const core = {
  name: "mgba",
  jsPath: path.join(WASM, "mgba_libretro.js"),
  wasmPath: path.join(WASM, "mgba_libretro.wasm"),
};

// Compiler backend / assembler / linker / objcopy — arm-none-eabi gcc family.
export const toolchain = {
  "cc1-arm": { gluePath: path.join(WASM, "cc1-arm.mjs") },
  "arm-none-eabi-as": { gluePath: path.join(WASM, "arm-none-eabi-as.mjs") },
  "arm-none-eabi-ld": { gluePath: path.join(WASM, "arm-none-eabi-ld.mjs") },
  "arm-none-eabi-objcopy": { gluePath: path.join(WASM, "arm-none-eabi-objcopy.mjs") },
};

// ── The GBA C build pipeline (build/) ──────────────────────────────────────
// The full driver lives in this package so ONE dep compiles everything for
// the target: `import { buildGbaC } from "romdev-platform-gba"`. The import
// chain is inert at load (the worker pool forks only when a tool actually
// runs; WASM glue resolves lazily), so static re-exports cost only a few ms
// of JS parse. The vendored build/common + build/_worker kit is
// byte-identical to romdevtools' canonical copy (enforced by romdevtools'
// build-kit parity test; re-sync with romdevtools scripts/sync-build-kit.sh).
export { buildGbaC } from "./build/gba-c/gba-c.js";
export { parseBuildLog } from "./build/parse-errors.js";
