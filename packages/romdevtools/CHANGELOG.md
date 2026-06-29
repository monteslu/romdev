# Changelog

All notable changes to `romdevtools`. Dates are release dates.
(Published as `romdev-mcp` through 0.11.0; renamed to `romdevtools` in 0.13.0 —
the `romdev-mcp` bin is kept as an alias.)

## 0.71.0 — 2026-06-28

### N64 / PS1 / Dreamcast reach full parity: cpuState + audioDebug + GPU-rendering helper libs + 5 examples each

The three next-gen 3D platforms are now first-class alongside the original 14.

**Live debugging (cpuState + audioDebug).** PS1 (beetle_psx_hw) and Dreamcast (flycast)
gained the romdev debug-reader exports, so `cpu({op:'read'})` and
`audioDebug({op:'inspect'})` light up (N64 already had them):
- **PS1** — `cpu({op:'read'})` returns the live R3000A register file; `audioDebug({chip:'spu'})`
  decodes the SPU's 24 voices + main volume (read from the raw register mirror, not the
  sweep-quantized `SPU_Read`).
- **Dreamcast** — `cpu({op:'read'})` returns the SH-4 registers (r0–r15, pc, pr, gbr, vbr,
  sr + decoded flags, mac, fpul); `audioDebug({chip:'aica'})` decodes the AICA's 64
  PCM/ADPCM channels + master volume. Full host plumbing + decoders added.
- The capability manifest now reports cpuState/audioDebug `true` for all three (verified by
  probing real core exports; `breakpoint`/`watch` remain pending on PS1/DC).

**GPU-rendering helper libs (no software framebuffers).** Every 3D platform's helper now
draws through the GPU — a software rasterizer would be black on the GL cores and <1fps:
- **N64** — the `n64.h` helper was rewritten to emit a **GBI (F3DEX2) display list** that
  glide64 HLEs onto the GPU (clear/rect as fill-rectangles, triangles scan-converted into
  GPU fill-rect spans), instead of poking pixels into RDRAM (which rendered black on
  glide64). No Nintendo microcode shipped — the OSTask CRC-bait trick selects F3DEX2.
- **PS1** — already correct (GP0 GPU primitives on beetle_psx_hw).
- **Dreamcast** — `dc.h` now sets **480i interlace** in `dc_video_init` (240p only showed
  the top 240 of 480 lines), and added a Maple-DMA `dc_pad()` / `dc_pressed()`.
- `#include "n64.h"` / `#include "psx.h"` now auto-bundle (parity with `dc.h`).

**5 genre examples per platform.** N64, PS1, and Dreamcast each ship
shmup / platformer / puzzle / racing / sports examples — all verified building + rendering
on the GPU.

**Docs.** MENTAL_MODEL + TROUBLESHOOTING for N64, PS1, and Dreamcast (the render model,
boot story, debug surface, and what's N/A and why).

### asar (SNES) build-tool fixes

From real commercial-disassembly feedback:
- **`build({output:'project'|'run'})` honors `options` + a new `defines` map** (e.g. asar
  `--define`) — they were silently dropped.
- **New `entry` param** so a project whose top file isn't `main.*` (e.g. an existing
  `smw.asm` disassembly) builds without injecting glue.
- **Subdirectory assets are staged recursively** (a flat `readdir` missed nested
  `incbin`/`incsrc` targets).
- **A clean asar error is no longer mislabeled** `[worker] Abort in WASM` (it exits errors
  via a C++-exception path; the misleading heap-pointer line is stripped when real
  diagnostics are present).
- **The LoROM-header bankcross preflight no longer false-positives** on banks $01+ (the
  header is only in bank $00) and honors `check bankcross off`.
- **A readfile/filesize advisory** warns when a source reads many distinct files that way
  (the asar-WASM resource limit), pointing at the pre-convert-to-`.bin` + `incbin`
  workaround.

### Toolchain

- **sh-c (Dreamcast) defaults to `-O1`** — the sh-elf `cc1.wasm` has an `-O2`-only pass
  that aborts on common control flow; `-O1` dodges it. A user-supplied `-O<level>` wins.

## 0.70.0 — 2026-06-26

### Dreamcast is ship-ready: verified build → run → screenshot, with a renderable example

The Dreamcast platform is now verified end-to-end and release-ready:

- **build → run → screenshot proven + regression-tested.** A C homebrew compiles via
  sh-elf-gcc, boots DIRECTLY on Flycast's reios HLE BIOS (no GD-ROM image, no firmware),
  and renders on the real GPU through native-gles at 640×480 — confirmed by the new
  `test/dreamcast-runside.test.js`.
- **dc.h is now auto-bundled.** The PowerVR2 framebuffer helper (640×480 RGB565 bring-up:
  FB_R_CTRL/SIZE/SOF1 + SPG) ships in the sh-c toolchain lib and is injected automatically,
  so `#include "dc.h"` just works — a DC program is a single `main.c` with no glue. A
  caller-supplied `dc.h` still overrides the bundled one.
- **A renderable example** — `examples/dreamcast/hello` (DCHELLO): the canonical starter
  that paints a test pattern through the GPU pipeline. Registered with createProject /
  scaffold like the other platforms.

(The 640×480 screenshot path was already correct — the GL FBO is sized to Flycast's
upscale bound and the host crops the readback to the core's reported geometry; a raw
readback without crop args was the only thing that looked oversized.)

## 0.69.0 — 2026-06-26

### PS1 renders on the REAL GPU via native-gles (Beetle PSX HW + OpenBIOS)

The PS1 core is now **Beetle PSX HW** (mednafen) with its GLES3/WebGL2 hardware renderer,
rendering the PS1 GPU on the real GPU through native-gles — the same path as glide64-N64
and Flycast-DC. It ships with **OpenBIOS embedded** (PCSX-Redux, MIT-licensed, region-free),
so there's NO copyrighted Sony firmware to ship and no BIOS file to supply. (Verified:
mod.GL exposed, SET_HW_RENDER fires, hwActive=true, the OpenBIOS 3D-cube boot animation
renders in shaded perspective through native-gles.)

- New package romdev-core-beetle-psx-hw (replaces romdev-core-pcsx-rearmed as the PS1
  core); build-beetle-psx-hw.sh reuses the N64 GL recipe (all-.o link, -lGL +
  GL_ENABLE_GET_PROC_ADDRESS + GL in EXPORTED_RUNTIME_METHODS, the libretro-common EXTRAS).
- Registry: ps1 → beetle_psx_hw, hwRender:true. Manifest: renderingKind 3d, run+screenshot
  +disasm+decompile+build true; cpuState/audioDebug now false (beetle lacks the romdev
  MIPS/SPU debug exports the old pcsx_rearmed-software build had — a future core patch;
  pcsx had no WebGL2 GPU path).

NOTE (both MIPS platforms): the GL cores render RDP/GPU display lists, NOT raw CPU-written
framebuffers — so the romdev software-3D example libs (which rasterize into a framebuffer)
render black on them; REAL games with GPU geometry render correctly. SDK-based examples
(libdragon rdpq / PSn00bSDK GTE) are the renderable path. Suite 1059/1059.

## 0.68.0 — 2026-06-26

### N64 renders on the REAL GPU via native-gles (glide64), not software

parallel_n64 now renders the RDP through **glide64 → GLES2/WebGL2 → native-gles** (the
real GPU, headless EGL pbuffer), replacing the angrylion software-RDP build. SET_HW_RENDER
fires, the host's LibretroGL drives native-gles, and frames read back via glReadPixels —
the same GPU path as Flycast/Dreamcast. (Verified: hwActive=true, the GL context engages
from boot.)

The build + host fixes that made it work (every one was a real wall):
- **Link all .o directly**, not via a .bc/.a archive — the archive route drops the
  GLSM/context_reset/glide64 objects (no externally-referenced symbol), so the core never
  calls SET_HW_RENDER. (build-parallel-n64.sh)
- **`-lGL` + `GL_ENABLE_GET_PROC_ADDRESS=1` + `"GL"` in EXPORTED_RUNTIME_METHODS** — these
  make Emscripten emit `Module["GL"]=GL`, so the returned module actually exposes the GL
  context object the host needs. Without them, `mod.GL` is undefined and HW render never
  initializes.
- **coreLoader: don't set `noInitialRun`/`wasmBinary` for GL (canvas) cores** — both
  suppress the Emscripten GL runtime init; use `locateFile` so the .wasm loads the normal way.
- **Pre-seed PLATFORM_CORE_OPTIONS before `_retro_init`** (loadCore now infers the platform
  from the core filename): the core picks its renderer (glide64 vs angrylion) from
  `parallel-n64-gfxplugin` during retro_init, so the override must be set before then.
- Registry: n64 is now `hwRender:true` (glide64 GL).

## 0.67.0 — 2026-06-26

### Dreamcast examples + sh-c -O level fix

Four DC example programs (rom-games/dreamcast/): dchello (test card), bounce (animation),
starfield (shmup background), grid (puzzle/board) — all build via the WASM toolchain and
render distinct content through Flycast, exercising the dc.h helper (no-KOS PowerVR2
framebuffer + 2D primitives).

sh-c driver: a user-supplied `-O<level>` now wins over the default `-O2` (gcc honors the
LAST -O, so a default appended after the user's would clobber it — only add -O2 if absent).
This matters because the WASM cc1 hangs at -O2 on some sources (the interprocedural-
optimization phase; native sh-elf-gcc compiles them in <1s), and -O1 is the workaround.
Suite 1059/1059.

## 0.66.0 — 2026-06-26

### Dreamcast: build() works — full WASM toolchain + packaging

`build({platform:"dreamcast"})` now compiles SH-4 C to a bootable ELF entirely in WASM,
and the result boots + renders through Flycast — the complete zero-install pipeline
(build → run → screenshot), verified end-to-end via the public `buildForPlatform`.

- **sh-elf-gcc WASM toolchain** (cc1 + as + ld + objcopy + objdump): gcc 14.2.0 +
  binutils 2.42 + newlib 4.4.0 for sh-elf (little-endian SH-4, m4-single-only). The cc1
  build needed CC_FOR_BUILD forced native (emconfigure makes $(CC)=emcc, which would
  build the gen tools as WASM) + the host-side libcpp/libiberty configured first.
- **sh-c build driver** + lib (dc-crt0.s zeroes .bss + calls main; dc.ld links at
  0x8c010000; newlib libc/libm/libgcc). The ELF IS the deliverable — reios boots it.
- **Packages:** romdev-core-flycast (the DC core) + romdev-toolchain-sh-gcc (the WASM
  compiler), both added as romdevtools deps; the registry resolves the DC core from the
  package. Manifest `dreamcast.build` is now true.

Dreamcast core parity reached: disasm + decompile + build + run + screenshot. Suite
1059/1059.

## 0.65.0 — 2026-06-26

### Dreamcast: homebrew renders correct graphics + HW-frame crop-to-native

A minimal DC homebrew (no KallistiOS — a dependency-free `dc.h` helper that programs the
PowerVR2 FB_R_CTRL/FB_R_SIZE/FB_R_SOF1 + SPG for a 640x480 RGB565 framebuffer) builds with
the native sh-elf toolchain, boots via reios HLE, runs, and renders a test pattern that the
host captures **pixel-exact** (verified: dark-blue background + equal red/green/blue bars +
white frame, the program's exact colors). This closes the DC render-fidelity loop.

Host change (helps any HW-render core): the video_refresh callback now records the core's
reported active resolution, and the GL readback crops the FBO to it — so a 640x480 DC frame
no longer comes back as the full 853x853 GL viewport with a dead border. `readbackFrame`
takes optional (cropW, cropH); `_afterRun` passes the core's w/h. Suite 1059/1059.

## 0.64.0 — 2026-06-26

### Dreamcast: present-path verified — screenshot works

Flycast renders to the GL FBO and the host reads it back: a framebuffer-writing homebrew
program shows ~727k captured pixels through the host's normal frame path (hwFramePending →
readbackFrame). Manifest `dreamcast.screenshot` is now true. With the CPU executing
(0.63.0), the direct-framebuffer present path lights up.

Added `flycast_emulate_framebuffer: enabled` to the host's DC options — it scans the DC
framebuffer out on every VBlank (the 2D path, no PowerVR2 tile list), so simple homebrew
that writes RGB565 to VRAM presents reliably without authoring a full TA list. (Full
TA/3D fidelity + correct framebuffer addressing come with the KOS helper lib; the pipeline
itself — boot → run → render → host capture — is proven end-to-end.) Suite 1059/1059.

## 0.63.0 — 2026-06-26

### Dreamcast: HOMEBREW EXECUTES — run + memory introspection live

Custom Flycast core patches make the SH-4 actually execute guest code. A homebrew .elf
boots via reios HLE, the SH-4 runs it, and the guest's RAM writes are visible through the
host (verified: a 0xDC0DC0DC marker the test program writes appears in DC RAM). Manifest
`dreamcast.run` is now true.

Root cause (3 stacked bugs): (1) worker-thread aborts — fixed by single-thread +
`--wrap pthread_create` no-op (0.62.0); (2) HLE BIOS off — only the reios path loads a raw
.elf, and the option is latched at retro_init, so default `UseReios=true` in source for
emscripten; (3) THE BIG ONE — `ThreadedRendering` defaulted ON, which runs the CPU on a
`std::async` worker that our pthread no-op kills → the SH-4 never steps (PC stuck at the
reset vector, reios_boot never fires, RAM stays zero). Fixed by unconditionally
`config::ThreadedRendering.override(false)` for emscripten in update_variables.

`screenshot` stays false until the PowerVR2 present-path is verified with a TA-driving
program (the KOS helper lib — next phase). All patches reproducible in build-flycast.sh.
Suite 1059/1059.

## 0.62.0 — 2026-06-26

### Dreamcast run-side BREAKTHROUGH: Flycast boots + runs DC ELFs

The threading wall is solved. Flycast (the full DC emulator) now **boots a homebrew
.elf via reios HLE and runs frames** through the romdev host — `retro_init` /
`retro_load_game` / `retro_run` all succeed, av_info reports 640×480, and video_refresh
fires every frame. No abort, no `unwind`.

The fix (after trying PROXY_TO_PTHREAD + ASYNCIFY, which deadlocks in Node on the
GL↔proxy-thread dependency): build single-threaded and **`--wrap` pthread_create to a
no-op** (`scripts/patches/romdev-snippets/flycast-pthread-noop.c`). pthread_create
returns success but spawns nothing; join/detach are no-ops. So flycast's worker threads
(achievements/http/network/audio-async) never run, `std::thread`'s ctor doesn't abort
(no "thread constructor failed"), and — crucially — the main thread never blocks on a
worker, so there's no emscripten `unwind`. Emulation runs synchronously on retro_run
(ThreadedRendering defaulted false). This is far cleaner than stubbing thread sites
one-by-one (there were 4+ wrapper classes plus raw std::thread/std::async).

Also: the GL `get_proc_address` bridge fix (0.59.0) is what got context_reset past the
signature mismatch; the 512MB-mmap fallback (posix_vmem) got init past the trap.

NEXT: a DC program that actually renders via PowerVR2 (the KOS helper lib) to verify the
present path end-to-end, then flip run/screenshot true. Captured in build-flycast.sh.
Suite green.

## 0.60.0 — 2026-06-26

### Dreamcast: SuperH4 SLEIGH metadata shipped + Flycast threading progress

- **SuperH4 SLEIGH metadata committed** (`.ldefs`/`.pspec`/`.cspec`) — these ship
  alongside the gitignored `.sla` (like every other CPU); without them the decompiler
  couldn't load the SuperH4 spec at runtime. (0.57.0 shipped the wiring but missed the
  metadata files. Now complete.)
- Flycast run-side threading: the single-threaded WASM build needs worker-thread
  creation stubbed (emscripten can't spawn them without -pthread; with -pthread the
  main thread can't block → unwind). Captured the patches in `build-flycast.sh`
  (`cThread::Start` / `VPeriodicThread::start` no-op, `ThreadedRendering` defaults
  false on emscripten) + the `flycast_threaded_rendering: disabled` host option.

KNOWN-OPEN: Flycast's load still aborts on a not-yet-located worker thread (no-pthread)
or unwinds (pthread). The thread/main-loop model integration is the remaining run-side
fight — see N64_PS1_LESSONS_FOR_DREAMCAST.md. DC analysis (disasm+decompile) is fully
shipped + tested. Suite 1059/1059.

## 0.59.0 — 2026-06-26

### Dreamcast run-side: Flycast loads ELFs + GL bridge fix (general)

Flycast WASM now boots a homebrew `.elf` (reios HLE — no BIOS/disc) and requests GL:
- threads: `-pthread -sPTHREAD_POOL_SIZE=8` (Flycast spawns std::threads; without
  pthreads the ctor aborts). The pthread build bakes the module filename into the
  worker bootstrap, so it MUST link with the final `flycast_libretro.js` name.
- **GL proc-address (general bridge fix in LibretroGL.js):** emscripten-WebGL cores
  (Flycast) resolve GL via libretro `get_proc_address`. The bridge previously returned
  a no-op 0-arg stub → the core called multi-arg GL fns through it → "null function or
  function signature mismatch" in context_reset. Now the bridge returns the real
  `emscripten_GetProcAddress` table pointer (built with `-sGL_ENABLE_GET_PROC_ADDRESS=1
  -lGL`); the native-gles stub path stays as the glide64-N64 fallback. This fix helps
  ANY future emscripten-WebGL core.
- `ROMDEV_CORE_LOG=1` env gates core stdout/stderr (was always suppressed) — found the
  thread + mmap aborts with it.

KNOWN-OPEN: `retro_run` throws emscripten's `unwind` (Flycast yields via
emscripten_set_main_loop / Asyncify, incompatible with the host's synchronous
frame-step). That main-loop integration is the next run-side step. Suite 1059/1059.

## 0.58.0 — 2026-06-26

### Dreamcast run-side: Flycast WASM core builds + inits; sh-elf toolchain built

The two heaviest Dreamcast pieces, both landed (build infrastructure; host present-path
integration is the next step):

- **sh-elf-gcc toolchain** (SH-4): binutils 2.42 + gcc 14.2.0 + newlib 4.4.0, built
  for `sh-elf` (m4-single-only, little-endian — the DC ABI). Compiles SH-4 C end to
  end. `scripts/build-sh-toolchain.sh` (adapted from the mips one; SH-4 is single-
  endian so no be/el split).
- **Flycast → WASM**: the full Dreamcast emulator (785 C++ files, GLES3/WebGL2)
  compiled to a 5.9MB WASM module that instantiates with all libretro entry points
  and `retro_init` succeeds. Flycast has no upstream emscripten build, so
  `scripts/build-flycast.sh` applies the romdev WASM patches discovered here:
  - a `CPU_GENERIC` host (no JIT) → the SH-4/ARM/DSP interpreters (`TARGET_NO_REC`);
    CMake `DetectArchitecture` + `build.h` + the FPU-control / JIT-segfault-recovery
    arch branches all get a generic no-op path.
  - asio single-threaded (`ASIO_DISABLE_THREADS`) so it doesn't need POSIX
    signal_blocker/tss_ptr (emscripten without -pthread isn't detected as POSIX).
  - Vulkan OFF (WASM uses WebGL); networking/UPnP stubbed.
  - **the key boot fix:** emscripten can't `mmap` a 512MB contiguous reservation (it
    traps), so `posix_vmem::init` declines fast-vmem on emscripten → Flycast's
    malloc-based memory fallback engages and `retro_init` succeeds.
- `dreamcast` registry entry (Flycast, hwRender — PowerVR2 is GPU-first, no software
  framebuffer; HLE reios BIOS, no firmware to ship).

Suite 1059/1059. Next: the GL present-path (load_game + run + frame through the host's
WebGL2 bridge), then the helper lib + 5 example games + packaging.

## 0.57.0 — 2026-06-26

### Dreamcast (SH-4) analysis slice — disasm + decompile

First slice of Dreamcast support: the SH-4 (SuperH) reverse-engineering path, on the
same pattern as the PS1/N64 analysis slice.

- rizin's `sh` plugin (already in rizin.wasm) wired for disasm/cfg/xrefs/functions
  (arch=sh, little-endian).
- Ghidra's **SuperH4** SLEIGH spec compiled (`SuperH4_le.sla`) + shipped in
  romdev-analysis-decompiler → `decompile` produces real C (langid
  `SuperH4:LE:32:default`). Verified: SH-4 bytes → disasm + decompiled C.
