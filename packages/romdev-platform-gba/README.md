# romdev-platform-gba

Game Boy Advance bundle, as WebAssembly: the mGBA emulator core and the
arm-none-eabi-gcc toolchain (`cc1`, `as`, `ld`, `objcopy`, `objdump`). The
objdump also serves ARM/Thumb disassembly for `disasm({target:'rom'})` and
byte-exact `disasm({target:'project'})`. The package also carries the GBA C
library tree (`share/gba/lib/`: libtonc, libgba, maxmod, sysbase, crt0s, linker
scripts, ARM target archives) and the C build pipeline:

```js
import { buildGbaC, parseBuildLog } from "romdev-platform-gba";

const r = await buildGbaC({ source: '#include <tonc.h>\nint main(){ ... }' });
// r.binary is a .gba ROM; r.log (or parseBuildLog(r.log)) lists any issues
```

An SDK or tool that builds GBA ROMs needs only this package; romdevtools'
`build({platform:'gba'})` goes through the same entry point. `buildGbaC` also
accepts an injected `env` (runTool, share manifest, hash, sdkCache) so the same
pipeline runs in a browser Web Worker; see `build/gba-c/gba-c.js` for the
contract.

A binary package for [romdev](https://github.com/monteslu/romdev). The main
`romdevtools` package loads it on demand. Install `romdevtools`
(`npx romdevtools`) for the full tool set, or this package alone for the build
pipeline.

## Upstream and license

Bundles: **mGBA** (https://github.com/libretro/mgba) and **arm-none-eabi gcc
14.2.0 with binutils 2.42 and newlib 4.4.0**.

**License:**

- mGBA: MPL-2.0 (the package's `license` field).
- gcc and binutils: GPL-3.0-or-later. libgcc carries the GCC Runtime Library
  Exception, and newlib uses BSD-style licences, so linking them does not place
  conditions on a compiled ROM.
- Libraries in `share/gba/lib/` keep their own licences: libgba (LGPL with a
  static-linking exception; it asks that a program credit the devkitPro
  project; `libgba/LICENSE`), maxmod (ISC, `maxmod/LICENSE-MAXMOD`), the
  devkitPro crt0 (MPL-2.0) and libtonc (MIT, `libtonc/LICENSE`; the upstream
  release has no licence file, and the author confirmed MIT to the gbadev-org
  fork, which added this one).

This package redistributes the upstream source built to WebAssembly. The
upstream versions are pinned in `packages/romdevtools/scripts/versions.json` in
the romdev repo, and the repo's `NOTICE` has the full third-party inventory.

**Built by:** `packages/romdevtools/scripts/build-mgba.sh` (patch
`mgba-romdev-watchpoint.patch`) and `build-arm-wasm-tools.sh` (toolchain built
by `build-arm-toolchain.sh`). See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
