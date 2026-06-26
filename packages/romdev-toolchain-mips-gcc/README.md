# romdev-toolchain-mips-gcc

The `mips-elf` GCC toolchain (binutils 2.42 + gcc 14.2.0 + newlib 4.4.0) compiled
to WASM, for romdev's **N64** (R4300, big-endian) and **PS1** (R3000, little-endian)
C builds and disassembly. One toolchain emits both endiannesses via `-EB`/`-EL`.

Built by `scripts/build-mips-toolchain.sh` (STAGE 1, native) + `build-mips-wasm-tools.sh`
(STAGE 2, WASM). Not vendored — fetched + built from pinned upstream (versions.json).
