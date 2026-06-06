// C64 SID (6581/8580) state introspection.
//
// Gives C64 titles the same "what is each voice playing this frame?" decode
// that getAudioState already gives the NES APU and SNES DSP. Before this, a
// C64 music job had to reverse-engineer the game's private player RAM by hand;
// now the hardware register file is decoded directly, player-independent.
//
// Data source: the `c64_sid_regs` region — a 29-byte snapshot of the SID
// register file at $D400-$D41C. These are the *register* bytes (what the CPU
// last wrote); the SID is write-only for $D400-$D414, so this is exactly the
// pitch/waveform/ADSR layer you want for music transcription:
//
//   Voice N base = N*7  (N = 0,1,2)
//     +0 freq lo          $D400/$D407/$D40E
//     +1 freq hi          $D401/$D408/$D40F
//     +2 PW lo            $D402/$D409/$D410
//     +3 PW hi (bits 0-3) $D403/$D40A/$D411
//     +4 control          $D404/$D40B/$D412 (gate/sync/ring/test/waveforms)
//     +5 attack/decay     $D405/$D40C/$D413 (hi nibble attack, lo decay)
//     +6 sustain/release  $D406/$D40D/$D414 (hi nibble sustain, lo release)
//   $15 cutoff lo (bits 0-2)  $D415
//   $16 cutoff hi             $D416
//   $17 resonance / routing   $D417 (hi nibble resonance, lo = filter routing)
//   $18 mode / volume         $D418 (lo nibble master vol, bits 4-6 mode, b7 v3off)

// SID master clock. PAL C64 = 985248 Hz; the phase accumulator is 24-bit, so
// freqHz = regValue16 * (clock / 2^24). NTSC differs (1022730) but PAL is the
// default for European homebrew and the caller can recompute from `freqHz`.
const SID_CLOCK_PAL = 985248;
const SID_PHASE = 16777216; // 2^24

// Control-register waveform bits (4-7). A voice can mix several; we list each
// set bit so the caller sees combined-waveform tricks (e.g. tri+saw).
const WAVEFORM_BITS = [
  [0x10, "triangle"],
  [0x20, "sawtooth"],
  [0x40, "pulse"],
  [0x80, "noise"],
];

// Filter mode bits ($D418 bits 4-6). A voice can route through several modes
// at once on real hardware (notch = LP+HP), so we list each set bit.
const FILTER_MODE_BITS = [
  [0x10, "lowpass"],
  [0x20, "bandpass"],
  [0x40, "highpass"],
];

/**
 * Convert a frequency in Hz to the nearest 12-TET note name (e.g. "C#4"),
 * or null for 0 / invalid frequencies. A4 = 440 Hz.
 * @param {number} hz
 * @returns {string | null}
 */
export function freqToNote(hz) {
  if (!hz || !Number.isFinite(hz) || hz <= 0) return null;
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  // MIDI 69 = A4 = 440 Hz; octave number in scientific pitch notation is
  // floor(midi/12) - 1 so that MIDI 60 = C4.
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const name = NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return name + octave;
}

/**
 * Decode the SID register snapshot into per-voice musical state.
 *
 * @param {Uint8Array} regs the 29-byte `c64_sid_regs` region ($D400-$D41C)
 * @returns {{
 *   voices: VoiceState[],
 *   filter: {
 *     cutoff: number, resonance: number,
 *     mode: string[], routedVoices: boolean[],
 *   },
 *   masterVolume: number,
 *   voice3Off: boolean,
 *   note: string,
 * }}
 *
 * @typedef {{
 *   freqHz: number, note: string|null, waveform: string[], pulseWidth: number,
 *   gate: boolean, sync: boolean, ringMod: boolean, test: boolean,
 *   adsr: { attack: number, decay: number, sustain: number, release: number },
 * }} VoiceState
 */
export function decodeC64Sid(regs) {
  const voices = [];
  for (let v = 0; v < 3; v++) {
    const base = v * 7;
    const freqLo = regs[base + 0];
    const freqHi = regs[base + 1];
    const pwLo = regs[base + 2];
    const pwHi = regs[base + 3] & 0x0f; // only low nibble is wired (12-bit PW)
    const ctrl = regs[base + 4];
    const ad = regs[base + 5];
    const sr = regs[base + 6];

    const reg16 = freqLo | (freqHi << 8);
    const freqHz = reg16 * (SID_CLOCK_PAL / SID_PHASE);
    const waveform = WAVEFORM_BITS
      .filter(([bit]) => ctrl & bit)
      .map(([, name]) => name);

    voices.push({
      freqHz: Math.round(freqHz * 100) / 100,
      note: freqToNote(freqHz),
      waveform,
      pulseWidth: (pwHi << 8) | pwLo, // 12-bit, 0..4095
      gate: !!(ctrl & 0x01),
      sync: !!(ctrl & 0x02),
      ringMod: !!(ctrl & 0x04),
      test: !!(ctrl & 0x08),
      adsr: {
        attack: (ad >> 4) & 0x0f,
        decay: ad & 0x0f,
        sustain: (sr >> 4) & 0x0f,
        release: sr & 0x0f,
      },
    });
  }

  const cutoffLo = regs[0x15] & 0x07; // only low 3 bits are wired
  const cutoffHi = regs[0x16];
  const res = regs[0x17];
  const modeVol = regs[0x18];

  const filter = {
    // 11-bit cutoff: hi byte is the upper 8 bits, lo register the lowest 3.
    cutoff: (cutoffHi << 3) | cutoffLo,
    resonance: (res >> 4) & 0x0f,
    mode: FILTER_MODE_BITS.filter(([bit]) => modeVol & bit).map(([, name]) => name),
    // $D417 low nibble routes voices 1-3 (+ ext in, bit3) through the filter.
    routedVoices: [!!(res & 0x01), !!(res & 0x02), !!(res & 0x04)],
  };

  return {
    voices,
    filter,
    masterVolume: modeVol & 0x0f,
    voice3Off: !!(modeVol & 0x80),
    note:
      "Decoded from the SID register file ($D400-$D41C) — the last values the " +
      "CPU wrote (SID is write-only here), which is exactly the pitch/waveform/" +
      "ADSR layer you want for music transcription. freqHz assumes PAL " +
      "(clock 985248 Hz, 24-bit phase accumulator); for NTSC recompute with " +
      "clock 1022730. pulseWidth is 12-bit (0-4095); ADSR fields are 0-15 rate " +
      "indices, not seconds.",
  };
}

/**
 * @param {import("./LibretroHost.js").LibretroHost} host
 * @param {string} platform
 * @returns {ReturnType<typeof decodeC64Sid> | null}
 */
export function getC64SidState(host, platform) {
  if (platform !== "c64") return null;
  const regs = host.readMemory("c64_sid_regs", 0, 29);
  return decodeC64Sid(regs);
}
