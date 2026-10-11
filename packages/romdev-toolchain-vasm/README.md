# romdev-toolchain-vasm

vasm (m68k, Motorola syntax) - Sega Genesis assembler, as WebAssembly.

A binary package for [romdev](https://github.com/monteslu/romdev). It ships the
prebuilt WebAssembly and JS glue, and the main `romdevtools` package loads it on
demand. You normally install `romdevtools` (`npx romdevtools`), not this package
directly.

## Upstream and license

Bundles: **vasm** (m68k CPU module, Motorola syntax), http://sun.hasenbraten.de/vasm/.

**License:** the vasm license (Volker Barthelmann, Frank Wille). In summary:
the upstream archive may be redistributed unmodified and used for
non-commercial purposes; commercial use needs the authors' written consent,
except for M68k code targeting AmigaOS. Read the full terms in `doc/vasm.texi`
of the upstream archive before using this package commercially.

This package redistributes the upstream source built to WebAssembly. Upstream
publishes only a rolling tarball, so it is pinned by sha256 in `packages/romdevtools/scripts/versions.json` in the
romdev repo, and the repo's `NOTICE` has the full third-party inventory.

**Built by:** `packages/romdevtools/scripts/build-vasm68k.sh` (no patches). See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
