# PC Engine — upstream sources

Pointers to the bundled library source + upstream repos, for when romdev's
examples aren't enough and you need ground truth.

## Toolchain — cc65 (HuC6280 / `pce` target)

- Upstream: https://github.com/cc65/cc65 (the `pce` target).
- Bundled in romdev-toolchain-cc65. The PCE runtime lives in cc65's
  `libsrc/pce/` — `crt0.s` (startup), `vdc.s` / `vce.s` (video helpers),
  `waitvsync.s`, `psg.s` (sound), `color.s`, plus the generic conio
  (`libsrc/cbm`-style `clrscr.s` / `cputc.s` / `gotoxy.s` adapted for the VDC).
- Headers: `include/pce.h` (hardware defines, joypad masks, colors),
  `include/conio.h` (text API). Linker config: `cfg/pce.cfg` (the HuCard memory
  layout: ZP, MAIN RAM at $2200, ROM banks).
- cc65 is **C89** — declare all locals at the top of a block, no `//` comments
  in strict mode, no variadic-heavy stdio.

## Emulator core — Geargrafx

- Upstream: https://github.com/drhelius/Geargrafx (by Ignacio Sánchez / drhelius,
  GPL-3.0). A clean, accurate PCE/TG-16 emulator with separate HuC6280 / HuC6270
  (×2) / HuC6260 / PSG classes.
- romdev pins a specific commit (see scripts/versions.json) and applies
  `scripts/patches/geargrafx-romdev-memory-regions.patch` to expose the VDC
  VRAM/SATB/regs, VCE palette, and HuC6280 CPU snapshot via
  `retro_get_memory_data` for the inspect tools.
- Ground-truth files (in the Geargrafx source): `src/huc6270.cpp/.h` (VDC + the
  actual sprite renderer at ~line 803 — the canonical SATB format), `src/huc6260.cpp`
  (the 9-bit GRB → RGB conversion at ~line 74), `src/huc6280.h` (CPU state struct).

## Hardware references

- The PC Engine VDC (HuC6270) and VCE (HuC6260) are documented in the Charles
  MacDonald / pcedev community docs. The register numbers and color format used
  by romdev's adapters match Geargrafx's implementation exactly (see above).
- Sprite SATB, BAT (background map), and palette layouts are summarized in this
  package's MENTAL_MODEL.md.
