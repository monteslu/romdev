// Game Boy (DMG/CGB) and Game Boy Advance APU state introspection.
//
// Same idea as nes-apu-state.js: give GB/GBC/GBA music jobs a "what is each
// channel playing this frame?" decode straight off the hardware register file,
// independent of whatever private sound driver the game uses.
//
// GB data source: the `gb_io` region — the 128-byte I/O page at $FF00-$FF7F.
// The APU register block lives at $FF10-$FF3F, i.e. io[0x10]..io[0x3F]:
//
//   NR10=$10 sweep      NR11=$11 duty/len   NR12=$12 vol/env
//   NR13=$13 freq lo    NR14=$14 freq hi+trigger        (channel 1, pulse+sweep)
//   NR21=$16 duty/len   NR22=$17 vol/env
//   NR23=$18 freq lo    NR24=$19 freq hi+trigger        (channel 2, pulse)
//   NR30=$1A DAC        NR31=$1B len        NR32=$1C vol-shift
//   NR33=$1D freq lo    NR34=$1E freq hi+trigger        (channel 3, wave)
//   NR41=$20 len        NR42=$21 vol/env
//   NR43=$22 noise freq NR44=$23 trigger                (channel 4, noise)
//   NR50=$24 master vol NR51=$25 panning    NR52=$26 power + channel status
//
// GBA data source: the `gba_io_regs` region — the 0x400-byte I/O page at
// $4000000. The GBA carries the same four DMG PSG channels (mirrored at byte
// offsets $60-$81) plus two Direct Sound DMA FIFO channels ($A0/$A4). The
// PSG decode reuses the exact same formulas as GB; only the offsets differ.
//
// These are *register* bytes (what the CPU last wrote), not the APU's internal
// envelope/sweep counters — which is exactly the pitch/duty/volume layer you
// want for music transcription.

// Pulse channels: freq = 131072 / (2048 - freq11) Hz.
// Wave channel:   freq =  65536 / (2048 - freq11) Hz.
// freq11 is the 11-bit timer (NRx3 | ((NRx4 & 7) << 8)).

// Duty-cycle code (NRx1 bits 6-7) → human label.
const DUTY_LABEL = ["12.5%", "25%", "50%", "75%"];

// Wave volume-shift code (NR32 bits 5-6) → output level percentage.
const WAVE_VOLUME_LABEL = ["mute", "100%", "50%", "25%"];

/**
 * Convert a frequency in Hz to the nearest note name (e.g. "A4", "C#5"),
 * or null for zero / non-finite frequencies. A4 = 440 Hz, 12-TET.
 * @param {number} hz
 * @returns {string | null}
 */
export function freqToNote(hz) {
  if (!hz || !Number.isFinite(hz) || hz <= 0) return null;
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const name = NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  return name;
}

/** Round a frequency to 2 decimal places (null stays null). */
function round2(hz) {
  return hz == null ? null : Math.round(hz * 100) / 100;
}

/**
 * Decode a square/pulse channel from its three register bytes.
 * @param {number} nrx1 duty/length (bits 6-7 = duty)
 * @param {number} nrx2 volume/envelope (bits 4-7 = initial volume)
 * @param {number} nrx3 frequency low byte
 * @param {number} nrx4 frequency high bits + trigger/length-enable
 * @param {boolean} enabled channel status bit from NR52
 * @returns {{ enabled: boolean, freqHz: number|null, note: string|null,
 *   duty: number, dutyLabel: string, volume: number, lengthEnable: boolean }}
 */
function decodePulseCore(nrx1, nrx2, nrx3, nrx4, enabled) {
  const freq11 = nrx3 | ((nrx4 & 0x07) << 8);
  const freqHz = freq11 < 2048 ? 131072 / (2048 - freq11) : null;
  const duty = (nrx1 >> 6) & 0x03;
  return {
    enabled,
    freqHz: round2(freqHz),
    note: freqToNote(freqHz),
    duty,
    dutyLabel: DUTY_LABEL[duty],
    volume: (nrx2 >> 4) & 0x0F,
    lengthEnable: !!(nrx4 & 0x40),
  };
}

