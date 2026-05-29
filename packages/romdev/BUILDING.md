# Building romdev from source

Single source of truth for: which platforms exist, which cores + toolchains
they use, where their patches live, which memory-region IDs they own, and
how to add a new platform without breaking the others.

If you're adding a platform: skim **§ Adding a new platform** first, then
fill in your row in **§ Platform matrix**.

---

## ⚠ READ FIRST — build state as of the monorepo split (2026-05-29)

The project is mid-migration from the single `romdev/` tree to the
**`romdev/` monorepo** (`~/code/cliemu/romdev/`, npm workspaces). This changes
where built WASM lives, and parts of the sections below describe the OLD layout.

**What's true now:**
- **WASM lives in `@romdev/*` packages**, not `src/.../wasm/`. The monorepo has
  `packages/romdev` (server + tools + scaffolds, NO wasm) + 14 binary packages
  (`@romdev/core-*`, `@romdev/toolchain-*`, `@romdev/platform-{snes,gba,atari2600}`).
  romdev resolves each core/compiler from its package via `import.meta.resolve`.
- **The build scripts (`scripts/build-*.sh`) still output to the OLD paths**
  (`src/cores/wasm/`, `src/toolchains/<tc>/wasm/`). Relocating each script + its
  patches INTO its owning package (so the package rebuilds its own wasm) is
  **pending D-work** — see `DEPLOYMENT_SKETCH.md`. For now: build in the old tree,
  the package wasm are copies of those outputs.
- **emscripten on this dev box:** `~/code/mine/emsdk/`. Source it first:
  `source ~/code/mine/emsdk/emsdk_env.sh`. Then `which emcc` should resolve.
- **Builds are NOT bit-reproducible.** A fresh `build-dasm.sh` produced a
  byte-different (98930 vs 98927 B), functionally-identical wasm — different
  sha256, same behavior (test passed). So "the wasm changed" must be judged by
  *behavior/tests*, not by hash equality across rebuilds. (Implication: don't
  gate CI on hash-matching prebuilt vs rebuilt wasm — they won't match.)
- **Verified buildable through the new layout:** dasm only (rebuilt from source,
  dropped into `@romdev/platform-atari2600`, 2600 test passed). The other 13 use
  COPIES of previously-built wasm — their from-scratch rebuild in the new layout
  is unverified. The heavy ones (arm-gcc 155MB / m68k-gcc / sdcc) are multi-hour
  Emscripten builds; rebuild rarely (mtimes show wasm is near-static).

**REMOVED platforms (2026-05-29):** atari5200, zxspectrum, coleco, msx are fully
gone (12-platform product now). Their build scripts (`build-atari800.sh`,
`build-fmsx`-type, `build-gearcoleco`-type, fuse) + the
`sync-cores-from-retroemu.sh` MSX/Coleco/ZX paths are **dead** — ignore mentions
of them below. `build-atari5200`/atari800 is dead too.

**GBA self-containment:** GBA's 3 ARM target archives (libc.a/libgcc.a/libnosys.a,
~15 MB) now live in `src/platforms/gba/lib/arm-archives/` (copied from the 1GB
`build/arm-toolchain/install/` tree, which is native build tools — NOT shipped).
`gba-c.js readTargetArchives()` reads from there now, not from `build/`. So
`@romdev/platform-gba` = mgba wasm + arm-gcc wasm + those 3 archives.

---

## Source provenance & version pinning

The boundary that keeps this repo *ours* and keeps builds reproducible:

**We fetch third-party source — we never vendor it.** Every emulator core and
compiler is third-party code (libretro cores, sdcc, cc65, dasm, asar, rgbds,
snes9x, etc.), each with its own license. We do **not** commit their source
into this repo. The build scripts *fetch* it on demand into `build/` (which is
**gitignored**), apply our patches, compile to WASM, and we ship **only the
resulting `.wasm` artifacts**. Their code stays theirs; what we distribute is
the built artifact plus our own patches.

> Why this matters: vendoring upstream source bloats the repo (the `build/`
> cache is ~14 GB of fetched trees) and drags every upstream's license into our
> tree. Fetch-on-demand keeps the repo as our code + our patches + built wasm.

**`scripts/versions.json` is the single source of truth for every pin.** URL,
exact commit (or version + sha256 for tarballs), license, and which patch (if
any) applies — all in one auditable place. Build scripts read it via
`scripts/_versions.sh` (`pin_url` / `pin_commit` / `pin_version` / `fetch_pinned`,
node-based so it works identically on the dev box and in the build container —
no `jq` dependency). **Never hardcode a URL/ref/version in a `build-*.sh` — edit
`versions.json`.** `fetch_pinned <key> <dir>` shallow-clones a git upstream at
its exact pinned commit (reproducible *and* small — no full history); tarball
upstreams record a sha256 so drift is at least detectable.

- A commit pinned to a moving branch (`master`/`main`) is **not a pin** — it's a
  reproducibility bug. All git upstreams in `versions.json` carry a real commit
  SHA, not a branch name. (As of 2026-05-29 the previously-unpinned dasm, asar,
  rgbds, vice + the six libretro cores that were cloned at bare `"master"` are
  now SHA-pinned.)
- A pin marked `UNVERIFIED-*` must be resolved before that component is rebuilt;
  `fetch_pinned` refuses to build an `UNVERIFIED-*` commit.

**Our patches are ours** and live in `scripts/patches/` (committed), never as
loose edits inside fetched `build/` trees. Each is justified — see
`scripts/patches/README.md`. The build is always: fetch pristine upstream →
apply our committed patch → build. If you changed upstream, it must become a
committed patch, full stop.

**The toolchain is pinned too.** WASM output is not bit-reproducible across emcc
versions, so the Emscripten version is pinned in `build-image/Dockerfile`
(`emscripten/emsdk:4.0.18`) — the same version recorded as `emsdk` in
`versions.json`. Run builds through `build-image/build-wasm.sh` to use it
instead of whatever emcc happens to be installed locally; that's how
"fetched source + pinned emcc + our patches = deterministic inputs" holds on
any machine. A clean container also *surfaces* host-incidental build deps that
a long-lived dev box hides — e.g. SDCC silently relied on the dev box's cached
emcc zlib + system boost; the container caught both (see § SDCC build prereqs).

---

## Host dependencies

A normal install (`npm install` against the published package) needs ONLY
Node 24+. Everything else is bundled WASM, runs identically on every host.

**Rebuilding the WASM toolchains / emulators from source** (i.e. running
the `scripts/build-*.sh` scripts) needs additional host tools. Install
once per build machine.

### Always needed for any WASM rebuild

