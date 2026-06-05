// Audio asset & engine tools. Helps agents close the loop on SNES (and
// future platforms') sound work, where the asm + sample-encoding stack
// is intricate enough that without tooling the agent burns hours.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { jsonContent, safeTool } from "../util.js";
import { getAudioStateCore } from "./platform-tools.js";

export function registerAudioTools(server, z, sessionKey) {
  server.tool(
    "pcmToBrr",
    "Encode raw 16-bit signed PCM audio (mono, little-endian) into SNES BRR format. " +
    "BRR is the SNES SPC700's only sample format — every sound effect and instrument " +
    "on the system goes through it. Output is a Uint8Array of 9-byte BRR blocks ready " +
    "to be uploaded into ARAM by your SPC driver. Pair this with the 'minimal-spc' or " +
    "'snesmod' audio engines from getAudioEngine to actually hear the sound. " +
    "Input: pass `pcmBase64` (raw s16le bytes), OR `pcmPath` (.pcm/.raw file on disk). " +
    "If your source audio is a .wav, first strip the WAV header — every byte after the " +
    "'data' chunk's 8-byte preamble is raw PCM. Output: `brrPath` (server writes a .brr) " +
    "or `brrBase64` (inline). Pass `outputPath` to control where the .brr lands.",
    {
      pcmBase64: z.string().optional().describe("Base64-encoded raw 16-bit signed PCM (mono, little-endian)."),
      pcmPath: z.string().optional().describe("Absolute path to a raw PCM file on disk. Preferred over pcmBase64."),
      outputPath: z.string().optional().describe("If given, write the .brr to this absolute path and return path-only."),
      loop: z.boolean().default(false).describe("If true, set the LOOP bit on the final block so the sample repeats. For one-shot SFX leave false; for sustained tones / drones / instruments set true."),
    },
    safeTool(async ({ pcmBase64, pcmPath, outputPath, loop }) => {
      const { pcmToBrr } = await import("../../platforms/snes/brr.js");
      let pcmBytes;
      if (pcmPath) {
        pcmBytes = await readFile(pcmPath);
      } else if (pcmBase64) {
        pcmBytes = Buffer.from(pcmBase64, "base64");
      } else {
        throw new Error("pcmToBrr: pass either pcmBase64 or pcmPath");
      }
      const { brr, blocks, samples } = pcmToBrr(pcmBytes, { loop });
      const meta = {
        brrBytes: brr.length,
        blocks,
        samples,
        durationSeconds: samples / 32000,  // SPC700 native sample rate is 32 kHz
        note: "BRR encoded with filter 0 (no prediction) and dynamic per-block shift. Upload starting at any 9-byte-aligned ARAM offset, then point your SPC driver's DSP voice at it.",
      };
      if (outputPath) {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, brr);
        return jsonContent({ ...meta, brrPath: outputPath });
      }
      return jsonContent({ ...meta, brrBase64: Buffer.from(brr).toString("base64") });
    }),
  );

  // (no getAudioEngine — driver design is part of the work, not part of the
  // toolchain. Authors write their own SPC stub + 65816 IPL upload to fit
  // their game's needs.)

  server.tool(
    "wavToXgm2Pcm",
    "Convert an external WAV (or raw s16le PCM) clip into a GENESIS XGM2 PCM sample — the exact format SGDK's " +
    "XGM2 driver plays with XGM2_playPCM/XGM2_playPCMEx. Bakes in the fiddly rules so you don't botch them: " +
    "8-bit SIGNED mono, resampled to 13.3 kHz (or 6.65 kHz with halfRate:true), length zero-padded to a multiple " +
    "of 256 bytes. " +
    "By default it also emits a ready-to-#include C array (`__attribute__((aligned(256)))` — the buffer MUST be " +
    "256-byte aligned in ROM) plus a `<NAME>_LEN` define, so you just #include it and call " +
    "`XGM2_playPCM(name, NAME_LEN, SOUND_PCM_CH1)`. " +
    "Input: `wavPath` (a .wav on disk — preferred) or `wavBase64`; for headerless audio pass `format:'pcm16'` + " +
    "`pcmRate`. Output: pass `outputCPath` to write a .c file (returns the path), or get `cSource` inline; the raw " +
    "`pcmBase64`/`pcmPath` (just the bytes) is also available if you'd rather bintos it yourself.",
    {
      wavPath: z.string().optional().describe("Absolute path to a .wav file (preferred — server reads it, no base64 cost)."),
      wavBase64: z.string().optional().describe("Base64-encoded WAV bytes (use wavPath when on disk)."),
      name: z.string().default("pcm_sample").describe("C identifier for the emitted array (e.g. 'sfx_jump'). The length define is <NAME>_LEN."),
      halfRate: z.boolean().default(false).describe("Encode for 6.65 kHz (XGM2_playPCMEx halfRate=TRUE) instead of the 13.3 kHz native rate. Halves ROM size at lower fidelity."),
      format: z.enum(["wav", "pcm16"]).default("wav").describe("'wav' (default) parses the RIFF header. 'pcm16' = raw 16-bit signed LE mono — then pass pcmRate."),
      pcmRate: z.number().int().min(1).optional().describe("Source sample rate (Hz) — REQUIRED for format:'pcm16' so it can resample to the XGM2 rate."),
      outputCPath: z.string().optional().describe("Write the C source (array + LEN define) to this absolute path and return path-only."),
      outputPcmPath: z.string().optional().describe("Also/instead write the raw padded PCM bytes (.pcm) here."),
    },
    safeTool(async ({ wavPath, wavBase64, name, halfRate, format, pcmRate, outputCPath, outputPcmPath }) => {
      const { wavToXgm2Pcm, emitXgm2PcmC } = await import("../../platforms/genesis/xgm2-pcm.js");
      let inputBytes;
      if (wavPath) inputBytes = await readFile(wavPath);
      else if (wavBase64) inputBytes = Buffer.from(wavBase64, "base64");
      else throw new Error("wavToXgm2Pcm: pass wavPath (preferred) or wavBase64.");

      const r = wavToXgm2Pcm(inputBytes, { halfRate, format, pcmRate });
      const cSource = emitXgm2PcmC(r.pcm, name, r.rate);
      const meta = {
        platform: "genesis",
        name,
        rate: r.rate,
        sourceRate: r.sourceRate,
        sampleCount: r.sampleCount,
        paddedBytes: r.paddedBytes,
        durationSeconds: Math.round(r.durationSeconds * 1000) / 1000,
        lenDefine: `${name.toUpperCase()}_LEN`,
        note: `8-bit signed mono @ ${r.rate} Hz, padded to ${r.paddedBytes} B (256-aligned). ` +
          `#include the C, then XGM2_playPCM(${name}, ${name.toUpperCase()}_LEN, SOUND_PCM_CH1)` +
          (halfRate ? " — encoded HALF-RATE, play with XGM2_playPCMEx(..., /*halfRate*/TRUE, ...)." : "."),
      };
      const out = { ...meta };
      if (outputCPath) {
        await mkdir(path.dirname(outputCPath), { recursive: true });
        await writeFile(outputCPath, cSource);
        out.cPath = outputCPath;
      } else {
        out.cSource = cSource;
      }
      if (outputPcmPath) {
        await mkdir(path.dirname(outputPcmPath), { recursive: true });
        await writeFile(outputPcmPath, Buffer.from(r.pcm));
        out.pcmPath = outputPcmPath;
      } else if (outputCPath) {
        // C went to disk; also offer the raw bytes inline (small after padding).
        out.pcmBase64 = Buffer.from(r.pcm).toString("base64");
      }
      return jsonContent(out);
    }),
  );

  const inputShape = z.object({
    up: z.boolean().optional(), down: z.boolean().optional(),
    left: z.boolean().optional(), right: z.boolean().optional(),
    a: z.boolean().optional(), b: z.boolean().optional(),
    x: z.boolean().optional(), y: z.boolean().optional(),
    l: z.boolean().optional(), r: z.boolean().optional(),
    start: z.boolean().optional(), select: z.boolean().optional(),
  });

  server.tool(
    "audioDebug",
    "Debug sound / transcribe music on the running ROM. `op`: 'inspect' | 'record'.\n" +
    "'inspect': decode a sound CHIP's live per-channel state — frame-accurate, no driver RE. `chip`: 'nes' (2A03: " +
    "pulse1/2/triangle/noise/dmc, timer→note/duty/vol/playing), 'gb'/'gba' (DMG APU; GBA + 2 DMA FIFO), 'dsp' " +
    "(SNES S-DSP per-voice vol/pitch/adsr + `env` 0=silent + `bufLastSamples` proves audio + `flg`), 'psg' " +
    "(Genesis/SMS SN76489), 'ym2612' (Genesis FM raw-blob for diffing), 'sid' (C64), 'mikey' (Lynx), 'pce' (PCE " +
    "PSG 6ch), 'ay8910' (MSX). All 14 systems. **GOTCHA: S-DSP FLG is $6C, KOFF is $5C (many refs swap them); " +
    "power-on FLG=$E0 → your driver MUST clear bit 6.** To ASSERT, use this; pair with watch(region:'nes_apu_regs').\n" +
    "'record': capture audio to a WAV over `frames` frames (`setInputs` to hold a button, e.g. 'press B for SFX'). " +
    "Sample rate is whatever the core emits (32000 SNES SPC / 48000 most / 44100). **A WAV is for a HUMAN to HEAR — " +
    "an agent can't listen; use op:'inspect' to assert.** Caveat: inspect doesn't expose Genesis XGM2 PCM, so " +
    "'did this sampled SFX fire' on Genesis is still record-and-listen.",
    {
      op: z.enum(["inspect", "record"]).describe("inspect a sound chip's live state; or record audio to a WAV."),
      chip: z.enum(["nes", "gb", "gba", "dsp", "psg", "ym2612", "sid", "mikey", "pce", "ay8910"]).optional().describe("op=inspect: which sound chip to decode (all 14 systems mapped)."),
      frames: z.number().int().min(1).max(60000).default(180).describe("op=record: emulator frames to capture (60 = 1s NTSC)."),
      path: z.string().optional().describe("op=record: absolute path to write the WAV file to."),
      setInputs: z.array(inputShape).max(2).optional().describe("op=record: input state to hold during the recording (e.g. press B to fire SFX)."),
    },
    safeTool(async (args) => {
      if (args.op === "inspect") {
        if (!args.chip) throw new Error("audioDebug({op:'inspect'}): `chip` is required.");
        return await getAudioStateCore(args);
      }
      if (args.op !== "record") throw new Error(`audioDebug: unknown op '${args.op}'`);
      if (!args.path) throw new Error("audioDebug({op:'record'}): `path` is required.");
      const { frames, path: outPath, setInputs } = args;
      const { getHost } = await import("../state.js");
      const host = getHost(sessionKey);
      if (!host.status.platform) {
        throw new Error("recordAudio: no media loaded — call loadMedia first.");
      }

      // Clear any previously-buffered audio so the recording starts from now.
      host.state.audioRing.length = 0;

      if (setInputs && setInputs.length > 0) {
        host.setInput({ ports: setInputs });
      }
      host.stepFrames(frames);
      if (setInputs && setInputs.length > 0) {
        host.setInput({ ports: [{}, {}] });
      }

      // Concatenate the audio ring into one Int16Array (interleaved stereo).
      let total = 0;
      for (const buf of host.state.audioRing) total += buf.length;
      const samples = new Int16Array(total);
      let off = 0;
      for (const buf of host.state.audioRing) {
        samples.set(buf, off);
        off += buf.length;
      }
      host.state.audioRing.length = 0;

      const sampleRate = host.status.audioSampleRate ?? 48000;
      const wav = encodeWav(samples, sampleRate);
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, wav);

      // RMS energy gives a quick "is anything actually playing?" check
      // — silence will be 0, even quiet SFX should be >> 0.
      let sumSq = 0;
      for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
      const rms = samples.length ? Math.sqrt(sumSq / samples.length) : 0;
      const peak = samples.reduce((p, s) => Math.max(p, Math.abs(s)), 0);

      return jsonContent({
        path: outPath,
        bytes: wav.length,
        sampleRate,
        channels: 2,
        durationSeconds: samples.length / 2 / sampleRate,
        sampleCount: samples.length / 2,
        rms: Math.round(rms),
        peak,
        silent: peak === 0,
        note: peak === 0
          ? "RECORDED SILENCE. The emulator emitted no audio during this window. Likely your sound code isn't running, or the core's audio callback isn't wired up for this ROM."
          : `Audio captured. Peak amplitude ${peak}/32767, RMS ${Math.round(rms)}. Listen to the WAV to confirm content.`,
      });
    }),
  );
}

/**
 * Encode interleaved 16-bit signed stereo PCM as a WAV file (RIFF/WAVE).
 * @param {Int16Array} samples interleaved stereo (L R L R ...)
 * @param {number} sampleRate
 * @returns {Buffer}
 */
function encodeWav(samples, sampleRate) {
  const numChannels = 2;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * 2;
  const fileSize = 44 + dataSize;

  const buf = Buffer.alloc(fileSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(fileSize - 8, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);                  // fmt chunk size
  buf.writeUInt16LE(1, 20);                   // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  // Sample data
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buf;
}