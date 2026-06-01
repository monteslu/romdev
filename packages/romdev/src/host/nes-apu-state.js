// NES 2A03 APU state introspection.
//
// Per the rom-games music-analysis asks: give NES titles the same "what is
// each channel playing this frame?" decode that getAudioState already gives
// SNES (dsp) and Genesis (psg/ym2612). Before this, an NES music job had to
// reverse-engineer the game's private sound-driver RAM by hand; now the
// hardware register file is decoded directly, game-driver-independent.
//
// Data source: the `nes_apu_regs` region (id 0x104) exposed by our fceumm
// patch (scripts/patches/fceumm-romdev-memory-regions.patch). It's a 24-byte
// synthesized snapshot of the APU register file at CPU $4000-$4017:
//
//   [0x00..0x0F]  PSG[0..15]      — $4000-$400F (pulse1, pulse2, triangle, noise)
//   [0x10]        DMCFormat       — $4010
//   [0x11]        RawDALatch      — $4011 (DMC direct load, 7-bit)
//   [0x12]        DMCAddressLatch — $4012
//   [0x13]        DMCSizeLatch    — $4013
//   [0x14]        0               — ($4014 is OAMDMA, not APU; zero-filled)
//   [0x15]        EnabledChannels — $4015 (write side: per-channel enable)
//   [0x16]        0               — ($4016 is controller, not APU)
//   [0x17]        IRQFrameMode    — $4017 (frame counter mode)
//
// These are the *register* bytes (what the CPU last wrote), not the APU's
// internal swe/envelope counters — which is exactly what you want for music
// transcription: timer + duty + volume nibble decode straight to pitch.

// 2A03 CPU clock (NTSC). Pulse freq = CPU / (16 * (timer + 1)),
// triangle freq = CPU / (32 * (timer + 1)). PAL differs but fceumm
// defaults to NTSC for homebrew, and the caller can recompute from `timer`.
const CPU_HZ_NTSC = 1789773;

// Duty-cycle bit pattern → human label (pulse $4000/$4004 bits 6-7).
const DUTY_LABEL = ["12.5%", "25%", "50%", "75% (25% inverted)"];

// Length-counter load table is irrelevant to pitch, so we don't decode it.

/**
 * Convert a frequency in Hz to the nearest MIDI note name (e.g. "A4"),
 * or null for sub-audible / zero frequencies. A4 = 440 Hz = MIDI 69.
 * @param {number} hz
 * @returns {{ midi: number, name: string, cents: number } | null}
 */
export function hzToMidi(hz) {
  if (!hz || hz < 16) return null; // below ~C0; treat as silent/inaudible
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const midiFloat = 69 + 12 * Math.log2(hz / 440);
  const midi = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midi) * 100);
  const name = NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  return { midi, name, cents };
}

/**
 * Decode the NES APU register snapshot into per-channel musical state.
 *
 * @param {Uint8Array} regs the 24-byte `nes_apu_regs` region
 * @returns {{
 *   pulse1: PulseState, pulse2: PulseState, triangle: TriangleState,
 *   noise: NoiseState, dmc: DmcState,
 *   status: { pulse1: boolean, pulse2: boolean, triangle: boolean, noise: boolean, dmc: boolean },
 *   frameCounter: { mode: 4 | 5, irqInhibit: boolean },
 *   regsHex: string,
 *   note: string,
 * }}
 *
 * @typedef {{ enabled: boolean, duty: number, dutyLabel: string, volume: number,
 *   constantVolume: boolean, lengthHalt: boolean, timer: number, freq: number|null,
 *   midi: number|null, note: string|null, cents: number|null, playing: boolean }} PulseState
 * @typedef {{ enabled: boolean, control: number, linearReload: number, lengthHalt: boolean,
 *   timer: number, freq: number|null, midi: number|null, note: string|null, cents: number|null,
 *   playing: boolean }} TriangleState
 * @typedef {{ enabled: boolean, volume: number, constantVolume: boolean, lengthHalt: boolean,
 *   period: number, mode: 'periodic'|'white', playing: boolean }} NoiseState
 * @typedef {{ enabled: boolean, irqEnabled: boolean, loop: boolean, rateIndex: number,
 *   directLoad: number, sampleAddress: number, sampleLength: number }} DmcState
 */