- **Emscripten SDK** (emsdk) — set `EMSDK=/path/to/emsdk` before running
  any build script. The build scripts source `$EMSDK/emsdk_env.sh`
  themselves; you don't have to activate first.
- **git, make, cmake** — for cloning + driving upstream build systems
- **gcc, g++, ar, ranlib, ld** — the native host compiler used by some
  toolchains' bootstrap stages

### Per-toolchain extras (Debian / Ubuntu / Bazzite)

```sh
# SDCC (needs native bison+flex to regenerate parser before emcc takes over)
sudo apt-get install -y bison flex

# m68k-elf cross toolchain (Genesis C — gcc + binutils + newlib + SGDK).
# Standard cross-gcc build prerequisites — every gcc-cross-compiler guide
# needs the same set:
sudo apt-get install -y gawk texinfo libgmp-dev libmpfr-dev libmpc-dev libisl-dev
```

| Package         | Used by                  | Purpose |
| --------------- | ------------------------ | ------- |
| `bison`         | SDCC                     | Regenerate the C parser before emcc bootstrap |
| `flex`          | SDCC                     | Same — lexer regen |
| `gawk`          | binutils, gcc (m68k-elf) | GNU awk specifically; build scripts use GNU extensions |
| `texinfo`       | gcc (m68k-elf)           | Provides `makeinfo` for gcc's docs build |
| `libgmp-dev`    | gcc (m68k-elf)           | Arbitrary-precision integer math; gcc optimizer requires it |
| `libmpfr-dev`   | gcc (m68k-elf)           | Arbitrary-precision floats; gcc constant-folding requires it |
| `libmpc-dev`    | gcc (m68k-elf)           | Complex-number math on top of mpfr; gcc requires it |
| `libisl-dev`    | gcc (m68k-elf)           | Integer set library, Graphite loop optimizer in gcc |

macOS: use `brew install bison flex gawk texinfo gmp mpfr libmpc isl` —
same purpose, same packages. The build scripts probe for these and bail
with a clear message if missing.

### Optional, per-platform

| Toolchain        | Extra host needs |
| ---------------- | ---------------- |
| `wla-dx`         | None — two-stage build that uses the native CMake artifacts internally. Just `cmake` from the always-needed list. |
| `m68k-elf-gcc`   | (See per-toolchain extras above.) ~5 GB free disk for the bootstrap; building gcc with GMP/MPFR/MPC is heavy. |
| `vasm68k`        | None |
| `cc65`, `asar`, `tcc-65816`, `mcpp`, `dasm`, `rgbds` | None beyond the always-needed set |

## What's bundled

romdev ships **two kinds** of WASM blobs:

1. **Emulator cores** under `src/cores/wasm/` — libretro cores compiled
   to WASM. One core per emulator (e.g. `fceumm_libretro.wasm` for NES,
   `gpgx_libretro.wasm` shared across Genesis / SMS / Game Gear).
2. **Toolchains** under `src/toolchains/<id>/wasm/` — assemblers /
   compilers / linkers. One toolchain may target many platforms (e.g.
   cc65 covers NES, C64, Atari 5200/7800, Lynx).

A platform = an emulator core + a toolchain + JS glue under
`src/platforms/<id>/`. Adding a platform means wiring **all three**.

## Platform matrix

The "Patch" column lists `scripts/patches/<file>.patch`. Empty = no
patch; we use the stock libretro core. Region IDs allocated below.

| Platform     | Core (WASM)                       | Patch                                    | Toolchain | Region IDs           | Status |
| ------------ | --------------------------------- | ---------------------------------------- | --------- | -------------------- | ------ |
| NES          | `fceumm_libretro.wasm`            | `fceumm-romdev-memory-regions.patch`     | cc65      | 0x100-0x106          | deep   |
| SNES         | `snes9x_libretro.wasm`            | `snes9x-romdev-memory-regions.patch`     | asar      | 0x110-0x113          | deep   |
| Genesis / MD | `gpgx_libretro.wasm`              | `genesis-plus-gx-romdev-memory-regions.patch` (shared) | vasm68k | 0x120-0x126 | deep |
| SMS          | `gpgx_libretro.wasm` (shared)     | same as Genesis                          | sdcc      | 0x130-0x133          | deep   |
| Game Gear    | `gpgx_libretro.wasm` (shared)     | same as Genesis                          | sdcc      | 0x134-0x135          | deep   |
| Game Boy     | `gambatte_libretro.wasm`          | `gambatte-romdev-memory-regions.patch`   | sdcc sm83 (default), rgbds (`language:"asm"`) | 0x140-0x146 | deep |
| Game Boy Color | `gambatte_libretro.wasm` (shared) | same as Game Boy                         | sdcc sm83 (default), rgbds (`language:"asm"`) | 0x140-0x146 (shared) | deep |
| Game Boy Advance | `mgba_libretro.wasm`            | —                                        | arm-none-eabi-gcc (libtonc default / libgba / none) | — | shallow (build + run + screenshot; deep introspection not patched) |
| Atari 2600   | `stella2014_libretro.wasm`        | `stella2014-romdev-memory-regions.patch` | dasm      | 0x160-0x161          | deep   |
| Atari 7800   | `prosystem_libretro.wasm`         | `prosystem-romdev-memory-regions.patch`  | cc65      | 0x150                | deep   |
| Commodore 64 | `vice_x64_libretro.wasm`          | `vice-romdev-memory-regions.patch`       | cc65      | 0x170-0x175          | deep   |
| Atari Lynx   | `handy_libretro.wasm`             | —                                        | cc65      | —                    | shallow (templates + sfx + music shipped; introspection generic) |
| Atari 5200   | `atari800_libretro.wasm`          | — (core needs Asyncify rebuild)          | cc65      | —                    | build only |
| MSX          | `fmsx_libretro.wasm`              | —                                        | sdcc      | —                    | shallow (bring-up only — single `default` template) |
| ColecoVision | `gearcoleco_libretro.wasm`        | —                                        | sdcc      | —                    | shallow (bring-up only — single `default` template) |
| ZX Spectrum  | `fuse_libretro.wasm`              | —                                        | sdcc      | —                    | build only (core rejects tape `retro_load_game`) |

**Status legend:**
- `deep` — inspectSprites / inspectPalette / getCPUState / getRenderingContext / disassembleRom / findReferences all wired with platform-specific decode.
- `shallow` — generic `system_ram` / `save_ram` / `video_ram` only. Deeper introspection needs a core patch (see § Adding deep introspection).
- `build only` — toolchain ships, run side blocked (documented).

## Memory-region ID allocation

