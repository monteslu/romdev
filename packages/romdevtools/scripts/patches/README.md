# Why these patches exist

Every patch here is **friction**: it has to re-apply cleanly on every upstream
bump, and each one is a thing that can break a rebuild. So each must justify
its own existence. If an upstream change makes one of these unnecessary, delete
it. None of these are "nice to have" — without them, specific romdev tools
return nothing or the platform doesn't build at all.

These patches are **ours** — they live in this repo, versioned with the build
scripts, and are applied to *fetched* upstream source (see
[`../versions.json`](../versions.json)). We never vendor upstream source into
git; we fetch it, apply these, build, and ship only the resulting `.wasm`.

---

## Family 1 — `*-romdev-memory-regions.patch` (7 patches)

**One shared reason.** Every libretro core exposes a fixed set of memory
regions through `retro_get_memory_data(id)` / `retro_get_memory_size(id)` —
usually just `SAVE_RAM` and `SYSTEM_RAM`. romdev's inspection tools
(`sprites({op:'inspect'})`, `palette({source:'live'})`, `background({view:'map'})`, `cpu({op:'read'})`,
`getPsgState`, `getDspState`, `getYm2612State`, `state({op:'dump'})`, `watch({on:'mem'})`,
`memory({op:'read'})` against named regions, …) need to read the emulator's *internal*
state — VRAM, OAM, palette/CGRAM, PPU/VDP/TIA/VIC registers, sound-chip
registers, CPU registers — which upstream does **not** expose.

Each patch adds romdev-private region IDs (the `ROMDEV_MEMORY_*` enum values)
and wires `retro_get_memory_data` to return pointers into the core's live
emulation structs. **Without the patch, every visual/audio/CPU inspection tool
for that platform returns empty or stale data** — the build still succeeds, so
the failure is silent at build time and only shows up as "inspectSprites found
nothing" at runtime. That silent-failure mode is exactly why these are
documented rather than left as bare diffs.

The sentinel `ROMDEV_MEMORY_*` macros also let each build script detect "patch
already applied" idempotently (grep for the sentinel) so re-running a build
doesn't double-apply.

| Patch | Platform(s) | Exposes | Files touched | Notes |
|---|---|---|---|---|
| `fceumm-romdev-memory-regions.patch` | NES | OAM, PALETTE, NAMETABLES, CHR, PPU regs, CPU regs, APU regs | `libretro.c`, `sound.c` | Also drops `static` on the APU register holders in `sound.c` so `libretro.c` can `extern` them for the `apu_regs` snapshot. |
| `gambatte-romdev-memory-regions.patch` | GB / GBC | VRAM, OAM, HRAM, IO, BG palette data, OBJ palette data, CPU regs | 6 files across `libgambatte/` | Largest of the family — gambatte hides most state behind private classes, so several headers get accessors added. |
| `genesis-plus-gx-romdev-memory-regions.patch` | Genesis / SMS / GG | Genesis: M68K regs, Z80 RAM, VDP regs, CRAM, VSRAM, YM2612, PSG. SMS/GG: VRAM, CRAM, VDP regs, Z80 regs | `libretro.c` | One core serves three platforms; `sms_z80_regs` works on Genesis ROMs too (shared Z80). |
| `snes9x-romdev-memory-regions.patch` | SNES | OAM, CGRAM, ARAM (APU RAM), FILLRAM | `libretro.cpp` | snes9x already exposes VRAM via the generic `video_ram` region, so VRAM is **not** in this patch. It does **not** expose PPU regs — tools pass tilemap/tile bases explicitly instead. |
| `stella2014-romdev-memory-regions.patch` | Atari 2600 | TIA regs, CPU regs | `libretro.cxx`, `M6502.hxx`, `TIA.hxx` | Needs header edits because Stella keeps M6502/TIA state private. |
| `prosystem-romdev-memory-regions.patch` | Atari 7800 | CPU regs | `core/libretro.c` | Smallest of the family. |
| `vice-romdev-memory-regions.patch` | C64 | VIC regs, SID regs, CIA1/CIA2 regs, color RAM, CPU regs | `libretro-core.c`, `maincpu.c` | `maincpu.c` holds the live CPU registers behind `#define reg_a romdev_reg_a` redirection so the libretro layer can read them. |