export function decodeNesApu(regs) {
  // ── Pulse channels ($4000-$4003 and $4004-$4007) ──────────────────
  const pulse = (base, statusBit) => {
    const r0 = regs[base + 0];
    const r2 = regs[base + 2];
    const r3 = regs[base + 3];
    const duty = (r0 >> 6) & 0x3;
    const lengthHalt = !!(r0 & 0x20);     // also envelope-loop
    const constantVolume = !!(r0 & 0x10);
    const volume = r0 & 0x0F;             // volume (constant) or envelope period
    const timer = ((r3 & 0x07) << 8) | r2; // 11-bit timer
    // Below timer 8 the pulse is silenced by the hardware sweep unit.
    const freq = timer >= 8 ? CPU_HZ_NTSC / (16 * (timer + 1)) : null;
    const m = freq ? hzToMidi(freq) : null;
    const enabled = !!(regs[0x15] & statusBit);
    return {
      enabled,
      duty, dutyLabel: DUTY_LABEL[duty],
      volume, constantVolume, lengthHalt,
      timer,
      freq: freq ? Math.round(freq * 100) / 100 : null,
      midi: m?.midi ?? null,
      note: m?.name ?? null,
      cents: m?.cents ?? null,
      // "playing" = channel enabled, audible timer, and non-zero output level
      playing: enabled && freq != null && (constantVolume ? volume > 0 : true),
    };
  };

  // ── Triangle ($4008-$400B) ────────────────────────────────────────
  const t0 = regs[0x08], t2 = regs[0x0A], t3 = regs[0x0B];
  const triLengthHalt = !!(t0 & 0x80);  // bit7 = length halt / linear control
  const linearReload = t0 & 0x7F;
  const triTimer = ((t3 & 0x07) << 8) | t2;
  // Triangle is /32, and one octave below the same timer on a pulse.
  const triFreq = triTimer >= 2 ? CPU_HZ_NTSC / (32 * (triTimer + 1)) : null;
  const triM = triFreq ? hzToMidi(triFreq) : null;
  const triEnabled = !!(regs[0x15] & 0x04);
  const triangle = {
    enabled: triEnabled,
    control: t0 >> 7,
    linearReload,
    lengthHalt: triLengthHalt,
    timer: triTimer,
    freq: triFreq ? Math.round(triFreq * 100) / 100 : null,
    midi: triM?.midi ?? null,
    note: triM?.name ?? null,
    cents: triM?.cents ?? null,
    // Triangle has no volume control — it plays at full level whenever
    // enabled with a non-zero linear+length counter and audible timer.
    playing: triEnabled && triFreq != null && linearReload > 0,
  };

  // ── Noise ($400C-$400F) ───────────────────────────────────────────
  const n0 = regs[0x0C], n2 = regs[0x0E];
  const noiseEnabled = !!(regs[0x15] & 0x08);
  const noise = {
    enabled: noiseEnabled,
    volume: n0 & 0x0F,
    constantVolume: !!(n0 & 0x10),
    lengthHalt: !!(n0 & 0x20),
    period: n2 & 0x0F,                       // index into the period table
    mode: (n2 & 0x80) ? 'periodic' : 'white', // bit7 = mode flag
    playing: noiseEnabled && ((n0 & 0x10) ? (n0 & 0x0F) > 0 : true),
  };

  // ── DMC ($4010-$4013) ─────────────────────────────────────────────
  const d0 = regs[0x10];
  const dmc = {
    enabled: !!(regs[0x15] & 0x10),
    irqEnabled: !!(d0 & 0x80),
    loop: !!(d0 & 0x40),
    rateIndex: d0 & 0x0F,
    directLoad: regs[0x11] & 0x7F,
    sampleAddress: 0xC000 + regs[0x12] * 64,
    sampleLength: regs[0x13] * 16 + 1,
  };

  const status = regs[0x15];
  const frameMode = regs[0x17];

  return {
    pulse1: pulse(0x00, 0x01),
    pulse2: pulse(0x04, 0x02),
    triangle,
    noise,
    dmc,
    status: {
      pulse1: !!(status & 0x01),
      pulse2: !!(status & 0x02),
      triangle: !!(status & 0x04),
      noise: !!(status & 0x08),
      dmc: !!(status & 0x10),
    },
    frameCounter: {
      mode: (frameMode & 0x80) ? 5 : 4,
      irqInhibit: !!(frameMode & 0x40),
    },
    regsHex: Array.from(regs, (b) => b.toString(16).padStart(2, "0")).join(""),
    note:
      "Decoded from the APU register file ($4000-$4017) — i.e. the last values " +
      "the CPU wrote, which is exactly the pitch/duty/volume layer you want for " +
      "music transcription. freq/midi assume NTSC (CPU 1789773 Hz); recompute " +
      "from `timer` for PAL. `playing` is a heuristic (enabled + audible timer + " +
      "non-zero level); cross-check with recordAudio if a channel looks ambiguous.",
  };
}

/**
 * @param {import("./LibretroHost.js").LibretroHost} host
 * @param {string} platform
 * @returns {ReturnType<typeof decodeNesApu> | null}
 */
export function getNesApuState(host, platform) {
  if (platform !== "nes") return null;
  const regs = host.readMemory("nes_apu_regs", 0, 24);
  return decodeNesApu(regs);
}
