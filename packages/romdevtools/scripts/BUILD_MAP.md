# Build map — which recipe builds which package

The build system is **centralized on purpose**: every upstream pin lives in one
[`versions.json`](./versions.json) (loaded by [`_versions.sh`](./_versions.sh)),
every `build-*.sh` recipe lives here in `scripts/`, and our patches are the only
committed third-party-adjacent source, in [`patches/`](./patches/). None of this
ships — `romdevtools`' `package.json` `files` allowlist excludes `scripts/`, so
patches + recipes are repo-only dev artifacts.

What **does** ship is the built `.wasm`, in the per-platform **binary packages**
(`romdev-core-*`, `romdev-platform-*`, `romdev-analysis*`). Those packages are
pure artifact carriers — a thin `index.js` + a `wasm/` dir. This file is the
missing link between the two: **given a package, find the recipe that builds it;
given a recipe, find what it ships into.**

> Why central, not per-package: one pin file (no 18-way version drift), shared
> primitives built once (bison/flex/emsdk; the m68k toolchain feeds BOTH GBA and
> Genesis), and no build cruft in the published binary packages. See
> [versions.json](./versions.json) header for the reproducibility model.

## Cores → packages

Each core recipe fetches its pinned upstream (`cores.<name>` in versions.json),
applies our patch, builds to WASM, stages into `src/cores/wasm/` (gitignored dev
staging), and copies into the shipping package's `wasm/`.

| Platform(s) | Core | Recipe | Patch | Ships in |
|---|---|---|---|---|
| NES | fceumm | `build-fceumm.sh` | `fceumm-romdev-memory-regions.patch` | `romdev-core-fceumm` |
| GB / GBC | gambatte | `build-gambatte.sh` | `gambatte-romdev-memory-regions.patch` | `romdev-core-gambatte` |
| Genesis / SMS / GG | genesis_plus_gx | `build-genesis-plus-gx.sh` | `genesis-plus-gx-romdev-memory-regions.patch` | `romdev-core-gpgx` |
| Atari 7800 | prosystem | `build-prosystem.sh` | `prosystem-romdev-memory-regions.patch` | `romdev-core-prosystem` |
| Lynx | handy | `build-handy.sh` | `handy-romdev-watchpoint.patch` | `romdev-core-handy` |
| C64 | vice (x64) | `build-vice.sh` | `vice-romdev-memory-regions.patch` | `romdev-core-vice` |
| PC Engine | geargrafx | `build-geargrafx.sh` | `geargrafx-romdev-memory-regions.patch` | `romdev-core-geargrafx` |
| MSX | bluemsx | `build-bluemsx.sh` | `bluemsx-romdev-memory-regions.patch`, `bluemsx-emscripten-build.patch` | `romdev-core-bluemsx` |
| Atari 2600 | stella2014 | `build-stella2014.sh` | `stella2014-romdev-memory-regions.patch` | `romdev-platform-atari2600` |
| SNES | snes9x | `build-snes9x.sh` | `snes9x-romdev-memory-regions.patch` | `romdev-platform-snes` |
| GBA | mgba | `build-mgba.sh` | `mgba-romdev-watchpoint.patch` | `romdev-platform-gba` |

**`romdev-core-*` vs `romdev-platform-*`:** a `core` package is just an emulator
core (often shared — gpgx serves 3 platforms, gambatte 2). A `platform` package
bundles a core **with the dedicated toolchain only that platform uses**, shipped
together because nothing else needs them: `romdev-platform-snes` = snes9x + asar +
tcc816 + wla-dx; `romdev-platform-gba` = mgba + arm-none-eabi-gcc; +
`romdev-platform-atari2600` = stella + dasm. (This split is documented in
`src/cores/registry.js` `CORES[].pkg`, the single source of truth for resolution.)

## Toolchains → packages

Toolchain recipes fetch `toolchains.<name>`, build to WASM, and stage into
`src/toolchains/<name>/wasm/`. ⚠ **Known asymmetry:** unlike the core recipes,
most toolchain recipes do NOT yet copy into their shipping package automatically —
the `romdev-toolchain-*/wasm/` copy is synced separately. (Worth unifying: give
each toolchain recipe the same `PKG_OUT` copy step the core recipes have.)

| Toolchain | Recipe | Ships in |
|---|---|---|
| cc65 (ca65/cc65/ld65/da65) | `build-cc65.sh` | `romdev-toolchain-cc65` |
| SDCC | `build-sdcc.sh` (+ `build-z80-binutils-wasm.sh`) | `romdev-toolchain-sdcc` |
| RGBDS | `build-rgbds.sh` | `romdev-toolchain-rgbds` |
| vasm (m68k) | `build-vasm68k.sh` | `romdev-toolchain-vasm` |
| m68k GCC + sjasm | `build-m68k-wasm-tools.sh`, `build-sjasm.sh` (toolchain built by `build-m68k-toolchain.sh`) | `romdev-toolchain-m68k-gcc` |
| asar (65816) | `build-asar.sh` | `romdev-platform-snes` |
| tcc816, wla-dx | `build-tcc816.sh`, `build-wladx.sh` | `romdev-platform-snes` |
| dasm | `build-dasm.sh` | `romdev-platform-atari2600` |
| arm-none-eabi-gcc | `build-arm-wasm-tools.sh` (toolchain by `build-arm-toolchain.sh`) | `romdev-platform-gba` |
| libtonc / libgba / maxmod | `build-libtonc.sh`, `build-libgba.sh`, `build-maxmod.sh` | GBA SDK libs (linked, ship as source/lib) |

## Analysis engine → packages

| Component | Recipe | Patch(es) | Ships in |
|---|---|---|---|
| Rizin (CFG / xrefs / functions) | `build-rizin.sh` | `rizin-romdev-emscripten.patch`, `rizin-libzip-emscripten.patch` | `romdev-analysis` |
| Ghidra decompiler + rz-ghidra + SLEIGH | `build-decompiler.sh` | (rz-ghidra/meson pins; SLEIGH specs pinned in `analysis.sleigh_specs.*`) | `romdev-analysis-decompiler` |

## Shared primitives (build no package directly)

Built once, consumed by the recipes above — they have no satellite package:

- `build-bison.sh`, `build-flex.sh`, `build-mcpp.sh` — host build tools.
- `build-m68k-toolchain.sh`, `build-arm-toolchain.sh` — native cross-toolchains
  the `*-wasm-tools` recipes wrap (newlib patches: `newlib-4.4.0-m68k-*.patch`).
- `build-genesis-libres.sh` — Genesis SGDK resource compiler bits.
- `build-sdcc-native-debug.sh` — a native SDCC for local debugging, not shipped.

## Orchestration

`build-all.sh` runs the toolchain recipes in order. Per-recipe usage is in each
script's header. To re-pin an upstream, edit [`versions.json`](./versions.json) —
never a `build-*.sh`. Emscripten itself is pinned in `build-image/Dockerfile`
(WASM isn't bit-reproducible across emcc versions, so an emsdk bump is deliberate).

_This map is hand-maintained; if you add a core/toolchain recipe, add its row._