/**
 * Decode the wave channel (channel 3) from its register bytes.
 * @param {number} nr30 DAC power (bit7)
 * @param {number} nr32 volume shift (bits 5-6)
 * @param {number} nr33 frequency low byte
 * @param {number} nr34 frequency high bits + trigger/length-enable
 * @param {boolean} enabled channel status bit from NR52
 * @returns {{ enabled: boolean, freqHz: number|null, note: string|null,
 *   volumeShift: number, volumeLabel: string, lengthEnable: boolean, dacOn: boolean }}
 */
function decodeWaveCore(nr30, nr32, nr33, nr34, enabled) {
  const freq11 = nr33 | ((nr34 & 0x07) << 8);
  const freqHz = freq11 < 2048 ? 65536 / (2048 - freq11) : null;
  const volumeShift = (nr32 >> 5) & 0x03;
  return {
    enabled,
    freqHz: round2(freqHz),
    note: freqToNote(freqHz),
    volumeShift,
    volumeLabel: WAVE_VOLUME_LABEL[volumeShift],
    lengthEnable: !!(nr34 & 0x40),
    dacOn: !!(nr30 & 0x80),
  };
}

/**
 * Decode the noise channel (channel 4) from its register bytes.
 * @param {number} nrx2 volume/envelope (bits 4-7 = initial volume)
 * @param {number} nrx3 noise frequency (divisor / shift clock / width)
 * @param {number} nrx4 trigger + length-enable
 * @param {boolean} enabled channel status bit from NR52
 * @returns {{ enabled: boolean, volume: number, divisorCode: number,
 *   shiftClock: number, widthMode: number, lengthEnable: boolean }}
 */
function decodeNoiseCore(nrx2, nrx3, nrx4, enabled) {
  return {
    enabled,
    volume: (nrx2 >> 4) & 0x0F,
    divisorCode: nrx3 & 0x07,        // bits 0-2: clock divisor code
    shiftClock: (nrx3 >> 4) & 0x0F,  // bits 4-7: shift-clock frequency
    widthMode: (nrx3 >> 3) & 0x01,   // bit 3: 0 = 15-bit, 1 = 7-bit LFSR
    lengthEnable: !!(nrx4 & 0x40),
  };
}

/**
 * @typedef {ReturnType<typeof decodePulseCore>} GbPulseState
 * @typedef {ReturnType<typeof decodeWaveCore>} GbWaveState
 * @typedef {ReturnType<typeof decodeNoiseCore>} GbNoiseState
 */

/**
 * Decode a four-channel DMG/CGB PSG register block given an accessor that maps
 * an APU register offset (e.g. 0x10 for NR10) to its byte value. Shared by both
 * the GB decoder (offsets into the I/O page) and the GBA decoder (offsets into
 * the GBA I/O page, which mirrors the same NRxx layout).
 *
 * @param {(off: number) => number} r register-byte accessor
 * @param {{ nr10: number, nr11: number, nr12: number, nr13: number, nr14: number,
 *   nr21: number, nr22: number, nr23: number, nr24: number,
 *   nr30: number, nr32: number, nr33: number, nr34: number,
 *   nr42: number, nr43: number, nr44: number }} map register offsets
 * @param {number} nr52 power + per-channel status byte
 * @returns {{ pulse1: GbPulseState & { sweep: { period: number, shift: number, negate: boolean } },
 *   pulse2: GbPulseState, wave: GbWaveState, noise: GbNoiseState }}
 */
function decodePsgBlock(r, map, nr52) {
  const sweepReg = r(map.nr10);
  const pulse1 = {
    ...decodePulseCore(r(map.nr11), r(map.nr12), r(map.nr13), r(map.nr14), !!(nr52 & 0x01)),
    sweep: {
      period: (sweepReg >> 4) & 0x07, // bits 4-6: sweep time/period
      shift: sweepReg & 0x07,         // bits 0-2: sweep shift amount
      negate: !!(sweepReg & 0x08),    // bit 3: 1 = decrease (negate)
    },
  };
  const pulse2 = decodePulseCore(
    r(map.nr21), r(map.nr22), r(map.nr23), r(map.nr24), !!(nr52 & 0x02),
  );
  const wave = decodeWaveCore(
    r(map.nr30), r(map.nr32), r(map.nr33), r(map.nr34), !!(nr52 & 0x04),
  );
  const noise = decodeNoiseCore(r(map.nr42), r(map.nr43), r(map.nr44), !!(nr52 & 0x08));
  return { pulse1, pulse2, wave, noise };
}

