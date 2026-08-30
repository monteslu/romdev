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
instead of the GBA's ARM7TDMI flags. That is why this package is ~1.2MB (almost
all of it libgcc) rather than the 155MB the compiler itself weighs.

A cart links **no libc** — the SDK is freestanding, so there is no `printf`, no
`malloc`, no `string.h`. It does link **libgcc**, which ships here as
`share/sync32/lib/libgcc.a`: the compiler emits calls into it for things the
CPU cannot do in one instruction, such as a 64-bit divide (`__aeabi_uldivmod`)
or double-precision float. It must be the **ARMv8-M** build — the ARM archives
in `romdev-platform-gba` are ARMv4T and are link-incompatible with a Cortex-M33
object — and it is built by `romdevtools/scripts/build-arm-libgcc-v8m.sh`.

Two consequences worth knowing when writing a cart:

- **Prefer `float` to `double`.** The FPU is single-precision only
  (`fpv5-sp-d16`), so a `double` compiles to soft-float library calls that are
  an order of magnitude slower.
- **Avoid 64-bit integer division in a hot loop** for the same reason: it is a
  library call, not an instruction.

Builds also pass `-ffreestanding`. Without it the compiler assumes a hosted
environment and may synthesize a `memset` call from a struct initializer, which
then cannot link.
