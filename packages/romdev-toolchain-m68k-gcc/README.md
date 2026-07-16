# romdev-toolchain-m68k-gcc

m68k-elf-gcc toolchain (cc1/as/ld/objcopy/objdump) for Sega Genesis C — and the
native m68k disassembler/reassembler behind `disassembleProject` — as
WebAssembly. Plus SGDK's Z80 tools (sjasm/bintos), the Genesis C library tree
(`share/genesis/lib/`: full SGDK + minimal runtime), and the full C build
pipeline:

```js
import { buildGenesisC, finalizeGenesisRom, parseBuildLog }
  from "romdev-toolchain-m68k-gcc";

const r = await buildGenesisC({ source: '#include <genesis.h>\nint main(){ ... }' });
const rom = finalizeGenesisRom(r.binary); // pad + $18E checksum (SGDK post-link)
```

One dep compiles everything for the target — an SDK or tool building Genesis
ROMs needs only this package (romdev's own server builds through the same
entry, so there is exactly one pipeline). `buildGenesisC` also accepts an
injected `env` (runTool / share manifest / hash / sdkCache / loadGlue) so the
identical pipeline runs in a browser Web Worker — see
`build/genesis-c/genesis-c.js` for the contract.

A binary package for [romdev](https://github.com/monteslu/romdev): it ships the
prebuilt WebAssembly + JS glue and is resolved by the main `romdev` package on
demand. Install `romdev` for the full dev suite, or this package alone for the
build pipeline.

## Upstream & license

Bundles: **m68k-elf-gcc, binutils**.

**License:** GPL-3.0-or-later with GCC Runtime Library Exception (does not encumber compiled ROMs).

This package redistributes the upstream binary built to WebAssembly; the source
is fetched from a pinned upstream commit at build time (see the romdev repo's
`scripts/versions.json` and `BUILDING.md`). See the romdev repo `NOTICE` for the
full third-party inventory.

**Built by:** `romdevtools/scripts/build-m68k-wasm-tools.sh + build-sjasm.sh` (no patch — built clean). See `scripts/BUILD_MAP.md` in the romdev repo for the full recipe→package map.
