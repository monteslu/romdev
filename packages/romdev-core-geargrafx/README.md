# romdev-core-geargrafx

The [Geargrafx](https://github.com/drhelius/Geargrafx) PC Engine /
TurboGrafx-16 libretro core, compiled to WebAssembly for
[romdev](https://github.com/monteslu/romdev).

## Use

A binary package: the main `romdevtools` package loads it on demand for
`loadMedia({platform:'pce'})`. You normally install `romdevtools`
(`npx romdevtools`), not this package directly.

## License

GPL-3.0-or-later (Geargrafx). The upstream commit is pinned in
`packages/romdevtools/scripts/versions.json` in the romdev repo.

**Built by:** `packages/romdevtools/scripts/build-geargrafx.sh` with patch
`geargrafx-romdev-memory-regions.patch`. See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