- analyze.js handles DC binaries: strips an ELF to its first PT_LOAD segment (vaddr =
  loadBase 0x8c010000) or treats a raw image as flat; left-pads so flat offset ==
  the VA's low bits + rebases the high bits (same trick PS1 needed for absolute-
  addressed calls — SH-4's PC-relative + absolute addressing needs it too).
- `dreamcast` added to the capability manifest as the new `sh` tier (analysis-first;
  run/build/etc. land in later phases). The 3D (PowerVR2) renderer's tile/sprite
  inspectors are N/A by hardware with a stated reason. Excluded from the all-14
  contract via the generalized NEXTGEN_TIER (mips + sh).

Suite 1059/1059. Run-side (Flycast WASM), build (sh-elf-gcc), the helper lib, and the
5 example games are the next phases.

## 0.56.1 — 2026-06-26

### ascii screenshot: legible default grid + lighter default color (0.44.0 feedback #1)

`frame({op:'screenshot', format:'ascii'})` defaulted to a `fb/16` grid (16×14 for a
256×224 NES frame — too coarse to read any game state) AND truecolor (`38;2;r;g;b`
per cell, ~7.9KB of escapes). So the "cheap text screenshot" was both expensive and
useless for an "are we in gameplay?" check.

- default grid is now `fb/8` (one cell per 8×8 tile → 32×28 for NES, legible).
- default `colors` is now `'256'` (indexed) instead of `'true'` — near-identical read,
  far fewer escape bytes. Net for the NES case: 4× more cells AND ~55% smaller
  (7876B → 3551B).
- when a caller forces a grid too coarse to show state, the result carries a `note`
  pointing at `memory({op:'read'})` as the cheaper exact path for a pass/fail check.

## 0.56.0 — 2026-06-26

### N64 + PS1 are now SHIPPABLE: core packages + toolchain wired for publish

The functionality was done, but the artifacts weren't distributable — the cores lived
only in the gitignored dev-staging dir, with no npm package to publish. Fixed:

- **New `romdev-core-pcsx-rearmed`** (PS1) and **`romdev-core-parallel-n64`** (N64,
  headless-angrylion software) packages, mirroring the 14's structure (package.json
  + index.js + README + gitignored `wasm/` shipped via the `files` allowlist +
  verify-wasm prepublish guard). These are CUSTOM romdev builds (the romdev debug
  exports + IPL3) — documented in each README + built by scripts/build-*.sh.
- **`romdev-toolchain-mips-gcc`** moved to required `dependencies` (build needs it);
  the two cores added to `dependencies` (always installed, like the 14). lockfile
  regenerated — `npm ci` passes.
- publish-all.mjs now discovers all 3 (26 packages total).

### A real shipping bug the npm-pack smoke test caught

The cores' Emscripten glue had a DEV SCRATCH wasm name baked in (`pcsx_vram.wasm`,
`pn64_sw.wasm` from `-o $SCRATCH/...`) instead of the published `*_libretro.wasm`.
The host always passes `wasmBinary` so it worked in dev — but any consumer loading
the factory directly got ENOENT. Re-linked both glues with the correct `-o` name (the
build scripts already used it; only my hand-links were wrong). A clean-install smoke
test (npm pack → install into a bare dir → resolve + instantiate + check exports) +
a packaging contract test now pin this so it can't silently regress.

Verified: clean-install smoke test passes, full build→load-from-package→run→render
pipeline works for both, npm ci + lint + 1054/1054 tests green. Ready for `npm publish`.

## 0.55.0 — 2026-06-26

### System manifests now call out the features a platform CAN'T have (and why)

A bare `inspectSprites: false` in the capability manifest is ambiguous — an agent
can't tell "N/A by hardware, permanent" from "a decoder we haven't built." For the
14 tile-based systems this never bit (they support those ops); for the framebuffer
(PS1) / 3D (N64) systems, FOUR ops are false with no stated reason.

- New `naReason(platform, op)` in the capability manifest returns a HARDWARE-grounded
  explanation, keyed on `renderingKind`: a framebuffer/3D renderer has no tile/
  sprite-attribute/nametable/palette tables for the tile-era inspectors to read —
  those ops are *meaningless on the hardware*, not merely absent. (PS1 `cart` →
  "disc-based, no cartridge ROM".)
- `platform({op:'capabilities', platform})` now includes a `naReasons` map alongside
  `ops`, so the manifest itself states what each platform can't do + why.
- The `unsupported()` signal from inspectSprites/inspectPalette/inspectBackground/
  renderingContext now carries that hardware reason instead of a generic "no decoder
  for this platform" — an agent gets "this is a 3D renderer, there are no sprite
  tables" and won't retry or request a decoder that can't exist.
- Conformance test pins it: every false introspection op on ps1/n64 must carry a
  hardware-grounded N/A reason. Suite 1054/1054.

## 0.54.0 — 2026-06-26

### Audit: two real N64/PS1 parity gaps found + fixed

A full per-tool audit (all 32 tools, live-probed on both platforms) surfaced two
genuine gaps where the platform was CAPABLE but the tool didn't deliver:

1. **PS1 reverse-engineering returned bogus addresses.** `disasm`/`cfg`/`xrefs`/
   `functions`/`decompile` on a PS1 PS-EXE found a single fake `fcn.00000000` at
   file offset 0 (not the real 0x80010000+ VA), and `decompile` then threw "address
   maps outside the image." Root cause: rizin ignores `-B` on a raw buffer, so the
   stripped .text was analyzed flat from 0, and PS1's ABSOLUTE jal targets dangled →
   no cross-function discovery. Fix: left-pad the .text so flat offset == the VA's
   low 20 bits (jal-following now works) and add the high bits back as a rebase, so
   every reported address is a real VA that round-trips. PS1 now finds all functions
   (16 vs 1) at correct VAs, CFG/xrefs/decompile all resolve. (N64 was already fine.)

2. **PS1 `video_ram` was claimed but empty.** The manifest lists `video_ram` for
   every platform, but pcsx_rearmed never exposed the GPU VRAM. Added a
   `romdev_vram_get` export (1024×512×16bpp) wired into `memory({region:'video_ram'})`
   — PS1 GPU VRAM is now readable (verified: rendered pixels show up).

Everything else in the audit was already at parity or genuinely N/A-by-hardware
(the tile/sprite/nametable/palette inspectors need tables a framebuffer/3D renderer
doesn't have; `cart` is for cartridge ROMs). save/loadState, runUntil, frame-verify,
romPatch, and the agnostic art/snippet tools all work on both. Suite 1053/1053.

## 0.53.0 — 2026-06-26

### N64 + PS1 reach EXAMPLE parity: 5 full genre games each

Both new platforms now ship the same caliber of bundled, playable examples as the
other 14 (parity = "5 decent full games"), registered in project.js and forkable +
buildable through the normal createProject/build tool flow.

**PS1** (4 × 3D + 1 × 2D, on a software 3D engine + the GPU): shmup STARFALL,
racing POLE BENDER (a real receding 3D road), platformer BLOCK HOP, sports
SLAM COURT (3D pong/air-hockey), puzzle DROP GRID (2D — the right idiom for a grid).

**N64** (all 5 × 3D — the N64 was a 3D-first machine, so even the puzzle is a 3D
well of cubes): STARFALL 64 / POLE BENDER 64 / BLOCK HOP 64 / SLAM COURT 64 /
DROP GRID 64, on the same software-3D lib with a framebuffer backend the
headless-angrylion core scans out.

Every example builds + boots + renders, verified on the actual cores (frames
inspected). The N64 path required the three earlier breakthroughs (self-booting
.z64 via a clean IPL3, a headless-angrylion GL-free core, and the VI-scanout
software rasterizer). Suite 1052/1052.

**This completes N64 + PS1 parity** — every tool the other 14 have works, and both
ship 5 full idiomatic examples.

## 0.51.0 — 2026-06-26

### N64 audioDebug — FULL parity (zero functional gaps)

- **`getAudioState({chip:'ai'})`** decodes the N64 Audio Interface: sample rate
  (from DACRATE + the VI clock), whether audio is playing (a buffer is DMA-queued),
  the DMA source address. (N64 audio is RSP-mixed, so the AI is the OUTPUT state, not
  per-voice — that lives in game-specific RSP audio lists in RDRAM.) Verified: a real
  ROM reports `playing:true, sampleRate:32006`. From a `romdev_ai_get` export added
  to parallel_n64. n64 `audioChips:['ai']`, `audioDebug:true`.

**This closes the last functional gap.** A programmatic audit confirms N64/PS1 now
match the canonical 14 on every applicable op — build, run, screenshot, memory,
cpuState, audioDebug, disasm, decompile, cheats, breakpoint, watch. The only manifest
differences are N/A BY HARDWARE: the tile/sprite/nametable/palette inspectors
(framebuffer/3D renderers have no such tables) and `cart` (disc-based). Suite 1052/1052.

## 0.50.0 — 2026-06-26

### PS1 SPU audioDebug

- **`getAudioState({chip:'spu'})`** decodes the PS1 SPU's 24 ADPCM voices (per-voice
  volume L/R, pitch→Hz, ADSR, key-on/off + main volume + control), from a
  `romdev_spu_get` export added to pcsx_rearmed (copies the SPU regArea). Verified:
  a toolchain-built program's SPU register writes read back correctly.
- ps1 `audioDebug:true` in the manifest.

**Parity status (N64/PS1 vs the canonical 14):** at parity on build, run, screenshot,
memory, cpuState, disasm, decompile, cheats, breakpoint, watch (+ PS1 audioDebug).
Genuinely N/A by hardware: the tile/sprite/nametable/palette inspectors (framebuffer/3D
renderers have no such tables) and `cart` (disc-based). **Remaining real TODO:** N64
audioDebug (the RSP/AI audio path — a deeper decode than the PS1 SPU register block).

## 0.49.0 — 2026-06-26

### N64 + PS1 live-debug — breakpoint + watch now work

The remaining big parity gap: the live-debugging RE tools. parallel_n64 (R4300) and
pcsx_rearmed (R3000) are rebuilt with romdev's CPU instrumentation, so:

- **`breakpoint({on:'pc'|'write'|'read'})`** + **`watch({on:'range'|'mem'})`** work on
  both MIPS platforms — verified live: a C program (built by the romdev toolchain)
  writing to a known address is caught by a write watchpoint with the writing PC, and
  a range watch captures the write stream during emulation.
- A `romdev_debug.c` instrumentation unit (per core) hooks the memory write/read paths
  (write/read watch + range watch + coverage) and the interpreter step (PC break +
  single-step). Exports the full `romdev_watchpoint`/`readwatch`/`pcbreak`/`range`/`cov`/
  `regsnap`/`watchdog` set the host already expects — so the host needed ZERO changes
  (its debug methods were already generic).
- Reproducible via the updated build-pcsx-rearmed.sh / build-parallel-n64.sh
  (patch the source + hooks + exports).

**Remaining honest gap:** `audioDebug` (PS1 SPU / N64 audio chip decoders) is still
TODO. The tile/sprite/nametable inspectors stay N/A by hardware (framebuffer/3D
renderers have no such tables). Everything else is at parity. Suite 1050/1050.

## 0.48.0 — 2026-06-25

### N64 + PS1 `build` op — full feature parity

The last missing op. N64 and PS1 now **build** C from source, completing parity
with the 14 (every op: build, run, screenshot, memory, disasm, decompile, cheats,
cpuState).

- **A from-scratch `mips-elf` GCC toolchain compiled to WASM** — binutils 2.42 +
  gcc 14.2.0 + newlib 4.4.0, the same two-stage pipeline as the Genesis m68k
  toolchain. STAGE 1 builds it natively; STAGE 2 re-compiles cc1/as/ld/objcopy/
  objdump to WASM. One toolchain serves both endiannesses (cc1 `-mel`/`-meb`,
  as/ld `-EL`/`-EB`).
- **`buildSource({platform:'ps1'|'n64', language:'c'})`** — cc1 → as → ld → objcopy,
  links a minimal crt0 + libc/libm/libgcc. PS1 wraps the image in a PS-EXE the HLE
  BIOS loads; N64 emits a big-endian flat image. **Verified end-to-end:** a C program
  compiled by the toolchain boots and renders on the PS1 core (GPU fill executed).
- Four GCC-15/emscripten build incompatibilities fixed along the way (all in the
  build scripts): binutils `static_assert`-as-identifier (`-std=gnu11`), newlib
  libgloss pre-C23 idioms (permissive target CFLAGS), libiberty `psignal` conflict
  (source patch, both gcc + binutils copies), and the `all-gcc`/`all` aux-tool
  targets pulling in ftw/gprofng (build the specific `cc1`/`as`/`ld` targets).
- New `romdev-toolchain-mips-gcc` package (the WASM tools); pinned + reproducible
  via `build-mips-toolchain.sh` + `build-mips-wasm-tools.sh`.

**Caveats:** the bare build path has no SDK yet — PS1 is "drive the GPU/SPU
registers yourself" (PSn00bSDK forthcoming); N64 compiles+links but a self-booting
cart needs IPL3 + a libdragon header (libdragon forthcoming). Both are logic/RE-
complete and the foundation for the SDKs. The framebuffer/3D renderers have no
tile/sprite inspectors by nature.

## 0.47.0 — 2026-06-25

### N64 + PS1 reach feature parity (cheats + cpuState + decompile)

The MIPS tier now matches the 14 on everything except `build`:

- **MIPS decompile** — `disasm({platform:'n64'|'ps1', target:'decompile'})` produces
  real Ghidra C pseudocode. **No Python**: the stock Ghidra MIPS SLEIGH spec is
  compiled to `.sla` (MIPS:BE:32 for N64, MIPS:LE:32 for PS1) by the same
  `sleigh_opt` that builds the other 8 CPU tables. (m2c/Pyodide was rejected — it
  would drag a CPython runtime into the tool.)
- **cpuState** — `cpu({op:'read'})` decodes the live R4300 (N64) / R3000 (PS1)
  register file: 32 GPRs by o32 ABI name + lo/hi + PC. Backed by a tiny
  `romdev_mips_regs_get` appended to each core's `libretro.c` (the new
  `build-parallel-n64.sh` / `build-pcsx-rearmed.sh` recipes).
- **cheats** — `_retro_cheat_set`/`_retro_cheat_reset` are now exported from the
  rebuilt cores (they were in the upstream C, just unexported).
- The cores are reproducible: pinned in `versions.json`, built by the new recipes
  (clone → append the regsnap → emcc with the cheat+regsnap exports; the regsnap is
  `EMSCRIPTEN_KEEPALIVE` so LTO doesn't strip it).

**Parity scorecard** — N64 & PS1 now have: run, screenshot, memory r/w, disasm
(cfg/xrefs/functions), decompile, cheats, cpuState. The one remaining op is
**build** (a MIPS GCC→WASM toolchain — PSn00bSDK/libdragon — the largest separate
piece). The framebuffer/3D renderers have no tile/sprite/nametable inspectors by
nature.

## 0.46.0 — 2026-06-25

### N64 + PS1 run-side: boot, run, render (the MIPS tier goes live)

Past analysis-only — N64 and PS1 now **boot, run, and present real frames** through
the host. The 32-bit MIPS tier is a new partial tier (`tier:"mips"`), distinct from
the canonical 14.

- **N64** (ParaLLEl-N64, HW 3D render) — `run` + `frame({op:'screenshot'})` produce
  real 3D frames headlessly via a GL framebuffer readback. Rendering goes through a
  ported GL bridge (`LibretroGL`/`LibretroGLBridge`) backed by `native-gles` +
  `webgl-node`, which are **optionalDependencies**: lazy-loaded only when an N64/PS1
  core boots, so the 14 software platforms and headless installs without the GPU
  module are completely unaffected (clear install hint if absent).
- **PS1** (PCSX-ReARMed, software + **built-in HLE BIOS**) — `run` + screenshot with
  zero firmware to ship, no GL dependency. Loads PS-EXE (and disc images).
- **Memory** works for both: `readMemory`/`writeMemory` on `system_ram` (N64 = 8MB
  RDRAM, PS1 = 2MB main RAM) — poke values directly.
- **Static RE** (from 0.45.0) still works: `disasm({platform:'n64'|'ps1',
  target:'rom'|'functions'|'cfg'|'xrefs'})`.
- N64 `.v64`/`.n64` byte orders auto-normalize to `.z64`; PS-EXE headers are stripped.

Three GL-binding bugs fixed to get frames on screen: the Emscripten `getContext`
shim's `instanceof WebGLRenderingContext` check (needs WebGL1 to be a distinct
class), the signed-vs-unsigned `RETRO_HW_FRAME_BUFFER_VALID` compare, and the
all-transparent FBO alpha (forced opaque in a new RGBA decode path).

**Still pending** for full parity (honestly off in the manifest): `build` (needs a
MIPS toolchain — PSn00bSDK/libdragon), `decompile` (needs a MIPS SLEIGH spec in the
decompiler — slaspec sources exist, a decompiler-package rebuild), `getCPUState` +
`cheats` (need a core rebuild exposing those exports). The framebuffer/3D renderers
have no tile/sprite/nametable inspectors by nature.

## 0.45.0 — 2026-06-25

### PS1 + N64 analysis-first (the 32-bit MIPS tier)

The first step past the GBA-era line: static RE for PlayStation (R3000) and
Nintendo 64 (R4300), via the MIPS plugin already in the shipped `rizin.wasm` — no
new core, no toolchain, no GPU bridge in this slice.

- **`disasm({platform:'ps1'|'n64', target:'functions'|'cfg'|'xrefs'|'rom'})`** —
  works on real ROMs. Verified: a libdragon N64 homebrew (`FlappyBird.z64`)
  recovers 251 functions with control-flow graphs and cross-references. The raw
  N64 ROM has no entry `aaa` recognizes, so MIPS analysis is seeded at the
  post-IPL3 code start (`af` + `aac`) — `aaa` finds 0, the seed finds the tree.
- **Endianness is wired right:** PS1 is little-endian, N64 is big-endian (same
  `mips` arch). N64 `.v64`/`.n64` dumps are auto-normalized to `.z64` byte order;
  PS1 PS-EXE headers are stripped to the load address.
- **Capability manifest:** `ps1` (framebuffer) / `n64` (3d) are an analysis-only
  tier — `disasm` true; run-side ops (build/run/screenshot/the tile/sprite
  inspectors) and `decompile` false. The tile/nametable inspectors are meaningless
  on a framebuffer/3D renderer, so an agent gets the clean `unsupported()` signal.
- **`decompile` (C pseudocode) is NOT available yet** for MIPS — the rz-ghidra
  decompiler ships no MIPS SLEIGH spec (adding `MIPS.sla` is a later
  `romdev-analysis-decompiler` rebuild). It returns a clear steer to the working
  disasm targets, not a cryptic failure.

## 0.44.0 — 2026-06-25

### v0.41.0 feedback (part 2) — RE-session ergonomics

- **`watch({on:'range'})` dedupe + digest.** A range watch over a churny window
  flooded with per-frame writes (a counter inc'd at one PC → hundreds of
  near-identical rows). New `dedupe:true` collapses identical `(pc,address,value)`
  events to one row with an `occurrences` count (parity with `on:'dma'`), and
  `distinctPCsOnly:true` returns JUST the per-PC digest (`byPC[{pc,count,
  sampleAddress,sampleValue}]`) and suppresses the raw event list — the
  token-cheap "which routines touch this range?" answer. (133737 N1)
