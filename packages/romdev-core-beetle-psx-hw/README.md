# romdev-core-beetle-psx-hw

[Beetle PSX HW](https://github.com/libretro/beetle-psx-libretro) (Sony PlayStation, a
mednafen PSX fork) compiled to WebAssembly for romdev, with the **GLES3/WebGL2 hardware
renderer** so the PS1 GPU renders on the real GPU through native-gles — the same path as
the glide64 N64 build and Flycast Dreamcast.

Ships with **OpenBIOS embedded** (from [PCSX-Redux](https://github.com/grumpycoders/pcsx-redux),
MIT-licensed, region-free) — there is no copyrighted Sony BIOS to ship and no BIOS file to
supply. Built reproducibly by `romdevtools/scripts/build-beetle-psx-hw.sh`.
