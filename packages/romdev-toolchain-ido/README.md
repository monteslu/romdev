# romdev-toolchain-ido

**Not published.** IDO is SGI's proprietary IRIX C compiler. romdev does not
distribute it, and no romdev npm package contains it. This package is marked
private, so npm will not publish it; it exists in the romdev repository only as
the folder a local build writes into.

## What a local build produces

The IRIX IDO 5.3 and 7.1 C compilers that N64 matching-decompilation projects
build with, as WebAssembly, for romdevtools' `decomp` tool:

- `wasm/5.3/` and `wasm/7.1/`: one module per IRIX program (`cc`, `acpp`,
  `cfe`, `uopt`, `ugen`, `as0`, `as1`, `ujoin`, `uld`, `umerge`, `usplit`),
  plus the compiler's message catalog `err.english.cc`.

## Getting IDO

Build it yourself from a romdev checkout with
`packages/romdevtools/scripts/build-ido.sh`. The script fetches the pinned
[ido-static-recomp](https://github.com/decompals/ido-static-recomp) (MIT),
which statically recompiles each IRIX executable to C, then compiles that C
with emcc and romdev's patch `ido-static-recomp-wasm.patch` (the WASM memory
model and a vfork-style fork so `cc` can run its passes as sibling modules).

A romdev checkout finds the built modules in this folder on its own. An
installed `romdevtools` finds them through `ROMDEV_IDO_DIR`, set to a directory
holding the `5.3/` and `7.1/` folders.

## License

This package grants no rights to IDO. The IRIX programs are SGI's proprietary
software and remain the property of their owners; nothing produced here is
redistributable. See `ido/<version>/LICENSE.md` in the ido-static-recomp
repository. The recompiler itself is MIT, and romdev's build script and patch
are MIT.
