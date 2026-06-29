# PlayStation (PS1) — source you can read

Trust hierarchy (try in order before filing a feedback round):

1. **Bundled examples** (`examples/ps1/{shmup,platformer,puzzle,racing,sports}/main.c` +
   `sprite_move/`) — verified building + rendering on the GPU. Start here.
2. **Bundled helper lib source** (`src/platforms/ps1/lib/c/psx.c` + `psx.h`) — the GPU
   front end. Read this when a primitive renders wrong: it shows how the software-3D
   transform feeds **GP0 GPU primitives** (the real console path — the GPU rasterizes the
   command stream; this is NOT a software framebuffer). The GP0 `0x60` rect-vs-poly gotcha
   is in here + TROUBLESHOOTING.
3. **The core source** (NOT bundled — fetch on demand):

   | What | Upstream |
   |---|---|
   | beetle-psx (Mednafen PSX, libretro, HW renderer) | https://github.com/libretro/beetle-psx-libretro |
   | R3000A CPU / SPU / GPU internals | (in the beetle tree: `mednafen/psx/cpu.c`, `spu.c`, `gpu.cpp`) |

   The cpuState/audioDebug exports we patch in (`romdev_mips_regs_get`,
   `romdev_spu_get`) live in `scripts/patches/romdev-snippets/beetle-psx-regsnap.c` +
   `beetle-psx-spu.c`.

4. **The toolchain** — a from-scratch `mips-elf-gcc` cross-compiler (little-endian) built
   to WASM (`scripts/build-mips-toolchain.sh` — one toolchain emits both N64 BE + PS1 LE):

   | Component | Upstream |
   |---|---|
   | binutils | https://ftp.gnu.org/gnu/binutils/ |
   | gcc | https://ftp.gnu.org/gnu/gcc/ |
   | newlib | https://sourceware.org/pub/newlib/ |

5. **Reverse engineering** — Rizin + Ghidra MIPS (R3000A):

   | What | Upstream |
   |---|---|
   | Rizin | https://github.com/rizinorg/rizin |
   | rz-ghidra | https://github.com/rizinorg/rz-ghidra |

## PS1 hardware docs

- **psx-spx** (Nocash, the canonical reference): https://psx-spx.consoledev.net/
- **PSn00bSDK** (a real open PS1 SDK — read its GPU/GTE/SPU code for the standard GP0/GP1
  encodings + SPU register layout): https://github.com/Lameguy64/PSn00bSDK

## When to use what

- "Why is my screen BLACK?" → MENTAL_MODEL + TROUBLESHOOTING (you must issue GP0
  primitives + set the draw/display environment — a CPU memset won't show).
- "My rectangles stretch to the edge" → the GP0 `0x60` variable-size-rect gotcha
  (TROUBLESHOOTING).
- "How does the helper emit a triangle?" → `psx.c` + psx-spx GPU section.
- "audioDebug SPU volumes look off" → the SPU volume/sweep registers read processed
  values; the decode reads the raw mirror (see `psx.c` / beetle `spu.c`).
- "disasm returns a single `fcn.00000000`" → TROUBLESHOOTING (the absolute-`jal` rebase).
