// Genesis XGM2 PCM encoder — turn an external WAV/PCM clip into the exact
// sample format SGDK's XGM2 driver plays with XGM2_playPCM/XGM2_playPCMEx.
//
// The format rules (from SGDK include/snd/xgm2.h) are fiddly and only
// discoverable by grepping the header — this tool bakes them in so an agent
// doesn't botch sign/rate/alignment/padding:
//   - 8-bit SIGNED mono PCM
//   - 13.3 kHz native (XGM2 driver rate) — or 6.65 kHz for half-rate playback
//   - length padded to a multiple of 256 bytes (with 0x00 = silence)
//   - the sample buffer must be 256-byte ALIGNED in ROM (emit
//     __attribute__((aligned(256))) on the array)
//
// Pure JS: a small WAV parser + linear resampler + signed-8 quantizer. No
// ffmpeg / external codec needed.

const XGM2_RATE = 13300;       // native XGM2 PCM playback rate (Hz)
const XGM2_RATE_HALF = 6650;   // XGM2_playPCMEx halfRate=TRUE

/**
 * Parse a RIFF/WAVE buffer into float32 mono samples + its sample rate.
 * Supports PCM 8/16/24/32-bit and IEEE float32; downmixes multi-channel to mono.
 * @param {Uint8Array|Buffer} buf
 * @returns {{ samples: Float32Array, sampleRate: number, channels: number, bits: number }}
 */
export function parseWav(buf) {
  const u = Buffer.from(buf);
  if (u.length < 44 || u.toString("ascii", 0, 4) !== "RIFF" || u.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file (bad header). Pass a .wav, or use pcmBase64/pcmPath with raw s16le mono.");
  }
  let off = 12;
  let fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= u.length) {
    const id = u.toString("ascii", off, off + 4);
    const sz = u.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: u.readUInt16LE(body),
        channels: u.readUInt16LE(body + 2),
        sampleRate: u.readUInt32LE(body + 4),
        bits: u.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataOff = body;
      dataLen = Math.min(sz, u.length - body);
    }
    off = body + sz + (sz & 1); // chunks are word-aligned
  }
  if (!fmt) throw new Error("WAV missing 'fmt ' chunk");
  if (dataOff < 0) throw new Error("WAV missing 'data' chunk");

  const { channels, bits, sampleRate, audioFormat } = fmt;
  const isFloat = audioFormat === 3;
  const bytesPerSample = bits >> 3;
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(dataLen / frameBytes);
  const out = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = dataOff + i * frameBytes + c * bytesPerSample;
      let v;
      if (isFloat && bits === 32) v = u.readFloatLE(p);
      else if (bits === 8) v = (u.readUInt8(p) - 128) / 128;        // WAV 8-bit is UNSIGNED
      else if (bits === 16) v = u.readInt16LE(p) / 32768;
      else if (bits === 24) { const x = u.readIntLE(p, 3); v = x / 8388608; }
      else if (bits === 32) v = u.readInt32LE(p) / 2147483648;
      else throw new Error(`unsupported WAV bit depth ${bits}`);
      acc += v;
    }
    out[i] = acc / channels; // downmix to mono
  }
  return { samples: out, sampleRate, channels, bits };
}

/** Linear-resample float samples from srcRate to dstRate. */
export function resampleLinear(samples, srcRate, dstRate) {
  if (srcRate === dstRate) return samples;
  const ratio = dstRate / srcRate;
  const n = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = srcPos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/**
 * Encode a WAV/PCM buffer into XGM2 PCM bytes (8-bit signed mono, target rate,
 * length padded to a 256-byte multiple).
 * @param {Uint8Array|Buffer} input
 * @param {object} [opts]
 * @param {boolean} [opts.halfRate] target 6.65 kHz instead of 13.3 kHz
 * @param {'wav'|'pcm16'} [opts.format] input format (default 'wav'). 'pcm16' = raw s16le mono.
 * @param {number} [opts.pcmRate] sample rate for raw pcm16 input (required for resample)
 * @returns {{ pcm: Uint8Array, sampleCount: number, paddedBytes: number, rate: number, durationSeconds: number, sourceRate: number }}
 */
export function wavToXgm2Pcm(input, opts = {}) {
  const targetRate = opts.halfRate ? XGM2_RATE_HALF : XGM2_RATE;
  let floatSamples, sourceRate;
  if (opts.format === "pcm16") {
    const u = Buffer.from(input);
    const n = u.length >> 1;
    floatSamples = new Float32Array(n);
    for (let i = 0; i < n; i++) floatSamples[i] = u.readInt16LE(i * 2) / 32768;
    sourceRate = opts.pcmRate || 0;
    if (!sourceRate) throw new Error("wavToXgm2Pcm: raw pcm16 input needs `pcmRate` (the source sample rate in Hz) to resample to the XGM2 rate.");
  } else {
    const parsed = parseWav(input);
    floatSamples = parsed.samples;
    sourceRate = parsed.sampleRate;
  }

  const resampled = resampleLinear(floatSamples, sourceRate, targetRate);

  // Quantize to 8-bit SIGNED, clamped to [-128, 127].
  const signed = new Int8Array(resampled.length);
  for (let i = 0; i < resampled.length; i++) {
    let v = Math.round(resampled[i] * 127);
    if (v > 127) v = 127; else if (v < -128) v = -128;
    signed[i] = v;
  }

  // Pad to a multiple of 256 bytes with 0x00 (silence in signed PCM).
  const paddedLen = Math.ceil(signed.length / 256) * 256 || 256;
  const pcm = new Uint8Array(paddedLen); // zero-filled
  pcm.set(new Uint8Array(signed.buffer, signed.byteOffset, signed.length));

  return {
    pcm,
    sampleCount: signed.length,
    paddedBytes: paddedLen,
    rate: targetRate,
    sourceRate,
    durationSeconds: signed.length / targetRate,
  };
}

/**
 * Emit a C source string declaring the sample as a 256-byte-aligned array plus
 * a length #define, ready to #include and play with XGM2_playPCM/Ex.
 * @param {Uint8Array} pcm
 * @param {string} name C identifier (e.g. "sfx_jump")
 * @param {number} rate target rate (for a comment)
 * @returns {string}
 */
export function emitXgm2PcmC(pcm, name, rate) {
  const lines = [];
  lines.push(`// XGM2 PCM sample — 8-bit signed mono, ${rate} Hz, ${pcm.length} bytes (256-aligned).`);
  lines.push(`// Play: XGM2_playPCM(${name}, ${name.toUpperCase()}_LEN, SOUND_PCM_CH1);`);
  lines.push(`// (use XGM2_playPCMEx(..., TRUE, ...) if this was encoded at half-rate.)`);
  lines.push(`#define ${name.toUpperCase()}_LEN ${pcm.length}`);
  lines.push(`const u8 ${name}[${pcm.length}] __attribute__((aligned(256))) = {`);
  for (let i = 0; i < pcm.length; i += 16) {
    const row = Array.from(pcm.subarray(i, i + 16), (b) => "0x" + b.toString(16).padStart(2, "0")).join(", ");
    lines.push("  " + row + ",");
  }
  lines.push("};");
  return lines.join("\n") + "\n";
}
