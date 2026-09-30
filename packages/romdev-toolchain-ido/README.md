# romdev-toolchain-ido

The IRIX IDO C compilers that N64 matching-decompilation projects build with,
as WASM, for romdev's decomp domain.

- `wasm/5.3/` and `wasm/7.1/`: one module per IRIX program (`cc`, `acpp`, `cfe`,
  `uopt`, `ugen`, `as0`, `as1`, `ujoin`, `uld`, `umerge`, `usplit`) plus the
  compiler's message catalog `err.english.cc`.

Built by `romdevtools/scripts/build-ido.sh`: the pinned
[ido-static-recomp](https://github.com/decompals/ido-static-recomp) (MIT)
statically recompiles each IRIX executable to C, and emcc compiles that C with
romdev's patch (`scripts/patches/ido-static-recomp-wasm.patch`: the WASM guest
memory model and a vfork-style fork so `cc` can run its passes as sibling
modules). The IRIX programs themselves remain the property of their owners; see
`ido/<version>/LICENSE.md` in the upstream repository.

- `wasm/armips.{mjs,wasm}`: [armips](https://github.com/Kingcom/armips) (MIT), the RSP/MIPS
  assembler decomp projects rebuild their RSP microcode with; built by
  `romdevtools/scripts/build-armips.sh` (patch `armips-wasm-single-thread.patch`).

romdev drives these modules from its isolated WASM worker; they are not a
general-purpose CLI.
