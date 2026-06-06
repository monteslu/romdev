# MSX — upstream sources

Pointers to the bundled library source + upstream repos, for when romdev's
examples aren't enough and you need ground truth.

## Toolchain — SDCC (z80 port)

- Upstream: https://sourceforge.net/projects/sdcc/ (the `z80` port).
- Bundled in romdev-toolchain-sdcc. romdev does NOT use a vendored MSX SDK; you
  call the C-BIOS / MSX BIOS routines directly from inline asm (`call 0x006C`
  etc.). The `msx_crt0.s` starter provides the cartridge boot handshake.
- SDCC is **C89** with quirks: declare locals at the top of a block, no `//` in
  strict mode, and **file-scope `__asm` is a syntax error** — inline asm only
  inside functions (put data labels in a function asm block, jumped over).
- Standard MSX BIOS entry points you'll use: INITXT $006C (text screen),
  INIT32 $006F (32-col), CHPUT $00A2 (print char in A), CHGET $009F (read key),
  GTSTCK $00D5 (joystick), GTTRIG $00D8 (trigger). These live in C-BIOS slot 0.

## Emulator core — blueMSX (libretro)

- Upstream: https://github.com/libretro/blueMSX-libretro (blueMSX by Daniel
  Vik et al., BSD-3-Clause).
- romdev pins a specific commit (scripts/versions.json) and applies TWO patches:
  - `scripts/patches/bluemsx-emscripten-build.patch` — REQUIRED build fix.
    Adds `-fno-common` (the non-obvious one: `-fcommon` makes blueMSX's tentative
    definitions VANISH under wasm-ld) + clang warning relaxations.
  - `scripts/patches/bluemsx-romdev-memory-regions.patch` — exposes the V9938
    VRAM/regs/status/palette + Z80 CPU snapshot via `retro_get_memory_data` for
    the inspect tools (blueMSX has no public accessors, so it adds getters in
    `Src/VideoChips/VDP.c` reading the `theVdp` singleton, and reads the CPU via
    `(R800*)boardInfo.cpuRef` in `libretro.c`).
- Ground-truth files (in the blueMSX source): `Src/VideoChips/VDP.c` (the VDP —
  the 9-bit GRB palette pack at ~line 1338, the screen-mode dispatch at ~line 425,
  `vdpRegs[64]` / `vdpStatus[16]` / `paletteReg[16]` fields), `Src/Z80/R800.h`
  (the CpuRegs struct), `Src/Board/MSX.c` (cart/board setup).

## BIOS — C-BIOS

- Upstream: https://cbios.sourceforge.net/ (C-BIOS, 2-clause BSD). An
  open-source MSX/MSX2/MSX2+ BIOS that lets cartridge homebrew boot with no
  proprietary ROM.
- romdev ships the C-BIOS machine tree (Machines/{MSX,MSX2,MSX2+} - C-BIOS) in
  the romdev-core-bluemsx package's `bios/` dir; the host mirrors it into the
  emulator's virtual filesystem and forces the "MSX2+ - C-BIOS" machine
  automatically. You don't need to configure anything.
- C-BIOS does NOT implement BASIC or disk — it's enough for cartridge games.
