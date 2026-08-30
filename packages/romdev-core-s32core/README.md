# romdev-core-s32core

The **sync32** console core for [romdev](https://github.com/monteslu/romdev),
bundled as WASM.

sync32 is monteslu's RP2350 console: games are Cortex-M33 ARM binaries shipped
as `.s32` files. `s32core` is a first-party pure-C interpreter for it, exposed
through the libretro API — the same shape as every other romdev core, so the
host runs it with no special-casing.

Built with **NODERAWFS**: the frontend `fopen()`s the `.s32` by its real path
and streams the game's `<romname>/` data directory straight off the host
filesystem, rather than preloading it into MEMFS. A cart with resources
therefore reads them from disk exactly as it does on hardware.

This package ships built artifacts only. The core's source lives in its own
repository, and romdev's `scripts/build-s32core.sh` compiles it here.

## Use

```js
import { core, platform } from "romdev-core-s32core";
// → { name: "s32core", jsPath: "…/s32core_libretro.js", wasmPath: "…/…wasm" }
```

Normally you do not import this directly — romdev's core registry resolves it
by platform id (`sync32`).
