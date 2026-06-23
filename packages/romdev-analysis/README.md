# romdev-analysis

Rizin — reverse-engineering analysis engine (control-flow graphs, cross-
references, function detection), compiled to WebAssembly.

A binary package for [romdev](https://github.com/monteslu/romdev) — it ships the
prebuilt WebAssembly + JS glue and is resolved by the main `romdev` package on
demand. You normally install `romdev`, not this package directly.

## Upstream & license

Bundles: **rizin** (https://github.com/rizinorg/rizin).

**License:** LGPL-3.0-only

This package redistributes the upstream binary built to WebAssembly; the source
and exact pinned commit are recorded in romdev's `scripts/versions.json`, and
the build recipe is `scripts/build-rizin.sh` + `scripts/patches/rizin-*.patch`.

## CPU coverage used by romdev

6502 (NES / Atari 2600 / Atari 7800 / C64 / Lynx), Z80 (SMS / Game Gear / MSX),
SM83 (`gb` plugin — Game Boy / GBC), ARM (GBA), M68K (Genesis), 65816 (`snes`
plugin), SPC700. HuC6280 (PC Engine) analysis arrives with the rz-ghidra
decompiler package (SLEIGH spec).

**Built by:** `romdevtools/scripts/build-rizin.sh` + patch(es) `rizin-romdev-emscripten.patch`, `rizin-libzip-emscripten.patch`. See `scripts/BUILD_MAP.md` in the romdev repo for the full recipe→package map.
