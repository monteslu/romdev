# romdev-core-bluemsx

The [blueMSX](https://github.com/libretro/blueMSX-libretro) MSX / MSX2 libretro
core, compiled to WebAssembly for [romdev](https://github.com/monteslu/romdev).

It bundles **C-BIOS** (https://cbios.sourceforge.net), an open-source MSX BIOS,
in `bios/Machines/`, so cartridge homebrew boots with no proprietary ROM.
romdev's host points the core at that tree automatically.

## Use

A binary package: the main `romdevtools` package loads it on demand for
`loadMedia({platform:'msx'})`. You normally install `romdevtools`
(`npx romdevtools`), not this package directly.

## License

- blueMSX: the blueMSX license, a permissive zlib-style license for the code
  the blueMSX team wrote. Some upstream source files come from other projects
  under their own terms, including GPL sound-chip code from openMSX and
  fMSX-SDL; see `license.txt` in the upstream repository.
- C-BIOS: BSD (2-clause). Its copyright and license text ship beside the ROMs
  in each machine folder as `cbios.txt`, as its binary-redistribution clause
  requires.

The upstream commit is pinned in `packages/romdevtools/scripts/versions.json`
in the romdev repo.

**Built by:** `packages/romdevtools/scripts/build-bluemsx.sh` with patches
`bluemsx-romdev-memory-regions.patch` and `bluemsx-emscripten-build.patch`. See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
