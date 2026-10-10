# romdev-toolchain-ido

**Not published.** IDO is SGI's proprietary compiler, so romdev never ships it.
This package exists in the repository only as the place a checkout builds it
into; it is marked private and npm will not publish it.

The IRIX IDO C compilers that N64 matching-decompilation projects build with,
as WASM, for romdev's decomp domain:

- `wasm/5.3/` and `wasm/7.1/`: one module per IRIX program (`cc`, `acpp`, `cfe`,
  `uopt`, `ugen`, `as0`, `as1`, `ujoin`, `uld`, `umerge`, `usplit`) plus the
  compiler's message catalog `err.english.cc`.

To use it, build it yourself from a romdev checkout with
`romdevtools/scripts/build-ido.sh`: the pinned
[ido-static-recomp](https://github.com/decompals/ido-static-recomp) (MIT)
statically recompiles each IRIX executable to C, and emcc compiles that C with
romdev's patch (`scripts/patches/ido-static-recomp-wasm.patch`: the WASM guest
memory model and a vfork-style fork so `cc` can run its passes as sibling
modules). The IRIX programs themselves remain the property of their owners; see
`ido/<version>/LICENSE.md` in the upstream repository.

A romdev checkout finds the built modules here on its own. An installed
romdevtools finds them through `ROMDEV_IDO_DIR`, set to a directory holding the
`5.3/` and `7.1/` folders.
