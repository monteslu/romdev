# Genesis C build pipeline

`genesis-c.js` exports `buildGenesisC()` and `finalizeGenesisRom()`, the C
build path for Sega Genesis ROMs. Each stage is a WebAssembly tool from this
package, run in its own worker, so a crash in one stage cannot take down the
caller:

```
main.c --cc1--> main.s --as--> main.o --ld--> main.elf --objcopy--> main.bin
                                        ^
                                        | links against
             crt0 + libmd.a (SGDK) or a minimal runtime, libc.a, libm.a (newlib), libgcc.a
```

No native code runs at build time. The JS driver orchestrates the WASM tools in
place of gcc's own driver, so gcc's fork/exec of its passes is not needed. The
target libraries (`libgcc.a`, newlib's `libc.a` and `libm.a`, SGDK's runtime)
are prebuilt target artifacts under `share/genesis/lib/`. SGDK's `libmd.a`
ships as a prebuilt seed built from the bundled SGDK source; pass
`rebuildSdk: true` to compile it from source instead (cached by source hash).
If the SGDK source no longer matches the seed and no rebuild was asked for, the
result carries an `sdkEditIgnored` warning naming the changed file.

## Two runtime modes

- `sgdk: true` (default): links the bundled SGDK runtime (`libmd.a`, the
  `sega.s` crt0, the `md.ld` linker script and the SGDK header tree), so
  `#include <genesis.h>` works and the standard SGDK API (`VDP_drawText`,
  `SYS_doVBlankProcess`, `SPR_addSprite` and the rest) is available.
- `sgdk: false`: gcc, newlib and libgcc only, with a small `sega.s` and
  `genesis.ld`. The program drives the VDP registers directly.

## Running outside Node

Pass `env` to run the same pipeline in a browser Web Worker. Every seam is
optional; omitting `env` uses the Node defaults (worker pool and file reads):

- `env.runTool`: runs the gcc tools (see `common/gcc-toolchain.js`, `ToolJob`).
- `env.loadGlue`: the sjasm and bintos module factories (see `sjasm/sjasm.js`).
- `env.share`: the `share/genesis/lib` tree as a `{relPath: string|Uint8Array}`
  manifest; stage it with `common/share-fs.js` `buildShareManifest` so the key
  order matches Node's (it determines compile order, archive member order and
  so the ROM bytes).
- `env.hash`: an async `{name: text} -> hex digest` used for the SDK seed check
  (required when `env` is given; in a browser, `crypto.subtle`).
- `env.sdkCache`: an optional `{get(key), put(key, bytes)}` cache for the
  rebuilt SDK archive.

`finalizeGenesisRom(binary)` pads the ROM and writes the header checksum at
`$18E`, SGDK's post-link step.
