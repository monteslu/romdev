# Sega Dreamcast — source you can read

Trust hierarchy (try in order before filing a feedback round):

1. **Bundled examples** (`examples/dreamcast/{hello,shmup,platformer,puzzle,racing,sports}/main.c`)
   — verified building + rendering on the GPU (full 480-line frame). Start here.
2. **Bundled helper lib source** (`src/toolchains/sh-c/lib/dc.h`) — the PowerVR2
   framebuffer bring-up + drawing + input. Read this when something doesn't render or input
   doesn't read: it shows `dc_video_init` (FB_R_CTRL/SIZE/SOF1 + SPG, **480i interlace** —
   240p only shows the top 240 lines), `dc_clear`/`dc_rect`, and the Maple-DMA `dc_pad()`.
3. **The core source** (NOT bundled — fetch on demand):

   | What | Upstream |
   |---|---|
   | Flycast (libretro core, PowerVR2 + reios HLE BIOS) | https://github.com/flyinghead/flycast |
   | SH-4 / PowerVR2 / AICA / Maple internals | (in the flycast tree: `core/hw/sh4/`, `core/hw/pvr/`, `core/hw/aica/`, `core/hw/maple/`) |

   The cpuState/audioDebug exports we patch in (`romdev_sh4_regs_get`, `romdev_aica_get`)
   live in `scripts/patches/romdev-snippets/flycast-debug.c`.

4. **The toolchain** — a from-scratch `sh-elf-gcc` cross-compiler (little-endian SH-4,
   m4-single-only FP) built to WASM (`scripts/build-sh-toolchain.sh` +
   `build-sh-wasm-tools.sh`). NOTE: cc1 defaults to **-O1** (the sh-elf cc1.wasm has an
   -O2-only crash on common control flow):

   | Component | Upstream |
   |---|---|
   | binutils | https://ftp.gnu.org/gnu/binutils/ |
   | gcc | https://ftp.gnu.org/gnu/gcc/ |
   | newlib | https://sourceware.org/pub/newlib/ |

5. **Reverse engineering** — Rizin + Ghidra SH-4 (SuperH4 SLEIGH):

   | What | Upstream |
   |---|---|
   | Rizin | https://github.com/rizinorg/rizin |
   | rz-ghidra | https://github.com/rizinorg/rz-ghidra |

## Dreamcast hardware docs

- **KallistiOS (KOS)** — the canonical open DC SDK; read its PowerVR2 TA, AICA, and Maple
  drivers for the standard register sequences: https://github.com/KallistiOS/KallistiOS
- **Mc Spankled / DCEmulation docs + the Sega Dreamcast Hardware Specification** (PVR2/Holly
  register maps): cross-check against flycast's `core/hw/pvr/pvr_regs.h` enum.
- **SH-4 ISA / SH7750 manual** (Renesas) for the CPU.

## When to use what

- "Boots but the screen is BLACK / only the top half draws" → MENTAL_MODEL +
  TROUBLESHOOTING (it's the framebuffer path + the 480i-interlace requirement).
- "How does the helper set up the PowerVR2 framebuffer?" → `dc.h` `dc_video_init` +
  flycast `core/hw/pvr/pvr_regs.h` (SPG_CONTROL interlace bit).
- "dc_pad doesn't reflect button presses" → `dc.h` `dc_pad()` (Maple Get-Condition DMA) +
  flycast `core/hw/maple/maple_devs.cpp` (the controller response framing). Reads the
  resting state; press mapping is a known follow-up.
- "Which AICA register holds channel key-on/volume?" → `dc-aica-state.js` decode +
  flycast `core/hw/aica/`.
