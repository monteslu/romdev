// N64 AI (Audio Interface) decoder.
//
// Data source: the romdev_ai_get export (parallel_n64) — the 6 AI registers + the
// VI clock. The N64 has no per-voice sound chip like the SNES DSP; audio is mixed
// by the RSP (microcode-dependent) and streamed to the AI's DAC via DMA. So the
// AI tells us the OUTPUT state: sample rate, whether audio is playing (a buffer is
// queued), and the DMA source address — the actionable "is sound on, at what rate"
// answer, not a per-channel breakdown (which lives in game-specific RSP audio lists).
//
// out layout: [DRAM_ADDR, LEN, CONTROL, STATUS, DACRATE, BITRATE, VI_CLOCK]

/**
 * @param {Uint32Array} a the 7-word AI snapshot (6 regs + VI clock)
 * @returns {{ chip:"ai", playing:boolean, sampleRate:number, dmaAddress:number,
 *   queuedBytes:number, dacRate:number, bitRate:number, control:number,
 *   status:number, note:string }}
 */
export function decodeN64Ai(a) {
  if (!a || a.length < 7) return { chip: "ai", playing: false, note: "no AI data" };
  const dramAddr = a[0] >>> 0;
  const len = a[1] >>> 0;
  const control = a[2] >>> 0;
  const status = a[3] >>> 0;
  const dacRate = a[4] >>> 0;
  const bitRate = a[5] >>> 0;
  const viClock = a[6] >>> 0;
  // DAC sample rate = VI clock / (dacrate + 1). dacrate 0 / no clock → unknown.
  const sampleRate = dacRate && viClock ? Math.round(viClock / (dacRate + 1)) : 0;
  // AI_LEN nonzero (a buffer is queued) AND DMA enabled (control bit0) = playing.
  const playing = (len & 0x3ffff) > 0 && (control & 1) !== 0;
  return {
    chip: "ai",
    playing,
    sampleRate,
    queuedBytes: len & 0x3ffff,
    dmaAddress: "0x" + dramAddr.toString(16).toUpperCase(),
    dacRate,
    bitRate,
    control,
    status,
    note: "N64 audio is RSP-mixed; the AI exposes the OUTPUT (sample rate + whether a buffer is playing + the DMA source), not per-channel voices. For per-channel, trace the game's RSP audio list in RDRAM.",
  };
}