We extend libretro's `RETRO_MEMORY_*` IDs (0..3) with the 0x100-0x1FF
range. Defined in `src/host/types.js` as `RetroMemory.*` + the matching
`MemoryRegionToRetro` string-keyed map. **Allocate a new block of 16
when you add a new platform; never overlap.**

| Block       | Platform / chip       | Defined in `RetroMemory.*`                              |
| ----------- | --------------------- | ------------------------------------------------------- |
| 0x100-0x10F | NES PPU/APU/CPU       | `NES_NAMETABLES`/`NES_PALETTE`/`NES_OAM`/`NES_CHR`/`NES_APU_REGS`/`NES_CPU_REGS`/`NES_PPU_REGS` |
| 0x110-0x11F | SNES OAM/CGRAM/etc.   | `SNES_OAM`/`SNES_CGRAM`/`SNES_ARAM`/`SNES_FILLRAM`      |
| 0x120-0x12F | Genesis VDP/audio     | `GENESIS_CRAM`/`GENESIS_VSRAM`/`GENESIS_VDP_REGS`/`GENESIS_Z80_RAM`/`GENESIS_M68K`/`GENESIS_YM2612`/`GENESIS_PSG` |
| 0x130-0x13F | SMS / Game Gear       | `SMS_VRAM`/`SMS_CRAM`/`SMS_VDP_REGS`/`SMS_Z80_REGS`/`GG_VRAM`/`GG_CRAM` |
| 0x140-0x14F | Game Boy / GBC        | `GB_VRAM`/`GB_OAM`/`GB_IO`/`GB_HRAM`/`GB_BGPDATA`/`GB_OBJPDATA`/`GB_CPU_REGS` |
| 0x150-0x15F | Atari 7800            | `A78_CPU_REGS`                                          |
| 0x160-0x16F | Atari 2600            | `A26_TIA_REGS`/`A26_CPU_REGS`                           |
| 0x170-0x17F | Commodore 64          | `C64_COLOR_RAM`/`C64_VIC_REGS`/`C64_SID_REGS`/`C64_CIA1_REGS`/`C64_CIA2_REGS`/`C64_CPU_REGS` |
| 0x180-0x1FF | **free**              | reserved for future platforms (GBA / Lynx / 5200 / etc.) |

When you patch a core, mirror these IDs as `#define ROMDEV_MEMORY_<NAME>
0x1XX` in the core's `libretro-core.c` (or equivalent). Convention used
across all our patches.

## Core build scripts

Each emulator core has a `scripts/build-<core>.sh`. They follow a common
shape: clone upstream, apply our memory-region patch (idempotently), run
the upstream Makefile via `emcc`, augment any missing libretro-common
objects, link to WASM, stage under `src/cores/wasm/`.

```
./scripts/build-fceumm.sh             # NES
./scripts/build-snes9x.sh             # SNES (adds CGRAM/OAM/ARAM/FillRAM regions + DSP state)
./scripts/build-genesis-plus-gx.sh    # Genesis + SMS/Game Gear (shared core)
./scripts/build-gambatte.sh           # Game Boy / Game Boy Color
./scripts/build-stella2014.sh         # Atari 2600
./scripts/build-prosystem.sh          # Atari 7800
./scripts/build-vice.sh               # Commodore 64
./scripts/build-atari800.sh           # Atari 5200 (Asyncify rebuild; BIOS-load path still blocks run loop)
./scripts/sync-cores-from-retroemu.sh # Lynx / MSX / ColecoVision / ZX Spectrum (no patches needed today)
```

### Patch convention

Patches live in `scripts/patches/<core>-romdev-memory-regions.patch`.
Each patch:

1. Defines `ROMDEV_MEMORY_<NAME>` IDs at the top of the diff.
2. Extends `retro_get_memory_data()` + `retro_get_memory_size()` with
   a `switch` covering the new IDs.
3. May add small accessor functions / globals to expose private chip
   state. Keep these surgical — name them `romdev_*` so they're easy
   to grep + remove if the core upstreams the change.

### Patch bugs vs core bugs — pay attention to the difference (R59 cautionary tale)

Memory-region patches live in the seam between the emulator core
(which we leave intact) and our diagnostic-read API (which we add).
Bugs in our patch code masquerade as core bugs to agents — an agent
sees `readMemory("nes_chr", offset)` return garbage and blames
fceumm; in reality our patch's CHR-read accessor was reading from
the wrong offset.

The R59 fceumm-`nes_chr`-VPage bug is the canonical example:
`memcpy(buf + i*1024, VPage[i] + i*1024, 1024)` accidentally added
the page offset twice (VPage[i] already points at the start of the
i-th page; adding `i*1024` reads from page i*2 instead of page i).
Symptom: agent reads CHR-RAM at PPU $1000+ and gets zeros even
though the writes landed correctly. Took two friction rounds to
diagnose because nothing else in the trace pointed at the patch.

Lesson when adding memory-region accessors:
1. Test the reader against a known-byte-pattern write — fill all
   8 pages with distinguishable data (page 0 = $00s, page 1 = $11s,
   ..., page 7 = $77s), then read every page and verify the byte
   pattern matches the page number.
2. Document inline what `<ptr>` actually is — `VPage[i]` is "pointer
   to page i" not "base of array, index by page" — getting that
   wrong is the entire R59 bug.
3. Bias toward the simplest accessor: if you can return a direct
   ptr (like `SPRAM` for OAM), do that. Only build per-page memcpy
   loops when the source data isn't already contiguous.

### CRLF gotcha

Some upstream libretro forks ship `.c` files with CRLF line endings
(seen: vice, others may follow). `git apply` on a LF-context patch will
fail silently. Build scripts that apply patches should normalize first:

```bash
sed -i 's/\r$//' libretro/libretro-core.c
git apply --recount scripts/patches/<core>-romdev-memory-regions.patch
```

`--recount` lets the hunk line numbers float as upstream drifts. Use
`grep -q '<sentinel>' <file>` to skip the apply if it already landed
(idempotency check — pattern used in `build-vice.sh`).

## Toolchain build scripts

