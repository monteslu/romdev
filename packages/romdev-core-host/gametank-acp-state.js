// GameTank ACP (audio coprocessor) state decoder — the "what is the sound doing
// this frame?" view that getAudioState gives the other platforms' chips.
//
// GameTank has no fixed-register synth (no APU/SID); its "sound chip" is a SECOND
// 65C02 running an audio program in 4 KB RAM that drives an 8-bit DAC at an IRQ
// rate. So this decode reports the ACP's STATE rather than per-voice registers:
// the live DAC output, the IRQ/sample rate, run/mute flags, volume, and which
// audio-CPU routine is executing. Data source: the romdev_acp_get export
// (gametank core) — a Uint32Array(10) (see LibretroHost.getAcpState for layout).

/**
 * @param {Uint32Array|null} a romdev_acp_get block (10 u32) or null
 * @returns {object} audioDebug-shaped state
 */
export function decodeGameTankAcp(a) {
  if (!a || a.length < 10) return { chip: "acp", playing: false, note: "no ACP data" };
  const dacReg = a[0] & 0xFF;
  const irqRate = a[1] & 0xFF;
  const irqCounter = a[2] & 0xFFFF;
  const running = !!a[3];
  const resetting = !!a[4];
  const muted = !!a[5];
  const volume = a[6] | 0;
  const audioPC = a[7] & 0xFFFF;
  const samplesPerFrame = a[8] >>> 0;
  const clkMult = a[9] & 0xFF;

  // "playing" = the audio CPU is running, not muted/resetting, and the DAC isn't
  // parked at the midpoint silence ($80) — a coarse but honest activity signal.
  const playing = running && !muted && !resetting && dacReg !== 0x80;

  return {
    chip: "acp",
    cpu: "65c02",                       // the audio coprocessor is a second 65C02
    playing,
    registers: {
      dac: "$" + dacReg.toString(16).padStart(2, "0").toUpperCase(),
      irqRate: "$" + irqRate.toString(16).padStart(2, "0").toUpperCase(),
      audioPC: "$" + audioPC.toString(16).padStart(4, "0").toUpperCase(),
      volume,
    },
    dacOutput: dacReg,                  // 0..255, $80 = silence midpoint
    irqRate,                            // sets the effective sample rate
    irqCounter,
    samplesPerFrame,
    clkMult,
    running, resetting, muted,
    note: muted ? "ACP muted"
      : resetting ? "ACP in reset"
      : !running ? "ACP idle (not running)"
      : "ACP running — driving the DAC from audio RAM",
  };
}
