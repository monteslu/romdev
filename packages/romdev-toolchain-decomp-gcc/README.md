# romdev-toolchain-decomp-gcc

The gcc toolchains N64 matching-decompilation projects pin, and the
command-line tools their builds run, as WASM, for romdev's decomp domain.

- `wasm/kmc-2.7.2/`: gcc 2.7.2 as shipped in the N64 SDK (KMC) - the driver
  `gcc`, the preprocessor `cpp` (cccp) and `cc1` - with the binutils 2.6
  assembler `as` it pairs with (including `--force-n64align`).
- `wasm/mips-linux-gnu-14.2/`: gcc 14.2.0 for target mips-linux-gnu (`gcc`,
  `cpp`, `cc1`), configured like Debian/Ubuntu's `gcc-mips-linux-gnu`: the
  modern cross gcc projects use for data-only TUs, `.s` preprocessing and
  linker scripts. It assembles with `mips-linux-gnu-as` from
  romdev-toolchain-mips-gcc. Built by `scripts/build-mips-linux-gcc-wasm.sh`
  (GPL-3.0) with `scripts/patches/gcc-14-driver-wasm-spawn.patch`.
- `wasm/tools/`: decompals' [slinky](https://github.com/decompals/slinky)
  (`slinky-cli`), [pigment64](https://github.com/decompals/pigment64) and
  [crunch64](https://github.com/decompals/crunch64) command-line tools (MIT),
  and `raw-deflate`, vanilla zlib's raw deflate (zlib license). Built by
  `scripts/build-decomp-rust-tools.sh` from the released sources.

Built by `romdevtools/scripts/build-decomp-gcc.sh` from the pinned
[decompals/mips-gcc-2.7.2](https://github.com/decompals/mips-gcc-2.7.2) and
[decompals/mips-binutils-2.6](https://github.com/decompals/mips-binutils-2.6)
(GPL-2.0), with `scripts/patches/kmc-gcc-2.7.2-wasm.patch` (the driver runs its
passes through romdev's spawn hook instead of fork/exec). Objects are verified
byte-identical to the natively built compilers on a real project.

romdev drives these modules from its isolated WASM worker; they are not a
general-purpose CLI.
