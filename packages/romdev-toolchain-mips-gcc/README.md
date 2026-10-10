# romdev-toolchain-mips-gcc

The `mips-elf` GCC toolchain (binutils 2.42 + gcc 14.2.0 + newlib 4.4.0) compiled
to WASM, for romdev's **N64** (R4300, big-endian) and **PS1** (R3000, little-endian)
C builds and disassembly. One toolchain emits both endiannesses via `-EB`/`-EL`.

It also ships **mips-linux-gnu binutils 2.46** (`mips-linux-gnu-{as,ld,objcopy,objdump}`),
the traditional-MIPS ELF vectors N64 matching-decompilation projects assemble,
link and objcopy with (the IRIX-compatible `mips-elf` vector writes different
object bytes). Those are linked with NODERAWFS and driven by romdevtools'
decomp domain; built by `scripts/build-mips-linux-binutils-wasm.sh`.

It also ships **armips** (`wasm/armips.{mjs,wasm}`, MIT), the assembler N64
decomp projects rebuild their RSP microcode with; built by `scripts/build-armips.sh`.

Built by `scripts/build-mips-toolchain.sh` (STAGE 1, native) + `build-mips-wasm-tools.sh`
(STAGE 2, WASM). Not vendored - fetched + built from pinned upstream (versions.json).
