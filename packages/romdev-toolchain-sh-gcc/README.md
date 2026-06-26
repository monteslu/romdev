# romdev-toolchain-sh-gcc

The `sh-elf` GCC toolchain (gcc 14.2.0 + binutils 2.42 + newlib 4.4.0) compiled to
WebAssembly, for romdev **Sega Dreamcast (SH-4)** C builds and disassembly.

Ships `cc1` (the C frontend), `sh-elf-as`, `sh-elf-ld`, `sh-elf-objcopy`, and
`sh-elf-objdump` as Emscripten ESM modules. The SH-4 is little-endian with
`m4-single-only` floating point; one toolchain emits all Dreamcast code.

Used by `romdevtools` to drive `build({platform:"dreamcast"})`: cc1 → as → ld produce
an ELF that Flycast's reios HLE BIOS boots directly (no GD-ROM image or firmware).

Built from source by `romdevtools/scripts/build-sh-wasm-tools.sh`.
