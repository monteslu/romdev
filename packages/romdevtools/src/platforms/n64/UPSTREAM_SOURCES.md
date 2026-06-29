# Nintendo 64 — source you can read

Trust hierarchy (try in order before filing a feedback round):

1. **Bundled examples** (`examples/n64/{shmup,platformer,puzzle,racing,sports}/main.c`) —
   verified building + rendering on the GPU. Start here for "how do I draw / animate / use
   the 3D helpers."
2. **Bundled helper lib source** (`src/platforms/n64/lib/c/n64.c` + `n64.h`) — the GPU
   drawing backend. Read this when a draw call doesn't render the way you expect: it shows
   exactly how `n64_clear`/`n64_rect`/`n64_tri*`/`n64_flip` build a **GBI (F3DEX2) display
   list** + the OSTask kick (NOT a software framebuffer — see MENTAL_MODEL).
3. **The core source** (NOT bundled — fetch on demand):

   | What | Upstream |
   |---|---|
   | parallel_n64 (libretro core + glide64 GL HLE) | https://github.com/libretro/parallel-n64 |
   | Reality co-processor / RSP-HLE + glide64 internals | (in the parallel_n64 tree: `mupen64plus-rsp-hle/`, `glide2gl/src/Glide64/`) |

4. **The toolchain** — a from-scratch `mips-elf-gcc` cross-compiler (big-endian) built to
   WASM (`scripts/build-mips-toolchain.sh` + `build-mips-wasm-tools.sh`):

   | Component | Upstream |
   |---|---|
   | binutils | https://ftp.gnu.org/gnu/binutils/ |
   | gcc | https://ftp.gnu.org/gnu/gcc/ |
   | newlib | https://sourceware.org/pub/newlib/ |

5. **Reverse engineering** — `disasm`/`decompile` go through Rizin + Ghidra's MIPS
   (R4300) support:

   | What | Upstream |
   |---|---|
   | Rizin | https://github.com/rizinorg/rizin |
   | rz-ghidra (decompiler) | https://github.com/rizinorg/rz-ghidra |

## N64 hardware docs

- **n64brew wiki** (the canonical modern reference): https://n64brew.dev/wiki/
- **RCP / RDP / RSP** + the VI/AI/PI/SI register maps: n64brew + the parallel_n64
  `vi_controller.h` / `rsp_core.c` enums in the core tree.
- **libdragon** (a real open N64 SDK — read its GBI/display-list code for the standard
  command encodings): https://github.com/DragonMinded/libdragon

## When to use what

- "Why is my homebrew BLACK on screen?" → MENTAL_MODEL + TROUBLESHOOTING (it's almost
  always software-framebuffer drawing instead of the GBI display-list path).
- "How does the helper build a display list / kick the RSP?" → `n64.c`
  (`dl_begin`/`dl_end_and_run`) + the n64brew RDP/RSP pages.
- "Which VI register sets 16bpp / scaling?" → the core's `vi_controller.h` enum.
- "disasm returns junk addresses on a multi-function program" → TROUBLESHOOTING (the
  absolute-`jal` base-alignment note).
