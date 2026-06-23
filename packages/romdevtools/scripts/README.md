# Build scripts

> **Which recipe builds which package?** See [`BUILD_MAP.md`](./BUILD_MAP.md) —
> the recipe ↔ binary-package map (e.g. `build-fceumm.sh` + its patch →
> `romdev-core-fceumm`). The reverse pointer is in each satellite package's
> README ("Built by:").
>
> **Adding a new platform?** Read [`../BUILDING.md`](../BUILDING.md) first.
> It's the single source of truth for the platform × core × patch × region-ID
> matrix + the "how to add a platform without breaking the others" recipe.
> Per-script details live here; the cross-cutting plan lives there.

These rebuild every bundled WASM artifact from upstream source, staging into
`src/cores/wasm/` and `src/toolchains/*/wasm/` (gitignored dev-staging dirs) and
copying into the shipping binary package's `wasm/` (see `BUILD_MAP.md`).

You only need to run them if you're:

- Updating a toolchain to a newer upstream version.
- Verifying reproducibility.
- Adding a new platform.

End users of romdev do not run these — the prebuilt `.wasm` files ship in the
per-platform binary packages (`romdev-core-*` / `romdev-platform-*` /
`romdev-analysis*`), pulled in as dependencies.

## Prerequisites

- **emsdk** (Emscripten ≥ 3.1) — set `EMSDK_ENV` or run `source $EMSDK/emsdk_env.sh`.
- **bison ≥ 3.0** and **flex ≥ 2.6**. If your distro doesn't have them, the
  scripts can build them locally first via `build-bison.sh` and `build-flex.sh`.
- **cmake ≥ 3.16**, **make**, **git**, **curl**.

## One-shot rebuild of everything

```
./scripts/build-all.sh
```

This will:
1. Build local bison + flex into `build/bison/install` and `build/flex/install`
   if not already present.
2. Clone every upstream toolchain into `build/<name>/src`.
3. Build the Emscripten version with our standard flags.
4. Copy the resulting `.{js,wasm}` into `src/toolchains/<name>/wasm/`.
5. Run the test suite to verify everything still works.

## Per-toolchain rebuild

```
./scripts/build-dasm.sh        # Atari 2600 (6502/6507)
./scripts/build-cc65.sh        # cc65 + ca65 + ld65 + da65 (6502 / 65816 / huc6280)
./scripts/build-asar.sh        # SNES (65816)
./scripts/build-vasm68k.sh     # Genesis (68k)
./scripts/build-rgbds.sh       # Game Boy / GBC (sm83 asm path — opt-in via language:"asm")
./scripts/build-sdcc.sh        # Z80 + SM83 + ez80 family — Game Boy (default C path), SMS, GG, MSX, ColecoVision, ZX (also pulls build-mcpp.sh). Native pass requires system bison + flex.
./scripts/build-mcpp.sh        # mcpp 2.7.2 — chained preprocessor for sdcc (bypasses Emscripten's no-fork limit)
./scripts/build-sdcc-native-debug.sh  # Debuggable native sdcc (-O0 -g3 -ggdb) for gdb investigation
                                       # of SDCC codegen bugs. Doesn't touch production WASM. See BUILDING.md.
```

**SDCC pre-flight linter:** `src/toolchains/sdcc/preflight-lint.js` runs
on every C source before `sdcc` is invoked. Catches C89 violations
(mid-block declarations, C99 inline for-loop counters) with correct
file:line — SDCC's own error messages for these are misleading. See
[`../src/platforms/gb/lib/c/SDCC_GOTCHAS.md`](../src/platforms/gb/lib/c/SDCC_GOTCHAS.md).

The previous incarnation of the linter flagged a big catalog of
"register-pressure crash patterns" — those were symptoms of the
emscripten 64 KB stack overflowing past `__data_end` and zeroing
`sm83_regs[]`. Fixed at the build level on 2026-05-25 with
`-s STACK_SIZE=8388608` in `_lib.sh`'s `EM_CLI_FLAGS`. Those checks
are gone from the linter.

**`unroll.h` — no longer in use:**
[`../src/platforms/gb/lib/c/unroll.h`](../src/platforms/gb/lib/c/unroll.h)
provides `UNROLL_N` macros (N ∈ {2,3,4,5,6,7,8,10,12,16,18,20,24,32,40,64}).
Originally the workaround for the now-fixed SDCC sm83 crash family.
**Not copied into projects by `examples({op:'fork'})` anymore.** If you want
to use it, fetch via `examples({op:'snippets', platform:"gb", mode:"get",
snippetName:"unroll", language:"c"})` and add to your repo manually.

## Cores

A few cores are now built from this repo for the patches we need (extra
memory regions, fixes for headless mode). Per-core scripts:

```
./scripts/build-fceumm.sh            # NES — adds nes_chr/nes_nametables/nes_palette/nes_oam regions
./scripts/build-gambatte.sh          # GB / GBC — adds gb_vram/gb_oam/gb_io/gb_hram/gb_bgpdata/gb_objpdata/gb_cpu_regs
./scripts/build-snes9x.sh            # SNES — adds CGRAM/OAM/ARAM/FillRAM regions + DSP state
./scripts/build-genesis-plus-gx.sh   # Genesis — adds CRAM/VSRAM/VDP_REGS/Z80_RAM/YM2612/PSG regions
./scripts/build-vice.sh              # C64 — adds c64_color_ram, c64_vic_regs, c64_sid_regs, c64_cia1_regs, c64_cia2_regs, c64_cpu_regs regions
./scripts/build-atari800.sh          # Atari 5200 (Asyncify rebuild; BIOS-load path still blocks run loop)
./scripts/build-stella2014.sh        # Atari 2600 — adds a26_tia_regs (32B TIA snapshot) + a26_cpu_regs (7B 6502 snapshot)
./scripts/build-prosystem.sh         # Atari 7800 — adds a78_cpu_regs (7B 6502 snapshot); MARIA + RAM + ROM all visible via system_ram
```

Patches live in `scripts/patches/` and are applied by the build scripts.

Other cores (Lynx/handy, MSX/fmsx, ColecoVision/gearcoleco) are imported
from the sibling `retroemu/cores/` build pipeline:

```
./scripts/sync-cores-from-retroemu.sh
```

This is a copy, not a symlink — once a `.wasm` is in `src/cores/wasm/`,
it ships with our package independent of any local retroemu version.

## Test ROMs

`scripts/fetch-test-roms.sh` downloads `nestest.nes` (Kevin Horton, public
domain) into `test/roms/`. Used by the MCP test suite for full-loop testing.
Not redistributed in our package.

## What's committed where

| Path                          | In git? | In npm? |
| ----------------------------- | ------- | ------- |
| `src/cores/wasm/*.{js,wasm}`  | yes     | yes     |
| `src/toolchains/*/wasm/*.{js,wasm}` | yes | yes     |
| `src/**/*.js` (host, MCP, toolchain wrappers) | yes | yes |
| `examples/`                   | yes     | yes     |
| `scripts/`                    | yes     | no      |
| `build/`                      | NO      | no      |
| `test/roms/`                  | NO      | no      |
| `node_modules/`               | NO      | no      |
