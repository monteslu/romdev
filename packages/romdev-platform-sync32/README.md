# romdev-platform-sync32

The **sync32** SDK tree for [romdev](https://github.com/monteslu/romdev):
`crt0.S`, the `ram.ld` / `xip.ld` linker scripts, `sync32.h` and an ARMv8-M
`libgcc.a`.

sync32 is an open RP2350-based console. A game is a freestanding
**Cortex-M33** binary wrapped in a 64-byte header (`.s32`). Building one needs
the crt0 (vector table and `_start`), the linker script for the memory mode,
and the console API header. All of them are small text files, so they ship here
instead of requiring a checkout of the SDK.

`sync32.h` defines three video modes, chosen in the cart header: 320x240 (4:3),
320x180 (16:9 letterbox) and 128x128 (shown at 3x, for 128x128
fantasy-console games). Every mode draws 8-bit indices into a 256-entry RGB565
palette.

The **compiler is not in this package.** sync32 carts are built with the WASM
`arm-none-eabi` toolchain in `romdev-platform-gba`, the same gcc, run with
`-mcpu=cortex-m33 -mthumb -mfloat-abi=hard -mfpu=fpv5-sp-d16` instead of the
GBA's ARM7TDMI flags. That is why this package is about 1.2MB (almost all of it
libgcc) rather than the size of the compiler itself. romdevtools drives it for
`build({platform:'sync32'})`; you normally install `romdevtools`
(`npx romdevtools`).

A cart links **no libc**: the SDK is freestanding, so there is no `printf`, no
`malloc` and no `string.h`. It does link **libgcc**, shipped here as
`share/sync32/lib/libgcc.a`: the compiler emits calls into it for operations
the CPU cannot do in one instruction, such as a 64-bit divide
(`__aeabi_uldivmod`) or double-precision float. It must be the **ARMv8-M**
build: the ARM archives in `romdev-platform-gba` are ARMv4T and cannot link with
a Cortex-M33 object.

Two consequences when writing a cart:

- **Prefer `float` to `double`.** The FPU is single-precision only
  (`fpv5-sp-d16`), so a `double` compiles to soft-float library calls that are
  an order of magnitude slower.
- **Avoid 64-bit integer division in a hot loop** for the same reason: it is a
  library call, not an instruction.

Builds also pass `-ffreestanding`. Without it the compiler assumes a hosted
environment and may turn a struct initializer into a `memset` call, which then
cannot link.

## License

- The SDK files (`crt0.S`, linker scripts, `sync32.h`): MIT (the package's
  `license` field).
- `libgcc.a`: GPL-3.0-or-later with the GCC Runtime Library Exception, so
  linking it does not place conditions on a compiled cart.

**Built by:** `packages/romdevtools/scripts/build-arm-libgcc-v8m.sh` (the
libgcc build) in the romdev repo.
