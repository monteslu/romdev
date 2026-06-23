# romdev-analysis-decompiler

Ghidra's decompiler — turns machine code into C-like pseudocode — compiled to
WebAssembly, with SLEIGH processor specifications for all 14 retro CPUs.

A binary package for [romdev](https://github.com/monteslu/romdev) — it ships the
prebuilt WebAssembly + compiled SLEIGH `.sla` tables and is resolved by the main
`romdev` package on demand (powers `disasm({target:'decompile'})`). You normally
install `romdev`, not this package directly.

## What's bundled

- `wasm/decompile.{js,wasm}` — Ghidra's standalone decompiler REPL, built from
  the Ghidra decompiler C++ (no JVM, no libbfd, no rizin) compiled to WASM.
- `sleigh/*.sla` + `.ldefs`/`.pspec`/`.cspec` — compiled processor tables for
  6502, 65C02, Z80, SM83, ARM (v4t), 68000, 65816, and HuC6280 — covering all
  14 romdev platforms.

## CPU → platform coverage

6502 (NES / Atari 2600 / Atari 7800 / C64), 65C02 (Lynx), Z80 (SMS / Game Gear /
MSX), SM83 (Game Boy / GBC), ARM7TDMI (GBA), 68000 (Genesis), 65816 (SNES),
HuC6280 (PC Engine). Decompiler quality is excellent on ARM/68000, good on
SM83/Z80, and rough on the 6502 family (an architecture limitation, not a bug).

## Licensing & attribution

Apache-2.0. This package redistributes **built artifacts only** (`.wasm`, `.sla`);
the source for each component is fetched on demand at the commit pinned in
romdev's `scripts/versions.json` and is never vendored here. Full per-component
attribution — including the Ghidra/NSA base (Apache-2.0), GhidraBoy (Apache-2.0),
ghidra-snes (MIT), and the HuC6280 spec (Apache-2.0 by derivation) — is in the
[NOTICE](./NOTICE) file.

**Built by:** `romdevtools/scripts/build-decompiler.sh` (no patch — built clean). See `scripts/BUILD_MAP.md` in the romdev repo for the full recipe→package map.