| Toolchain        | Script                       | Builds                                            |
| ---------------- | ---------------------------- | ------------------------------------------------- |
| cc65             | `build-cc65.sh`              | cc65 + ca65 + ld65 + da65                         |
| sdcc             | `build-sdcc.sh`              | sdcc + sdasz80 + sdasgb + sdld + mcpp             |
| rgbds            | `build-rgbds.sh`             | rgbasm + rgblink + rgbfix                         |
| dasm             | `build-dasm.sh`              | dasm                                              |
| asar             | `build-asar.sh`              | asar (SNES assembler)                             |
| vasm68k          | `build-vasm68k.sh`           | vasm Motorola-syntax 68k variant                  |
| vasmarm          | `build-vasmarm.sh`           | vasm ARM variant (GBA reserved)                   |
| tcc-65816        | `build-tcc816.sh`            | 816-tcc (TinyCC fork → wla-dx asm for SNES)       |
| wla-dx           | `build-wladx.sh`             | wla-65816 + wlalink (two-stage: native gen + WASM)|
| m68k-elf-gcc     | `build-m68k-toolchain.sh`    | native binutils + gcc + newlib for Genesis C (stage 1 of the Genesis tier-1 pipeline; stage 2 ports cc1/as/ld to WASM, stage 3 builds SGDK against this toolchain) |

### Multi-port toolchains

**SDCC bundles four backends** in one WASM:
- `z80` (SMS, Game Gear, MSX, ColecoVision, ZX Spectrum)
- `sm83` aka `gbz80` (Game Boy / GBC, used by GBDK)
- `z180` (rarely targeted)
- `ez80_z80` (Game Gear superset)

`SDCC_PORTS` in `src/toolchains/sdcc/sdcc.js` maps platform-id → port-id
+ lib directory. `buildZ80C()` swaps `sdasz80` ↔ `sdasgb` based on the
port — sm83's instruction set differs from z80's.

**crt0 auto-detect (R54).** `buildZ80C({crt0})` accepts EITHER a pre-
assembled `.rel` object OR raw `.s`/`.asm` source. Detection: a real
sdld `.rel` begins with the `XL2`/`XL3`/`XL4` byte-order tag. Anything
else is assumed to be assembly source and gets passed through
`runSdasgb` (sm83) or `runSdasz80` (z80) before linking. Pre-r54 the
raw .s text was shoved into `/work/crt0.rel` and sdld silently fell
back to the stock `sm83.lib` / `z80.lib` crt0 on rel-parse failure —
the custom `gb_crt0.s` / `sms_crt0.s` / `gg_crt0.s` NEVER linked.
Symptoms were silent everywhere (the stock crt0 was "good enough" to
boot + call `_main`, just not to set up the cartridge IO/IRQ surface);
the diagnosis was visible only by grepping the link map for `init`.

**cc65** is similarly multi-target (NES / C64 / a5200 / a7800 / Lynx)
via `--target <name>` plus per-target linker config presets under
`src/toolchains/cc65/presets/`.

### Subprocess isolation for WASM toolchains (R12, 2026-05-25)

Every WASM toolchain call (cc65, ca65, ld65, da65, dasm, asar,
vasm68k, sdcc, sdcpp/mcpp, sdasz80, sdasgb, sdld, rgbasm, rgblink,
rgbfix) runs in a **child worker process** spawned via
`child_process.fork`. The MCP server itself never instantiates an
emscripten module.

What this guarantees:

- **WASM Abort / SIGSEGV / OOM in a tool kills the worker, not the
  server.** The pool detects the unexpected exit and reports
  `{ exitCode: <signal>, log: "[crash] worker exited unexpectedly…",
  crash: { exitCode, signal } }` to the caller. Other MCP sessions
  continue uninterrupted.
- **One agent's bad C code cannot kill another agent's session.** The
  pool serves all sessions; each call runs in its own subprocess.
- **Tool registration, save states, playtest windows, loaded ROMs all
  survive a worker crash.** They live in the parent.

Implementation:

- `src/toolchains/_worker/wasm-worker.js` — child entry. Loads the
  requested glue module, materializes MEMFS from a job spec
  (`inputFiles`, `hostDirMounts`), runs `callMain`, captures
  `outputFiles`, reports back via IPC.
- `src/toolchains/_worker/pool.js` — child-process pool. Default 2
  workers (env: `ROM_DEV_WASM_POOL_SIZE`). On worker exit, the pool
  fails any in-flight job, removes the dead worker, spawns a
  replacement.
- `src/toolchains/_worker/run.js` — caller-facing `runIsolated({
  gluePath, argv, stdinText?, inputFiles?, hostDirMounts?, outputFiles?
  })`. Each per-toolchain wrapper (`runCc65`, `runSdcc`, `runAsar`,
  …) builds a job spec and awaits this.

Test: `test/crash-isolation.test.js` SIGKILLs the worker mid-flight
and asserts the next call succeeds against a replacement.

Cost: ~200-500 ms per first-time module load per worker. The warm
pool amortizes — repeat calls hit a hot factory cache (see
`factoryCache` in wasm-worker.js). Measured end-to-end for an empty
`buildSource({platform:"nes",language:"c"})` through the running MCP
server: ~85 ms per call once warm (cc65 → ca65 → ld65 pipeline, three
IPC round-trips + three MEMFS setups).

### Per-platform helpers — no build-time injection

Older versions of this server auto-mounted platform runtimes (gb_runtime,
nes_runtime, sms_crt0, etc.) + auto-applied post-link patches (Nintendo
logo + checksums for GB) based on source contents. **2026-05-25 / R9
removed all of it.** The build pipeline now compiles exactly what the
caller hands it via `sources` / `sourcesPaths` / `includes` /
`includePaths` / `crt0` / `crt0Path` / `linkerConfig` / `codeLoc`. Every
byte that compiles is visible in the caller's repo. See "Self-contained
projects" below for the policy + how `createProject` makes this
ergonomic.

When adding a new platform with non-trivial bring-up needs:
- Put runtime / crt0 / cfg under `src/platforms/<id>/lib/` (or, for
  cc65 linker presets, `src/toolchains/cc65/presets/<platform>/`).
- Add a template entry to `TEMPLATES` in `src/mcp/tools/project.js`
  listing the files to copy into a generated project directory.
- Do NOT add merging logic into the build pipeline. The pipeline
  compiles what the caller provides — that's the whole policy.

### When to ship a *second* bundle of the same toolchain

If two platforms need **conflicting compiler patches** of the same
upstream tool (not just different `-m` flags), ship them as separate
WASM bundles + give the toolchain registry distinct ids
(e.g. `sdcc-414` vs `sdcc-440`). We haven't needed this yet — the
"SDCC 4.5.0 z80 codegen bug" was solved by pinning to 4.4.0 for all
platforms instead of forking. Document the bug + the version pin in
the build script header so future you knows why.

### SDCC pre-flight linter

`buildForPlatform` runs a pattern scanner over C sources **before**
invoking SDCC, for all SDCC-targeted platforms (GB, GBC, SMS, GG, MSX,
ColecoVision). What it catches:

- C99 syntax violations: mid-block decls, inline `for (int i = 0;)`,
  compound literals, designated initializers. SDCC sm83 is C89-only
  and its own error messages for these are misleading (it reports the
  syntax error on the line AFTER the offense).

