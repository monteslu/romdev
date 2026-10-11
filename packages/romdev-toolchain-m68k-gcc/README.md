# romdev-toolchain-m68k-gcc

The m68k-elf gcc toolchain (`cc1`, `as`, `ld`, `objcopy`, `objdump`) for Sega
Genesis C, as WebAssembly. The objdump also serves 68000 disassembly for
`disasm({target:'rom'})` and byte-exact `disasm({target:'project'})`, and the
`as`, `ld` and `objcopy` also build Genesis assembly: romdevtools translates
Motorola-syntax sources for them. The
package also carries SGDK's Z80 tools (`sjasm`, `bintos`), the Genesis C
library tree (`share/genesis/lib/`: SGDK and a minimal runtime) and the C build
pipeline:

```js
import { buildGenesisC, finalizeGenesisRom, parseBuildLog }
  from "romdev-toolchain-m68k-gcc";

const r = await buildGenesisC({ source: '#include <genesis.h>\nint main(){ ... }' });
const rom = finalizeGenesisRom(r.binary); // pad and write the $18E checksum (SGDK's post-link step)
```

An SDK or tool that builds Genesis ROMs needs only this package; romdevtools'
`build({platform:'genesis'})` goes through the same entry point.
`buildGenesisC` also accepts an injected `env` (runTool, share manifest, hash,
sdkCache, loadGlue) so the same pipeline runs in a browser Web Worker; see
`build/genesis-c/genesis-c.js` for the contract.

A binary package for [romdev](https://github.com/monteslu/romdev). The main
`romdevtools` package loads it on demand. Install `romdevtools`
(`npx romdevtools`) for the full tool set, or this package alone for the build
pipeline.

## Upstream and license

Bundles: **gcc 14.2.0, binutils 2.42 and newlib 4.4.0** for m68k-elf, and
**SGDK** (https://github.com/Stephane-D/SGDK) with its `sjasm` and `bintos`
tools.

**License:**

- gcc and binutils: GPL-3.0-or-later (the package's `license` field). libgcc
  carries the GCC Runtime Library Exception, and newlib uses BSD-style
  licences, so linking them does not place conditions on a compiled ROM.
- SGDK: MIT (`share/genesis/lib/sgdk/LICENSE`, with `COPYING.RUNTIME`).
- `sjasm` and `bintos` are built from SGDK's `tools/` tree at the pinned SGDK
  commit; `sjasm` keeps its original author's licence notice there.

This package redistributes the upstream source built to WebAssembly. The
upstream versions are pinned in `packages/romdevtools/scripts/versions.json` in
the romdev repo, and the repo's `NOTICE` has the full third-party inventory.

**Built by:** `packages/romdevtools/scripts/build-m68k-wasm-tools.sh` (the
native stage is `build-m68k-toolchain.sh`, with newlib patches
`newlib-4.4.0-m68k-ldbl-eq-dbl.patch` and
`newlib-4.4.0-m68k-bare-metal-system.patch`) and `build-sjasm.sh`. See
[BUILD_MAP.md](https://github.com/monteslu/romdev/blob/main/packages/romdevtools/scripts/BUILD_MAP.md)
for the recipe-to-package map.
