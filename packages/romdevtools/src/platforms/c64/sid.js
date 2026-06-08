// Commodore 64 SID (MOS 6581/8580) helpers.
//
// SID is the C64's sound chip — 3 voices, each with:
//   - Frequency (16-bit)
//   - Pulse width (12-bit, used for pulse waveform)
//   - Waveform + gate + sync + ring-mod (control register)
//   - Attack/Decay nibbles + Sustain/Release nibbles (ADSR envelope)
// Plus a global filter (cutoff, resonance, voice routing) and
// the master volume + filter mode bits.
//
// Register layout ($D400-$D41C, 29 bytes; write-only on real hardware
// except for $D419-$D41C which are read-only):
//
//   Voice 1: $D400-$D406
//     $D400/01  FREQ_LO / FREQ_HI
//     $D402/03  PW_LO / PW_HI (low nibble of $D403 used)
//     $D404     CONTROL: bit 0 = gate, 1 = sync, 2 = ring-mod, 3 = test,
//                       4 = triangle, 5 = sawtooth, 6 = pulse, 7 = noise
//     $D405     ATTACK/DECAY (4+4 bits)
//     $D406     SUSTAIN/RELEASE (4+4 bits)
//
//   Voice 2: $D407-$D40D (same layout)
//   Voice 3: $D40E-$D414 (same layout)
//
//   $D415/16  filter cutoff LO/HI (only high 11 bits used)
//   $D417     filter resonance + voice-routing
//   $D418     volume + filter mode
//   $D419/1A  paddle X/Y (read-only)
//   $D41B     voice 3 OSC3 readback
//   $D41C     voice 3 ENV3 readback

function decodeControl(byte) {
  // Decode the waveform field (top 4 bits) as a name where possible.
  const wfBits = (byte >> 4) & 0x0F;
  let waveform;
  if (wfBits === 0)        waveform = "none";
  else if (wfBits === 0x1) waveform = "triangle";
  else if (wfBits === 0x2) waveform = "sawtooth";
  else if (wfBits === 0x4) waveform = "pulse";
  else if (wfBits === 0x8) waveform = "noise";
  else                     waveform = "mixed (0x" + wfBits.toString(16) + ")";
  return {
    hex: hex2(byte),
    gate:    !!(byte & 0x01),
    sync:    !!(byte & 0x02),
    ringMod: !!(byte & 0x04),
    test:    !!(byte & 0x08),
    waveform,
    waveformBits: wfBits,
  };
}

function decodeVoice(regs, base) {
  const freq = regs[base + 0] | (regs[base + 1] << 8);
  const pw   = regs[base + 2] | ((regs[base + 3] & 0x0F) << 8); // 12-bit
  const ctrl = regs[base + 4];
  const adByte = regs[base + 5];
  const srByte = regs[base + 6];
  // Hz approximation: SID frequency = (F * Φ2) / (2^24) where Φ2 ≈ 985248 Hz PAL
  // (or 1022730 NTSC). Use PAL as default for the display — close enough for
  // agent-level reasoning about pitch.
  const hzPal  = (freq * 985248) / (1 << 24);
  return {
    freqRaw:  freq,
    freqHzPal: +hzPal.toFixed(2),
    pulseWidth: pw,
    pulseWidthPct: +((pw / 4095) * 100).toFixed(1),
    control: decodeControl(ctrl),
    attack:  (adByte >> 4) & 0x0F,
    decay:   adByte & 0x0F,
    sustain: (srByte >> 4) & 0x0F,
    release: srByte & 0x0F,
  };
}

/**
 * Decode the SID state from a 29-byte buffer (one snapshot, $D400-$D41C).
 */
export function decodeSidState(regs) {
  const filterLo = regs[0x15] & 0x07;       // low 3 bits used
  const filterHi = regs[0x16];                // full byte
  const filterCutoff = (filterHi << 3) | filterLo;
  const res = regs[0x17];
  const vol = regs[0x18];
  return {
    voice1: decodeVoice(regs, 0x00),
    voice2: decodeVoice(regs, 0x07),
    voice3: decodeVoice(regs, 0x0E),
    filter: {
      cutoff: filterCutoff,             // 11-bit
      cutoffPct: +((filterCutoff / 0x7FF) * 100).toFixed(1),
      resonance: (res >> 4) & 0x0F,
      voicesFiltered: {
        v1: !!(res & 0x01),
        v2: !!(res & 0x02),
        v3: !!(res & 0x04),
        ext: !!(res & 0x08),
      },
    },
    output: {
      volume:        vol & 0x0F,
      lowPass:       !!(vol & 0x10),
      bandPass:      !!(vol & 0x20),
      highPass:      !!(vol & 0x40),
      voice3Off:     !!(vol & 0x80),
    },
    readback: {
      paddleX: regs[0x19],
      paddleY: regs[0x1A],
      osc3:    regs[0x1B],
      env3:    regs[0x1C],
    },
  };
}

function hex2(n) {
  return "0x" + (n & 0xFF).toString(16).toUpperCase().padStart(2, "0");
}

/**
 * snapshotSid(host) — return the decoded SID state from the running emulator.
 */
export function snapshotSid(host) {
  const regs = host.readMemory("c64_sid_regs", 0, 29);
  return decodeSidState(regs);
}
