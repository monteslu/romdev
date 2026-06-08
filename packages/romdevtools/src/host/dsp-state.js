// SNES S-DSP state introspection.
//
// Per the rom-games agent's audio-debugging asks: distinguish "voice
// never produced output" (BRR/envelope issue) from "voice produced
// output but mixer muted it" (master volume issue). The data lives in
// the savestate's "SND" block, AFTER the SMP::save_state region. We
// parse it the same way as cpu-state.js parses the SMP block.
//
// SND block layout (cumulative):
//   [0x10000]                      apuram (SMP::save_state)
//   [4 × 14 = 56 bytes]            SMP regs (clock + opcode + PC + SP + A + X + Y + 8 P flags)
//   [...status + timer fields...]
//   [DSP::save_state begins here]
//     [128 bytes]                  m.regs (DSP register file)
//     [per voice × 8]
//       [12 × int16 = 24 bytes]    v.buf (BRR sample ring)
//       [uint16]                   v.interp_pos
//       [uint16]                   v.brr_addr
//       [uint16]                   v.env       ← THE KEY FIELD
//       [int16]                    v.hidden_env
//       [uint8]                    v.buf_pos
//       [uint8]                    v.brr_offset
//       [uint8]                    v.kon_delay
//       [uint8]                    v.env_mode
//       [uint8]                    v.t_envx_out
//       [extra: 1 byte N + N bytes pad]
//     [...echo history, misc...]
//
// All multi-byte fields are little-endian (host byte order on wasm32).
// SPC_DSP::copy_state uses memcpy (no endian flip).

import { findSnes9xBlock } from "./snes9x-state.js";

// Where the DSP block starts within "SND", measured from the start of
// the SMP region. Sum of every INT32(...) call in SMP::save_state:
//   apuram(0x10000) + clock(4) + opcode_number(4) + opcode_cycle(4)
//   + pc(4) + sp(4) + a(4) + x(4) + y(4)
//   + p.n/v/p/b/h/i/z/c (8 × 4 = 32)
//   + iplrom_enable(4) + dsp_addr(4)
//   + ram00f8(4) + ram00f9(4)
//   + timer0.{enable,target,stage1,stage2,stage3} (5 × 4 = 20)
//   + timer1 (5 × 4 = 20)
//   + timer2 (5 × 4 = 20)
//   + rd(4) + wr(4) + dp(4) + sp(4) + ya(4) + bit(4) = 24
const SMP_BLOCK_BYTES =
  0x10000 + // apuram
  3 * 4 +   // clock + opcode_number + opcode_cycle
  5 * 4 +   // pc + sp + a + x + y
  8 * 4 +   // p flags (n v p b h i z c)
  4 * 4 +   // iplrom_enable + dsp_addr + ram00f8 + ram00f9
  3 * 5 * 4 + // 3 timers × 5 fields
  6 * 4;    // rd + wr + dp + sp + ya + bit

/**
 * Decode SNES S-DSP voice state + key register slices.
 *
 * @param {Uint8Array} state full savestate buffer
 * @returns {{
 *   regs: Uint8Array,                       // 128-byte DSP register file
 *   masterVolume: { l: number, r: number }, // signed -128..127
 *   echoVolume: { l: number, r: number },
 *   flg: number,                            // FLG register: bit 6 = mute, bit 7 = reset
 *   kon: number,                            // last KON write (bitmask of voices keyed on)
 *   koff: number,                           // last KOFF write
 *   endx: number,                           // ENDX (voices whose samples have ended)
 *   voices: Array<{
 *     slot: number,
 *     vol: { l: number, r: number },        // signed -128..127
 *     pitch: number,                        // 14-bit unsigned
 *     srcn: number,                         // sample directory index
 *     adsr: { adsr1: number, adsr2: number },
 *     gain: number,
 *     envx: number,                         // RAW DSP register (snapshot at last sample)
 *     outx: number,                         // RAW DSP register (snapshot)
 *     env: number,                          // INTERNAL envelope value (gates output)
 *     hiddenEnv: number,                    // ADSR rate counter / GAIN internal
 *     envMode: number,                      // 0=release, 1=attack, 2=decay, 3=sustain
 *     bufLastSamples: number[],             // last 12 BRR-decoded samples (int16)
 *     bufPos: number,
 *   }>
 * } | null}
 */
