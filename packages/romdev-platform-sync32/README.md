# romdev-platform-sync32

The **sync32** SDK tree for [romdev](https://github.com/monteslu/romdev):
`crt0.S`, the `ram.ld` / `xip.ld` linker scripts, and `sync32.h`.

sync32 is monteslu's RP2350 console. A game is a freestanding **Cortex-M33**
binary wrapped in a 64-byte header (`.s32`). Building one needs the crt0 (vector
table + `_start`), the linker script for the memory mode, and the console API
header — all small, all text, so they ship here instead of requiring a checkout
of the SDK next door.

The **compiler is not in this package.** sync32 carts are built with the WASM
`arm-none-eabi` toolchain already shipped in `romdev-platform-gba` — the same
gcc, asked for `-mcpu=cortex-m33 -mthumb -mfloat-abi=hard -mfpu=fpv5-sp-d16`
instead of the GBA's ARM7TDMI flags. That is why this package is a few KB.

A cart links with **no libraries**: the SDK is freestanding and a built cart has
no undefined symbols and no libgcc helpers.
