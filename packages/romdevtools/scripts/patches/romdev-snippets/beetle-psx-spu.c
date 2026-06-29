/* ── romdev: SPU register block for beetle_psx_hw (audioDebug) ───────────────
 * Appended to mednafen/psx/spu.c by build-beetle-psx-hw.sh, where the static
 * `regs` write-through mirror is in scope. EMSCRIPTEN_KEEPALIVE + listed in
 * EXPORTED_FUNCTIONS so LTO keeps it.
 *
 * Reads the RAW register store (regs.Regs[], updated on every SPU_Write) rather
 * than SPU_Read() — SPU_Read returns *processed* values for the volume/sweep
 * registers (it quantizes main/voice volume through the sweep envelope, so a
 * write of 0x3FFF reads back as e.g. 0x3800). audioDebug wants the register the
 * program actually wrote, so we mirror regs.Regs directly.
 *
 * Layout: regs.Regs[0x100] is the 512-byte SPU register space, word-indexed
 * ($1F801C00 + 2*i). Matches the host's getSpuRegs() / decodePs1Spu() which
 * index by word (regs[0xC0] = main volume L, etc.). Host passes bytes=0x400 but
 * the real register file is 0x100 words (0x200 bytes); we clamp + zero-pad.
 */
#include <emscripten.h>

EMSCRIPTEN_KEEPALIVE void romdev_spu_get(unsigned short *out, int bytes)
{
   int i, n;
   if (!out) return;
   if (bytes <= 0) bytes = 0x400;
   n = bytes / 2;
   for (i = 0; i < n; i++)
      out[i] = (i < 0x100) ? regs.Regs[i] : 0;
}