export function decodeSnes9xDSP(state) {
  const off = findSnes9xBlock(state, "SND");
  if (off < 0) return null;
  let p = off + SMP_BLOCK_BYTES;

  // DSP register file (128 bytes)
  const regs = state.slice(p, p + 128);
  p += 128;

  // 8 voices
  const voices = [];
  for (let i = 0; i < 8; i++) {
    const bufStart = p;
    const bufLastSamples = [];
    for (let j = 0; j < 12; j++) {
      const lo = state[bufStart + j * 2];
      const hi = state[bufStart + j * 2 + 1];
      // Sign-extend 16-bit
      const u = lo | (hi << 8);
      bufLastSamples.push(u >= 0x8000 ? u - 0x10000 : u);
    }
    p += 24;
    p += 2; // interpPos (decoded field, not surfaced)
    p += 2; // brrAddr (decoded field, not surfaced)
    const env = state[p] | (state[p + 1] << 8); p += 2;
    const hiddenEnvU = state[p] | (state[p + 1] << 8); p += 2;
    const hiddenEnv = hiddenEnvU >= 0x8000 ? hiddenEnvU - 0x10000 : hiddenEnvU;
    const bufPos = state[p++];
    /* brrOffset */ p++;
    /* konDelay */ p++;
    const envMode = state[p++];
    /* t_envx_out */ p++;
    // copier.extra(): uint8 N then N bytes pad
    const extraN = state[p++];
    p += extraN;

    // Voice DSP regs: base = voice<<4, fields:
    //   $X0 VOLL, $X1 VOLR, $X2 PITCHL, $X3 PITCHH, $X4 SRCN,
    //   $X5 ADSR1, $X6 ADSR2, $X7 GAIN, $X8 ENVX, $X9 OUTX
    const base = i << 4;
    const vol = {
      l: regs[base] > 0x7F ? regs[base] - 256 : regs[base],
      r: regs[base + 1] > 0x7F ? regs[base + 1] - 256 : regs[base + 1],
    };
    const pitch = regs[base + 2] | ((regs[base + 3] & 0x3F) << 8);
    voices.push({
      slot: i,
      vol,
      pitch,
      srcn: regs[base + 4],
      adsr: { adsr1: regs[base + 5], adsr2: regs[base + 6] },
      gain: regs[base + 7],
      envx: regs[base + 8],
      outx: regs[base + 9],
      env,
      hiddenEnv,
      envMode,
      bufLastSamples,
      bufPos,
    });
    // Discard interpPos, brrAddr — agent rarely needs them; available
    // via savestate if they do.
  }

  // CAREFUL: the DSP register file (m.regs) holds the LAST VALUE WRITTEN
  // to each address, not necessarily a useful runtime state. Reading
  // regs[KON] tells you "what KON byte the driver wrote most recently",
  // not "which voices are currently keying on" — the DSP consumes KON
  // every sample and clears its internal new_kon shadow. Same for KOFF.
  // ENDX is special: the DSP auto-clears regs[ENDX] on every write
  // regardless of the data byte.
  //
  // Surface these as `regs4C` / `regs5C` / `regs7C` (raw byte names)
  // rather than `kon` / `koff` / `endx` (state names) so callers don't
  // mistake the byte for a live interpretation. Field names are still
  // memorable (the address IS the canonical DSP register name) but
  // semantically honest about what you're reading.
  //
  // Source: snes9x/src/apu/bapu/dsp/SPC_DSP.h r_* constants; .cpp KON/
  // ENDX special-case write handling at lines 285-291.
  return {
    regs,
    masterVolume: {
      l: regs[0x0C] > 0x7F ? regs[0x0C] - 256 : regs[0x0C],
      r: regs[0x1C] > 0x7F ? regs[0x1C] - 256 : regs[0x1C],
    },
    echoVolume: {
      l: regs[0x2C] > 0x7F ? regs[0x2C] - 256 : regs[0x2C],
      r: regs[0x3C] > 0x7F ? regs[0x3C] - 256 : regs[0x3C],
    },
    flg: regs[0x6C], // bit 6 = mute, bit 7 = reset — direct register, no shadow
    regs4C: regs[0x4C], // last KON write (not "currently keying on" — DSP consumes per sample)
    regs5C: regs[0x5C], // last KOFF write
    regs7C: regs[0x7C], // ENDX register — auto-cleared by DSP on every write
    voices,
  };
}

/**
 * @param {import("./LibretroHost.js").LibretroHost} host
 * @param {string} platform
 */
export function getDspState(host, platform) {
  if (platform !== "snes") return null;
  return decodeSnes9xDSP(host.serializeState());
}
