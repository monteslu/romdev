# romdev-core-bluemsx

The [blueMSX](https://github.com/libretro/blueMSX-libretro) MSX / MSX2 libretro
core, compiled to WebAssembly for [romdev](https://github.com/monteslu/romdev).

Bundles **C-BIOS** (the open-source, BSD-licensed MSX BIOS) so cartridge
homebrew boots with no proprietary ROM.

License: BSD-3-Clause (blueMSX core + C-BIOS). Not intended for standalone use;
loaded by romdev's core registry.

**Built by:** `romdevtools/scripts/build-bluemsx.sh` + patch(es) `bluemsx-romdev-memory-regions.patch`, `bluemsx-emscripten-build.patch`. See `scripts/BUILD_MAP.md` in the romdev repo for the full recipe→package map.
