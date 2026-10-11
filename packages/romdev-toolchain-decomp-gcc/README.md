# romdev-toolchain-decomp-gcc

The gcc toolchains that N64 and PS1 matching-decompilation projects pin, and the
command-line tools their builds run, as WebAssembly, for romdevtools' `decomp`
tool.

- `wasm/kmc-2.7.2/`: gcc 2.7.2 as shipped in the N64 SDK (KMC): the driver
  `gcc`, the preprocessor `cpp` (cccp) and `cc1`, with the binutils 2.6
  assembler `as` it pairs with (including `--force-n64align`). Built from
  [decompals/mips-gcc-2.7.2](https://github.com/decompals/mips-gcc-2.7.2) and
  [decompals/mips-binutils-2.6](https://github.com/decompals/mips-binutils-2.6)
  (GPL-2.0) with `kmc-gcc-2.7.2-wasm.patch` (the driver runs its passes through
  romdev's spawn hook instead of fork/exec) and `kmc-binutils-2.6-wasm.patch`
  (lays out obstack chunks and frags as the reference x86_64 build does, so gas
  splits frags at the same places).
- `wasm/egcs-1.1.2/`: EGCS 1.1.2 (gcc 2.91.66) for mips-linux (`gcc`, `cpp`
  (cccp), `cc1`) with its binutils 2.9.5 assembler `as`: the compiler N64
  decomp projects build their iQue (China) versions with. Built from
  [decompals/mips-gcc-egcs-2.91.66](https://github.com/decompals/mips-gcc-egcs-2.91.66)
  and [decompals/mips-binutils-egcs-2.9.5](https://github.com/decompals/mips-binutils-egcs-2.9.5)
  (GPL-2.0) with `egcs-1.1.2-wasm.patch` and `egcs-binutils-2.9.5-wasm.patch`.
- `wasm/psx-gcc-2.6.3/`: gcc 2.6.3 for the PlayStation (`gcc`, `cc1`, `cpp`),
  built with the steps of [decompals/old-gcc](https://github.com/decompals/old-gcc)'s
  `gcc-2.6.3-psx` recipe (the `cc1-psx-26` that PS1 decomp projects run
  directly), plus the driver with `psx-gcc-2.6.3-wasm.patch` (spawn hook, a
  `sys_errlist` built from strerror, `-EL` for its mips-linux-gnu `as` step).
  The build's generators are compiled with emcc too and run under Node. The
  projects' assembly post-processor, maspsx, is ported to JS in romdevtools.
- `wasm/mips-linux-gnu-14.2/`: gcc 14.2.0 for target mips-linux-gnu (`gcc`,
  `cpp`, `cc1`), configured like Debian's `gcc-mips-linux-gnu` (trixie,
  14.2.0-13cross1): the modern cross gcc projects use for data-only translation
  units, `.s` preprocessing and linker scripts. It assembles with
  `mips-linux-gnu-as` from `romdev-toolchain-mips-gcc`. Built with
  `gcc-14-driver-wasm-spawn.patch` and Debian's distro specs
  (`gcc-14-debian-distro-specs.patch`). Like Debian's cross cpp it pre-includes
  glibc's `stdc-predef.h`, shipped at `mips-linux-gnu/include/` from Debian's
  libc6-dev-mips-cross (LGPL-2.1-or-later). romdev runs the driver with
  `GCC_EXEC_PREFIX=<this dir>/lib/gcc/`.
- `wasm/tools/`: decompals' [slinky](https://github.com/decompals/slinky)
  (`slinky-cli`), [pigment64](https://github.com/decompals/pigment64) and
  [crunch64](https://github.com/decompals/crunch64) command-line tools (MIT),
  and `raw-deflate`, vanilla zlib's raw deflate (zlib license).
- `wasm/tools/psx-str`, `psx-disk`, `psx-assets`: a PS1 decomp project's own
  setup tools (a string encoder in Rust, a disc image extractor and an asset
  tool in Go), built from that project's repository at the commit pinned in
  `versions.json` (AGPL-3.0). The Go tools are wasip1 modules run under
  `node:wasi`. romdev builds all three from a rewritten copy of the source
  that carries none of the game's text: names the tools need (project file
  paths, env vars, the console-port file lists, the disc's volume
  identifiers) are read at run time from the project and its original disc
  image, and objdiff progress labels are the overlay codes. Extracted and
  built assets and rebuilt disc images are unchanged.

Objects these compilers emit are compared byte for byte against the natively
built compilers over full project builds. romdev drives the modules from its
isolated WASM worker; they are not a general-purpose CLI. You normally install
`romdevtools` (`npx romdevtools`), not this package directly.

## Upstream and license

GPL-2.0-or-later (the old gcc and binutils trees), GPL-3.0-or-later (gcc 14.2),
LGPL-2.1-or-later (`stdc-predef.h`), AGPL-3.0-only (the PS1 project's setup
tools), MIT (slinky, pigment64, crunch64) and Zlib (`raw-deflate`). The
upstream commits and tarballs are pinned in
`packages/romdevtools/scripts/versions.json` in the romdev repo; the patches
are in `packages/romdevtools/scripts/patches/`, and the source rewrites
in `packages/romdevtools/scripts/src/decomp-go-wasip1/` (Go tools) and
`packages/romdevtools/scripts/src/psx-str/` (string encoder).

**Built by** (all in `packages/romdevtools/scripts/`):

- `build-decomp-gcc.sh` (`kmc`, `egcs` and `psx` targets) for the old gcc
  toolchains;
- `build-mips-linux-gcc-wasm.sh` for gcc 14.2;
- `build-decomp-rust-tools.sh` for slinky, pigment64, crunch64, raw-deflate and
  the Rust string encoder;
- `build-decomp-go-tools.sh` for the Go setup tools.

See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
