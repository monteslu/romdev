// PC Engine HuC6280 PSG decoder.
//
// Data source: the `pce_psg_regs` region (id 0x1A5) exposed by our patched
// geargrafx core. Layout (packed little-endian, see the geargrafx region patch):
//   [0]   channel_select   [1] main_amplitude
//   [2-3] lfo_frequency     [4] lfo_control
//   then 6 channels × 14 bytes:
//     enabled(1) frequency(2) control(1) amplitude(1) vol_left(1) vol_right(1)
//     wave_index(1) noise_control(1) noise_enabled(1) noise_freq(4)
//
// The HuC6280 PSG ("wonder-PSG") has 6 wavetable channels; channels 4 and 5 can
// also produce noise (noise_enabled). Channel control bit 7 = channel on; the
// low nibble is the 4-bit master volume; vol_left/vol_right are the panned
// per-side volumes (4-bit each). Frequency is a 12-bit period.

const GLOBAL_BYTES = 5;
const CHAN_BYTES = 14;
const NUM_CH = 6;

/** PC Engine PSG base clock for the wavetable channels (~3.58 MHz / 32). */
const PSG_CLOCK = 3579545;

/**
 * @param {Uint8Array} regs the `pce_psg_regs` region (89 bytes)
 * @returns {{ chip:"pce", channelSelect:number, mainAmplitude:number,
 *   lfoFrequency:number, lfoControl:number, channels:Array<object> }}
 */
export function decodePcePsg(regs) {
  const u16 = (o) => regs[o] | (regs[o + 1] << 8);
  const u32 = (o) => (regs[o] | (regs[o + 1] << 8) | (regs[o + 2] << 16) | (regs[o + 3] << 24)) >>> 0;

  const channels = [];
  for (let i = 0; i < NUM_CH; i++) {
    const b = GLOBAL_BYTES + i * CHAN_BYTES;
    const frequency = u16(b + 1);
    const control = regs[b + 3];
    const on = !!(control & 0x80);
    // Wavetable channel frequency: f = clock / (32 * period). period 0 → silent.
    const period = frequency & 0x0fff;
    const hz = on && period ? Math.round(PSG_CLOCK / (32 * period)) : 0;
    channels.push({
      channel: i,
      enabled: !!regs[b + 0],
      on,
      frequency: period,
      approxHz: hz,
      masterVolume: control & 0x1f,        // low 5 bits = channel master volume
      amplitude: regs[b + 4],
      volLeft: regs[b + 5] & 0x0f,
      volRight: regs[b + 6] & 0x0f,
      waveIndex: regs[b + 7],
      noiseControl: regs[b + 8],
      noiseEnabled: !!regs[b + 9],
      noiseFreq: u32(b + 10),
      // Channels 4 and 5 are the only ones with a noise generator on the HuC6280.
      canNoise: i >= 4,
    });
  }

  return {
    chip: "pce",
    channelSelect: regs[0],
    mainAmplitude: regs[1],
    mainVolumeLeft: (regs[1] >> 4) & 0x0f,
    mainVolumeRight: regs[1] & 0x0f,
    lfoFrequency: u16(2),
    lfoControl: regs[4],
    lfoEnabled: !!(regs[4] & 0x80),
    channels,
  };
}

/**
 * Read + decode the PSG state from a running host.
 * @param {import("./LibretroHost.js").LibretroHost} host
 * @returns {ReturnType<typeof decodePcePsg> | null}
 */
export function getPcePsgState(host) {
  const size = host.regionSize("pce_psg_regs");
  if (!size) return null;
  return decodePcePsg(host.readMemory("pce_psg_regs", 0, size));
}
