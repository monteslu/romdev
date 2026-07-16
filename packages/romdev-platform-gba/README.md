# romdev-platform-gba

Game Boy Advance bundle: mGBA emulator core + arm-none-eabi-gcc toolchain
(cc1/as/ld/objcopy/objdump) — the objdump also powers ARM/Thumb `disassembleRom` +
byte-exact `disassembleProject` — as WebAssembly. Plus the GBA C library tree
(`share/gba/lib/`: libtonc, libgba, maxmod, sysbase, crt0s, ld scripts, ARM
target archives) and the full C build pipeline:

```js
import { buildGbaC, parseBuildLog } from "romdev-platform-gba";

const r = await buildGbaC({ source: '#include <tonc.h>\nint main(){ ... }' });
// r.binary is a hardware-valid .gba ROM; r.log / parseBuildLog(r.log) for issues
```

One dep compiles everything for the target — an SDK or tool building GBA ROMs
needs only this package (romdev's own server builds through the same entry, so
there is exactly one pipeline). `buildGbaC` also accepts an injected `env`
(runTool / share manifest / hash / sdkCache) so the identical pipeline runs in
a browser Web Worker — see `build/gba-c/gba-c.js` for the contract.

A binary package for [romdev](https://github.com/monteslu/romdev): it ships the
prebuilt WebAssembly + JS glue and is resolved by the main `romdev` package on
demand. Install `romdev` for the full dev suite, or this package alone for the
build pipeline.

## Upstream & license

Bundles: **mGBA, arm-none-eabi-gcc**.

**License:** mGBA: MPL-2.0. arm-none-eabi-gcc/binutils: GPL-3.0 with GCC Runtime Library Exception (does not encumber compiled ROMs).

This package redistributes the upstream binary built to WebAssembly; the source
is fetched from a pinned upstream commit at build time (see the romdev repo's
`scripts/versions.json` and `BUILDING.md`). See the romdev repo `NOTICE` for the
full third-party inventory.

**Built by:** `romdevtools/scripts/build-mgba.sh + build-arm-wasm-tools.sh` + patch(es) `mgba-romdev-watchpoint.patch`. See `scripts/BUILD_MAP.md` in the romdev repo for the full recipe→package map.
