// MSX AY-3-8910 (PSG) decoder.
//
// Data source: the `msx_psg_regs` region (id 0x1C5) exposed by our patched
// blueMSX core — the chip's 16 registers, the standard AY-3-8910 layout:
//   R0/R1   channel A tone period (12-bit: R0 = fine, R1 low nibble = coarse)
//   R2/R3   channel B tone period
//   R4/R5   channel C tone period
//   R6      noise period (5-bit)
//   R7      mixer/enable: bits 0-2 tone A/B/C enable (0=on), bits 3-5 noise A/B/C
//           enable (0=on), bits 6-7 = I/O port direction
//   R8/R9/R10  channel A/B/C amplitude (bit 4 = use-envelope, bits 0-3 = level)
//   R11/R12 envelope period (16-bit)
//   R13     envelope shape (CONT/ATT/ALT/HOLD)
//   R14/R15 I/O ports A/B (joysticks/keyboard on MSX — not audio)
//
// MSX PSG clock is 1.7897725 MHz; tone f = clock / (16 * period).

const PSG_CLOCK = 1789772.5;

/**
 * @param {Uint8Array} regs the 16-byte `msx_psg_regs` region
 * @returns {{ chip:"ay8910", channels:Array<object>, noise:object, envelope:object, ioPorts:object }}
 */
export function decodeMsxAy(regs) {
  const mixer = regs[7];
  const channels = [];
  for (let i = 0; i < 3; i++) {
    const fine = regs[i * 2];
    const coarse = regs[i * 2 + 1] & 0x0f;
    const period = (coarse << 8) | fine;
    const toneOn = !((mixer >> i) & 1);     // bit clear = enabled
    const noiseOn = !((mixer >> (i + 3)) & 1);
    const amp = regs[8 + i];
    const useEnvelope = !!(amp & 0x10);
    const hz = toneOn && period ? Math.round(PSG_CLOCK / (16 * period)) : 0;
    channels.push({
      channel: ["A", "B", "C"][i],
      tonePeriod: period,
      approxHz: hz,
      toneEnabled: toneOn,
      noiseEnabled: noiseOn,
      amplitude: amp & 0x0f,
      useEnvelope,
    });
  }
  const noisePeriod = regs[6] & 0x1f;
  const envPeriod = regs[11] | (regs[12] << 8);
  const envShape = regs[13];
  return {
    chip: "ay8910",
    channels,
    noise: {
      period: noisePeriod,
      approxHz: noisePeriod ? Math.round(PSG_CLOCK / (16 * noisePeriod)) : 0,
    },
    envelope: {
      period: envPeriod,
      shape: envShape,
      continue: !!(envShape & 0x08),
      attack: !!(envShape & 0x04),
      alternate: !!(envShape & 0x02),
      hold: !!(envShape & 0x01),
    },
    mixer,
    ioPorts: { a: regs[14], b: regs[15] },
  };
}

/**
 * Read + decode the PSG state from a running host.
 * @param {import("./LibretroHost.js").LibretroHost} host
 * @returns {ReturnType<typeof decodeMsxAy> | null}
 */
export function getMsxAyState(host) {
  const size = host.regionSize("msx_psg_regs");
  if (!size) return null;
  return decodeMsxAy(host.readMemory("msx_psg_regs", 0, size));
}
