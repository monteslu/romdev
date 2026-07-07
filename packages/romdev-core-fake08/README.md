# romdev-core-fake08

The [FAKE-08](https://github.com/jtothebell/fake-08) libretro core — an open-source
(MIT) PICO-8 player — compiled to WASM for [romdev](https://github.com/monteslu/romdev).

FAKE-08 is a clean-room reimplementation, **not** Lexaloffle's PICO-8, and needs **no
BIOS**. It runs `.p8` (Lua source carts) and `.p8.png` (carts embedded in a label PNG)
at PICO-8's native 128×128 / 16-color / 6-button surface.

This package ships only the built `.js` + `.wasm`; romdev's core registry resolves it via
`import("romdev-core-fake08")` → `core.jsPath` / `core.wasmPath`.

## License

The core is MIT (FAKE-08 + z8lua). Individual PICO-8 carts carry their own licenses —
respect them. See the [romdev NOTICE](https://github.com/monteslu/romdev/blob/main/NOTICE).
