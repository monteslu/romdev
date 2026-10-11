# romdev-toolchain-sh-gcc

The sh-elf gcc toolchain (gcc 14.2.0, binutils 2.42) compiled to WebAssembly,
for romdev's Sega Dreamcast (SH-4) C builds and disassembly.

It ships `cc1` (the C front end), `sh-elf-as`, `sh-elf-ld`, `sh-elf-objcopy`
and `sh-elf-objdump` as Emscripten ES modules. The SH-4 runs little-endian with
`-m4-single-only` floating point, and one toolchain emits all Dreamcast code.

romdevtools uses it for `build({platform:'dreamcast'})`: cc1, as and ld produce
an ELF that the Flycast core's reios HLE BIOS boots directly, with no GD-ROM
image or firmware. You normally install `romdevtools` (`npx romdevtools`), not
this package directly.

## License

gcc and binutils: GPL-3.0-or-later. This package contains the compiler and
binutils only. The newlib C library (BSD-style licences) and libgcc (GPL with
the GCC Runtime Library Exception) that Dreamcast builds link against ship with
romdevtools; neither places conditions on a compiled program.

**Built by:** `packages/romdevtools/scripts/build-sh-wasm-tools.sh` (the native
stage, which also builds newlib 4.4.0 and libgcc, is `build-sh-toolchain.sh`).
See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
