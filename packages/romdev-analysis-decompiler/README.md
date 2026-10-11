# romdev-analysis-decompiler

Ghidra's decompiler, which turns machine code into C-like pseudocode, compiled
to WebAssembly, with SLEIGH processor specifications for the CPUs romdev's
platforms use.

A binary package for [romdev](https://github.com/monteslu/romdev). It ships the
prebuilt WebAssembly and compiled SLEIGH `.sla` tables, and the main
`romdevtools` package loads it on demand for `disasm({target:'decompile'})`.
You normally install `romdevtools` (`npx romdevtools`), not this package
directly.

## What's bundled

- `wasm/decompile.{js,wasm}`: Ghidra's standalone decompiler, built from the
  Ghidra decompiler C++ (no JVM, no libbfd, no rizin) and compiled to WASM.
- `sleigh/*.sla` with `.ldefs`/`.pspec`/`.cspec`: compiled processor tables
  for 6502, 65C02, Z80, SM83, ARM (v4T), 68000, 65816, HuC6280, MIPS32 (both
  endians) and SH-4.

## CPU to platform coverage

6502 (NES, Atari 2600, Atari 7800, C64), 65C02 (Lynx), Z80 (SMS,
Game Gear, MSX), SM83 (Game Boy, GBC), ARM7TDMI (GBA), 68000 (Genesis), 65816
(SNES), HuC6280 (PC Engine), MIPS (N64, PS1) and SH-4 (Dreamcast).
Pseudocode reads best on ARM and 68000 code, well on SM83 and Z80, and roughly
on the 6502 family, where 8-bit idioms such as carry-chained 16-bit math do not
map cleanly to C (a property of the architecture, not a bug).

## Licensing and attribution

Apache-2.0. This package redistributes built artifacts only (`.wasm`, `.sla`).
The source for each component is fetched at the commit pinned in
`packages/romdevtools/scripts/versions.json` in the romdev repo and is not
vendored here. Per-component attribution, including the Ghidra base
(Apache-2.0), GhidraBoy (Apache-2.0), ghidra-snes (MIT) and the HuC6280 spec
(Apache-2.0 by derivation), is in the [NOTICE](./NOTICE) file.

**Built by:** `packages/romdevtools/scripts/build-decompiler.sh` (no patches).
See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
