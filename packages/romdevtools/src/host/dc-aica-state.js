// Dreamcast AICA sound-chip decode — the "what is each of the 64 PCM channels
// doing this frame?" view that getAudioState gives the other platforms' chips.
// Input is the raw AICA register window (Uint8Array) from host.getAicaRegs():
// 64 channels × 0x80 bytes starting at 0x000, plus CommonData at 0x2800.
//
// The AICA is a 64-channel PCM/ADPCM sampler. Canonical per-channel register map
// (offset within the channel's 0x80 block), little-endian 16-bit registers:
//   0x00 : KYONEX(15) KYONB(14) ... LPCTL(9) PCMS(8..7) SA-high(6..0)
//   0x04 : SA-low (sample start address, low 16)
//   0x08 : LSA (loop start)            0x0C : LEA (loop end)
//   0x10 : D2R/D1R/AR (attack/decay)   0x14 : RR/DL/KRS/LS (release/sustain)
//   0x18 : LPSLNK / OCT / FNS (pitch: OCT bits 14..11 signed, FNS bits 9..0)
//   0x24 : DISDL (direct send level, bits 11..8) / DIPAN (pan, bits 4..0)
// CommonData (0x2800): 0x00 MVOL (master volume, bits 3..0) + MONO/MEM8MB/etc.

const CH_STRIDE = 0x80;
const NUM_CH = 64;
const COMMON = 0x2800;

/**
 * @param {Uint8Array|null} reg  the AICA register window from getAicaRegs()
 * @returns {{ chip:"aica", masterVolume:number, voices:Array<object>,
 *   activeVoices:number } | null}
 */
export function decodeAica(reg) {
  if (!reg || reg.length < COMMON + 2) return null;
  const u16 = (o) => (reg[o] | (reg[o + 1] << 8)) & 0xffff;

  const voices = [];
  let active = 0;
  for (let c = 0; c < NUM_CH; c++) {
    const base = c * CH_STRIDE;
    if (base + 0x28 > reg.length) break;
    const play = u16(base + 0x00);
    const keyOn = !!(play & 0x4000);       // KYONB
    const loop = !!(play & 0x0200);        // LPCTL
    const pcms = (play >> 7) & 0x3;         // 0/1 = 16/8-bit PCM, 2 = ADPCM
    const saHi = play & 0x7f;
    const saLo = u16(base + 0x04);
    const sampleAddr = ((saHi << 16) | saLo) >>> 0;
    const lsa = u16(base + 0x08);
    const lea = u16(base + 0x0c);
    const pitch = u16(base + 0x18);
    const oct = (pitch >> 11) & 0xf;        // signed 4-bit
    const fns = pitch & 0x3ff;
    const env = u16(base + 0x24);
    const disdl = (env >> 8) & 0xf;         // direct send level (volume)
    const dipan = env & 0x1f;               // pan
    if (keyOn && disdl > 0) active++;
    voices.push({
      ch: c,
      keyOn,
      loop,
      format: pcms === 2 ? "ADPCM" : (pcms === 1 ? "PCM8" : "PCM16"),
      sampleAddr: "$" + sampleAddr.toString(16).toUpperCase(),
      loopStart: lsa,
      loopEnd: lea,
      octave: oct >= 8 ? oct - 16 : oct,    // 4-bit signed
      fns,
      volume: disdl,                         // 0..15 direct send level
      pan: dipan,
    });
  }

  const mvol = u16(COMMON + 0x00) & 0xf;
  return { chip: "aica", masterVolume: mvol, activeVoices: active, voices };
}