- **`catalog({op:'status'}).capabilities` build-toolchain flags.** Added
  `cc65Build`, `ld65Link`, `da65Disasm` so an agent knows before calling
  `build`/`disasm` whether the toolchain is present (the analysis subtargets
  cfg/xrefs/functions/decompile are all da65-backed). (184553 #1, 190223 #1)
- **`cheats` slot lifecycle.** `apply` now REPLACES an active freeze on the same
  address instead of stacking a second one that fights for the byte
  (`replacedSameAddress`), and new `op:'remove'` drops ONE cheat by slot/code
  without `clear`'s nuke-all. (213831 #3)
- **`breakpoint` `settleFrames`.** Back-to-back driven runs on the same live host
  could inherit the prior run's held-button shadow on frame 0 (false-positiving a
  negative control). `settleFrames:N` releases the pad to neutral and steps N
  frames before the run so it starts clean. (213831 #1)
- **`breakpoint({on:'pc'})` miss-note** now names the negative-control case: a
  `hit:false` may be the DESIRED result (proving input X does NOT reach a branch),
  not a wrong-address failure. (213831 #2)
- Confirmed already shipped (0.42.0): hex-string `address`/`offset` params, the
  base capabilities map. (133737 N2, 002129 #2)

## 0.43.0 — 2026-06-25

### Port engine is now GENERIC (any source → any target), not NES→SNES-only

The recompiler was rebuilt around a small intermediate representation (IR): a
LIFTER turns a source-CPU disassembly into IR; an EMITTER turns IR into target-CPU
assembly. Adding a platform PAIR is now one lifter + one emitter, not a bespoke
recompiler. NES→SNES and the new NES→Genesis run through the *same* pipeline.

- **`disasm({target:'recompile', targetPlatform})`** — `'snes'` is the 1:1
  emulation-mode port (with the PPU shim/runtime render layers); **`'genesis'` is a
  real 6502→68000 LOGIC translation** — `lda #$42`→`move.b #$42,d0`,
  `sta $0010`→`move.b d0,($FF0010).l`, branches/jsr/jmp mapped, the NES address
  space mapped into Genesis work RAM at `$FF0000` (which IS the Tier-1 RAM-diff
  oracle's mirror). Verified end-to-end: a real NES homebrew's reset routine
  translates to m68k (0 residue), builds with vasm68k, and BOOTS in gpgx with the
  translated logic executing (RAM writes land).
- The presentation seam (PPU/APU) is stubbed for non-SNES targets — it's a LOGIC
  port; verify with `frame({op:'compareRam'})` vs the NES original. A render
  runtime per target is a later layer (NES-PPU-on-SNES is the template).
- Unsupported targets fail with the supported set. `recompileNesToSnes` now
  delegates to the generic engine (same image; existing SNES tests unchanged).
- New: `src/analysis/recompile/` (ir, lift-6502, emit-65816, emit-m68k, index).

## 0.42.0 — 2026-06-24

### v0.41.0 feedback batch + the NES→SNES port engine

A round driven by RE-session feedback (cheats, ergonomics, the human-playtest
eviction case) plus the flagship port-engine work.

#### Fixed — `cheats` raw RAM codes were inert

`cheats({op:'make'})` for a sub-`$0100` RAM address emitted the short `32:09`
form, which libretro cores PARSE but never bind — and `apply` then falsely
reported `applied:true`. `encodeRaw` now pads the address to a binding width
(`0032:09`); `apply` re-encodes a hand-typed short code too. Verified on fceumm.

#### New — hex-string forms on address params

A hex literal in a JSON arg (`address: 0xC06C`) was a hard parse error. All
address-like params (`address`/`offset`/`pc`/`compare`/…) now accept the STRING
forms `"0xC06C"` / `"$C06C"` / decimal strings, coerced before validation —
centralized so every tool gets it.

#### New — `catalog({op:'status'}).capabilities`

A map of which debug ops the loaded core/toolchain implement (pcBreakpoint,
watchpointExact, rangeWatch, cheats, da65Toolchain, …) so an agent picks a
working trace strategy up front instead of probing by failure.

#### New — `callStack` on breakpoint hits (13 of 14 platforms)

`breakpoint({on:'pc'|'write'})` hits carry a decoded call stack: the server walks
the stack from the captured stack pointer and returns each caller PC. Covers the
6502 family (JSR-opcode validated), m68k (Genesis — 4-byte BE return), and Z80/
SM83 (SMS/GG/MSX/GB/GBC — 2-byte LE return). GBA (ARM) is the lone exclusion: its
calls return through the link register, not the stack.

#### New — `references` finds inline jump-table / trampoline call sites

When no `jsr/jmp/branch` names a CODE address (it's reached via a computed jump),
`references` now scans the raw ROM for the address as a 16-bit pointer (LE/BE) and
reports `tableHits`. Per-platform header skip (NES/SNES/7800/Lynx); the 6502
RTS-trick `addr-1` form is scanned only on the 6502 family.

#### New — `disasm({target:'pointerTable'})` (all mapped platforms)

Static index→handler decode of a jump/pointer table: contiguous `dw`, SPLIT
lo/hi arrays at two bases, the RTS-trick (`+1`), and a REVERSE lookup (handler →
dispatch index). The static complement to the live `breakpoint({on:'jumptable'})`.
Works on every platform with an address mapper (nes/snes/sms/gg/gb/gbc/2600/7800/
c64/genesis); the endian default follows the CPU (Genesis/m68k → BE).

#### New — playtest eviction survivability

While a playtest window is open, romdev rolls a `.state` to disk every ~15s (and
on F2), so a session eviction can't lose a human's manual progress — the recovery
hint points at `state({op:'load', path})`. Surfaced in `playtest({op:'status'})`.

#### Leaner schemas

The last inline 62-value region enum in the watch/breakpoint tool schemas is now
a runtime-validated string — the full enum lives once on `memory`'s `region`.

#### Port engine — NES→SNES static recompile renders + plays

`disasm({target:'recompile'})` now draws the original ROM's screen on SNES
(`withShim`, phase-1 static — fixed the `cpx.w` upload bug) and animates sprites
+ runs the game's NMI each vblank (`withRuntime`, phase-2 live). The recompiler
follows the real reset vector and anchors the entry to the routine's first
instruction. (Plus the `frame` port-compare oracles: compareRam/compareRender/
findDiverge/portStatus + side-by-side two-core capture.)

## 0.41.0 — 2026-06-12

### RE engine round — bank-aware decompile, live jumptable recovery, readable 6502 output

A correctness + readability pass across the whole reverse-engineering engine,
plus the differentiator no static tool has: **resolving computed jumps with the
live emulator.** All 14 platforms; no `romdev-analysis*` package changes (the
work is in the address-mapping JS, the decompile post-passes, and the live-debug
tools).

#### New — `breakpoint({on:'jumptable', address})`: live computed-jumptable recovery

Static analysis follows direct addressing only, so a game's *hottest* routines —
state machines, script / event VMs, battle engines that dispatch through
`JMP (table,X)` or an RTS-trick — decompile to `(*_IRQ)()` + "Could not recover
jumptable." romdev has a **live emulator**, so it resolves them dynamically: break
at the dispatcher, single-step through the indirect transfer, and record the PC
it actually lands on — accumulated across frames/inputs. Fixed trampolines (the
compiler's pointer-call shim, return paths) are filtered out by what *doesn't*
vary; the destinations that vary hit-to-hit are the real switch arms, ranked by
hit count. Drive more game states (`pressDuring` / `fromState`) to surface rarer
arms. **No standalone tool (IDA / Ghidra / Binary Ninja) can do this** — it needs
an emulator in the loop. `disasm({target:'resolveJumptable', address})` is the
static-side alias that redirects to it.

#### New — `disasm({target:'decompile'})` reads cleaner

- **Hardware registers are named.** MMIO refs Ghidra emits as raw addresses
  (`*0x2001`, `uRAM400e`) become the register name (`PPUMASK`, `NOISE_LO`), with a
  `/* hw registers: … */` legend — on the 9 platforms with a register map
  (NES/SNES/Genesis/GB/GBC/SMS/GG/2600/7800/C64).
- **6502 SLEIGH clutter folds to readable C** (NES/2600/7800/C64/Lynx/PCE). Width
  types become C99 stdint (`uint1`→`uint8_t`, `uint2`→`uint16_t`), redundant
  nested casts collapse (`(uint16_t)(uint8_t)x`→`(uint8_t)x`), and zero-page byte
  refs are named (`cRAM00fd`→`zp_FD`), with a `/* 6502 fold: … */` legend. A real
  banked NES function went from `*(xunknown1 *)(uint2)(uint1)(param_2 - 0xb)` to
  `*(uint8_t *)(zp_FE - 0xb)` — same semantics, far more readable. (The
  carry-flag-16-bit / BCD reconstruction is left to an LLM reading the output;
  rewriting it textually would risk changing semantics.)

#### Improved — bank-aware decompile + honest function ranking

- **Banked NES `decompile` resolves the bank.** Rizin reports flat-PRG VAs, so a
  flat decode was bank-blind (cross-bank `JSR`/`JMP` landed on the wrong bank).
  `decompile` now lays a real 32 KB CPU window (selected bank @ `$8000` + fixed
  top bank @ `$C000`) so in-bank *and* fixed-bank calls resolve; NROM falls
  through to the flat path. On a real banked game this moved a top-12 function
  list from ~1 readable / 11 garbage to ~10 readable / 2.
- **`disasm({target:'functions'})` is ranked real-code-first** with a
  `looksLikeData` flag (+ `dataCount`), so giant single-block data folds stop
  crowding out the actual control-flow routines you want.

#### Fixed / hardened

- **SMD-interleaved Genesis dumps auto-deinterleave.** A `.bin` in the SMD copier
  format (size = N·16 KB + 512, `0xAA 0xBB` magic) read flat decodes to pure
  "bad instruction" garbage; analysis now detects + reverses the interleave and
  warns, so a flat disasm isn't silently wrong.
- **C64 `.prg` load-address header is stripped** before analysis (the 2-byte load
  address was being analyzed as code), with the base applied so addresses line up.
- **Worker-pool timeout + recycle.** A whole-ROM `aaa` on a multi-MB ROM that
  never returns no longer wedges the shared WASM analysis pool — the call times
  out, the worker is killed + respawned, and a clean `{ timedOut }` result comes
  back (with a "use a scoped pass" hint) instead of every later `disasm` hanging
  until a manual server restart.

#### New op discovery

- **`platform({op:'capabilities', platform?})`** — the per-platform op-support
  matrix (CPU family, rendering kind, which introspection/debug ops each core
  actually wires), so an agent can check support before calling instead of
  catching a failure. Unsupported ops now throw a typed, structured error
  (`{ unsupported, platform, op, reason, alternative }`) rather than a bare string.

## 0.40.2 — 2026-06-11

### Fixed — SNES `disasm({target:'decompile'})` treated the address as a raw file offset

On SNES, `decompile` decompiled the function at raw FILE offset `address`, but
`functions` / `cfg` / `xrefs` all report LoROM/HiROM **CPU** addresses — so the
documented "decompile an address from `functions`" loop silently returned the
wrong function (e.g. asking for the entry at CPU `$00:8000` decompiled file
`0x8000` = CPU `$01:8000`, the wrong bank).

Fix: SNES now lays the cart out by **24-bit CPU address** — each ROM chunk is
placed at its CPU bank (LoROM `$bank:8000`, HiROM `$C0+bank`), with the
`$80-$FF` FastROM (and HiROM `$40-$7F`) mirrors filled in — then decompiles at
the CPU address directly. This fixes both the function lookup AND in-bank /
`jsl` operand resolution (a flat-at-0 image would mis-label every cross-bank
call). The CPU-addressed image is ~16MB sparse (zero-filled between banks); a
real 4MB cart decompiles in ~1.2s. (No change to the `romdev-analysis*`
packages — the fix is in the address-mapping JS.)

Note: 65816 decompiler output is medium quality (variable register width, BCD/
decimal-flag expansion, direct-page guards) — for SNES, lean on `cfg` / `xrefs`
+ targeted `decompile` of leaf routines over big dispatchers.

## 0.40.1 — 2026-06-11

### Fixed — Genesis `disasm({target:'decompile'})` was shifted +0x200

A Genesis decompile at a caller-supplied address silently returned the function
0x200 bytes too low (the wrong one, or an empty `{ return; }` / `halt_baddata()`),
with no warning. `cfg` / `xrefs` / `functions` on the same address were correct —
only `decompile` was off.

Root cause: Rizin's Mega Drive loader splits a flat `.bin` into vtable / header /
text segments and reports a non-zero address delta (`0x200`) on the code segment;
the decompiler's address mapping honored that delta, but the raw image handed to
Ghidra loads flat at offset 0, so the two disagreed by exactly 0x200. Fix: flat-
cartridge platforms (Genesis, SMS, Game Gear, MSX, Game Boy / GBC) now force
file-offset == CPU-address and ignore Rizin's segment delta. The 6502-family
platforms were unaffected (they use a separate base-address path). Regression
test added. (No change to the `romdev-analysis` / `romdev-analysis-decompiler`
packages — the fix is entirely in the address-mapping JS.)

## 0.40.0 — 2026-06-11

### Reverse-engineering analysis engine — control-flow graphs, deep xrefs, function detection, and a decompiler

A full open-source RE analysis layer, covering **all 14 platforms** with zero
proprietary dependencies. Two new binary packages carry the WebAssembly; the
main package gains four `disasm` targets and one `symbols` op that drive them.

- **`disasm({target:'functions'})`** — auto-detected function list
  (`{address, size, nbbs, cc, callers, callees}`): the structural map of an
  unknown ROM, the carve step before you label anything live.
- **`disasm({target:'cfg', address})`** — basic-block control-flow graph of the
  function at `address` (nodes + typed edges: jump / branch_true / branch_false).
- **`disasm({target:'xrefs', address})`** — every cross-reference TO `address`,
  following the analysis graph. Deeper than the flat `target:'references'` da65
  operand scan — prefer `xrefs` once a function pass has run, `references` for a
  quick header-less sweep.
- **`disasm({target:'decompile', address})`** — Ghidra C-like **pseudocode** for
  the function at `address`, with the decompiler's own warnings and a per-CPU
  `qualityNote`. Altitude rule: decompile is for UNDERSTANDING (and as a port
  spec when retargeting to a bigger machine) — `target:'project'` stays the
  byte-exact rebuildable edit path. Quality is excellent on ARM (GBA) and M68K
  (Genesis), good on SM83 (GB/GBC) and Z80 (SMS/GG/MSX), medium on 65816 (SNES)
  and HuC6280 (PC Engine), and rough on the 6502 family (an architecture limit —
  every tool is rough on 6502).
- **`symbols({op:'analyze'})`** — one-shot structural map of a ROM
  (auto-detected functions + strings + entrypoints), no `.dbg`/`.map` needed.

Built from pinned upstreams, fetch-on-demand, never vendored — only the compiled
artifacts ship (see `scripts/build-rizin.sh`, `scripts/build-decompiler.sh`,
`scripts/versions.json`):
- **`romdev-analysis`** — Rizin compiled to WASM (the CFG / xrefs / functions
  engine). LGPL-3.0.
- **`romdev-analysis-decompiler`** — Ghidra's C++ decompiler compiled to WASM
  (no JVM, no rizin) plus SLEIGH processor tables for all 14 CPUs. Apache-2.0,
  with full per-component attribution in the package NOTICE (Ghidra/NSA, and the
  community SM83 / 65816 / HuC6280 SLEIGH specs).

### Documentation: no commercial game titles in shipped source

Swept every shipped tool description, doc, README, mental-model guide, and the
ROM-hacking playbook for commercial game/franchise names and replaced them with
generic platform + hardware + mechanic descriptions ("a banked NES racer", "a
top-down dungeon-crawler shape"). Console and chip names are unchanged — they're
not anyone's IP. The bundled cheat database (third-party crowd-sourced data) is
unaffected.

### Tests build their own ROMs (no external fixtures)

Tests that needed a real ROM now build one from our **own example sources** at
runtime instead of depending on a ROM file on disk — so the whole suite runs
with no external/commercial ROM anywhere. Every previously-skipped fixture-gated
test now runs: **918 tests, 918 pass, 0 fail, 0 skipped**. (This also surfaced a
latent fidelity bug the silent skips had hidden: `wrapRomFromParts` dropped the
iNES battery-SRAM flag on round-trip — now preserved via a new `hasBattery`
field, and exposed on the `wrapRomFromParts` tool.)

## 0.30.0 — 2026-06-11

### RE-tooling round — the Cheat-Engine "locate a value + find its writer" workflow
From an NES reverse-engineering feedback batch. Six additions to the
memory/breakpoint primitives:
- **`memory({op:'searchUnknown'})`** — the unknown-initial-value hunt: seed the
  WHOLE region with no value, then narrow across in-game events with
  `searchNext({compare:'dec'|'inc'|'unchanged'|'changed'|'gt'|'lt'})`. Finds the
  lives/timer/ammo address you can't see on the HUD (`op:'search'` needs a value;
  this doesn't).
- **`memory({op:'diff'})` predicate filters** — `changeDir:'dec'|'inc'`,
  `deltaEq:N` (signed exact delta, e.g. −1 = "lost a life"), `beforeMin/Max` +
  `afterMin/Max` (value-range gates). A 500-byte death-window diff returns the
  ~3 rows you want in one call.
- **`memory({op:'diff'})` honors `outputPath` + `echo:false`** (was a bug — diff
  ignored `outputPath`; a big diff now routes to your path, not a harness path).
- **`memory({op:'readCart', cpuAddress, bank})`** — read cart ROM by a BANKED CPU
  address (NES/SNES), the inverse of the breakpoint result's bank/prgOffset; no
  more hand-computed `cpuAddr−0x8000+bank*0x4000`.
- **`breakpoint({on:'write', condition})`** — stop on the MEANINGFUL write, not
  restoring churn: `condition:'increase'|'decrease'` (the stored byte actually
  moved that way) or `'equals'` + `conditionValue` (became N, e.g. a $00→$01
  re-arm). Reports `oldValueByte`→`valueByte`. Live on **all 14 platforms** (11
  emulator cores rebuilt to capture the pre-write byte). Also clarified in the
  tool note that `on:'write'` runs to end-of-frame and reports the LAST matching
  write (`hits` = count).
- **Tool-schema slim** — dropped the inlined ~62-value region enum from every
  SECONDARY region sub-param (`watch` per-range `ranges[].region`, `recordSession`
  `memorySamples[].region`, and both `runUntil` memory conditions); they're now
  runtime-validated strings, trimming the deferred-load schema cost the feedback
  flagged. The ONE primary discoverable enum (`watch` on:'mem' single-range
  `region`, where the region IS the choice) is intentionally kept. **Bonus fix:**
  the `runUntil` region was a STALE hardcoded 8-value list that silently
  schema-rejected valid non-NES regions (`genesis_cram`, `c64_color_ram`,
  `nes_apu_regs`, …) the handler actually supports — now accepted.

### Core rebuilds
11 emulator cores rebuilt for the value-conditioned write breakpoint (bump +
republish each): fceumm, snes9x, genesis-plus-gx, gambatte, mgba, handy,
geargrafx, prosystem, stella2014, bluemsx, vice. **Build fix (latent, was on
main):** the bluemsx region patch carried a duplicate Makefile CFLAGS hunk
identical to the build patch's; since `git apply` is atomic, that made the whole
region patch silently fail to apply — the watchpoint/region exposure was being
dropped from the build. Removed the duplicate hunk.

## 0.29.0 — 2026-06-11

### Examples — the complete-game library, finished & made honest
- **The 14×5 grid is complete (70 games).** Every platform now ships all five
  canonical genres. The last gap, the Atari 2600 puzzle, ships as **TILE TWINS**
  — a memory match-pairs game (a real puzzle: a static, turn-based board drawn
  as full-width COLUPF bands, the honest TIA fit — not a colored match-3 grid the
  TIA can't render). Forkable via `examples({op:'fork', example:'atari2600/puzzle'})`.
- **C64 games now SAVE for real — 1541 disk save.** The honest C64 medium is the
  floppy (no battery SRAM). All 5 C64 games write a hi-score/record to a SEQ file
  on drive 8 via the KERNAL; run from a `.d64` it commits to the live disk and
  `state({op:'exportDisk'})` captures it (reload restores it). As a bare `.prg`
  there's no mounted disk, so it's an honest in-session no-op. (Replaces the old
  gated no-op seams — the VICE core already supported writable-disk write-back.)
- **C64 two-player now works.** The VICE core drove only one control port per
  RetroPad; host port-1 (P2) input never reached the game. Now both standard
  control ports are live (host port 0 = P1, host port 1 = P2) — verified by
  driving both paddles independently in the versus games.
- **PCE save claim corrected (honesty).** A bare HuCard cannot save — BRAM is
  peripheral-only (CD-ROM² / Tennokoe Bank / Memory Base 128) on real hardware.
  The 5 PCE games no longer claim a battery save; they keep an honest in-session
  hi-score, with the BRAM mapping documented in-file as the real-hardware path.
- **Honest framing.** The examples are described as SCAFFOLDING, not showcases:
  the gameplay is intentionally thin — their value is the working boot sequence,
  APIs, and syntax to fork from. Superlatives dropped from the `examples` tool
  doctrine and the generated project README.

### Added — livestream frame coverage: see what the agent is doing
- **Most state-changing tools now emit the post-call frame to /livestream**,
  at zero cost to the agent (deferred PNG encode after the response goes
  out): `frame({op:'step'})`, `input` set/press/sequence/navigate,
  `state({op:'load'})`, `loadMedia`, `host({op:'reset'})` (soft + hard),
  `runUntil`, `cheats({op:'apply'})`, and `cpu({op:'call'})` — joining the
  breakpoint/watch hits, verify, and stepInstruction that already emitted.
- **Throttled to one frame per 2s per (session, tool)**, trailing-edge: a
  frame-step loop can't flood the stream and its LAST frame always lands;
  different tools back-to-back all show; multiple agents on one server
  never throttle each other.
- **`call_frame` events carry a caption** (`step ×30`, `press start`,
  `state load boss`, `loaded game.nes`) and the livestream UI shows it on
  the image card — the stream reads as a narrative.
- **To-disk renders now reach the stream too**: `tiles({op:'preview'})`,
  `extractSpriteSheet`-style file renders, and `encodeArt` quantize/crop
  attach the PNG as an observer sideband when routed to `outputPath` — the
  human sees the render even though the agent only gets a path.

## 0.28.0

The reverse-engineering release: the three RE primitives — break-instant
`registersAtHit`, interference-free `pure` CPU calls, and the
`watch({on:'copy'})` graphics source-trace — now work on ALL 14 platforms
(every emulator core rebuilt; upstream pins unchanged, everything carried by
the patches in `scripts/patches/`). Plus the full scaffold overhaul from real
RetroDECK playtesting, banked-cart parity for disasm/rebuild, the value-search
upgrades, and the playtest co-drive detection. Details per section below.


### Added — pure calls + the generic copy trace on ALL 14 platforms (primitives #2 and #3)
The other two primitives from the all-platforms RE proposal, completing the
set (registersAtHit was #1):
- **`cpu({op:'call', pure:true})` works everywhere.** The guarantee is the
  same on every platform — the game's own NMI/IRQ/VBlank logic CANNOT run
  during the call and stomp the routine's output buffer — with the mechanism
  reported as `pureMode`: Genesis/SMS/GG step ONLY the CPU (`'cpu-only'`,
  the gpgx separable-loop path); every other core suppresses interrupt
  DELIVERY for the duration (`'irq-blocked'` via a new `romdev_irqblock_set`
  export — pending lines stay pending, video/timers advance harmlessly, no
  game handler executes); the 2600's 6507 has no interrupt lines at all
  (`'no-interrupts'`). Proven live on NES: NMI delivery verified firing,
  then silent under the block, then a planted routine pure-called
  end-to-end with its write landing.
- **`watch({on:'copy'})` — the generic "where does this graphic come
  from?".** Logs every write landing in a VRAM/dest address window with the
  EXECUTING instruction's PC. Port-based video memory is hooked INSIDE the
  cores — NES $2007, SNES $2118/19 (BOTH CPU port writes and the DMA path —
  the PC is the DMA-triggering instruction), PCE VWR, MSX VDP data port,
  SMS/GG/Genesis VDP data port (the CPU-port complement of the Genesis DMA
  watch). Direct-mapped platforms (GB/GBC, GBA, C64, Lynx, 7800) route
  through the CPU-address range log automatically. Follow a hit with
  breakpoint({on:'pc', address: pc}) for registersAtHit at the uploader.
- Cores rebuilt again (same pins; the scripts/patches/ diffs carry
  everything — all 11 verified to apply clean to pristine checkouts).
- `test/pure-copy-primitives.test.js`: the 13-core irq-block/run-pure
  feature matrix, NES NMI-delivery proof + end-to-end pure call, MSX
  block-safety, and copy traces on NES (port), SNES (port+DMA), GB (mapped).

### Fixed/Added — registersAtHit + freeze-after-hit on ALL 14 platforms (every core rebuilt)
The gpgx round's break-instant fixes, extended to every other core — the same
three guarantees now hold across the whole platform matrix:
- **`registersAtHit` everywhere** — every breakpoint hit (pc-break, watchdog,
  write-watch, read-watch) on every platform freezes the FULL register file at
  the hit instant inside the core hook, exported via `romdev_regsnap_get` and
  surfaced in the breakpoint hit response. Per-CPU register sets: 6502 family
  (NES/2600/7800/C64/Lynx/PCE) A/X/Y/P/S/PC; 65816 (SNES) +DB/D; sm83 (GB/GBC)
  A/F/B/C/D/E/H/L/SP; Z80 (SMS/GG/MSX) +IX/IY; m68k (Genesis) D0-7/A0-7/SR;
  ARM7 (GBA) r0-r15/CPSR. NES previously snapshotted pc-breaks only — its
  write/read hits now snapshot too.
- **Freeze-after-hit everywhere** — once a hit fires, the CPU run loop stays
  frozen (across re-entries and frames) until the host clears the hit, so even
  live register reads agree with the snapshot. Previously each core resumed on
  the next loop re-entry and the registers drifted.
- **Executing-instruction PC everywhere** — write/read watchpoints and range
  logs report the EXECUTING instruction's first byte, latched at dispatch
  (sm83/Z80/65816/6502 PCs advance past operands mid-instruction — the same
  off-by-one class the gpgx round fixed for m68k; GBA reports the pipeline PC,
  matching its breakpoint-address convention).
- Cores rebuilt: fceumm, snes9x, gambatte, mGBA, handy, vice, stella2014,
  prosystem, geargrafx, bluemsx (pins unchanged; the romdev patches in
  scripts/patches/ carry all of it — the whole stack reproduces from a clean
  clone). `cpu({op:'call', pure:true})` remains gpgx-only (the other systems'
  CPU/video loops are not separable without deeper core surgery); their calls
  carry the ⚠ frame-logic caveat instead.
- `test/regsnap-all-cores.test.js`: live single-step snapshot + freeze proof
  on 10 platforms (plus the existing gpgx suite for Genesis/SMS/GG).

### Fixed/Added — gpgx core round (a both-consoles sports-title feedback): break-instant truth on Genesis/SMS/GG
The first core rebuild in this release (gpgx only; pins unchanged, patch extended).
- **`registersAtHit` on Genesis/SMS/GG** — `breakpoint({on:'pc'|'write'|'read'})`
  hits now carry the FULL register file (m68k d0-d7/a0-a7/pc/sr/sp; z80
  a/f/b/c/d/e/h/l/ix/iy/pc/sp) frozen by the core AT the hit instant. gpgx
  schedules CPUs per scanline, so the live register file used to drift
  hundreds of instructions past a hit before the host could read it — the
  "wrong-pointer chases" that cost a real RE session ~2h. On a pc-break the
  CPU now also stays FROZEN for the remainder of the frame (and across
  frames until the hit is cleared), so even live reads agree.
- **Write/read watchpoint PC is the EXECUTING instruction** — the hooks now
  record the instruction's first-byte address latched at dispatch, not the
  post-prefetch PC (the orb-at-$2A7216-reported-as-$2A721C off-by-one).
  `breakpoint({on:'write'})` also renames `value`→`valueByte` (it's the one
  byte that landed, not the operand) and explains its `hits` semantics.
- **`cpu({op:'call', pure:true})`** — steps ONLY the active CPU (new
  `romdev_run_pure` export): no VDP line processing, no co-CPU, no interrupts
  raised — so the game's own VBlank logic can NOT run "concurrently" and
  stomp the driven routine's output buffer (a real session diffed a correct
  codec reimplementation against that poisoned output for ~1.5h). Non-pure
  calls that spanned frames now carry a loud ⚠ caveat naming the risk and
  the fix.
- **Genesis `system_ram` normalized to CPU byte order** — gpgx stores 68k
  work RAM host-LE word-swapped (`work_ram[A^1]`); the raw layout leaked
  through every byte-granular tool. Self-consistent within search→write
  loops (which is why it hid — even a test had the swapped bytes baked in as
  the expected value), but off-by-XOR-1 the moment an offset crossed to/from
  disassembly addresses or cheat-DB maps. Offset X now IS the byte the 68k
  sees at $FF0000+X; words read big-endian as documented. This also fixes
  `cpu({op:'call'})` sentinel pushes / `presetMemory` writes for any non-zero
  sentinel address (the default $0 sentinel was swap-invariant, hiding it).
- breakpoint hit responses normalize `hits` (a watchdog stop no longer
  reports the contradictory `hit:true, hits:0`).
- Docs: the held-input menu trick (when a `pressDuring` schedule never
  registers on a menu screen, hold via `input({op:'set'})` and omit
  pressDuring — runs inherit held input) is now in the breakpoint/watch tool
  docs; the server banner prints a one-line headless note when no display is
  available (so an agent knows before promising a playtest window).
- `test/gpgx-registers-at-hit.test.js`: live-core coverage for all of it,
  including a per-platform Genesis memory-read smoke (the earlier
  "info is not defined" regression was invisible to a fake-host-only suite).


### Fixed/Added — value-search upgrades (from the locate-value skill review)
- **Relative compares work as the FIRST `searchNext`.** `op:'search'` now
  baselines every candidate at seed time, so `compare:'inc'/'dec'/'changed'/
  'unchanged'` no longer silently return 0 candidates on the first narrow
  (the footgun a real session burned rounds on and a skill had to document —
  the "do one eq round first" workaround is obsolete).
- **Representation-aware search** — `memory({op:'search', as:'bcd'|'digits'})`
  for the stored≠displayed cases: `'bcd'` matches packed-BCD values (2 decimal
  digits/byte, region endianness — classic NES scores); `'digits'` matches one
  byte per ON-SCREEN digit at ANY constant tile base (HUD digit/tile-index
  buffers; the base is auto-detected per candidate and reported; single-digit
  seeds only accept base 0/0x30 to avoid matching everything). `searchNext`
  narrows in the seed's representation automatically, including numeric
  `inc`/`dec` on decoded values. Works on all platforms/regions (endianness
  per region, big-endian m68k included).
- **search/searchNext response notes fixed** — they recommended the dead
  `searchValue` name and a `writeMemory({bytes})` form that op:'write'
  REJECTS; now they name the live ops with a `hex` payload, mention the
  scene-changed-mid-step empty-round trap, and point input-driven values at
  `diffRuns`. Same stale-name fix in two `watch` tool notes.
- `test/search-representations.test.js` covers all of it.


### Added — banked-cart parity across ALL platforms (per-bank references + rebuild glue)
The 0.27.0 feedback round fixed per-bank reference scanning and one-call banked
rebuild glue for NES only. Every other banked-cart platform now gets the same
treatment:
- **`disasm({target:'references'})` scans EVERY bank on every banked format** —
  SNES multi-bank LoROM (was: only the first 32KB bank), GB/GBC MBC and SMS/GG
  Sega-mapper and MSX megaROM (was: only the first 32KB), Atari 2600 F8/F6/F4
  (was: only the boot bank), Atari 7800 (was: only the top 16KB — flat carts now
  scan the WHOLE image, SuperGame carts per-bank), and >32KB HuCards (was: a
  wrapped, garbage start address). Non-NES refs carry a `romBank` tag (NES keeps
  `prgBank`). Very large carts scan the first 64 banks and SAY SO in `notes`.
- **`disasm({target:'project'})` splits every banked format per-bank** so
  instructions never straddle a bank edge: Sega-mapper SMS/GG (16KB banks),
  MSX megaROMs (16KB banks + the "AB" header as its own data region), banked
  2600 (4KB banks), 7800 SuperGame (16KB banks + the .a78 header split out),
  >32KB HuCards (8KB pages + optional copier header split out).
- **Atari 7800 SuperGame and PC Engine HuCards (flat AND banked) get one-call
  byte-identical `build()` rebuilds** — their asm toolchain is cc65/ca65, the
  same match that made NES one-call. NES-style glue: HEADER segment carrying
  the original header bytes, per-bank segment wrappers, generated multi-bank
  `.cfg` via `linkerConfigPath`. **PCE was previously the one honestly-LOSSY
  case** (planRegions trimmed real $FF padding and didn't strip copier
  headers) — both fixed, `verifiable:true` now.
- **SMS/GG, MSX, and 2600 banked carts get per-bank native rebuild recipes**
  (their `build()` is SDCC/DASM — can't consume the disasm syntax): per-bank
  wrappers + cfg blobs (2600), bank-by-bank `as`/`objcopy`/`dd`/`cat` recipes
  in `BUILD.md` (SMS/GG/MSX), all byte-exact.
- Proven by `test/banked-parity.test.js`: synthetic banked carts on 7 platforms;
  byte-identical one-call rebuilds verified end-to-end for 7800 SuperGame,
  banked PCE, and flat-PCE-with-real-padding.


### Fixed — scaffold overhaul from real RetroDECK/Bazzite playtesting (all 14 platforms)
A full human playtest of every genre scaffold on real hardware surfaced clusters
of repeated logic errors. The big ones:
- **SMS/GG: every `build({output:'project'})` ROM black-screened** — the project
  recipe skipped the dir's `*_crt0.s` believing `buildForPlatform` auto-injects
  the bundled crt0 (it doesn't; only the rom/run handlers do), so SDCC's stock
  z80 crt0 linked instead and `main()` never ran. Also: the bundled crt0's reset
  block was 9 bytes (overflowed into the `.org 0x0008` RST slot, corrupting
  `jp gsinit`), `_CODE` linked at `$0000` ON TOP of the vector table, and `.gg`
  ROMs got an SMS region nibble (`$4C`) that flips Genesis-Plus-GX into SMS-compat
  mode. Project builds now route/fall back to the bundled crt0, `_CODE` sits at
  `$0100`, GG ROMs get region `$7C`, ROMs pad to 32KB before the TMR SEGA header,
  and a regression test pins the boot byte + header. The SMS scaffold now ships
  `sms_crt0.s` like GG/MSX.
- **"All enemies spawn on the left"** (18 shmup/racing templates): spawn X/lane
  came from `spawn_timer`, which the caller resets to 0 immediately before
  `spawn()` — a constant. Each template now has a Galois-LFSR `rand8()`.
- **Puzzle genre**: the gbc template is now the polished falling-jewel reference
  game (4-direction matches, gravity + cascade chains, magic piece, SFX + music,
  collect/flush vblank rendering, dataLoc `$C200` via the gb/gbc project recipe);
  the DMG gb template is rebuilt around the same core; and the
  mark/clear/gravity/cascade core is ported to all 10 other platforms (PCE: H+V
  in its 8KB boot bank). Replaces a horizontal-only scan that missed vertical/
  diagonal matches, half-cleared 4+ runs, and never dropped survivors.
- **Atari 2600**: SWCHA ASL carry-chains clobbered A between shifts (pressing
  RIGHT also "pressed" LEFT — the stuck-to-the-left-edge bug) in three templates;
  the platformer's terminal-velocity clamp caught POSITIVE velocities (unsigned
  CMP), killing every jump within one frame; sports' paddle axis was inverted vs
  the kernel's Y convention and RESBL was never strobed (the ball NEVER moved
  horizontally — per-frame div-15 + HMBL positioning added); racing re-randomizes
  both lanes on crash; shmup aliens reaching the cannon reset the wave.
- **Atari 7800**: the SWCHA joystick bit defines were exactly REVERSED on every
  template (up/down steered left/right; sports' left/right moved the paddle
  vertically). Plus speed tuning (platformer movement + jump, puzzle fall rate,
  sports serve).
- **Platformers**: GBA fell through every platform (the `blocked_below` gate
  only matched a 1px window at 20px/frame fall speeds); SNES platforms are now
  visibly drawn on the scrolled text layer (were invisible collision rects);
  Lynx landing uses a crossing test (exact-equality check tunnelled); C64
  `render_view` rewritten ~20x faster (a per-CELL platform scan + 16-bit modulo
  cost ~2s per 8px scroll step at 1MHz — froze the game and ate jump presses);
  NES player is red (was sky-blue on sky-blue) and moves 2px/frame; GB/GBC jump
  height tamed.
- **GBA sports "never starts"**: `tte_printf` (broken in this libtonc — the
  documented GBA-1 issue) ran every frame and crashed with an undefined-
  instruction exception on iteration 1. Replaced with the `tte_write` digit path
  the other templates already use.
- **SNES**: each genre now gets a distinct backdrop tint (every scaffold shipped
  the same blue checkered wallpaper).
- **Sound everywhere**: every scaffold now has a continuous background-music
  loop plus audible SFX, verified per platform by recording + RMS analysis.
  Genesis/Lynx tick a melody inside `sfx_update()` (no template wiring; Lynx
  voices 64→100), NES adds a triangle-channel melody to `nes_runtime`, PCE a
  ch5 melody with corrected volume (the 5-bit field is ~-1.5dB/step from 31 —
  the old 13 was -27dB, near-silence; the shmup SFX are maxed), and the SMS/GG
  3-voice tracker that already shipped is now actually STARTED by all 11
  templates. **MSX root cause**: `msx_crt0.s` had the same `_INITIALIZER`-in-RAM
  bug fixed for SMS/GG (every `static x = N` booted 0) plus a BIOS-KEYINT
  PSGADDR-latch race (PSG writes now DI/EI-guarded) — both fixed; this likely
  also explains the reported MSX sprite flakiness.
- **GB/GBC sports scanline tear**: the OAM DMA now fires at the vblank leading
  edge (45 staged `oam_set` calls used to push it a third of the frame into
  active display — the "horizontal line a 3rd of the way down" glitch).
- Misc per-genre polish: PCE gameplay speeds, C64 racing clears the BASIC
  startup text, C64 sports court widened to the 9-bit sprite range, MSX/Lynx
  sports contrast, GBA puzzle well border.
- **Verification**: all 69 existing platform×genre scaffolds were swept —
  scaffold → project build → boot → render-health green, all 14 platforms
  respond to input, and each platform's audio was captured and RMS-checked.
  (Atari 2600 has no puzzle genre by design.)

### Fixed/Added — the 0.27.0 NES RE feedback round (banked-NES rebuilds, A/B diff, token cuts)
- **Banked NES `disasm({target:'project'})` now emits COMPLETE, working rebuild
  glue** (the headline ask): a `HEADER` segment with the original 16 iNES bytes,
  a per-bank `PRGn` segment wrapper for every bank, a multi-bank `nes_rebuild.cfg`
  (switchable banks at `$8000`, fixed top bank at `$C000`, CHR wired when
  present), and a `rebuild.json` `build()` call referencing all of it. Proven
  byte-identical on a synthetic 4-bank mapper-2 ROM fed straight back to
  `build()` — what previously took an hour of hand-written segments + cfg is
  now zero glue. (NROM keeps the existing proven `inesHeader` one-call path.)
- **`build({linkerConfigPath})`** reads the `.cfg` from disk so a large
  multi-bank config never streams through context (and `rebuild.json` uses it).
- **`disasm({target:'references'})` scans every PRG bank on banked NES** —
  the old flat-blob-at-`$8000` disassembly returned `refsFound:0` on >32KB
  ROMs. Refs now carry a `prgBank` tag, and `#$nn` immediates no longer count
  as references (they're values, not addresses).
- **`memory({op:'diffRuns'})`** — the A/B input-diff primitive: runs the same
  start state twice under two different held inputs (savestate restore in
  between) and returns only the divergent bytes, with run-A/run-B values for
  small clusters. Replaces the save/run/dump/restore/run/dump/python-diff loop
  (~6 calls + a 4KB context hit) with one call; live-verified isolating an NES
  player-X byte.
- **`memory({op:'read'/'readCart', outputPath, echo:false})`** returns just
  `{path, bytes}` — no more ~4KB hex echo on a 2KB dump that was explicitly
  routed to disk.
- **`memory({op:'diff'})`**: summary clusters ≤8 bytes now include
  `before`/`after` hex (no more falling back to `view:'raw'` for the values),
  and `minDelta` filters RNG/counter wiggle.
- **`input({op:'press'})` guarantees a released→pressed edge** (one released
  frame first), so edge-triggered handlers (START pause) can't miss the press
  when the button was already held.
- **`breakpoint({on:'pc'})` misses now diagnose**: report `pcNow`, stop
  suggesting `pressDuring` when input WAS supplied (wrong-address is then the
  likely story), and point at `watch({on:'pc'})` coverage tracing.

### Added — human co-drive detection: agents now KNOW when a human is playing in the playtest window
The long-standing confusion ("they get confused when I try to play while they're
coding") had a real mechanism: the playtest window shares the session's ONE
emulator host with the agent, and its 60fps tick wrote the human's pad state —
including all-zeros when nobody was pressing — over the agent's `input({op:'set'})`
every frame. The agent had no signal a human was co-driving and no warning that
its input was being clobbered. Now:
- **The window only writes input while the human is actually pressing** (pad,
  keyboard, or rewind-scrub), plus one release write after they let go. An idle
  window no longer silently clobbers the agent's held input. The human still wins
  the instant they press.
- **The window tracks human activity** ("pressed within the last ~2 s" ≈ 120
  ticks) and exposes it: `catalog({op:'status'})` reports `playtestWindowOpen` +
  `humanInputActive` (+ `framesSinceHumanInput`), and `playtest({op:'status'})`
  reports the same.
- **`frame({op:'step'/'stepAndShot'})` and `input(set/press/sequence/navigate)`
  responses carry a `humanCoDriveWarning`** while the human is actively playing,
  telling the agent the conflict is happening NOW and pointing at the escape
  hatches: `host({op:'pause'})` to inspect frozen, or a second session
  (different `x-romdev-session` = fully isolated emulator) for deterministic work.
- The playtest tool's FOOTGUN doc now describes the real contract (real-time
  stepping always races; input only clobbered while the human presses).

### Changed — `screenshot` scale docs: native is the accurate default, upscale adds no detail
The `scale` param's docs oversold integer UPscaling as making tiny handheld shots
"legible." That was misleading: nearest-neighbor upscale just duplicates pixels —
it adds **no information** the native frame doesn't already have, costs more image
tokens, and since VLM vision encoders resize every input to their own fixed
resolution it may not change what the model sees (and can slightly degrade it via a
bicubic downscale of stretched pixels). Reworded the param + tool description to
lead with **native (`scale:1`, the default) = perfect pixels = the accurate
representation**, keep the genuinely-useful DOWNscale (`<1`, fewer tokens for
"did it change?" checks), and frame upscale honestly as a last resort for clients
that can't zoom a small image. (No behavior change — `scale` was already opt-in and
defaulted to native; this is the docs telling the truth about it.)
(Committed during the 0.27.0 cycle but AFTER 0.27.0 published — ships in 0.28.0.)

## 0.27.0

### Added — `breakpoint(on:'pc', captureMemory:[…])` reads named RAM at the hit
Completes item 2 of an NES action-game RE report. 0.26.0 shipped `registersAtHit` (the
break-instant register file) but not the memory half. Now `breakpoint(on:'pc')`
takes `captureMemory:[{region,offset,length,label}]` and returns those reads inline
as `capturedMemory`, so register + RAM inspection at a PC collapses into ONE call —
no follow-up `cpu`/`memory` round trips. `registersAtHit` is the true break instant
(core snapshot); `capturedMemory` reflects the routine's RAM side effects for the
hit frame (stable + what RE needs), documented as such.

## 0.26.0

### Fixed — NES `breakpoint(on:'pc')` now returns reliable break-instant registers
An agent RE'ing an NES action game found that after a `pc` breakpoint hit, a follow-up
`cpu({op:'read'})` returned the **idle-loop PC**, not the breakpoint instruction —
the documented "break, then read the live register file" workflow gave end-of-frame
state. Root cause: fceumm drains the cycle budget on hit but `retro_run` still
finishes the frame, so the live X6502 registers are clobbered before the host reads
them (the schema's "CPU is FROZEN at this instruction" was wrong for NES).
- **fceumm core rebuild** (romdev-core-fceumm 0.8.0): the PC-break handler now
  SNAPSHOTS A/X/Y/P/S at the hit instant, exposed via `romdev_pcbreak_get`.
- **`breakpoint(on:'pc')` returns `registersAtHit`** — the reliable break-instant
  register file. The schema + hit note now steer to it and explicitly warn that a
  live `cpu({op:'read'})` after a hit is end-of-frame state on fceumm. (The
  `captureMemory` companion that reads named RAM inline at the hit landed in 0.27.0.)
- **NES `cpu({op:'read'})` core-internal fields relabeled** (item 3): `DB`,
  `IRQlow`, `tcount`, `count` are fceumm internals (data-bus latch / IRQ bitmask /
  cycle counters), not 6502 registers — moved out of `registers` into a labeled
  `coreInternal` object so they're not misread as CPU state.

### Added — `/livestream` shows the SYSTEM (platform) on every tool call + frame
A human watching `/livestream` on a multi-agent server saw the session id + tool
name, but not WHICH console each call/frame belonged to. Every observer event now
carries `platform` (the session host's loaded system — nes, genesis, …), surfaced
as a badge on the log row and the frame card. Wired on BOTH transports (the MCP
observer middleware and the REST tool registry), resolved AFTER the handler runs so
a `loadMedia` / `build({output:'run'})` that sets the platform mid-call labels its
own frame correctly. Null until a ROM is loaded.

## 0.25.0

### Added — C64 input scripting + verification (RE startup-flow telemetry)
Follow-up to the 0.24.0 C64 keyboard work: an agent RE'ing a C64 shoot-'em-up could now
press keys, but couldn't (a) script a keyboard+joystick startup TIMELINE in one
call, or (b) tell whether a non-responsive key reached VICE at all. Both added — no
core rebuild (the `c64_cia1_regs` region + key matrix already existed):
- **`recordSession` `inputScript[].keys`** — hold C64 keyboard keys from a frame
  until the next entry, interleaved with joystick `ports`, in one deterministic
  timeline (e.g. `{atFrame:0,keys:['f1']},{atFrame:30,ports:[{b:true}]},
  {atFrame:60,keys:['run/stop']},{atFrame:90,keys:[]}`). `ports` is now optional
  (a step may set just keys). Unknown keys are **rejected with a clear error**, not
  silently ignored.
- **`input({op:'pressKey', verify:true})`** — also samples CIA1 **`$DC00`/`$DC01`**
  (the keyboard/joystick scan ports the KERNAL reads) **before / during (key held)
  / after**, plus matrix coords + active joyport. Lets you distinguish "my key
  never reached VICE" (`before==during`) from "VICE saw it but the game ignored it"
  (they differ, no reaction) when a C64 game doesn't respond.

### Changed — `scaffold` no longer echoes the vendored toolchain manifest
`scaffold({op:'project'|'game'})` used to return a flat `files[]` of EVERY written
file — including the toolchain copies (35 of 44 entries on NES, **173 of 264 on
GBA**, ~270 on SGDK Genesis) that an agent never touches. Across a matrix run (one
game × every genre × every platform) that was ~100 KB of pure vendored-path lists
in context with zero decision value. Now the response is a compact receipt:
- `files` — only the project-**OWNED** files you edit (main source, runtime, crt0,
  cfg, README).
- `fileCount` (total written) + `vendorFileCount` (the summarized vendored copies,
  on disk if you ever need them).
- `verbose:true` restores the full flat list as `allFiles`.

"Owned" is classified by what a file **is**, not just a `vendor/` prefix — so it
correctly excludes the SDK header trees the GBA (libtonc `include/`+`sysinclude/`)
and Genesis (SGDK `include/`) toolchains drop OUTSIDE `vendor/`, plus prebuilt
`crt*.o` / `*.a` / `*.lib`. (The initial fix used a `vendor/`-prefix denylist and
missed exactly those two SDK platforms — caught + fixed via a 0.24.0 matrix-run
report. GBA dropped 173→9 owned, Genesis 82→13.) Mirrors the `inline`/`outputPath`
choose-your-payload pattern the snippets op already had.

### Changed — scaffold README + `nextStep` lead with `build({output:'project'})`
The generated project README and the scaffold's `nextStep` now lead with the
one-call **`build({output:'project', platform, path, outputPath})`** form (infers
toolchain/crt0/linker from the directory — no `sourcesPaths`/`includePaths`/
`linkerConfig` to hand-specify), and demote the verbose `output:'run'` + manifest
form to a collapsed "compiling edited loose source" alternative. The project-dir
build was already the easier path; now it's the one a fresh agent copies first.

### Fixed — SMS shmup + Atari 7800 sports scaffolds rendered with wrong colors
Both built and booted but looked broken (a 0.24.0 matrix report flagged them):
- **SMS shmup** rendered the starfield as blue/**GREEN** striped bands. The BG
  palette had colour 1 = `0x08`, which in SMS 2-2-2 BGR is green (G bits), not the
  "deep space blue" the comment claimed. Fixed to a pure-blue depth gradient
  (`0x10/0x20/0x30`) — the bands now read as space, dominant colour went green
  `#00aa00` → blue `#0000ad`.
- **Atari 7800 sports** rendered a near-black playfield that looked dead. Two MARIA
  colour-byte bugs: the court walls used `0x48` (hue 4 = RED → **pink**, not the
  intended blue) and the court floor was `0x00` (black, indistinguishable from a
  blank screen). Fixed to blue walls (`0x8A`, hue 8) + a dark-green court floor
  (`0xB4`) — now reads as an actual court (dominant black → green `#008221`).

Both verified by screenshot + `frame({op:'verify'})`. (These were colour-value
bugs in the scaffold templates, not the render pipeline.)

### Removed — `catalog({op:'whatsNew'})` + the old→new tool rename table
`whatsNew` returned a 125-entry map of pre-1.0 renamed tool names (plus, until now,
~1.4k tokens of inlined CHANGELOG prose) so an agent resuming an old handoff could
re-map a tool that had moved. The pre-1.0 consolidation is long settled — the old
names are git history, and no running agent carries them — so maintaining a
forever-growing rename record (and risking it landing in context) wasn't worth it.
Dropped the op, the `tool-manifest.js` map, and its tests. An agent that hits an
unknown tool name now just reads the current surface (`catalog({op:'categories'})`
or the tool list); full release notes remain in CHANGELOG.md for humans.

## 0.24.0

### Added — C64 keyboard + joyport input (VICE core patch)
An agent RE'ing a C64 shoot-'em-up could reach the intro via joystick but couldn't ENTER
gameplay — the game needs **F1** (1 player) + fire on **port 2**, and romdev's
input was joypad-mask-only. Many C64 games gate gameplay behind KEYBOARD setup
screens that joystick can't reach. The VICE core now exports
`romdev_key_matrix`/`romdev_kbdbuf_feed`/`romdev_joyport_*`, surfaced as:
- **`input({op:'pressKey', key})`** — press a C64 keyboard key (F1/F3/F5/F7,
  Return, Space, Run/Stop, a–z, 0–9, …) by driving the C64 8×8 key matrix.
- **`input({op:'typeText', text})`** — feed a string into the kernal keyboard
  buffer (LOAD/RUN/filenames); `\r` → RETURN.
- **`input({op:'joyport', joyport?})`** — read/set the active C64 joystick port
  (1 or 2; default 2, most games).
- `input({op:'layout', platform:'c64'})` now reports the keyboard keys + joyport.

**A controller alone plays C64** (the Batocera/RetroDeck model — no physical
keyboard needed). Spare pad buttons/stick map to the C64 keyboard keys games need
to start: X/Space=Space, L2=Run/Stop, R2=Return, top face / right-stick =
F1/F3/F5/F7; d-pad + Fire stay the joystick. Unified in the host so it works the
same in the playtest window AND for the agent's headless `setInput`. No-controller
keyboard fallback maps PC F1–F4/Space/Enter to the same C64 keys.
`playtest({op:'open'})` on a C64 game relays the controls. (romdev-core-vice 0.7.0.)

### Changed — leaner, less-confusing agent docs (AGENTS.md / SKILL.md)
AGENTS.md was loaded in full every session for every platform — ~30k tokens, of
which ~13k was platform-specific or duplicated detail an agent on one platform
never needed (and could misapply across platforms). Cut **~31% (~9.5k tokens)**:
- Per-platform debug-tooling detail → each platform's `MENTAL_MODEL.md`.
- The ROM-hacking workflow → folded into the `ROMHACKING_PLAYBOOK.md` guide.
- Toolchain landmines → per-platform `TROUBLESHOOTING.md`/`SDCC_GOTCHAS.md`.
- Disassembler flag reference → it's already in the disasm tool's own schema.
All reachable on demand via `platform({op:'doc'})`; AGENTS.md keeps generic
guidance + symptom→doc pointers. **"Read your target platform's
`platform({op:'doc', name:'mental_model'})` BEFORE you write code for it"** is now
a top-level rule (the footguns live there) — so the on-demand docs actually get
read. The dynamic SKILL.md inherits all of this.

## 0.23.0

Response to real build-session feedback. Theme: bugs found, false alarms
removed, and — the recurring finding — **tools that already existed but agents
couldn't find them**.

### Fixed — multi-tenant host cross-talk (a whole class of bugs)
`sprites({op:'inspect', platform:'genesis'})` returned a *GBC*-flavored error while
Genesis was loaded. Root cause: `inspectSpritesCore` / `getCPUStateCore` /
`getAudioStateCore` / `inspectBackgroundMapCore` / `inspectPatternTilesCore` were
module-global `export let` bindings reassigned per session, each closing over THAT
registration's `sessionKey` — so the last session to register stole the host for
everyone. Now the caller's `sessionKey` is threaded through. Verified on all 7
tile-based sprite platforms with sessions live simultaneously.

### Fixed — SMS/GG C crt0: `static x = N;` initializers booted to 0
Investigating two reported "silent sm83 miscompiles" (32-bit xorshift, indexed
loop): NEITHER reproduces on GB/GBC — both produce byte-exact output. The real bug
was a genuine **z80 crt0 defect**: `sms_crt0.s`/`gg_crt0.s` placed `_INITIALIZER`
in RAM not ROM, so the gsinit `ldir` copied RAM onto itself → every value-static
booted 0 and BSS wasn't zeroed. Fixed both (mirrors the correct `gb_crt0.s`).
Re-verified all SMS/GG scaffolds still build clean + render.

### Changed — lint stops crying wolf on WRAM copies
The SDCC `xdata-copy-miscompile` warning fired on EVERY `dst[i]=src[i]` loop,
including plain WRAM arrays (the message even said "ignore if plain WRAM") —
training agents to ignore lint. Now: provably-VRAM dest → warning, plain RAM array
→ suppressed, unknown → info. (Deliberately did NOT add the requested 32-bit-shift
/ short-loop lint heuristics — they'd be false positives for non-bugs.)

### Added — feedback ergonomics
- **`frame({op:'screenshot', scale})` up-scales** (integer ≥2, nearest-neighbor)
  for legible handheld shots (GB 160×144 → 640×576 at `scale:4`), plus the
  existing `0<scale<1` downscale. All platforms.
- **Cheap symbol→address:** `symbols({op:'resolve', dbgPath|mapPath, name})` reads
  the map FILE on disk (no 63 KB round-trip through context); `build({output:
  'romWithDebug', resolveSymbols:[...]})` folds just those addresses into the
  result. cc65 `.dbg` / sdld `.map` / GNU ld `.map`.

### Added — Genesis feel/perf diagnostics
- **`watch({on:'dma', perFrame:true})`** — per-frame DMA-bytes timeline + spike
  detection (catches "rewriting tilemaps in the frame loop", the #1 Genesis feel
  bug). A hardware-scroll scaffold settles to a flat ~8 bytes/frame.
- **`scaffold` template `two_plane_parallax`** — plane-A foreground + plane-B
  repeated starfield + player sprite, hardware scroll only, zero loop-time tilemap
  writes. Builds clean, renders, scrolls (verified).
- Genesis MENTAL_MODEL/TROUBLESHOOTING: "do NOT rewrite tilemaps in the frame
  loop", logical-vs-hardware plane size, the correct parallax loop, large-scroller-style
  column streaming, and a "why does movement feel choppy?" recipe.

### Changed — discoverability (the recurring root cause)
Several feedback "feature asks" were tools that already existed. `recordSession`
(motion/telemetry timeline) was mislabeled in the catalog as "capture inputs for
replay"; relabeled. New AGENTS.md "Diagnosing behavior over time (game-feel)"
section maps symptom → existing tool (choppy movement → `recordSession`/`watch`
series on scroll+sprite; wrong-but-clean value → `resolveSymbols` + `memory` read;
can't-read-the-BG → `background({view:'map'})` + `screenshot scale:4`).

### Other
- `build({output:'project', path})` already defaults the gb/gbc/sms/gg/msx crt0 +
  codeLoc — documented (the GBC agent was hand-passing them to `output:'rom'`).
- P4 doc + a new info-level `wram-static-overlap` lint advisory (hardcoded
  `$C000–$C0FF` pointer overlapping SDCC's static-data segment — the actual cause
  of the reporter's "monochrome RNG").

## 0.22.1

Doc-only follow-up to 0.22.0's movement-analysis feedback: the `pressDuring`
schema on `watch` and `breakpoint` now states that entries with OVERLAPPING
windows on the same port are OR'd into a chord (e.g. `b`+`right` held while `a`
fires mid-window), not overwritten. The driver already behaved this way; this
documents the guarantee so it doesn't have to be confirmed empirically.

## 0.22.0

**Transparency + correctness pass: every tool failure is actionable, dangerous
warnings are ranked first, and all 14 platforms' scaffolds build clean AND
render visible content.** The theme: a coding agent should never be left guessing
by an opaque error, never skip a crash-class warning buried in noise, and never
copy a scaffold that ships with warnings or a blank screen.

### Changed — actionable error messages across all 14 platforms
Failures now name the fix, not just the symptom:
- **`build`/assemble:** compile errors carry `{file, line, message, stage}`; LINK
  errors (which have no source line) now reach `issues[]` too, each with a `hint`
  naming the missing symbol + how to resolve it — on ALL FOUR linkers (GNU ld for
  Genesis/GBA, ld65 for NES/C64/Lynx/A2600/A7800/PCE, sdld for GB/GBC/SMS/GG/MSX,
  wlalink for SNES). The crt0 (startup-stub) assembly path and `assembleSnippet`
  now surface the first `file:line: message` instead of dumping a raw log.
- **`loadMedia`:** a refused ROM names the likely cause (wrong platform / truncated
  / unsupported mapper) and points at `cart({op:'identify'})`.
- **Runtime/host:** `getHost`'s "No ROM loaded" echoes the EXACT `loadMedia` call
  to recover with after a session eviction; unknown memory region lists the valid
  names; "no save state named X" lists the existing slots; `host({op:'unload'})`
  no longer claims success when nothing was loaded.

### Changed — build `issues[]` ranks the dangerous warnings FIRST
A weak agent skips a lethal warning when it's buried among unused-variable noise.
`issues[]` is now ordered **critical → error → warning → info** (stable within a
rank) on every platform. The SDCC pre-flight lint marks the unconditional
`uint8`-loop-bound trap as `critical: true` (it always hangs) with a `WILL HANG:`
message; the conditional VRAM byte-copy stays a plain warning (it can't be proven
unsafe statically, so it must not cry wolf).

### Fixed — `watch`/`breakpoint` inherit held input (the movement-analysis bug)
A `watch`/`breakpoint` run with NO `pressDuring` now inherits whatever
`input({op:'set'})` last held — exactly like `frame({op:'step'})`. Previously the
first frame reset the pad to neutral, silently dropping a held button. A
`pressDuring` schedule still OWNS the pad for the run (deterministic capture).
Documented on the `input`/`watch`/`breakpoint` schemas.

### Fixed — all 130 scaffolds: zero warnings AND render visible content
Swept every `scaffold({op:'project'})` template on all 14 platforms:
- **Warnings 65 → 0** (was concentrated in GB/GBC/Genesis/GG/GBA/SMS), fixed at
  the SOURCE so scaffolds model the right pattern: GB/GBC VRAM tile copies use the
  runtime's pointer-walk `memcpy_vram` (the indexed `dst[i]=src[i]` form SDCC sm83
  miscompiles into VRAM); Genesis builds pass `-Wno-main` (SGDK mandates
  `int main(bool)`); GBA/GG/SMS narrowing + dead-branch fixes.
- **Blank/broken renders 31 → 0** (verified via `frame({op:'verify'})`): added a
  patterned background to lone-sprite/text scaffolds, and fixed real bugs found
  along the way — **NES FamiTone2's `$0300` RAM collided with the C runtime BSS**
  (zeroed PPUCTRL, killed rendering; the driver's RAM was relocated to `$0700`);
  the **SNES `sfx_init()`-before-`setScreenOn()`** forced-blank trap; a **C64 cc65
  screen-fill-loop hang** (rewritten via `memset`) + sprite-data/`$0801` overlap;
  the **Lynx double-buffer** stale-page trap.

### Added — ESLint over romdev's own JavaScript
Flat config (`npm run lint`) catching real bugs (undefined refs, unused
imports/vars, dupe keys, self-assignment) over the monorepo's plain-JS ESM
sources; vendored SDK/wasm/build trees ignored. Cleaned 114 pre-existing findings.

## 0.21.0

**NES CHR-ROM / iNES rebuild ergonomics + turnkey `disasm({target:'project'})`
across all platforms.** Addresses the v0.16.0 feedback: rebuilding a commercial
NROM game from its disassembly into a byte-identical `.nes` no longer needs
hand-written iNES header bytes, a CHR-ROM `.incbin` glue source, or a 3-region
linker `.cfg`.

### Added — `build({inesHeader:{prgBanks, chrBanks, mapper, mirroring, battery?}})`
NES NROM-rebuild convenience. Auto-emits the 16-byte iNES HEADER segment, wires
the CHR-ROM blob (from `binaryIncludePaths`) into a CHARS segment, and
synthesizes the flat NROM linker `.cfg` (HEADER + PRG + CHARS). The agent
supplies only the PRG disassembly + the CHR blob — no glue `.s`/`.cfg`, no
hand-derived header bytes. PRG start/size derive from `prgBanks` (NROM-128 →
$C000, NROM-256 → $8000). Mutually exclusive with `linkerConfig`. Proven
byte-identical against `nestest.nes`.

### Added — `linkerConfig:"chr-rom"` NES preset
Sibling of `chr-ram`/`chr-ram-runtime`, for homebrew C that ships FIXED tile art:
segment split + a CHARS segment in an 8 KB ROM2 bank + a companion crt0 with an
8 KB-CHR-ROM iNES header. (For other bank configs, prefer `inesHeader`.)

### Changed — `disasm({target:'project'})` now emits a TURNKEY, rebuildable project
Previously it wrote only byte-exact `.asm` region files. Now, per platform, it
also writes the "rebuild glue": data blobs (NES CHR-ROM, MSX/Genesis/GBA/Lynx
headers), a human/agent-readable `BUILD.md`, and — where a one-call rebuild
exists — a `rebuild.json` (the exact `build()` args, absolute paths). Feed
`rebuild.json` back to `build` and you get a byte-identical ROM.
- **One-call `build()` rebuild (byte-identical):** NES, C64, Atari 7800, Lynx
  (Lynx: build() yields the headerless image + a shipped `lnx_header.bin` to
  prepend).
- **Native-recipe (byte-identical, documented in BUILD.md):** SMS, GG, MSX, GB,
  GBC, Genesis, GBA, Atari 2600 — the disasm emits each CPU's native-reassembler
  syntax (ca65 for 6502/65816, GNU `as` for z80/sm83/m68k/arm), which those
  platforms' `build()` toolchains (SDCC/RGBDS/asar/dasm/vasm) can't consume, so
  BUILD.md gives the proven native chain.
- **Not yet byte-exact:** PC Engine (planRegions trims real trailing padding +
  doesn't strip a copier header — BUILD.md says so).

### Fixed — disasm round-trip bugs surfaced by the rebuild work
- `reassemble.js`'s data-only floor omitted `.org`, silently truncating any
  region with a non-zero start address — so multi-bank GB/GBC ($4000 banks) and
  MSX ($4010) didn't round-trip at all. The floor now mirrors the linked path's
  origin handling.
- `dataRegionSource` emitted `$`-prefixed hex that GNU assemblers (ARM/m68k)
  reject (`$2E` read as an undefined symbol); it's now CPU-family-aware (`0x` hex
  for z80/sm83/m68k/arm, `$` for 6502/65816).

### Added — NES MENTAL_MODEL.md "Rebuilding a CHR-ROM NROM image" section
The iNES header bytes decoded, CHR-ROM vs CHR-RAM, NROM-128/-256 mapping, and the
three rebuild paths (`inesHeader` / `chr-rom` preset / `disasm({target:'project'})`).

## 0.20.0

**Genre-scaffold parity across all 14 platforms + the MSX cartridge-boot fix +
PCE rendering fix + a higher blank-screen bar.**

### Fixed — MSX cartridges now actually boot (`scaffold` + recipe)
Every MSX program had been booting to the C-BIOS "No cartridge found" screen:
`retro_load_game` returned true but the cart never reached a slot. Root cause was
NOT the wasm core, the C-BIOS, or the libretro API (all verified working against a
commercial MSX `.rom` in the same host) — it was our **build**. `projectBuildRecipe`
had no MSX branch, so `msx_crt0.s` was compiled as an ordinary translation unit
*alongside* SDCC's stock CP/M-style crt0; the cartridge `"AB"` header at $4000
got dropped and the INIT entry pointed at junk. Fix: route `msx_crt0.s` through
the crt0 slot (`crt0File`, `codeLoc = 0x4010`), exactly like the SMS/GG recipe.
MSX is now full tier-1.

### Fixed — PC Engine "bottom half is vertical stripes" on every game
`vdc_init` set `VDC_MWR` to `0x0010`, which per the HuC6280 VDC spec selects the
**64×32** virtual screen, not the 32×32 the comment claimed. The BAT-clear loops
walk stride-32, so only the top ~16 rows of the 64-wide map were cleared — the
bottom half rendered uninitialized VRAM as vertical stripes. Set `VDC_MWR` to
`0x0000` (true 32×32) so the clear covers the whole visible map.

### Added — genre-scaffold parity (PC Engine, MSX, Atari 2600)
PC Engine and MSX gained the full 5 canonical genre scaffolds
(`shmup` / `platformer` / `puzzle` / `sports` / `racing`); Atari 2600 gained 4
(no `puzzle` — the TIA has no tilemap to draw a match-3 board). Previously these
three shipped only ~3 ad-hoc starters while the other 11 platforms had the full
set. All 14 new scaffolds are verified rendering live (`frame({op:'verify'})` →
`verified:true`, ≥3 distinct colors, dominant under the blank threshold). The MSX
and PCE `platformer` scaffolds side-scroll (MSX via SCREEN 2 name-table column
streaming; PCE via the VDC BXR register). `scaffold({op:'game'})` now works on
all 14 platforms; only the per-(platform,genre) gaps (e.g. `atari2600` + `puzzle`)
are rejected, with the error naming the genres that platform *does* have.

### Changed — blank-screen detection bar raised to 92%
`frame({op:'verify'})`'s `nearlyBlank` threshold went from 99.5% to **92%**
dominant-color coverage — 88–92% of one flat color still reads as "blank" to a
human. A sweep re-tuned the genre scaffolds across every platform to clear the
higher bar (real backgrounds/HUD instead of a lone sprite on a flat field).

### Fixed — `frame({op:'verify'})` now emits its judged frame to the livestream
The REST/skill tool path (`runTool`) was dropping the observer image/frame
sidebands that only the MCP middleware handled, so `verify` (and any tool that
emits a deferred frame) never reached the `/livestream` UI over plain HTTP.
`runTool` now mirrors the middleware: it strips the sidebands from the result and
fires the deferred `call_frame` event.

## 0.19.0

**Two one-stop-shop features for agents — both fold into existing tools, both
work on all 14 platforms.**

### Added — `frame({op:'verify'})`: "is the game actually rendering / alive?"
A one-call render-health check for agents debugging WITHOUT vision (the spiral
where a black frame might be broken *or* fine and you can't tell). Pass `frames`
to boot-then-check in one call. Fuses two independent signals: a platform-agnostic
pixel-content scan of the live framebuffer (distinctColors, dominant-color %) and
the per-platform render-ENABLE/NMI decode (reused from the rendering-context
decoder — covers all 14 platforms). Returns `{verified:true|false|null, issues[],
pixels, render}`:
- `verified:null` + `unsettled` before any frame is stepped (frame-0 guard — never
  cries wolf on boot; step first).
- `issues[]` flags `blankScreen` / `nearlyBlank` / `renderDisabled`. `renderDisabled`
  is ONLY raised when the registers say so (never on a platform we can't decode —
  there the pixel check carries the verdict).
- Pass/fail with zero image tokens; for WHAT to fix, getPlatformDoc(mental_model).
- Verified across all 14 platforms (`frame-verify-allplatforms.test.js`): the
  verdict is internally consistent everywhere, and it correctly flags genuinely
  blank scaffolds as broken. Implements the locked `renderHealth` spec, folded
  into `frame` rather than a new top-level tool.

### Added — `watch({on:'range'/'pc', fromState|fromStatePath})`: trace from a moment
The range/PC tracers can now restore a savestate FIRST, so the log runs from a
known, repeatable point (jump to the boss fight, then see exactly what writes HP)
instead of from wherever the live session happens to be. `fromState` = an in-memory
slot (state({op:'save', name})); `fromStatePath` = a savestate file on disk
(relative paths resolve to the ROM dir). Deterministic — same state → identical
trace. Platform-agnostic (rides the existing all-14-platform range/PC watch).
Result echoes `restoredFrom`. Tests in `watch-fromstate.test.js`.

## 0.18.1

**C64: a game's OWN in-game disk SAVE works — and always did.** 0.18.0 shipped
the disk ops with a "known limit" claiming a running game's KERNAL `SAVE` doesn't
persist in WASM. That was WRONG — the cause was a bug in romdev's `.d64`
*directory reader*, not the emulator: the C64 KERNAL stores filenames in high-bit
PETSCII (A–Z = 0xC1–0xDA), and `readDirectory` dropped those bytes, so an
emulator-written `SCORE` parsed as an empty name and looked missing. VICE was
committing the save to the live disk the whole time (true-drive GCR write-back).

### Fixed
- **`readDirectory`/`extractFile` decode high-bit PETSCII filenames** (and
  lower-as-upper) — so files a game saves (KERNAL SAVE) are visible, not just
  files romdev's own `prgToD64` wrote (which used plain ASCII). Verified end to
  end: a cc65 program does `cbm_save("SCORE",8,…)`, and `exportDisk` reads the
  `SCORE` file back with the right bytes. Locked by a regression test in
  `d64.test.js` + a transparent-save test in `c64-disk-save.test.js`.
- The 0.18.0 "Known limit" is **retracted**: run the game, let it save, then
  `state({op:'exportDisk', path})` captures a `.d64` that includes the save.
  Docs + the `save_ram` n/a message corrected. (Confirmed against the native
  vice-libretro core in RetroDECK, which produces a byte-identical saved disk.)

## 0.18.0

**C64 disk SAVES — the floppy is the C64 save medium, and romdev now reads/writes
it on the live disk.** 0.17.0 added loading/running/distributing `.d64` disks;
this adds save/restore, the C64 analogue of SRAM `exportSram`/`importSram` (the
C64 has no battery RAM — games save by writing files to the floppy, so the disk
IS the save).

### Added — `state` disk ops (C64 / VICE)
- **`state({op:'exportDisk', path})`** — write the LIVE mounted 1541 `.d64` to a
  file (captures any files the game wrote to disk). Re-load it with `loadMedia`
  (autostarts) or push it back with `importDisk`.
- **`state({op:'importDisk', path})`** — write a `.d64` back into the running
  drive (inject a save disk made elsewhere). Enforces the standard 174848-byte
  35-track format.
- **`state({op:'putDiskFile', path, name})`** — inject ONE PRG file straight into
  the live disk via the drive's filesystem (the "write a save" primitive).
- Backed by new VICE core exports (`romdev_disk_export`/`import`/`putfile`) that
  operate on the live `disk_image_t` directly — captured in the reproducible
  `vice-romdev-memory-regions.patch` (verified by a from-scratch re-fetch+build).
  New `LibretroHost` methods: `exportDiskImage`/`importDiskImage`/`putDiskFile`/
  `diskImageSupported`. Locked by `c64-disk-save.test.js`.

### Known limit
- A game's OWN mid-run KERNAL `SAVE` does not yet auto-persist to disk in this
  WASM build (the emulated 1541 serial-bus write stalls). Drive saves from the
  host instead (`putDiskFile` / capture with `exportDisk`), or use a full-machine
  savestate. The C64 `save_ram` n/a message now points at the disk ops.

### Reproducibility hardening
- Every upstream pin in `versions.json` is now a full commit SHA or a verified
  sha256 — closed two gaps: **cc65** was pinned to the mutable tag `V2.19`
  (→ resolved to SHA `555282497c…`), and **sdcc** carried an unfilled
  `UNVERIFIED-…` sha256 (→ real `ae8c1216…`). Zero weak pins remain.

## 0.17.0

**C64 disk images — load real games & ship yours as `.d64`.** The Commodore
brand relaunched in 2025/26 (the FPGA Commodore 64 Ultimate / C64C Ultimate, on
the original 1986 tooling) and the homebrew/demo scene is booming — and that
world ships and loads games as **`.d64` disk images / `.crt` carts**, not bare
`.prg`. romdev was C64-`.prg`-only; now it handles disks end to end. No new
top-level tool and no core rebuild — the bundled VICE already does the work; the
gap was romdev's loader.

### Added
- **Load & run disk/tape/cart:** `loadMedia({platform:'c64', path:'game.d64'})`
  now accepts `.d64/.t64/.tap/.crt/.g64`. VICE attaches the disk to drive 8 and
  **autostarts** it (= `LOAD"*",8,1 : RUN`) under warp (~100 frames vs sitting
  at the BASIC `READY.` prompt). New c64 core-option defaults wire this up
  (`vice_autostart` + `vice_autoloadwarp` + `vice_warp_boost`, write-protection
  off). `status.mediaKind` now reflects the real medium (`disk`/`tape`/
  `cartridge`/`program`) instead of always `program` — `defaultMediaKind` is
  extension-aware.
- **Distribute as a disk:** `cart({op:'packDisk', prgPath})` wraps a built
  `.prg` into an autostart-able `.d64` (a pure-JS 1541 codec — no `c1541`
  dependency; exact `.prg` round-trip, standard 174848-byte image). `cart({op:
  'extract'})` on a `.d64` lists the directory; pass `name:` to pull a file off
  the disk. So the full create→build→distribute loop produces the format the new
  hardware and the scene actually load.

### Known limit
- **In-emulator disk WRITES (a running game's own SAVE) are not yet persisted
  back out of the core.** The write succeeds inside VICE but this WASM build
  doesn't flush the modified image to the (MEM)FS on detach, and VICE exposes no
  disk memory region. Loading/running/distributing disks is unaffected. The
  honest C64 `save_ram` n/a message says so; for reliable persistence use a
  full-machine savestate (`state({op:'save'/'load', path})`). A core patch to
  add a disk export/flush entry point is tracked as a follow-up.

## 0.15.0

**Scaffold audit: every scaffold on every platform now builds AND renders.** Two
independent multi-agent audits found the documented "scaffold then build the dir"
happy path was broken on most platforms, and that many scaffolds built but
rendered blank. Both are fixed — verified 115/115 templates build via the dir
path, and every genre game renders recognizable content. This matters most for
weaker agents: the first build now succeeds, so they build on a working example
instead of assuming the server is broken and installing their own tools.

### Fixed — project-directory build (the linchpin)
- **`build({output:'run'|'project', path})` now works on EVERY platform.** It was
  0/8 on GB/GBC/NES/Genesis and 0/5 on Atari 2600 via the natural path. The
  dir-builder used to glob every file as a source; it now applies a per-platform
  recipe that matches a hand-written build: routes the crt0 correctly (GB/GBC
  `gb_crt0.s` via the cart-header path — no more `Multiple definition of gsinit`),
  applies the linker preset (NES `chr-ram-runtime` — no more `Missing memory area
  'OAM'`), skips SDK intermediates (Genesis `sega.preprocessed.s`, the SNES SPC700
  driver, any `*.upstream.*`), wires the GBA runtime (libtonc/libgba/maxmod by
  what the source includes), routes `#include`d C/asm siblings as includes, and
  bundles every incbin asset (`.xgc`/`.vgz`/…). `output:'run'` accepts `path` too
  (build+load+run+screenshot a dir in one call). One shared code path so the two
  build routes can't drift. Locked in by `scaffold-build-happypath.test.js`.
- **SNES multi-`.c` builds** (genre scaffolds ship `main.c` + `snes_sfx.c`) — the
  stale single-`.c` guard in `buildSnesC` is removed (the link path already
  handled multiple TUs).

### Fixed — scaffolds rendered blank/wrong (now show content)
- **SMS/GG**: `vdp_init` R6 default 0xFB→0xFF — sprite tiles now read from $2000
  where scaffolds upload them (were reading the empty $0000 bank → invisible). GG
  also: 64-byte GG palette format (scaffolds shipped 32) + visible-window coords.
- **Genesis**: genre scaffolds now call `VDP_linkSprites` (the SAT link bytes were
  0 = end-of-list → only slot 0 drew); shmup enemies spread across the field.
- **SNES**: `sports`/`racing` `oamSet` now uses byte offsets (`slot<<2`); a real
  4bpp console font is embedded (the stub made all text black) + the BG-base /
  text-offset / `consoleVblank` wiring fixed → c_hello/puzzle/platformer show text.
- **Lynx**: `platformer`/`puzzle`/`sports`/`racing` use the `while(tgi_busy()){}` +
  full-screen `tgi_bar` clear (were black via bare `tgi_clear()`).
- **C64**: genre sprite data moved $0800→$2000 (it collided with the $0801 `.prg`
  load → `sports` crashed to BASIC, sprites corrupt).
- **NES**: the bundled runtime no longer races the OAM-DMA — `oam_clear` resets the
  index and `ppu_wait_nmi` hides unused slots after staging, so sprite-light
  scaffolds no longer flicker to black; `default` backdrop no longer cycles to black.
- **PCE**: `pce_video.c` now programs the VDC display timing (NTSC 256×224) — fixes
  the vertically-doubled picture.
- **GBA**: per-frame `tte_printf("%05d")` (broken in the bundled libtonc — garbles +
  wedges the loop) replaced with a hand-built score string + `tte_write`.
- **Atari 2600**: `paddle` kernel rebuilt to a 2-line kernel (the per-line work
  overflowed a 76-cycle scanline → ~250 lines, no vsync lock); now stable at 210.

### Changed
- **Doc-drift swept**: every agent-facing `runSource`/`buildSource` → the current
  `build({output:'run'|'rom'})`, dead tool names (`loadCategory`, `inspectSprites`,
  …) → the consolidated forms, across the scaffold README emitter, `nextStep`,
  examples, platform docs, and `.cfg` comments. Emitted scaffold-README `frames`
  60→240 (60 caught the boot logo on some platforms → false "blank").
- **Thin genres** given a BG world (Genesis sports court / racing road, NES racing
  road, SNES sports/racing) so they read as the genre, not objects on black.
- **Missing-genre error** for msx/pce/atari2600 now names the working project
  templates instead of a bare "default".
- The `uint8-loop-bound` preflight lint is scope-aware (no longer false-flags a
  `uint16_t` loop counter that shares a name with a `uint8_t` in another function).

## 0.16.0

**Build diagnostics: agents were building blind — errors AND warnings now reach
the response as structured `issues[]`.** An agent can only fix what the toolchain
tells it, where it tells it. Audited the whole build surface and closed the gaps
so diagnostics (file/line/message/stage) come back in the tool result, not buried
in the raw log. (Also bumps a doc count: the surface is 32 tools after 0.15.0's
dmaTrace→watch / patchGbHeader→romPatch consolidation; stale "34" references in
the docs + source comments updated.)

### Fixed
- **Warnings were OFF.** No C compiler was being asked for them. gcc (GBA/Genesis)
  now compiles USER source with `-Wall -Wextra -Wno-unused-parameter` (the bundled
  SDK stays warning-free so its noise doesn't bury the agent's); cc65 enables its
  valid high-value `-W` set. So unused vars, implicit declarations, etc. are now
  emitted and surfaced.
- **Swallowed errors now structured:** SDCC's keyword-less `file:line: syntax
  error: …` and `warning NNN: …` (GB/GBC/SMS/MSX previously returned an empty
  `issues[]` on a syntax error); the sdld/ASlink `Undefined Global '_x'` link
  error; vasm errors (Genesis asm emits no stage marker, so they hit the
  fallback, which had skipped the vasm parser); and a **missing `incbin` asset**
  — the #1 thing an agent forgets to pass — now reports `could not open <x.bin>`
  with the exact filename.
- **Fixed a build crash that ate the real error:** `build({output:'rom', path})`
  fell into the source builder with no source and threw "Cannot read properties
  of undefined (reading 'split')" instead of the compiler error; it now routes to
  the project-dir builder like `output:'run'`/`'project'`.
- Verified live across all 14 platforms; a `parse-errors-coverage` test locks the
  formats in. (Known limit: asar/SNES-asm only yields a wrapper "aborted"
  message — its WASM build aborts without printing line info.)

### Added — SRAM (cartridge battery save) support, folded into existing tools
The cartridge battery SAVE FILE (in-game saves — distinct from a whole-machine
savestate) is now fully supported, with NO new top-level tool:
- **Live read/write** already worked via `memory({region:'save_ram'})` on every
  battery-capable core (NES/GB/GBC/SNES/Genesis/GBA — verified against each core's
  source; they all expose RETRO_MEMORY_SAVE_RAM).
- **Persist the `.sav`:** `state({op:'exportSram', path})` / `{op:'importSram', path}`
  dump/restore the battery RAM as a real save file (relative path → ROM dir, size-
  mismatch guard, zero-pad-smaller). The save-editor / inject-a-save capability that
  previously forced agents out to local tooling.
- **Presence:** `cart({op:'identify'})` now returns `saveRam:{hasBattery, bytes}`
  (from the iNES battery flag / GB cart-type) so an agent knows a save exists.
- **Honest "no save":** empty `save_ram` now says *why* — "this cart has no battery
  save" / "Atari 2600/7800 & Lynx never had cartridge saves" / "C64 has no battery SRAM (disk/.prg)" — instead of a generic "core didn't expose it." (Confirmed via research +
  core source: no core patches were needed; earlier "broken" readings were
  password-based NES carts, which correctly have no battery.)

### Fixed / Added — v0.15.0 session feedback
- **`state` file `path` resolution.** A RELATIVE `path` (save/load/export) used to
  resolve against the server's CWD → silent ENOENT (and the docs use relative
  paths). It now resolves against the LOADED ROM's directory ("states live next to
  my ROM"); absolute paths are used as-is; the result echoes `resolvedPath`.
- **Abort-guard on input-driven `breakpoint({on:'write', precision:'exact'})`.** New
  `abortIf:[{region,offset,label}]` — caller-named "is this scenario still valid?"
  bytes. If any changes mid-run (player died → title screen, scene flipped) the
  watchpoint stops IMMEDIATELY and returns `{aborted:true, abortedBy, before,
  after}` instead of burning all `maxFrames` and returning a meaningless
  `found:false`. Collapses the derailed-run recovery (breakpoint → screenshot →
  N× memory read → reload) into one informative call.
- **No-hit note is now once-per-session.** `breakpoint` on:write used to repeat a
  ~100-token "two common reasons" explainer on every miss; the full form now fires
  only on the first miss per session, a one-liner after.

## 0.14.0

**Two platform-specific top-level tools folded into their domain verbs, a
device-free cheat search, and skill-surface polish.** Pre-1.0 the surface keeps
consolidating with no deprecated aliases (call `catalog({op:'whatsNew'})` for the
live OLD→NEW map), so the tool count drops 34 → 32.

### Changed (breaking — pre-1.0, no aliases)
- **`patchGbHeader` → `romPatch({op:'gbHeader'})`.** It's a ROM-file patch, same
  family as romPatch's other ops — not a standalone Game-Boy tool. Same params
  (path/outputPath/cgb/title/cartType/romSize/ramSize/destination), same output.
- **`dmaTrace` → `watch({on:'dma'})`.** The Genesis VDP-DMA trace is a log-all
  trace like `watch`'s on:'mem'/'range'/'pc' — now a fourth `on`. Same
  `precision:'exact'|'sampled'` + filters.
- **`cheats({op:'search'})` no longer needs `platform`.** Omit it and the search
  sweeps EVERY indexed platform; each match reports its own `platform`. You don't
  have to know the console to find a game's cheats. Pass `platform` only to scope
  the search to one console.

### Added
- **`GET /skills/romdev/SKILL.md`** is now the primary skill URL — it mirrors the
  on-disk path agents save skills to (`~/.claude/skills/romdev/SKILL.md`) exactly.
  `/romdev/SKILL.md` and the flat `/romdev-skill.md` are kept as aliases.
- **The `/livestream` observer header now links to `/documentation`** (the live
  Swagger console), so a human watching can jump to the API docs.

### Fixed (HTTP transport — failures are now unmissable)
- **A failed tool call returns a non-2xx, never a 200 with the error in the body.**
  Tools that signal failure by RETURNING a failure-shaped result ({ok:false} /
  {opened:false} / {applied:false} / a top-level `error`) — not just by throwing —
  now map to HTTP 400 uniformly for EVERY tool. Before, e.g. `playtest` returning
  `{opened:false}` came back 200, so an agent driving the REST/skill surface saw
  "success," never read the body, and reported "window's up!" while no window
  existed. (Valid "no"/state answers — `notSupported`, `matched:false`,
  `loaded:false` — correctly stay 200.) A failed `playtest` window-open also now
  logs to the server console so a human at the terminal sees it regardless.
- **`x-romdev-session` is now REQUIRED — a missing header returns 401**, instead
  of the server auto-minting a throwaway one-shot session (which silently dropped
  the loaded ROM and surfaced as "No ROM loaded" a couple calls later). The 401
  message tells the agent to pick one stable id and send it every call.

### Fixed (playtest — no more invisible windows)
- **`playtest({op:'open'})` now FAILS LOUDLY when there's no real display** instead
  of reporting `opened:true` for a window nothing can see. If the server's SDL
  comes up on the `offscreen`/`dummy` video driver (no desktop session — server
  started over SSH, from a tty, before the desktop login, or as a headless agent
  subprocess), the window would render and play audio but never appear on a
  screen. We now detect the selected driver via SDL itself
  (`sdl.info.drivers.video.current`) — ground truth, cross-platform (Linux/macOS/
  Windows), and it correctly ALLOWS a virtual display like Xvfb (reports `x11`,
  not `offscreen`). On the offscreen case the open throws (→ 400 / MCP error) with
  the exact fix: run the server from inside your logged-in desktop session.
  Headless tools (screenshot/runSource/inspect) are unaffected — offscreen stays
  fine for everything except opening a window for a human.

### Changed
- **The skill/HTTP session docs now coach a UNIQUE, task-descriptive
  `x-romdev-session` id** (e.g. `nes-platformer-build`) — the id is the label a
  human sees in `/livestream`, and it's how several agents share one server
  without clobbering each other's emulator host.

## 0.13.0

**Renamed `romdev-mcp` → `romdevtools` + a plain-HTTP tool surface and an Agent
Skill, so you can drive the same tools without using MCP.** Most agents support
MCP; some people just prefer not to (setup, always-on context cost, server
lifecycle). The same 34 tools are now reachable three ways — MCP, plain HTTP,
and a portable SKILL.md — all generated from the one tool registry (no
duplication). Same Express app, same localhost trust, per-agent dynamic sessions.

### Changed (rename + robustness)
- **Package `romdev-mcp` → `romdevtools`**; primary command is now `npx
  romdevtools`. `romdev-mcp` stays a bin alias of the same server, so existing
  `npx romdev-mcp` / MCP configs keep working. CLI bin → `romdevtools-cli`.
- **Server fails loudly on a bad bind.** The primary HTTP listener now handles
  `error`: a taken port prints a clear "port N in use — use a different port"
  message to stderr and exits non-zero, and the success banner only prints on a
  real bind (previously it could print "listening…" + exit 0 while not bound).
  `GET /healthz` now returns `version` (so a saved skill can detect staleness).

### Added
- **`POST /tool/{name}`** — run any tool over plain HTTP; JSON body = the args,
  JSON response = the result. Same handlers, same strict validation, same clean
  errors as MCP (bad enum / wrong type / "unknown parameter 'addr' — did you mean
  'offset'?"). Sticky emulator sessions via an `x-romdev-session` header (the
  first call returns one; echo it to keep a host across load→step→read); omit it
  for one-shot file tools. No auth (localhost, same model as `/mcp`).
- **`GET /openapi.json`** — OpenAPI 3.1 for every `/tool/{name}`, request schemas
  via zod→JSON-Schema (the same conversion MCP `tools/list` uses).
- **`GET /documentation`** — Swagger UI over the spec: a live "try it" console.
- **`GET /tool/{name}/schema`** — that tool's JSON Schema (a validator on demand).
- **`GET /skills/romdev/SKILL.md`** — the Agent Skills open-standard SKILL.md
  (frontmatter + workflow guide + generated tool reference). ~100 tokens of
  name+description until invoked vs the always-on MCP tool defs — the on-demand
  context win. Works in Claude Code, opencode, OpenClaw, Hermes, etc. unchanged.

### Changed
- **AGENTS.md is now channel-neutral.** The "how to call" prose lives in per-
  channel preambles (`src/http/skill-doc.js`): the MCP connection text =
  mcpPreamble + AGENTS body ("call the MCP tools…", no routes); the skill doc =
  skillPreamble + sanitized AGENTS body + tool reference ("POST /tool/{name}…",
  no MCP). Neither surface mentions the other (enforced by a test).

## 0.12.0

**Music compilers for 9 systems** — `encodeAudio` grew from 3 to 13 targets, so an
agent can compile real music into a game on nearly every platform with no external
tools. Each target emits exactly what that platform's bundled sound driver plays.

### Added
- **`encodeAudio({ target:'maxmod' })`** — GBA: a tracker module (`.xm`/`.mod`/
  `.it`/`.s3m`) → a Maxmod **soundbank** (.bin + .h). A faithful pure-JS port of
  devkitPro `mmutil` (new package **`romdev-maxmod`**), **byte-identical to real
  mmutil** (verified on .xm/.mod/.it). No devkitPro, no native binary.
- **`encodeAudio({ target:'famitone' })`** — NES: a FamiTracker text export
  (`.txt`) → FamiTone2 ca65 data. A faithful pure-JS port of `text2data` (new
  package **`romdev-famitone`**), byte-exact vs `text2data -ca65`. `noWarnings`/
  `keepInstruments` flags. Plays via the bundled famitone2.s driver.
- **`encodeAudio({ target: 'spc'|'gg'|'sms'|'c64'|'lynx'|'atari7800'|'gb'|'gbc' })`**
  — a note/duration `song` → that platform's bundled-driver note table (in-process,
  no new packages). Note→native pitch per chip: SNES DSP pitch, SN76489 divider
  (gg/sms), SID freq word (c64, 3 voices), Mikey note index (lynx), TIA AUDF
  (atari7800, 32-pitch snap), hUGE note index (gb/gbc, multi-channel hUGEDriver).
  Emits a drop-in `cSource` + raw table bytes. Each verified against its driver's
  own pre-baked note values (e.g. A4=440 → GG divider 254 = the driver's NOTE_A4).
- **`MUSIC_SOURCING.md` guide** — the per-system recipe for turning chiptune /
  tracker / VGM **or arbitrary audio (WAV/MP3)** into game music: ffmpeg → sample
  encoders for the sample-capable systems (Genesis/SNES/GBA), and the open-source
  transcription chain (Basic Pitch → FamiStudio/OpenMPT/mid2vgm → these compilers)
  for the synth-only chips, with the honest "synth chips play notes, not your
  recording" caveat.

### Notes
- The MCP surface stays **34 tools** — every new compiler is a `target` on the
  existing `encodeAudio`, not a new tool.
- PCE and MSX have no bundled music driver yet, so they're not covered (they'd
  need a driver written first, not just a compiler).

## 0.11.0

Genesis music + the symbol/build/audio gaps from the v0.6.0 agent feedback, plus
the consolidation-review follow-ups (axis consistency, op cheat-sheets, a
discoverable rename table).

### Added
- **`catalog({op:'whatsNew'})`** — the recent CHANGELOG + an OLD→NEW tool RENAME
  TABLE (derived from the consolidation MERGE_MAP). Resuming a handoff written
  against an older server? Call this first: pre-1.0 the surface consolidates
  freely with no deprecated aliases, so a remembered name is usually now an `op`
  on a domain tool — this maps all ~124 of them in one read instead of probing.
- **Per-op "cheat-sheet" lines** at the top of the fat domain tools (`cpu`,
  `romPatch`, `memory`, `tiles`): a one-line `op → {params}` map so you can see a
  single op's signature without reading the whole merged param blob.
- **`encodeAudio({ target:'xgm2', vgmPath|vgmBase64, name, system })`** — compile a
  `.vgm`/`.vgz` to a COMPILED Genesis XGM2 blob + a 256-aligned C array you
  `#include` and `XGM2_play()`. `XGM2_play()` needs a compiled blob (split FM/PSG
  streams + sample table), not raw VGM — this does that compile. It's a pure-JS
  port of SGDK's Java `xgm2tool` (new package **`romdev-xgm2`**); no Java/jar, no
  native binary. PSG-only tracks coexist with `xgm2pcm` SFX. Verified end-to-end
  (VGM → ROM → gpgx plays real audio).
- **Genesis/GBA symbol resolution.** `symbols({op:'resolve'|'lookup'|'list'|'map'|'addr'})`
  now parses the GNU ld `.map` that `build({output:'romWithDebug'})` produces for
  Genesis (m68k) and GBA (ARM), in addition to cc65 `.dbg` and SDCC sdld `.map`.
  So a C global's name → address → `memory({op:'read'})` is a 1-byte headless
  assertion on every buildable platform (and the SDCC targets gained
  resolve/lookup/list, which they lacked before). Genesis work-RAM symbols come
  back with a `ramOffset` + a ready `system_ram` read recipe.
- **`audioDebug({ op:'inspect', frames:N })` trace mode** — steps N frames,
  samples the chip each frame, returns a per-channel note-timeline (value
  transitions) to assert a melody headlessly. Single-frame snapshot stays the
  default (omit `frames`).
- **`build({ output:'project', path, platform })` builds a C/SGDK directory.**
  Now discovers `main.c` (C / SGDK Genesis / GBA / cc65-C / SDCC-C) or
  `main.s`/`main.asm` and links every source in the dir — no per-iteration file
  manifest. Binary assets (`.bin/.chr/.pcm/.brr/.vgm/...`) fold in automatically.

### Changed (breaking — pre-1.0, no aliases)
- **`tiles` is now keyed by `op`, not `as`.** Every other domain tool keys on
  `op`; `tiles({as:...})` was the lone exception and agents reflexively typed
  `tiles({op:...})` and ate a round-trip. Now consistent: `tiles({op:'png'|
  'pixels'|'fingerprints'|'ascii'|'preview'})`. The old `as` key is rejected.

### Fixed
- Genesis music docs named the wrong tool/API. Corrected to `XGM2_play` (there is
  no `XGM2_startPlay` in R58), the compiled-blob requirement, and that the legacy
  `xgmtool`/`.xgc`/`XGM_*` is a DIFFERENT format.
- **`romPatch({op:'findPointer'})` no longer doubles its hit list with shadows.**
  On the multi-width systems (Genesis: 32+24-bit BE; SNES: 16+24-bit LE) a wider
  hit shares its low bytes with the narrower form one position over — the byte
  shadow. Those are now suppressed by default (`shadowsSuppressed` reports the
  count); `suppressShadows:false` shows the raw set and a new `widths:[4]` filter
  searches only the widest form. The suppression matches on offset-overlap AND
  pointer-value (so two coincidentally co-located but distinct pointers are never
  falsely merged). The other 12 platforms emit a single width, so this is a
  verified no-op there. (sports-title agent nit: 20 hits → the 10 distinct
  relocation handles, no hand-dedupe.)
- **`cpu({op:'call'})` watchdog now trips on a wrong-entry free-run, not just a
  tight loop — on EVERY CPU.** Two cross-system gaps fixed:
  - The default budget was `maxFrames*500k`, always larger than `maxFrames`-worth
    of real execution, so a wrapper PC with a bad source that fell back into the
    game's main loop silently hit `maxFrames` with `watchdog:false`. The default
    is now **per-CPU** (`0.8 × maxFrames × instrPerFrame`, capped at 4M) so it
    trips before the frame cap on the fast cores AND the slow ~1MHz 8-bit CPUs
    (a flat 4M never tripped within 600 frames on the 6507/6510 — they run only
    ~3–3.8M instructions in that span). Real codecs finish in <~1M instructions,
    so even the slow-CPU floor keeps 2–3× headroom. The not-returned message now
    names the wrapper/free-run case.
  - **The instruction watchdog is now wired into the gpgx `z80_run` loop, not
    just `m68k_run`** — so it actually fires on **SMS/GG** (where the Z80 is the
    active CPU). Before, `callSubroutine` armed a watchdog that could never trip
    on SMS/GG (the counter only incremented on the m68k), so a Z80 free-run fell
    to `maxFrames`. Requires the rebuilt `romdev-core-gpgx` WASM. (sports-title
    agent nit, generalized to all 14 platforms.)

## 0.10.0

Tool-surface consolidation: **132 narrow tools → 34 domain tools.** Every tool is
now a small verb with a typed operation axis (`memory({op})`, `build({output})`,
`breakpoint({on})`, `sprites({op})`, `disasm({target})`, `romPatch({op})`, …) —
never a generic `action: functionName` dispatcher. No capability lost; every old
tool is reached as an operation on a richer domain tool. Cuts the dump-all token
cost ~4× and keeps the surface under the soft tool-cap of clients like Cursor/
Copilot. The progressive-disclosure path (`loadCategory`/`describeTool`/lean mode)
was removed too — every tool registers at session init, so `tools/list` returns
the full surface immediately. See AGENTS.md "Tool surface" for the new names and
the rename map.

## 0.9.0

The RE-INJECT path (Blocker 2 from the decompress feedback) — the round-trip
side of a ROM hack. You could already FIND any asset; now you can put an edited
copy BACK in a form the game accepts, on all 14 platforms.

### Added
- **`makeStoredBlock({ platform, rawHex|rawBytes, format })`** — wrap raw bytes so
  the game's OWN decompressor expands them VERBATIM, via each format's literal/
  raw-copy escape. No need to write a compressor. Formats: GBA BIOS LZ77 (flag
  byte 0x00 = 8 literals), SNES LC_LZ2 (command 000 direct-copy + 0xFF end),
  SMS/GG + MSX RLE (0x80|n literal run), NES PackBits/Konami-RLE, and `raw` (no
  wrapper) for the systems that store graphics uncompressed (Lynx/2600/7800,
  often PCE, NES CHR-ROM). HONEST limits, surfaced in the tool: Genesis Nemesis
  (Huffman) and C64 crunchers (Exomizer/pucrunch) have NO clean stored escape and
  are not offered; Genesis Kosinski is offered but flagged EXPERIMENTAL (the
  end-terminator varies by decompressor — self-verify). Output is proven to
  round-trip both against reference decompressors AND, for GBA, against the REAL
  BIOS LZ77 (SWI 0x11) running live under mgba.
- **`findPointerTo({ path, romOffset })`** — find every pointer in a ROM that
  references a byte offset, using the platform-correct encoding: Genesis 32-bit
  BE (= ROM offset, 1:1 at $000000); SNES 16-bit (bank-implied) / 24-bit long LE
  via LoROM/HiROM (auto-detected); GBA 32-bit LE = 0x08000000+offset (value-
  search-complete — catches literal pools AND tables in one pass); NES/GB/SMS/PCE
  /etc 16-bit LE CPU addresses with their bank-window aliases (page-ambiguous —
  correlate with the nearby bank-set). The missing piece for redirecting a loader.
- **`relocateBlock({ path, newHex, toOffset, pointerOffset })`** — write an edited
  block to free ROM space (pair with findFreeSpace) and repoint a pointer at it,
  with the platform-correct pointer encoding. `dryRun:true` previews the writes.
  The safe "don't overwrite in place" move when an edit changes size.

The full round-trip: watchDma/findWriter locate the block → callSubroutine
decompresses it (now hang-proof) → edit → makeStoredBlock → findFreeSpace →
relocateBlock writes + repoints → verify in the emulator.

## 0.8.0

The `callSubroutine` instruction **watchdog is now on every CPU core** — the
0.7.0 hang-fix was the Genesis reference; this round fans the core-side hook out
to the other ten CPUs so a runaway routine never hangs the WASM on any platform.
Requires the bumped core packages.

### Changed — watchdog on all cores
- The instruction WATCHDOG (force-stop a runaway routine at a host-set budget,
  return `{watchdog:true, finalPC, finalRegs}` instead of hanging `_retro_run`) is
  now built into all eleven CPU cores: m68k+Z80 (gpgx, 0.7.0), 6502 (fceumm),
  SM83 (gambatte), 65816 (snes9x), ARM7TDMI (mgba), 65C02 (handy), 6510 (vice),
  6502 (prosystem), 6507 (stella2014), HuC6280 (geargrafx), Z80 (bluemsx). Each
  core: a per-instruction counter in the CPU dispatch loop that, at the limit,
  freezes the PC + sets the same `romdev_pc_hit` the breakpoint uses (so
  `retro_run` drains the frame and returns), reports the trip as a 6th element of
  `romdev_pcbreak_get`, and exports `romdev_watchdog_set`. mgba ends the frame via
  a cycle-budget bump and NEVER `processEvents` (so the VBlank IRQ can't rewrite
  the frozen PC). Why it must be in each core: WASM is single-threaded synchronous,
  so a JS timeout can't interrupt a routine spinning inside one `_retro_run` frame.
- `callSubroutine` / `decompressWith` now return progress-on-timeout (Blocker 1
  from the decompress feedback) on EVERY platform, not just Genesis.
- Verified per core with a dedicated watchdog test (an infinite-loop routine trips
  the watchdog, reports `finalPC`, and does NOT hang). 593/593 green.

## 0.7.0

Reverse-engineering follow-ups from a Genesis sports-title agent's decompress
feedback. Genesis reference for the hang-fix (the watchdog is a core hook — it
fans out to every core in 0.8.0); the JS-layer fixes (watchDma, previewTileArt)
are all-platform.

### Added — `callSubroutine` no longer hangs (Blocker 1)
- **Instruction watchdog** (`romdev_watchdog_set`, gpgx m68k): force-stops a
  runaway routine (e.g. a codec fed a wrong A0 that loops forever) so it can't
  hang `_retro_run`. `callSubroutine` arms it and on timeout returns PROGRESS —
  `finalPC` (where it's stuck) + `finalRegs` (A0/A1/D0/D1/PC/SP) + `watchdog:true`
  + a `reason` — instead of an opaque `returned:false`.
- **`presetMemory`** param — seed RAM globals a codec reads before running it.
- **`stopAtPC`** param — halt mid-routine and return the partial output.
- **`maxInstructions`** param — the real (instruction-count) budget. Tail-call /
  JMP-wrapper routines are handled (the final RTS is what's detected).

### Changed
- **`watchDma`** — `dedupe:true` collapses the per-frame VRAM refresh (7000+ events
  → a handful + an `occurrences` count); `sourceFilter:'rom-only'|'ram-only'` drops
  the RAM→VRAM sprite noise; adds `from:ROM/RAM` and `limit`. Fixes the token-cap
  flood the agent hit twice.
- **`previewTileArt`** — `byteOffset` param (preview straight from a raw DMA /
  `findReferences` source) with an `alignmentWarning` + nearest-aligned offsets
  when it isn't a multiple of the tile size — the silent-scramble trap.

## 0.6.0

Reverse-engineering round 2 — the tools that collapse the two walls a real
romhack hits: **compressed assets** and **finding the unknown routine**. All on
**all 14 platforms** (every CPU family), feature-detected with clean `notSupported`
where a core can't. Requires the bumped core packages.

### Added — drive the ROM's own code (item 1)
- **`callSubroutine({ pc, regs, sandbox })`** — set up the CPU (registers by reg-id,
  PC) and run a subroutine until it returns, then read back what it produced.
  Sandboxed (snapshot+restore) by default. The general RE primitive.
- **`decompressWith({ entryPC, sourceAddress, destAddress })`** — thin wrapper for
  the decompressor shape (A0=src/A1=dst). Run the game's OWN codec and `readMemory`
  the output — instead of reimplementing an undocumented LZ format. The codec wall,
  gone.
- **`setRegister({ regId, value })`** — write a CPU register (inverse of getCPUState).
  Per-CPU reg-id conventions (m68k 0-7=D,8-15=A,16=PC,18=SP; 6502 0=A,1=X,2=Y,3=P,
  4=SP,16=PC; SM83/Z80 0=A,1=F,2-7=BCDEHL,16=PC,18=SP; 65816 +5=DB,6=D; ARM 0-15=
  r0-r15,16=CPSR). The host's `callSubroutine` knows each CPU's stack discipline
  (page-stack vs predecrement, return width, the 6502/65816 RTS+1 quirk, ARM
  pipeline flush), so it drives routines correctly on every core, not just Genesis.

### Added — discovery (item 2)
- **`watchRange({ start, end, kind })`** — log EVERY read/write hitting an address
  range (not stop-on-first) as `{pc,address,value}`, with a `distinctPCs` summary.
  The fix for "I don't know which PC touches this" — watch the whole pool and SEE
  the routine instead of probing single addresses.
- **`logPCRange({ start, end, frames })`** — coverage trace: every DISTINCT PC that
  executed in a window. FIND an unknown renderer by seeing what runs, not guessing.

### Added — targeted DMA (item 3, Genesis)
- **`watchDma({ vramDest })`** — every mem→VDP DMA with its VRAM destination + ROM
  source + length. "Which DMA wrote the tile at VRAM 0xNNNN, and from where?" — the
  precise version of `traceVramSource`, the way to catch a DMA'd (not CPU-written)
  name/portrait bitmap. Genesis-only (VDP DMA); `notSupported` elsewhere.

### Also
- **PC Engine (geargrafx) gained a write watchpoint** — so `findWriter` +
  `watchRange`-write now work there too (round 1 had read-watch + breakpoint only).

## 0.5.0

Execution breakpoints — the RE primitive that turns "infer for hours" into "read
the register." Adds `runUntilPC`, `runUntilRead`, and `stepInstruction`, live on
**all 14 platforms**. Same model as the write watchpoint; requires the bumped core
packages (gpgx, fceumm, gambatte, prosystem, geargrafx, bluemsx, handy, vice,
platform-snes, platform-atari2600, platform-gba).

### Added — PC breakpoint + read watchpoint + single-step (all 14 platforms)
The symmetric gaps next to `findWriter` (a core-level WRITE watchpoint), requested
by an agent who could disassemble a name-decoder but couldn't read the one address
register that held the answer. Every bundled CPU family now has it:
- **m68k** Genesis (gpgx), **6502/65C02** NES (fceumm) · Atari 2600 (stella) ·
  Atari 7800 (prosystem) · Lynx (handy), **SM83** GB/GBC (gambatte), **65816** SNES
  (snes9x), **Z80** SMS/GG (gpgx) · MSX (bluemsx), **HuC6280** PC Engine (geargrafx),
  **ARM7TDMI** GBA (mgba), **6510** C64 (vice).
- Each core gains the same `romdev_pcbreak_*` / `romdev_readwatch_*` exports (the
  gpgx m68k patch is the template); the host + MCP layer is core-agnostic and
  feature-detects, returning `notSupported` on any core that lacks the exports.
- Single-step is a per-instruction countdown so it ADVANCES the PC; on a hit the
  core consumes its frame cycle budget (PC frozen) so `retro_run` still completes —
  no mid-frame hang.
- **PC Engine caveat (fixed in 0.6.0):** at 0.5.0 geargrafx had no write
  watchpoint, so `findWriter` was unavailable there (the breakpoint tools worked).
  0.6.0 adds the write watchpoint to geargrafx, so `findWriter` works on PC Engine
  too — all 14 platforms now.
- **`runUntilPC({address, maxFrames, pressDuring})`** — runs until the m68k PC
  reaches `address`, then STOPS with the CPU frozen EXACTLY at that instruction
  (the core's execute loop bails mid-frame on the hit). Then `getCPUState` reads
  the full register file at that precise moment — e.g. break at a decoder's
  `move.b (a0),d0` and read `A0` to get the source pointer in one shot.
- **`runUntilRead({address, ...})`** — the read-side mirror of `findWriter`:
  returns the EXACT instruction PC that READ a watched address (find who *consumes*
  a value, not just who writes it).
- **`stepInstruction()`** — CPU-level single-step (finer than `stepFrames`); pair
  with `getCPUState` to watch registers change one instruction at a time.
- All three feature-detect per core and return `notSupported` where the core lacks
  the patch. Genesis is wired now; the gpgx m68k patch (`romdev_pcbreak_*` /
  `romdev_readwatch_*`) is the template for the remaining cores.

### Fixed
- `build-genesis-plus-gx.sh` now stages the rebuilt core into BOTH `src/cores/wasm`
  AND the `romdev-core-gpgx` package (which the registry actually resolves at
  runtime) — a rebuild no longer silently loads the old package copy.

## 0.4.1

Fixes inverted controller-button mapping on the three genesis_plus_gx platforms
(Genesis, SMS, Game Gear), backed by a **full empirical 14-platform input audit**.
Pure `romdev-mcp` patch — no toolchain/core packages changed.

### Fixed — genesis_plus_gx face-button aliases were inverted
genesis_plus_gx maps the console's printed face buttons onto libretro ids in a
non-obvious order, and romdev's native-button aliases + docs had it backwards.
Verified empirically against the running core (an SGDK / port-$DC probe driven by
each libretro button):
- **Genesis**: A/B/C map to libretro **y/b/a** — so `setInput({a:true})` presses
  Genesis **C**, and Genesis A (SGDK `BUTTON_A`) is `setInput({y:true})` /
  `{west:true}`. `pressButton({button:'c'})` resolved to libretro `y` (Genesis A!);
  now resolves to `a` (Genesis C).
- **SMS / Game Gear**: button 1 (TL) = libretro **b**, button 2 (TR) = libretro
  **a** — so `setInput({a:true})` presses button 2. `pressButton({button:'1'/'2'})`
  resolved to `a`/`b`; now `b`/`a`.
- The **spatial face-button names are correct** on all of these (east/south/west
  resolve to the right physical button) — prefer them, or `pressButton`'s native
  aliases, over raw libretro a/b/x/y.
- This was an agent-reported bug: an SGDK platformer's jump (BUTTON_A) wouldn't
  fire headlessly because every "reasonable" libretro guess pressed the wrong
  button.

### Verified — all 14 platforms probed live (so we KNOW the scope)
Each platform got a hardware-register probe ROM driven by each libretro button.
Result: the press-inversion is **exactly the three genesis_plus_gx platforms**
(Genesis/SMS/GG). Every other core maps `setInput({a})`→A correctly:
**NES** (fceumm), **GB/GBC** (gambatte), **SNES** (snes9x — a/b/x/y/l/r all
correct), **GBA** (mGBA), **PC Engine** (geargrafx — a=I, b=II), **MSX** (bluemsx
— a=trigger 1, b=trigger 2), **Lynx** (handy — a=A, b=B, active-high). **C64**
(vice) and **Atari 2600** (stella) are single-fire — fire registers via `b`/`south`,
`a` is a correct no-op.

### Changed — docs
- `getInputLayout` notes for genesis/sms/gg corrected (they previously claimed
  libretro `a` = Genesis A / SMS button 1 — both wrong).
- **Atari 7800** `getInputLayout` note corrected: it had the ProLine INPT register
  numbers swapped (claimed a→INPT1/b→INPT0; the audit + prosystem source confirm
  **a→INPT0 (right/button 2), b→INPT1 (left/button 1)**). The right/left semantic
  was already right, so button presses were unaffected — only register-by-number
  reads were misled. Also documents the default 1-button boot mode (both fires read
  INPT4 until 2-button mode is enabled via CTLSWB).
- `setInput` / `pressButton` descriptions now surface the face-button-naming trap
  at the callsite and point to spatial names / `getInputLayout().faceButtons`.
- `stepFrames` / `screenshot` descriptions nudge toward `stepAndScreenshot` for
  the drive-then-look loop (token-saving).

## 0.4.0

Native disassemblers across the board, GBA disassembly + byte-exact projects
unlocked, and smarter cheat search. Disassembly is now byte-exact on **all 14
platforms** — `disassembleRom`, `findReferences`, and `disassembleProject` all run
through native tools end to end, no hand-rolled JS de/encoders left anywhere.

### Changed — native binutils disassemblers replace ALL the hand-rolled ones
Every hand-rolled JS instruction decoder (m68k / z80 / sm83) is **deleted** and
replaced by **native GNU binutils `objdump` compiled to WASM** — the same binutils
we already build per toolchain, now shipping `objdump` alongside
`as`/`ld`/`objcopy`. The JS decoders dropped real instructions and (on m68k)
desynced the byte stream into garbage — the "useless binary" a Genesis RE session
hit. There is **no JS fallback** — the native path is the only path.
- **m68k (Genesis)** → `m68k-elf-objdump`. The JS decoder dropped move-sr / muls /
  divu and mis-sized the fallback; a real ROM now disassembles cleanly.
- **Z80 (SMS / Game Gear / MSX)** → binutils z80 `objdump` `-m z80` (fixes the
  (ix+d)/(iy+d) displacement display + edge cases).
- **SM83 (Game Boy / Color)** → the same z80-elf `objdump` via its `gbz80` machine.
  One z80-elf binutils serves both CPU families.
- **ARM/Thumb (GBA)** → `arm-none-eabi-objdump`.

### Added
- **GBA disassembly** (the 14th platform, previously rejected) — `disassembleRom`
  and `findReferences` disassemble ARM7/Thumb via native `arm-none-eabi-objdump`
  (ARM by default, `thumb:true` for Thumb code).
- **`disassembleProject` now covers all 14 platforms, GBA included.** Each region
  disassembles through the CPU's native objdump and reassembles **byte-exact**
  through the matching native `as`/`ld`/`objcopy` (cc65 ca65/ld65 for 6502/65816).
  Any line the assembler won't reproduce exactly is healed to a `.byte` of its real
  bytes, so the round-trip is always byte-for-byte. The GBA project splits a 192-byte
  header data region from an ARM code region; it rebuilds byte-exact but reads low
  (most GBA C is Thumb reached via an ARM crt0 stub — ARM/Thumb mode-tracking is the
  readability follow-up).
- **Lynx** wired into `disassembleRom` + `findReferences` (65C02 via da65; strips the
  64-byte LYNX header, anchors at $0200).
- **Cheat search** now uses `fuse.js` over tag-stripped game names — adds
  character-level typo tolerance on top of the existing region/revision-tag and
  word-order robustness.

### Internal
- Native binutils 2.42 is built to WASM for THREE targets — `m68k-elf`,
  `arm-none-eabi`, and `z80-elf` (one serves both Z80 and gbz80) — each shipping
  `as`/`ld`/`objcopy`/`objdump`. Reproducible build scripts under `scripts/`
  (`build-m68k-wasm-tools.sh`, `build-arm-wasm-tools.sh`, `build-z80-binutils-wasm.sh`),
  pins in `scripts/versions.json`.
- Bumped binary packages this release: `romdev-toolchain-m68k-gcc` 0.2.0 (+ objdump),
  `romdev-platform-gba` 0.3.0 (+ ARM objdump), `romdev-toolchain-sdcc` 0.2.0
  (+ z80-elf binutils).

## 0.3.1

Homebrew/asset-import polish from a Genesis platformer session, plus a Genesis
sprite-inspection bug fix.

### Added
- **`wavToXgm2Pcm`** — convert a WAV (or raw s16le PCM) into a Genesis XGM2 PCM
  sample: 8-bit signed mono, 13.3 kHz (or 6.65 half-rate), 256-byte-padded, plus a
  256-aligned C array + `<NAME>_LEN` define ready to `#include` and `XGM2_playPCM`.
  Bakes in the fiddly sign/rate/alignment/padding rules.
- **`convertImageToTiles`** now takes `pngPath` (reads the PNG from disk — no base64
  token cost or hand-forwarding corruption) and `tileOrder:'sprite'` (column-major,
  the order multi-cell hardware sprites read on Genesis/Lynx).

### Changed
- **`imageToTilemap`** (Genesis) now warns when a visible dominant color is forced
  to palette index 0 (transparent on a scroll plane → renders as the backdrop).
- **`recordAudio`** description now cross-references `getAudioState` (WAV is to
  HEAR; getAudioState is to ASSERT), and notes getAudioState doesn't cover Genesis
  PCM-channel activity yet. Genesis MENTAL_MODEL documents the XGM2 PCM rules.

### Fixed
- **Genesis `inspectSprites` size/position** — a 32×32 sprite decoded as 8×8 (and
  x/y/tile/palette could be wrong) because the SAT words were read big-endian;
  gpgx stores VRAM host-little-endian (byte-swapped). Fixed in the live sprite,
  plane-preview, and which-tiles decoders.

## 0.3.0

The reverse-engineering / romhacking release — a full RE toolkit driven by a real
a Genesis sports-title session, plus PC Engine + MSX cheat coverage
and a cleaner package split.

### Added — RE / romhacking toolkit
- **`searchValue` / `searchNext`** — the iterative value-search loop (Cheat-Engine
  / RetroArch cheat search): seed candidate addresses for an on-screen value, then
  narrow with `eq`/`gt`/`lt`/`changed`/`unchanged`/`inc`/`dec` as the value changes.
  The bread-and-butter "find the address of X" primitive. Works on all 14 platforms.
- **`readCartRom`** — read the loaded cartridge ROM image to confirm a patch is
  actually running. For un-banked platforms (Genesis, GB/GBC, SMS/GG, PCE, Lynx,
  Atari, C64) a file offset equals the CPU ROM address; NES/SNES skip the header
  and flag `mapped:true` (bytes correct, mapper-banked).
- **`classifyRegion`** — heuristic ("looks like ascii-text / high-entropy /
  tile-data / structured-data") that flags when a "found table" is really an ASCII
  string, killing the coincidental-match trap before a broken patch ships.
- **`navigate`** — drive menus by advancing on SCREEN CHANGE instead of fixed frame
  waits, reporting per-press whether it was `consumed`. 5–10× faster, deterministic
  menu scripting.
- **`traceVramSource`** (Genesis) — report which ROM offset a VRAM graphic was DMA'd
  from (decoded from the VDP DMA registers). Answers "this name/logo is a
  pre-rendered bitmap — where in ROM is it?".
- **`searchCheats`** — fuzzy game-name search over the cheat DB (no full-DB dump).
- **ROM-hacking playbook** — cross-platform RE/patching decision tree, readable via
  `getPlatformDoc({platform:'romhacking', name:'playbook'})`.

### Added — platforms / data
- **PC Engine** and **MSX** cheat-database coverage (397 + 377 games).
- **`romdev_game_codes`** — the cheat database is now its own package (lazy-loaded one
  platform at a time), shrinking the main package while letting the DB grow
  independently. Still a required dependency, so `npx romdev-mcp` ships with cheats.

### Changed
- **`learnFontMap`** now detects and reports pre-rendered tile graphics
  (`likelyPreRenderedGraphic`) instead of failing silently on non-font "text".
- **`diffMemory`** defaults to a clustered summary (changed ranges + stride
  detection — "islands at stride 0x80 ⇒ likely a struct array") instead of dumping
  thousands of per-byte rows; `view:'raw'` for the exact list.
- **`findWriter` / `watchMemory`** now hint, on no per-byte write, that the region
  may be bulk-copied/DMA'd (sprite shadow, display list, VRAM) — watch the source
  struct, not the destination.
- **`screenshot`** with `inline:true` now also writes a temp PNG and returns its
  path, so follow-up ImageMagick crops don't ENOENT.
- **`gameCheats`** fuzzy-matches a ROM name to the DB (region/revision tag tolerant).

### Fixed
- **Genesis CRAM color decode** — colors rendered blue-on-black; the decoder now
  reads the packed 9-bit little-endian CRAM correctly.

## 0.2.0

- PC Engine and MSX added as Tier-1 platforms (14 total).
- Server/livestream show the version, sourced from `package.json`.
