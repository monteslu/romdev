/*
 * xgm2_demo_data.s — embed the compiled XGM2 music blob into ROM.
 *
 * SGDK's rescomp normally produces a .o for each .xgm/.xgc resource and
 * generates a matching extern in resources.h. We don't ship rescomp at
 * runtime, so we do the same thing by hand with a 2-line .incbin:
 *
 *   - Place the bytes in .rodata so they land in ROM (no RAM cost).
 *   - Expose a single global symbol `music_xgm` so the C side can call
 *     XGM2_play(music_xgm) — the driver expects the compiled XGC2 blob.
 *
 * The companion .xgc file is produced by SGDK's xgm2tool from a source
 * .vgm (also shipped under romdev-toolchain-m68k-gcc/share/genesis/lib/sgdk/music/). To
 * rebuild from the source .vgm:
 *
 *   java -jar xgm2tool.jar demo.vgm demo.xgc -s -n
 *
 * This pattern mirrors src/platforms/snes/lib/c/snes_sfx_data.asm (R31)
 * — both ship audio assets as binary siblings incbin'd from a tiny .asm.
 */

    .section .rodata

    .globl  music_xgm
    .align  2
music_xgm:
    .incbin "demo.xgc"
