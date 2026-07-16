# Genesis C toolchain — pipeline overview

This directory will host the JS-side glue for the Genesis C build path
once the WASM artifacts ship. Pipeline shape:

```
                  ┌─── cc1 (WASM)    ──┐
   main.c ──────► │   m68k-elf-as (WASM)│ ──► .o ──► m68k-elf-ld (WASM) ──► ELF ──► objcopy ──► .bin
                  └─ JS driver orchestrates ─┘                            (Genesis raw ROM)
                                              ▲
                                              │ links against
                                              libgcc.a + libc.a (newlib) + libmd.a (SGDK)
                                              — all built natively as PURE target artifacts
                                              and shipped as binary blobs (no native code
                                              ever runs at user-build time).
```

## Status

- **Native cross-toolchain build (stage 1)**: in progress —
  `scripts/build-m68k-toolchain.sh` produces binutils + gcc + newlib +
  libgcc into `build/m68k-toolchain/install/`.
- **WASM port of cc1/as/ld (stage 2)**: pending.
- **SGDK native build against the cross-toolchain (stage 3)**: pending.
- **JS driver `buildGenesisC()`**: pending.
- **build({output:'rom'}) wiring**: pending.

## Why a 3-stage build

GCC's build is bootstrapping: gcc-the-binary builds libgcc.a using
gcc-the-binary, and libgcc.a is a TARGET artifact (m68k object file),
not a host one. Emscripten can't host the native gcc bootstrap because
gcc spawns its own subprocesses (cc1, as, ld) during the build.

Solution:
1. **Stage 1 (native)** builds the cross-toolchain on the build host.
   The output is a native Linux/Mac binary that produces m68k-elf
   objects. Plus libgcc.a, libc.a, crt0.o, etc. — pure target artifacts.
2. **Stage 2 (WASM)** re-compiles cc1, m68k-elf-as, m68k-elf-ld via
   emcc, sourcing from the same upstream gcc/binutils trees but
   building only the components users invoke at runtime. Each becomes
   a `Module` we can `callMain` on, identical to wla-65816 / tcc-65816
   from R15/R16/R18.
3. **Stage 3 (native against stage 1)** builds SGDK once on the build
   host using the native stage-1 toolchain. Output: `libmd.a` +
   `sega.s` (crt0) + `md.ld` (linker script) + the SGDK include tree.
   These are TARGET artifacts — they ship as binary blobs alongside
   our WASM tools and never re-build on user machines.

User builds (stage 4, at runtime) wire it together:
- JS driver calls cc1.wasm with the user's main.c → .s
- JS driver calls as.wasm with the .s → .o
- JS driver calls ld.wasm linking [crt0.o, user .o(s), libmd.a,
  libc.a, libgcc.a] against md.ld → main.elf
- JS driver calls objcopy.wasm with main.elf → main.bin (raw Genesis ROM)

The "fork/exec" problem that historically blocked gcc-in-the-browser
goes away because **we don't ship gcc-the-driver**. The driver is JS,
running in Node, orchestrating WASM tools via our existing worker pool
(R12). Each WASM tool sees a clean MEMFS, runs a single callMain,
returns its output.