That's all the linter does now. The previous incarnation flagged a
big catalog of "register-pressure crash patterns" (parallel array
writes, multi-array indexed reads, for-loops with function calls,
nested-if return clusters) — those were all symptoms of an emscripten
stack-overflow bug that's now fixed at the build level (see below).

Detected issues land in the `issues[]` array of the buildSource
response with `stage: "lint"`, a short `message`, a long `details`
explanation, and `ref: "C89"`.

Pass `lint: "strict"` to `buildSource` to make any lint hit fail the
build. Default is `"advisory"` — warnings appear but the build proceeds.

### Stack-size fix (2026-05-25)

For weeks agents reported a recurring SDCC crash on GB/GBC C builds:
`Aborted(Assertion failed: str != NULL, at: dbuf_string.c,40,
dbuf_append_str)`. It manifested on for-loops with function calls,
parallel array writes, indexed-with-multiplication reads — the
register-pressure cases. Documented as "SDCC 4.4.0 sm83 codegen
quirks" + worked around with the `unroll.h` macros.

Root cause: emscripten's default 64 KB stack. SDCC's compilation
pipeline (boost graph register allocator + iCode walking) consumes
~140 KB in those cases. The stack grew down past `__data_end` and
silently zeroed out the static `sm83_regs[]` table that holds the
register names. After that, `aopGet` would look up a register by
rIdx, find a zero-filled `reg_info`, and pass NULL for the register
name to `dbuf_append_str`. The assertion fired in a totally different
file from the actual bug.

Fixed by adding `-s STACK_SIZE=8388608` (8 MB) to the shared
emscripten link flags in `scripts/_lib.sh`. All bundled toolchains
that link through `EM_CLI_FLAGS` (cc65, sdcc, dasm, asar, vasm68k,
rgbds, mcpp) get the same fix.

Verification: every previously documented "crash pattern" from
SDCC_GOTCHAS.md (#1, #3, #5, #37, #38, #39 + the whole family)
compiles cleanly with the fix in place. If you find a new SDCC
crash that ISN'T C89-related, it's worth investigating as a real
codegen bug — the native-debug build at
`scripts/build-sdcc-native-debug.sh` is still around for gdb work.

### GB/GBC: custom crt0 + cart header window (caller-driven, no auto)

For `platform: "gb" | "gbc"` C builds, three pieces work together to
produce a real cartridge image — but **none of them are auto-applied**.
`createProject` writes them into the project directory and the caller
points the build at them explicitly.

1. **Custom crt0**: `src/platforms/gb/lib/c/gb_crt0.s` defines 16
   separate `_HEADERx (ABS)` sections at the right `.org`s ($0000,
   $0008, ..., $0060, $0100, $0104) so the linker doesn't merge them.
   The reset vector at $0100 is `nop; jp init`, and `init:` lives in
   `_CODE`. **Pass via `crt0Path` or `crt0` to the build call.**

2. **Code base offset**: the gb_crt0 reserves $0100-$014F for the
   header window, so `_CODE` must start at $0150. **Pass
   `codeLoc: 0x150`** in the build args. Without this, the SDCC linker
   packs `_CODE` into the header gap and overwrites the Nintendo logo.

3. **Post-link header patch**: after building, run
   `patchGbHeader({path})` (MCP tool) OR `node patch-header.js <rom>`
   (standalone Node script, bundled into every GB project by
   `createProject`). Both write the canonical 48-byte Nintendo logo at
   $0104-$0133 + the 8-bit header checksum at $014D + the 16-bit
   global ROM checksum at $014E-$014F. For asm-mode RGBDS projects use
   `rgbfix -v -p 0` which the rgbds toolchain already provides.

For mapper-different layouts (MMC1, MBC3, MBC5), write your own crt0
+ supply your own `codeLoc` + skip the header patch if your layout
provides one differently.

### Per-TU error tagging

Multi-source SDCC builds (`sourcesPaths: {...}`) report **`failedTU`**
+ **`compiledOK`** on the buildSource response when a TU's compile
fails. Lets agents pinpoint exactly which file died without grepping
the log.

### Self-contained projects (no auto-injection — 2026-05-25 / R9 policy)

The build pipeline does NOT auto-inject platform runtimes, custom
crt0s, or post-link header patches based on source contents. It
compiles exactly what the caller provides via `sources` /
`sourcesPaths` / `includes` / `includePaths` / `crt0` / `crt0Path` /
`linkerConfig`. The agent — or the human reading the agent's repo —
can always see every byte that compiles by reading the project
directory. If you take a generated project elsewhere and rebuild
with stock cc65 / SDCC, every source the linker needs is in the
directory.

`createProject({platform, template, name, path})` is the canonical
scaffolding tool. For templates that need a runtime (NES + GB/GBC
C templates), it copies the runtime files into the project
directory:

- **NES** (`templates/{default,hello_sprite,tile_engine}.c`) copies:
  `nes_runtime.h`, `nes_runtime.c`, `chr-ram-runtime.crt0.s` (the
  preset's crt0), `chr-ram-runtime.cfg` (the preset's linker config).
  Build invokes `runSource` with `sourcesPaths` pointing at the
  project's own files; `crt0` arg = contents of the crt0.s file;
  `linkerConfig` arg = contents of the .cfg file.

- **GB/GBC** (`templates/{default,hello_sprite,tile_engine}.c`)
  copies: `gb_hardware.h`, `gb_runtime.h`, `gb_runtime.c`,
  `gb_crt0.s`, `patch-header.js`. The bundled `patch-header.js`
  applies the Nintendo boot logo + header/global checksums; the
  `patchGbHeader` MCP tool does the same thing without leaving MCP.
  RGBDS asm projects use `rgbfix` (which the rgbds toolchain bundles).

Other platforms (C64, Atari, SNES, Genesis, Lynx, GBA) ship their
own per-platform runtime files alongside main.c — sfx/music wrappers,
crt0, registers headers, etc. — same scaffolding pattern as NES + GB.

For mapper-different NES layouts (MMC1, UNROM, MMC3) the caller
passes their own `linkerConfig` .cfg contents + a matching crt0
via the `crt0` arg.

### Library source bundled into projects (R58 + R58b)

Every scaffolded project includes the FULL source tree of every
library the ROM links against, dropped into `vendor/` inside the
project at scaffold time:

| Platform | What lands at `vendor/` |
|---|---|
| Lynx     | `vendor/cc65/libsrc/lynx/` (TGI driver, lynx_snd, joystick, conio, crt0) |
| NES      | `vendor/cc65/libsrc/nes/` (joystick, conio, ppu helpers) |
| C64      | `vendor/cc65/libsrc/c64/` (joystick, VIC/SID/CIA helpers, conio) |
| Atari 2600 | `vendor/cc65/libsrc/atari2600/` (small — 2600 is asm-first) |
| Atari 7800 | `vendor/cc65/libsrc/atari7800/` (joystick, MARIA helpers) |
| GBA      | `vendor/libtonc/src/`, `vendor/libgba/src/`, `vendor/maxmod/` |
| SNES     | `vendor/pvsneslib/source/`, `vendor/pvsneslib/include/` |
| Genesis  | `vendor/sgdk/src/` (every SGDK module — VDP, SPR, JOY, XGM2, etc.) |

The agent can `grep -rn <symbol> vendor/` inside their project to
read the actual implementation of any library function. **R58b** in
project.js wires this via two mechanisms:

1. **Per-platform `*_VENDOR_DIRS` constants** (Lynx, GBA libtonc,
   GBA libgba, SNES PVSnesLib, C64) added to each template's
   `runtimeDirs`. Explicit, template-author-controlled.
2. **Auto-vendor fallback** in `createProjectImpl` — if
   `src/platforms/<p>/lib/cc65-src/` exists and the template didn't
   already copy `vendor/cc65/libsrc/<p>/`, copy it automatically.
   Catches NES + Atari 2600 + Atari 7800 without per-template edits.

The agent reads + greps but can NOT yet edit-and-rebuild — the
linker still uses precompiled `libtonc.a` / `libmd.a` / etc. R59
(planned) closes that with a per-TU object cache + source-first
library build. Until R59, `vendor/` is read-only-by-policy.

### SDCC native debug build (for codegen investigation)

`scripts/build-sdcc-native-debug.sh` produces a debuggable native
`sdcc` binary at `build/sdcc-debug/sdcc-X.Y.Z/src/sdcc`, compiled
with `-O0 -g3 -ggdb`. Use this when the WASM build crashes inside
SDCC and you need a stack trace.

Typical workflow when an agent reports "SDCC crashes on this C code":

```sh
# 1. Build the debug compiler (~5-10 min).
./scripts/build-sdcc-native-debug.sh

# 2. Preprocess the failing C source.
SDCC_DBG_DIR=build/sdcc-debug/sdcc-4.4.0
cpp -P -I$SDCC_DBG_DIR/device/include /path/to/crash.c > /tmp/crash.i

# 3. Run sdcc under gdb with a conditional breakpoint.
gdb --args $SDCC_DBG_DIR/src/sdcc -msm83 --c1mode -o /tmp/crash.asm
(gdb) break dbuf_append_str if str == 0
(gdb) run < /tmp/crash.i
(gdb) bt          # shows which SDCC codegen function passed NULL
```

The backtrace identifies the upstream codegen bug. Patch z80/gen.c
or similar, regression-test against existing SMS/GB examples, then
ship as `scripts/patches/sdcc-<descriptive-name>.patch` and wire
into `build-sdcc.sh`.

**Important: don't ship "defensive" downstream patches** (e.g.
turning `assert(str)` into `if (str == NULL) str = ""`). We tried
that approach in R5 — it converted the assertion crash into
malformed asm output that the peephole pass detects as a "FATAL
Internal Error" instead. Same outcome from the agent's perspective.
The fix has to be at the codegen NULL source, not at the
assertion site.

