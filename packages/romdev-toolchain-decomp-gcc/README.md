# romdev-toolchain-decomp-gcc

The gcc toolchains N64 matching-decompilation projects pin, as WASM, for
romdev's decomp domain.

- `wasm/kmc-2.7.2/`: gcc 2.7.2 as shipped in the N64 SDK (KMC) - the driver
  `gcc`, the preprocessor `cpp` (cccp) and `cc1` - with the binutils 2.6
  assembler `as` it pairs with (including `--force-n64align`).

Built by `romdevtools/scripts/build-decomp-gcc.sh` from the pinned
[decompals/mips-gcc-2.7.2](https://github.com/decompals/mips-gcc-2.7.2) and
[decompals/mips-binutils-2.6](https://github.com/decompals/mips-binutils-2.6)
(GPL-2.0), with `scripts/patches/kmc-gcc-2.7.2-wasm.patch` (the driver runs its
passes through romdev's spawn hook instead of fork/exec). Objects are verified
byte-identical to the natively built compilers on a real project.

romdev drives these modules from its isolated WASM worker; they are not a
general-purpose CLI.
