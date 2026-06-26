// PS1 SPU (Sound Processing Unit) decoder.
//
// Data source: the SPU's 0x400-word register block ($1F801C00-based), exposed by
// the romdev_spu_get export in the rebuilt pcsx_rearmed core. The block is indexed
// as 16-bit words; per-voice registers occupy the first 24×8 words (16 bytes each),
// then the global voice/control registers follow.
//
// The SPU has 24 ADPCM voices. Per voice (offset = voice*8 words):
//   +0 VolumeLeft   +1 VolumeRight   +2 ADPCM SampleRate (pitch)
//   +3 ADPCM StartAddr   +4 ADSR lo   +5 ADSR hi   +6 ADSR CurrentVol  +7 RepeatAddr
// Global (word index):
//   0xC0/0xC1 = main volume L/R, 0xCC/0xCD = KeyOn (24-bit across two words),
//   0xCE/0xCF = KeyOff, 0xD6 = SPU control (SPUCNT).

const NUM_VOICES = 24;

/** SPU pitch → Hz: the 16-bit pitch is in units of 44100/4096 Hz per step
 *  (4096 = "1.0" = 44100 Hz). */
function pitchToHz(pitch) {
  return Math.round((pitch / 4096) * 44100);
}

/**
 * @param {Uint16Array} regs the 0x400-word SPU register block
 * @returns {{ chip:"spu", mainVolumeLeft:number, mainVolumeRight:number,
 *   control:number, voices:Array<object> }}
 */
export function decodePs1Spu(regs) {
  if (!regs || regs.length < 0x200) return { chip: "spu", voices: [] };
  // Key-on / key-off are 24-bit, split across two 16-bit words.
  const keyOn = (regs[0xCC] | (regs[0xCD] << 16)) >>> 0;
  const keyOff = (regs[0xCE] | (regs[0xCF] << 16)) >>> 0;

  const voices = [];
  for (let v = 0; v < NUM_VOICES; v++) {
    const b = v * 8;
    const volL = regs[b + 0];
    const volR = regs[b + 1];
    const pitch = regs[b + 2];
    const adsr = (regs[b + 4] | (regs[b + 5] << 16)) >>> 0;
    const curVol = regs[b + 6];
    const on = !!(keyOn & (1 << v));
    voices.push({
      voice: v,
      keyOn: on,
      keyOff: !!(keyOff & (1 << v)),
      // signed 15-bit volumes (top bit = sweep mode; report the magnitude)
      volumeLeft: volL & 0x7fff,
      volumeRight: volR & 0x7fff,
      pitch,
      hz: pitch ? pitchToHz(pitch) : 0,
      adsr: "0x" + adsr.toString(16).padStart(8, "0").toUpperCase(),
      currentVolume: curVol,
      active: curVol > 0 || on,
    });
  }
  return {
    chip: "spu",
    mainVolumeLeft: regs[0xC0] & 0x7fff,
    mainVolumeRight: regs[0xC1] & 0x7fff,
    control: regs[0xD6],
    keyOnMask: "0x" + keyOn.toString(16).toUpperCase(),
    voices,
  };
}