// APU register offsets within the 128-byte `gb_io` page ($FF00-$FF7F).
const GB_MAP = {
  nr10: 0x10, nr11: 0x11, nr12: 0x12, nr13: 0x13, nr14: 0x14,
  nr21: 0x16, nr22: 0x17, nr23: 0x18, nr24: 0x19,
  nr30: 0x1a, nr32: 0x1c, nr33: 0x1d, nr34: 0x1e,
  nr42: 0x21, nr43: 0x22, nr44: 0x23,
  nr50: 0x24, nr51: 0x25, nr52: 0x26,
};

/** Format a byte as a "0x.." hex string (2 digits). */
function hex(b) {
  return "0x" + (b & 0xff).toString(16).padStart(2, "0");
}

/** Format a 16-bit value as a "0x...." hex string (4 digits). */
function hex16(v) {
  return "0x" + (v & 0xffff).toString(16).padStart(4, "0");
}

/**
 * Decode the Game Boy (DMG/CGB) APU register file into per-channel musical state.
 *
 * @param {Uint8Array} io the 128-byte `gb_io` region ($FF00-$FF7F)
 * @returns {{
 *   enabled: boolean,
 *   channels: {
 *     pulse1: GbPulseState & { sweep: { period: number, shift: number, negate: boolean } },
 *     pulse2: GbPulseState,
 *     wave: GbWaveState,
 *     noise: GbNoiseState,
 *   },
 *   nr52: string,
 *   panning: string,
 *   masterVolume: { left: number, right: number },
 * }}
 */
export function decodeGbApu(io) {
  const nr52 = io[GB_MAP.nr52];
  const nr50 = io[GB_MAP.nr50];
  const channels = decodePsgBlock((off) => io[off], GB_MAP, nr52);
  return {
    enabled: !!(nr52 & 0x80), // NR52 bit7 = APU power
    channels,
    nr52: hex(nr52),
    panning: hex(io[GB_MAP.nr51]),
    masterVolume: {
      left: (nr50 >> 4) & 0x07,  // bits 4-6: left (SO2) volume
      right: nr50 & 0x07,        // bits 0-2: right (SO1) volume
    },
  };
}

// GBA audio register byte offsets within the 0x400-byte `gba_io_regs` page.
// The four PSG channels mirror the DMG NRxx registers, two bytes apart, and we
// remap them onto the same GB_MAP-style offset names so decodePsgBlock works
// unchanged. SOUND1CNT_L holds the sweep; SOUNDxCNT_H/_X hold len/vol/env/freq.
const GBA = {
  SOUND1CNT_L: 0x60, SOUND1CNT_H: 0x62, SOUND1CNT_X: 0x64,
  SOUND2CNT_L: 0x68, SOUND2CNT_H: 0x6c,
  SOUND3CNT_L: 0x70, SOUND3CNT_H: 0x72, SOUND3CNT_X: 0x74,
  SOUND4CNT_L: 0x78, SOUND4CNT_H: 0x7c,
  SOUNDCNT_L: 0x80, SOUNDCNT_H: 0x82, SOUNDCNT_X: 0x84, SOUNDBIAS: 0x88,
};

/**
 * Decode one Direct Sound DMA FIFO channel's control bits out of SOUNDCNT_H.
 * @param {number} cntH the 16-bit SOUNDCNT_H value
 * @param {number} shift bit position of this channel's control nibble (8 for A, 12 for B)
 * @returns {{ enable: { right: boolean, left: boolean }, timer: number,
 *   reset: boolean, volume: string }}
 */
