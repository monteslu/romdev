# romdev-analysis

Rizin, the reverse-engineering analysis engine (control-flow graphs,
cross-references, function detection), compiled to WebAssembly.

A binary package for [romdev](https://github.com/monteslu/romdev). It ships the
prebuilt WebAssembly and JS glue, and the main `romdevtools` package loads it on
demand for `disasm({target:'functions'|'cfg'|'xrefs'})`. You normally install
`romdevtools` (`npx romdevtools`), not this package directly.

## Upstream and license

Bundles: **rizin** v0.8.2 (https://github.com/rizinorg/rizin).

**License:** LGPL-3.0-only

This package redistributes the upstream source built to WebAssembly. The
upstream commit is pinned in `packages/romdevtools/scripts/versions.json` in the
romdev repo, and the repo's `NOTICE` has the full third-party inventory.

## CPU coverage used by romdev

6502 (NES, Atari 2600, Atari 7800, C64, Lynx), Z80 (SMS, Game Gear, MSX), SM83
(the `gb` plugin: Game Boy, GBC), ARM (GBA), M68K (Genesis), 65816 (the `snes`
plugin), MIPS (N64 big-endian, PS1 little-endian) and SH-4 (Dreamcast). Rizin
has no HuC6280 plugin, so PC Engine analysis uses the 6502 plugin: function and
control-flow results are approximate there, while `disasm({target:'decompile'})`
uses a proper HuC6280 SLEIGH spec from `romdev-analysis-decompiler`.

**Built by:** `packages/romdevtools/scripts/build-rizin.sh` with patches
`rizin-romdev-emscripten.patch` and `rizin-libzip-emscripten.patch`. See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