### m68k-elf toolchain build (Genesis C tier-1)

Three-stage build orchestrated by `scripts/build-m68k-toolchain.sh`:

1. **binutils 2.42** (assembler + linker + objcopy for m68k-elf). Standard
   configure/make, ~5 min.

2. **gcc 14.2.0 stage 1** — C-only, `--without-headers --with-newlib`.
   Produces `m68k-elf-gcc` + `cc1` but NO `libgcc.a` yet (target libc
   doesn't exist). ~20-30 min on a 24-core box.

3. **newlib 4.4.0** — target libc built using the just-installed
   `m68k-elf-gcc`. Configure flags critical for clean build:
   `--disable-newlib-io-long-long --disable-newlib-io-long-double
   --enable-newlib-reent-small`. **Without these flags, newlib's
   `libm/complex/` fails** with `implicit declaration of 'coshl'` etc.
   because m68k-elf's `long double` is treated as `double` but the
   complex-math sources assume full IEEE long double.

4. **gcc 14.2.0 stage 2** — re-run `make all && make install` in the
   same build-gcc tree. Now that newlib is installed, gcc builds
   `libgcc.a` against it. ~5-10 min for the libgcc-only delta.

Output: `build/m68k-toolchain/install/bin/m68k-elf-{gcc,as,ld,objcopy,
ranlib,...}`. ~250 MB of native binaries + headers + target libs. Stays
inside the build tree — never touches `/usr/local`.

**What ships vs. what stays on the build machine**

Nothing native goes into the npm package. The native build is purely
a means to produce two kinds of artifacts that DO ship:

- **WASM tools** — compiled to WASM via emcc, end up under
  `src/toolchains/<name>/wasm/`. For Genesis: `cc1.wasm`,
  `m68k-elf-as.wasm`, `m68k-elf-ld.wasm`, `m68k-elf-objcopy.wasm`,
  plus SGDK's helper tools (`mac68k`, `bintos`, `convsym`, `sjasm`)
  each ported the same way.
- **Target binary artifacts** — pure m68k-elf object files (libgcc.a,
  libc.a, libm.a, crt0.o, crtbegin.o, crtend.o, libmd.a) shipped under
  `src/platforms/genesis/lib/c/`. These are NOT native — they're m68k
  machine code that gets linked into the user's Genesis ROM. Same
  pattern as PVSnesLib's `.obj` files for SNES (R18).

The native binaries in `build/m68k-toolchain/install/bin/` are throw-
away — they exist to produce the above and are never shipped.

**WASM port — `scripts/build-m68k-wasm-tools.sh` (R20 stage 2):**

5. **WASM tools** — re-compile `cc1`, `m68k-elf-as`, `m68k-elf-ld`,
   `m68k-elf-objcopy` to WASM via emcc, sourcing from the same upstream
   gcc/binutils trees. Build flags worth knowing about:
   - `-s MODULARIZE=1 -s EXPORT_ES6=1` → ESM glue (`.mjs`) with
     `import.meta.url`. The worker (`src/toolchains/_worker/wasm-worker.js`)
     accepts either `.js` or `.mjs` glue.
   - `-s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=134217728` — cc1 OOMs
     immediately at the default 16 MB cap on any real source.
   - **libiberty psignal clash**: emscripten declares
     `psignal(int, const char*)` but libiberty's fallback uses
     `(int, char*)`. Workaround: `#define HAVE_PSIGNAL 1` in
     `libiberty/config.h` so libiberty doesn't emit its own fallback.
   - **gcov-tool needs ftw()** which emscripten libc lacks; bypass by
     running `make cc1` directly instead of `make all-gcc`.

6. **Target artifacts** → `src/platforms/genesis/lib/c/`: the minimum-
   viable bundle (`libgcc.a`, `libc.a`, `libm.a`, `crtbegin.o`,
   `crtend.o`, plus our original-code `sega.s` 256-byte vector table
   and `genesis.ld`).

7. **SGDK** → `src/platforms/genesis/lib/sgdk/`: `libmd.a` (2.6 MB,
   77 .o files, built against the stage-1 native toolchain),
   `sega.s` (raw, uses `#include`), `sega.preprocessed.s` (cpp-
   expanded — needed by the bare WASM `as` which doesn't run cpp),
   `rom_header.c`, `md.ld`, full `include/` header tree (69 headers),
   MIT LICENSE, libgcc-runtime-exception COPYING.RUNTIME. Note: we
   currently use SGDK's *runtime* (libmd.a + headers + crt0 + linker
   script) but NOT its helper tools (mac68k / bintos / convsym /
   sjasm). The pure-binutils path (`m68k-elf-as` + `m68k-elf-ld` +
   `m68k-elf-objcopy`) covers everything the user actually needs.

8. **JS driver** → `src/toolchains/genesis-c/genesis-c.js`:
   orchestrates `cc1` → `as` → `ld` → `objcopy` via the worker pool
   (R12). Two modes: `sgdk:true` (default, links libmd.a + sega.o +
   rom_header.bin + libc + libgcc) and `sgdk:false` (minimum-viable).
   Wired into `buildSource({platform:"genesis", language:"c"})`.

9. **createProject template** → `genesis/sgdk_hello`: ships the
   full SGDK runtime INTO the user's project tree (libmd.a + sega.s
   + sega.preprocessed.s + md.ld + rom_header.c + LICENSE + 69
   headers under `include/`), so the project is portable: anyone with
   `m68k-elf-gcc` installed can rebuild it without romdev. **No
   scripts** in the project — portability is in the directory shape,
   not in a shell file that might not run on Windows.

