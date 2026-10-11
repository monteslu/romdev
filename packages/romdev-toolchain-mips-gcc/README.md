# romdev-toolchain-mips-gcc

MIPS toolchains compiled to WebAssembly, for romdev's N64 and PS1 work:

- **mips-elf gcc 14.2.0 and binutils 2.42** (`cc1`, `mips-elf-as`,
  `mips-elf-ld`, `mips-elf-objcopy`, `mips-elf-objdump`): the C builds and
  disassembly for N64 (R4300, big-endian) and PS1 (R3000, little-endian). One
  toolchain emits both byte orders with `-EB` / `-EL`.
- **mips-linux-gnu binutils 2.46** (`mips-linux-gnu-as`, `-ld`, `-objcopy`,
  `-objdump`): the traditional-MIPS ELF tools N64 matching-decompilation
  projects assemble, link and objcopy with. The `mips-elf` tools cannot stand
  in for them, because their IRIX-compatible ELF output differs byte for byte.
  These modules use NODERAWFS (they read and write the real filesystem) and are
  driven by romdevtools' `decomp` tool and by `romdev-permuter`.
- **armips** (`wasm/armips.{mjs,wasm}`): the assembler N64 decomp projects
  rebuild their RSP microcode with, at the commit those projects pin.

A binary package for [romdev](https://github.com/monteslu/romdev). The main
`romdevtools` package loads it on demand for `build({platform:'n64'|'ps1'})`
and the `decomp` tool. You normally install `romdevtools` (`npx romdevtools`),
not this package directly.

## Upstream and license

- gcc and binutils: GPL-3.0-or-later (the package's `license` field).
- armips (https://github.com/Kingcom/armips): MIT.
- This package contains the compilers, binutils and armips only. The newlib C
  library (BSD-style licences) and libgcc (GPL with the GCC Runtime Library
  Exception) that N64 and PS1 builds link against ship with romdevtools;
  neither places conditions on a compiled ROM.

The upstream versions and commits are pinned in
`packages/romdevtools/scripts/versions.json` in the romdev repo, and the repo's
`NOTICE` has the full third-party inventory.

**Built by** (all in `packages/romdevtools/scripts/`):

- `build-mips-toolchain.sh` (native stage) and `build-mips-wasm-tools.sh`
  (WASM stage) for the mips-elf toolchain;
- `build-mips-linux-binutils-wasm.sh` for the mips-linux-gnu binutils;
- `build-armips.sh` with patch `armips-wasm-single-thread.patch` for armips.

See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