function decodeDirectSound(cntH, shift) {
  const f = (cntH >> shift) & 0x0f;
  return {
    enable: {
      right: !!(f & 0x01), // output to right
      left: !!(f & 0x02),  // output to left
    },
    timer: (f >> 2) & 0x01, // which timer (0 or 1) drives the FIFO
    reset: !!(f & 0x08),    // FIFO reset
    // DMA-sound volume ratio: SOUNDCNT_H bit2 (A) / bit3 (B). 0 = 50%, 1 = 100%.
    volume: ((cntH >> (shift === 8 ? 2 : 3)) & 0x01) ? "100%" : "50%",
  };
}

/**
 * Decode the Game Boy Advance APU register file: the four DMG PSG channels plus
 * the two Direct Sound DMA FIFO channels.
 *
 * @param {Uint8Array} io the 0x400-byte `gba_io_regs` region (IO page at $4000000)
 * @returns {{
 *   enabled: boolean,
 *   psg: ReturnType<typeof decodePsgBlock>,
 *   directSound: {
 *     a: ReturnType<typeof decodeDirectSound>,
 *     b: ReturnType<typeof decodeDirectSound>,
 *   },
 *   psgVolume: { right: number, left: number },
 *   soundBias: string,
 *   soundcntX: string,
 * }}
 */
export function decodeGbaApu(io) {
  /** Read a 16-bit little-endian halfword at byte offset `off`. */
  const u16 = (off) => io[off] | (io[off + 1] << 8);

  const soundcntX = u16(GBA.SOUNDCNT_X);
  const soundcntL = u16(GBA.SOUNDCNT_L);
  const soundcntH = u16(GBA.SOUNDCNT_H);

  // SOUNDCNT_X bits 0-3 are the live PSG channel-on status (same bit order as
  // GB NR52 bits 0-3), so we can feed them straight into the shared decoder.
  const nr52Equiv = soundcntX & 0x0f;

  // Map the shared PSG decoder's NRxx offset names onto the GBA register bytes.
  // Each GBA sound register is a 16-bit pair; the meaningful NRxx byte we want
  // is at a specific byte offset within it (low byte = first, high byte = +1).
  const gbaPsgMap = {
    nr10: GBA.SOUND1CNT_L,         // sweep (low byte of SOUND1CNT_L)
    nr11: GBA.SOUND1CNT_H,         // duty/len  (low byte of SOUND1CNT_H)
    nr12: GBA.SOUND1CNT_H + 1,     // vol/env   (high byte of SOUND1CNT_H)
    nr13: GBA.SOUND1CNT_X,         // freq lo   (low byte of SOUND1CNT_X)
    nr14: GBA.SOUND1CNT_X + 1,     // freq hi   (high byte of SOUND1CNT_X)
    nr21: GBA.SOUND2CNT_L,         // duty/len
    nr22: GBA.SOUND2CNT_L + 1,     // vol/env
    nr23: GBA.SOUND2CNT_H,         // freq lo
    nr24: GBA.SOUND2CNT_H + 1,     // freq hi
    nr30: GBA.SOUND3CNT_L,         // DAC/wave enable
    nr32: GBA.SOUND3CNT_H + 1,     // vol-shift (high byte of SOUND3CNT_H)
    nr33: GBA.SOUND3CNT_X,         // freq lo
    nr34: GBA.SOUND3CNT_X + 1,     // freq hi
    nr42: GBA.SOUND4CNT_L + 1,     // vol/env   (high byte of SOUND4CNT_L)
    nr43: GBA.SOUND4CNT_H,         // noise freq
    nr44: GBA.SOUND4CNT_H + 1,     // trigger/len-enable
  };

  const psg = decodePsgBlock((off) => io[off], gbaPsgMap, nr52Equiv);

  return {
    enabled: !!(soundcntX & 0x80), // SOUNDCNT_X bit7 = master sound enable
    psg,
    directSound: {
      a: decodeDirectSound(soundcntH, 8),
      b: decodeDirectSound(soundcntH, 12),
    },
    psgVolume: {
      right: soundcntL & 0x07,        // bits 0-2: right (SO1) PSG volume
      left: (soundcntL >> 4) & 0x07,  // bits 4-6: left  (SO2) PSG volume
    },
    soundBias: hex16(io[GBA.SOUNDBIAS] | (io[GBA.SOUNDBIAS + 1] << 8)),
    soundcntX: hex16(soundcntX),
  };
}