### SDCC build prereqs (system-level)

SDCC is the **dep-heaviest "light" build** — it drives the build image's
system package list. It needs, beyond the always-needed set:

```
sudo apt-get install -y bison flex zlib1g-dev libboost-graph-dev   # Debian / Ubuntu / Bazzite
brew install bison flex boost                                      # macOS (zlib is in the SDK)
```

(These are baked into `build-image/Dockerfile` — building through
`build-image/build-wasm.sh` needs none of them on the host.)

**Why zlib and boost are both needed, and in two different ways** — SDCC does a
two-pass build and *each pass* needs zlib + boost via a *different* mechanism:

| Dep | Native pass (plain `gcc`, `./configure`) | Emscripten pass (`emconfigure`) |
| --- | --- | --- |
| zlib | `/usr/include/zlib.h` → `zlib1g-dev` | emcc port: `-s USE_ZLIB=1` (+ prime before configure) |
| boost | `/usr/include/boost/...` → `libboost-graph-dev` | emcc port: `-s USE_BOOST_HEADERS=1` (+ prime before configure) |

`build-sdcc.sh` primes the emscripten ports (a no-op compile that pulls the port
into emcc's sysroot) **before** running `emconfigure`, because configure's
`checking for zlib.h` / `boost/graph/adjacency_list.hpp` probes compile against
the *sysroot*, not `/usr/include` — so a native `-dev` package does NOT satisfy
the emscripten probe, and the port does NOT satisfy the native probe. Both are
mandatory: boost backs SDCC's register allocator (no `--disable-boost`).

> This is the classic "works on my box" trap: the dev box had system boost and a
> cached emcc zlib, so both passes passed silently there. The pinned container
> had neither and failed loudly — which is exactly what it's for. If you build
> outside the container, these are the deps you'll be missing.

**The preprocessor is mcpp, NOT sdcpp.** SDCC normally fork/execs its own
preprocessor (sdcpp), which Emscripten can't do. Our wrapper
(`src/toolchains/sdcc/sdcc.js`) sidesteps this: it preprocesses with
**`mcpp.wasm`** (built by `build-mcpp.sh`) and feeds the `.i` to sdcc in
`--c1mode` (sdcc then skips its own preprocessor). So `mcpp.wasm` is the shipped
preprocessor; **sdcpp is never used or staged.** `build-sdcc.sh` builds sdcpp
only best-effort (`|| true`) and does not verify it — a sdcpp failure must not
fail the build. (Under emcc 4.0.18 sdcpp's bundled gcc fails to link anyway —
it needs sdbinutils/libiberty, which the emscripten pass `--disable`s — and that
is fine because we don't ship it. There's also a `getexecname()` portability
error in its libbacktrace that `-Wno-implicit-function-declaration
-Wno-int-conversion` work around so it gets as far as it can.) The **only**
required staged artifact verified by the script is `sdcc.wasm`.

The two-pass build reuses ONE source tree (native pass first → runtime libs
under `device/lib/build/<port>/`; emscripten pass second → `sdcc.wasm` reusing
those libs). **Skipping the native pass means no port libs → "library not
found".** The native pass is gated on a `.native-built` marker. ⚠ The shared
tree is fragile across re-runs: a half-finished emscripten pass can leave wasm
`.o` files that a later native relink rejects (`file format not recognized`).
**If a rebuild misbehaves, wipe the whole source tree, not just the marker:**
`rm -rf build/sdcc/sdcc-X.Y.Z` (the tarball stays cached; it re-extracts). Do
this as the build user — if a prior container run left root-owned files, clean
via the container: `docker run --rm -v "$PWD:/work" -w /work
romdev/wasm-builder:emscripten-4.0.18 bash -lc 'rm -rf build/sdcc/sdcc-X.Y.Z'`.

## JS-side wiring per platform

Adding a platform means adding:

1. **`src/host/types.js`** — new `RetroMemory.*` entries + matching
   `MemoryRegionToRetro` map entries.
2. **`src/platforms/<id>/`** — chip-specific decoders.
   - `vic.js` / `vdp.js` / `tia.js` / etc. — PPU/VDP decode, palette,
     sprite, register table.
   - `lib/` — starter snippets agents can `getStarterSnippet({platform,
     name})`.
   - Optional `image-to-tilemap.js` if the platform supports PNG →
     tilemap conversion. **Exporting `<platform>ImageToTilemap()` is only
     half the job** — you MUST also wire a branch into the `imageToTilemap`
     dispatcher in `src/mcp/tools/platform-tools.js`, or the tool falls
     through to "not implemented" even though the function exists. (This
     gap shipped silently for Genesis once; a string-match inventory
     reported it as supported because the file existed.) Return the
     normalized `{chr, nametable, attr, palette, uniqueTiles*, previewPng}`
     shape; map any platform-specific field names in the dispatcher.
3. **`src/host/cpu-state.js`** — add a branch returning `{pc, sp,
   registers, flags, ...}` for the platform's CPU.
4. **`src/platforms/common/registers.js`** — add a `<PLATFORM>_REGISTERS`
   table + wire it into `registersForPlatform(platform)`.
5. **`src/mcp/tools/platform-tools.js`** — add `inspectPalette` /
   `inspectSprites` / `inspectBackgroundMap` / `getPlatformPalettePng`
   branches.
6. **`src/mcp/tools/rendering-context.js`** — add `<platform>Context()`
   function + wire into the switch in `getRenderingContextCore`.
7. **`src/mcp/tools/disasm.js`** — add `map<Platform>Address()` mapper
   + extension sniff + `cpuToFile` translator branch.
8. **`src/mcp/tools/find-references.js`** — same dispatch.
9. **`src/mcp/tools/diff-roms.js`** — add `regionMap<Platform>()` +
   `cpuAddressFor` branch.
10. **`src/mcp/tools/cart-parts.js`** — add `extract<Platform>()` +
    `wrap<Platform>()` for the `extractCart` / `wrapRomFromParts` pair.
11. **`src/toolchains/index.js`** — add the platform's toolchain
    dispatch + (if multi-port) update `SDCC_PORTS` or the cc65 target
    map.
12. **`src/cores/registry.js`** — register the core (wasm path + sample
    rate + default mediaKind).
13. **`examples/<id>/main.{c,asm,s}`** — minimal "hello" buildable via
    `buildSource({platform})`.

## Adding deep introspection to a "shallow" platform

The pattern that worked across snes9x / gpgx / fceumm / gambatte /
stella2014 / prosystem / vice:

1. Audit upstream source — find the global structs holding chip state
   (e.g. `vicii.regs[]` on vice, `ppu.regs[]` on fceumm).
2. Allocate a block of `ROMDEV_MEMORY_*` IDs (16 per platform; see § Memory-region ID allocation).
3. Write `scripts/patches/<core>-romdev-memory-regions.patch` that:
   - Adds the `#define`s.
   - Extends `retro_get_memory_data` / `retro_get_memory_size`.
   - Adds tiny accessor functions if any state is `static` or behind
     side-effect-bearing read functions (use `sid_peek` rather than
     `sid_read` on vice, for example).
4. Update `build-<core>.sh` to apply the patch idempotently (CRLF
     normalize first if needed; `grep -q` sentinel for skip-on-rerun).
5. Rebuild the core. Verify `nm <core>.wasm | grep romdev_` shows the
   new symbols.
6. Wire up the JS side (steps 1-13 above).
7. Restart the MCP server (`pkill` + relaunch — ESM doesn't hot-reload).
8. Smoke-test with curl: load a test ROM, step frames, call
   `inspectPalette` / `inspectSprites` / `getCPUState`.
9. Update **§ Platform matrix** in this file. Move the platform from
   `shallow` → `deep`.

## Testing across platforms

Run the full integration suite:

```
npm test
```

102 tests today. Add a smoke test per platform under `test/` when you
add a new one. The harness boots an MCP server in-process via
`createMcpServer()` and drives it through the JSON-RPC surface; no
mocks of cores or toolchains. If a test fails after your change,
something cross-platform regressed.

## Reproducibility checklist

Before merging a new platform or a core update:

- [ ] Upstream is pinned in `scripts/versions.json` — a real **commit SHA**
      (git) or **version + sha256** (tarball), never a bare branch. The build
      script fetches via `fetch_pinned`/`pin_*`, with NO hardcoded URL/ref.
- [ ] License recorded in the `versions.json` entry (their code is theirs; we
      ship only the built wasm + our patches — no upstream source vendored).
- [ ] Built against the pinned image (`build-image/build-wasm.sh <script>`),
      not a random local emcc.
- [ ] Patch file committed to `scripts/patches/` **with a justification** —
      header comment + entry in `scripts/patches/README.md`.
- [ ] Build script applies it idempotently (`grep -q` sentinel) +
      handles CRLF if upstream ships it.
- [ ] Memory-region IDs in their assigned block (see allocation table);
      `src/host/types.js` updated.
- [ ] Built WASM staged at `src/cores/wasm/<name>.wasm` AND committed
      (we ship the binary; not everyone has emsdk).
- [ ] `npm test` is 100% green.
- [ ] Smoke test through curl on the running server (load → stepFrames
      → inspectPalette/Sprites/CPU/Rendering).
- [ ] This file updated: matrix row, region-block, and any new
      toolchain bundle notes.
- [ ] No build artifacts in `/tmp` — everything we'd want to reproduce
      lives under `build/` (gitignored, source of truth is `scripts/`)
      or `src/` (committed).

## Known build-host quirks

- **gcc 14+** — SDCC's bundled `sdas/linksrc/aslink.h` declares
  `extern VOID elf();` with K&R empty parens; gcc 14 treats those as
  `(void)` and rejects the `elf(i)` call site. `build-sdcc.sh` patches
  this with `sed` before the native configure.
- **emcc + boost/zlib** — SDCC needs both, in two ways per pass (see
  § SDCC build prereqs). Native pass: `libboost-graph-dev` + `zlib1g-dev`
  from the system. Emscripten pass: the emcc ports `-s USE_BOOST_HEADERS=1`
  + `-s USE_ZLIB=1`, primed with a no-op compile before `emconfigure` so
  autoconf's `boost/graph/adjacency_list.hpp` / `zlib.h` probes resolve
  against the sysroot. A native `-dev` package does NOT satisfy the
  emscripten probe and vice-versa.
- **vice CRLF** — vice-libretro's `libretro/libretro-core.c` ships with
  CRLF line endings on some clones. `build-vice.sh` normalizes before
  patching.
- **maincpu_regs is stale** (vice) — vice's `mos6510_regs_t maincpu_regs`
  is only written by `EXPORT_REGISTERS` at branch/interrupt sites, not
  per-instruction. Our patch lifts the static `reg_a/x/y/p/sp` locals
  out of `maincpu_mainloop()` via `#define` aliasing to file-scope
  globals (`romdev_reg_*`) so they reflect live state every
  instruction.