**Could upstream make these unnecessary?** Only if a core upstreamed a generic
"expose internal regions" facility. None has. Until then, keep them.

---

## Family 2 — newlib m68k patches (2 patches, GBA/Genesis-C heavy toolchain)

These already carry their own justification in the patch header (read the top
of each file). Summary:

| Patch | Why | What breaks without it |
|---|---|---|
| `newlib-4.4.0-m68k-bare-metal-system.patch` | newlib's m68k-elf default combines `-DHAVE_SYSTEM` with `-DMISSING_SYSCALL_NAMES`, a contradiction (HAVE_SYSTEM expects `system()` to work, MISSING_SYSCALL_NAMES says there are no syscalls). Replaces with `-DNO_EXEC`. | newlib's `stdlib/system.c` fails to build for bare-metal m68k. |
| `newlib-4.4.0-m68k-ldbl-eq-dbl.patch` | Sets `_LDBL_EQ_DBL=1` for m68k-elf so libm/complex don't reference long-double-only functions (`coshl`, `sinhl`, `expl`, …) that m68k `math.h` hides. | libm link errors on undefined `*l` long-double math symbols. |

---

## Family 3 — rizin emscripten patches (2 patches, analysis engine)

Make Rizin v0.8.2 build single-threaded for wasm32-emscripten (Node target).
Recipe derived from the rzwasi project (https://github.com/IndAlok/rzwasi,
LGPL-3.0) and re-cut as committed diffs against our pinned commit. Applied by
`build-rizin.sh`.

| Patch | Why | What breaks without it |
|---|---|---|
| `rizin-romdev-emscripten.patch` | (1) thread.h/thread*.c: pthread API replaced with single-thread stubs (`rz_emscripten_thread_stubs.h`) — emscripten pthreads need SharedArrayBuffer wasm we don't want for a one-shot CLI tool; (2) cons.c: route `__cons_write_ll` through `Module.print` so output capture works under MODULARIZE; (3) sys.c: no `execinfo.h`/backtrace under emscripten; (4) io_shm.c: no SysV shm; (5) rz_heap_jemalloc.h: skip jemalloc internals; (6) meson.build: emscripten has no librt/ptrace. | Build fails at thread.c (`#error Threading library only supported for pthread and w32`), then at execinfo.h, shm.h; output is invisible to the JS host. |
| `rizin-libzip-emscripten.patch` | libzip meson **subproject** (fetched at configure time, so this can't live in the rizin patch): stub `zip_secure_random` with `srand/rand` (no `/dev/urandom` guarantee), drop macOS `sys/attr.h`/clonefile path, fix `ftello` redefinition, map `*_s` bounded-string calls to plain libc. Applied after `meson subprojects download` with sentinel `romdev emscripten compat`. | libzip compile errors abort the whole rizin build (zip support is linked into rz_io). |

Known runtime wart (documented in `build-rizin.sh`): plugin-LISTING commands
(`La`, `e asm.arch=??`) trap with "null function or function signature
mismatch" — a fn-pointer cast UB that native builds tolerate. Nothing on the
analysis path (`aaa`, `aflj`, `axtj`, `agf json`, `pdj`) hits it. If a future
rizin bump fixes the cast, retest and delete this note.

---

## Rules for this directory

- A patch with no entry in this README is a bug — add the justification or
  delete the patch.
- Patches apply to fetched upstream at the commit pinned in `versions.json`.
  If a bump breaks a patch, re-cut it against the new commit and update both
  files together.
- Build scripts apply these with `git apply --recount` and detect
  already-applied state via the `ROMDEV_MEMORY_*` sentinel — keep that sentinel
  in any re-cut.
