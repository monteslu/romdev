// Audio asset & engine tools. Helps agents close the loop on SNES (and
// future platforms') sound work, where the asm + sample-encoding stack
// is intricate enough that without tooling the agent burns hours.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { jsonContent, safeTool } from "../util.js";
import { getAudioStateCore } from "./platform-tools.js";

export function registerAudioTools(server, z, sessionKey) {
  // encodeAudio({target:'brr'}) — raw PCM → SNES BRR.
  async function encBrr({ pcmBase64, pcmPath, outputPath, loop = false }) {
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
  }

  // encodeAudio({target:'xgm2pcm'}) — WAV/PCM → Genesis XGM2 PCM sample.
  async function encXgm({ wavPath, wavBase64, name = "pcm_sample", halfRate = false, format = "wav", pcmRate, outputCPath, outputPcmPath }) {
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
  }

  // encodeAudio({target:'xgm2'}) — VGM music → compiled GENESIS XGM2 blob (SGDK XGM2_play).
  async function encXgm2Music({ vgmPath, vgmBase64, name = "music", system = null, packed = true, outputCPath, outputBinPath }) {
      const { vgmToXgm2C } = await import("romdev-xgm2");
      let vgmBytes;
      if (vgmPath) vgmBytes = await readFile(vgmPath);
      else if (vgmBase64) vgmBytes = Buffer.from(vgmBase64, "base64");
      else throw new Error("encodeAudio({target:'xgm2'}): pass `vgmPath` (a .vgm/.vgz on disk) or `vgmBase64`.");

      let result;
      try {
        result = vgmToXgm2C(vgmBytes, name, { packed, system });
      } catch (e) {
        throw new Error(`encodeAudio({target:'xgm2'}): VGM→XGM2 conversion failed: ${e.message}. Confirm the input is a valid Mega Drive .vgm (SN76489 PSG and/or YM2612 FM).`);
      }
      const { blob, cSource, lenDefine } = result;

      const out = {
        platform: "genesis",
        name,
        xgm2Bytes: blob.length,
        lenDefine,
        note: `Compiled XGM2 music (${blob.length} B, 256-aligned). #include the C, then XGM2_play(${name}). ` +
          `(PSG-only tracks coexist with XGM2 PCM SFX from encodeAudio({target:'xgm2pcm'}).)`,
      };
      if (outputCPath) {
        await mkdir(path.dirname(outputCPath), { recursive: true });
        await writeFile(outputCPath, cSource);
        out.cPath = outputCPath;
      } else {
        out.cSource = cSource;
      }
      if (outputBinPath) {
        await mkdir(path.dirname(outputBinPath), { recursive: true });
        await writeFile(outputBinPath, Buffer.from(blob));
        out.binPath = outputBinPath;
      }
      return jsonContent(out);
  }

  // encodeAudio({target:'maxmod'}) — tracker module (.xm/.mod/.it/.s3m) → GBA Maxmod soundbank.
  async function encMaxmod({ modulePath, moduleBase64, name = "soundbank", outputBinPath, outputHeaderPath }) {
      const { soundbankFromModule, detectModuleFormat } = await import("romdev-maxmod");
      let modBytes;
      if (modulePath) modBytes = new Uint8Array(await readFile(modulePath));
      else if (moduleBase64) modBytes = new Uint8Array(Buffer.from(moduleBase64, "base64"));
      else throw new Error("encodeAudio({target:'maxmod'}): pass `modulePath` (.xm/.mod/.it/.s3m) or `moduleBase64`.");
      const fmt = detectModuleFormat(modBytes);
      if (!fmt) throw new Error("encodeAudio({target:'maxmod'}): unrecognized module — expected a .xm/.mod/.it/.s3m tracker module.");
      let bin, header;
      try {
        ({ bin, header } = soundbankFromModule(modBytes, { name }));
      } catch (e) {
        throw new Error(`encodeAudio({target:'maxmod'}): conversion failed: ${e.message}. Confirm the input is a valid ${fmt.toUpperCase()} module.`);
      }
      const out = {
        platform: "gba",
        format: fmt,
        name,
        soundbankBytes: bin.length,
        header,
        note: `Maxmod soundbank (${bin.length} B) — byte-identical to mmutil. Link the .bin as your soundbank, mmInitDefault() it, then mmStart(MOD_${name.toUpperCase()}, MM_PLAY_LOOP). The .h #defines (MOD_${name.toUpperCase()}, MSL_*) are in \`header\`.`,
      };
      if (outputBinPath) {
        await mkdir(path.dirname(outputBinPath), { recursive: true });
        await writeFile(outputBinPath, Buffer.from(bin));
        out.binPath = outputBinPath;
      } else {
        out.soundbankBase64 = Buffer.from(bin).toString("base64");
      }
      if (outputHeaderPath) {
        await mkdir(path.dirname(outputHeaderPath), { recursive: true });
        await writeFile(outputHeaderPath, header);
        out.headerPath = outputHeaderPath;
      }
      return jsonContent(out);
  }

  // encodeAudio({target:'famitone'}) — FamiTracker .txt export → NES FamiTone2 ca65 data.
  async function encFamitone({ txtPath, txt, name = "music", outputAsmPath, noWarnings = false, keepInstruments = false }) {
      const { emitFamiTone2, isFamiTrackerTextExport } = await import("romdev-famitone");
      let source = txt;
      if (!source && txtPath) source = await readFile(txtPath, "utf8");
      if (!source) throw new Error("encodeAudio({target:'famitone'}): pass `txtPath` (a FamiTracker text export) or `txt`.");
      if (!isFamiTrackerTextExport(source)) {
        throw new Error("encodeAudio({target:'famitone'}): input is not a FamiTracker text export (File→Export Text in FamiTracker/Dn-FamiTracker). Got something else.");
      }
      let asm;
      try {
        asm = emitFamiTone2(source, { name, noWarnings, keepInstruments });
      } catch (e) {
        throw new Error(`encodeAudio({target:'famitone'}): conversion failed: ${e.message}. ` +
          `If it's an "Unsupported effect", FamiTone2 only supports a subset (no sweep, limited fx) — pass noWarnings:true to skip unsupported effects, or remove them in FamiTracker.`);
      }
      const out = {
        platform: "nes",
        name,
        note: `FamiTone2 ca65 data for '${name}'. Assemble alongside the bundled famitone2.s driver; FamiToneInit(${name}_music_data) then FamiToneMusicPlay(songIndex). (text2data -ca65 compatible.)`,
      };
      if (outputAsmPath) {
        await mkdir(path.dirname(outputAsmPath), { recursive: true });
        await writeFile(outputAsmPath, asm);
        out.asmPath = outputAsmPath;
      } else {
        out.asmSource = asm;
      }
      return jsonContent(out);
  }

  // encodeAudio({target:'spc'}) — a note/duration song → the SNES apu_blob row table.
  async function encSpcSong({ song, base = "C4", baseP = 0x1000, defaultTicks = 16, outputAsmPath, outputBinPath }) {
      const { compileSong } = await import("../../platforms/snes/song.js");
      if (!song) throw new Error("encodeAudio({target:'spc'}): pass `song` — { rows:[ {note,ticks} | \"C4:16\" ... ] }.");
      const spec = typeof song === "string" ? JSON.parse(song) : song;
      // allow base/baseP/defaultTicks either on the song or as top-level args
      const merged = { base, baseP, defaultTicks, ...spec };
      let result;
      try {
        result = compileSong(merged);
      } catch (e) {
        throw new Error(`encodeAudio({target:'spc'}): ${e.message}`);
      }
      const { bytes, rows, asm } = result;
      const out = {
        platform: "snes",
        rows,
        tableBytes: bytes.length,
        note: `SNES song table (${rows} rows, ${bytes.length} B) for the apu_blob driver's voice-1 music engine. ` +
          `Paste the \`asm\` at the 'song:' label in lib/audio/apu_blob.asm and rebuild apu_blob.bin (scripts/build-apu-blob.js), ` +
          `or write the raw bytes into ARAM \$5000. Each row = [ticks, DSP-pitch-lo, DSP-pitch-hi]; \$00 loops. ` +
          `Single voice, re-triggers the loaded BRR sample at each note's pitch (P = baseP * 2^(semitones/12)).`,
      };
      if (outputAsmPath) {
        await mkdir(path.dirname(outputAsmPath), { recursive: true });
        await writeFile(outputAsmPath, asm);
        out.asmPath = outputAsmPath;
      } else {
        out.asmSource = asm;
      }
      if (outputBinPath) {
        await mkdir(path.dirname(outputBinPath), { recursive: true });
        await writeFile(outputBinPath, Buffer.from(bytes));
        out.binPath = outputBinPath;
      } else {
        out.tableBase64 = Buffer.from(bytes).toString("base64");
      }
      return jsonContent(out);
  }

  // encodeAudio({target: gg|sms|c64|lynx|atari7800}) — a note/duration song → that
  // platform's bundled-driver note table. Each platforms/<p>/song.js exports
  // compileSong() returning { bytes, cSource, rows } in the driver's exact format.
  const SYNTH_SONG = {
    gg:        { mod: "../../platforms/gg/song.js",        platform: "gg",        chip: "SN76489 PSG", paste: "the songN[] arrays in gg_music.c" },
    sms:       { mod: "../../platforms/sms/song.js",       platform: "sms",       chip: "SN76489 PSG", paste: "the mel*_freq/mel*_len arrays in sms_music.c (+ set track_len)" },
    c64:       { mod: "../../platforms/c64/song.js",       platform: "c64",       chip: "SID",         paste: "the melody/bass/harmony[] Note arrays in c64_music.c" },
    lynx:      { mod: "../../platforms/lynx/song.js",      platform: "lynx",      chip: "Mikey",       paste: "the song byte stream lynx_music.c feeds lynx_snd_play()" },
    atari7800: { mod: "../../platforms/atari7800/song.js", platform: "atari7800", chip: "TIA",         paste: "the voice table(s) in atari7800_music.c" },
    gb:        { mod: "../../platforms/gb/song.js",        platform: "gb",        chip: "GB APU (hUGEDriver)",  paste: "the huge_song_t + pattern arrays in song_data.c" },
    gbc:       { mod: "../../platforms/gbc/song.js",       platform: "gbc",       chip: "GB APU (hUGEDriver)",  paste: "the huge_song_t + pattern arrays in song_data.c" },
  };
  async function encSynthSong(target, { song, base, baseP, defaultTicks, name, outputBinPath, outputCPath }) {
      const info = SYNTH_SONG[target];
      const { compileSong } = await import(info.mod);
      if (!song) throw new Error(`encodeAudio({target:'${target}'}): pass \`song\` — { rows:[ {note,...} | "C4:16" ... ] }.`);
      const spec = typeof song === "string" ? JSON.parse(song) : song;
      const merged = { ...(base !== undefined ? { base } : {}), ...(baseP !== undefined ? { baseP } : {}),
        ...(defaultTicks !== undefined ? { defaultTicks } : {}), ...(name ? { name } : {}), ...spec };
      let r;
      try { r = compileSong(merged); }
      catch (e) { throw new Error(`encodeAudio({target:'${target}'}): ${e.message}`); }
      const cSource = r.cSource ?? r.asm ?? "";
      const out = {
        platform: info.platform,
        chip: info.chip,
        rows: r.rows,
        tableBytes: r.bytes ? r.bytes.length : undefined,
        note: `${info.platform.toUpperCase()} song (${r.rows} rows) for the bundled ${info.chip} driver. Paste \`cSource\` over ${info.paste}, or write the raw \`tableBytes\` into the driver's table.` +
          (r.snapped ? ` (TIA has only 32 pitches — some notes snapped to the nearest; see the C comments.)` : ``),
      };
      if (outputCPath) {
        await mkdir(path.dirname(outputCPath), { recursive: true });
        await writeFile(outputCPath, cSource);
        out.cPath = outputCPath;
      } else {
        out.cSource = cSource;
      }
      if (r.bytes) {
        if (outputBinPath) {
          await mkdir(path.dirname(outputBinPath), { recursive: true });
          await writeFile(outputBinPath, Buffer.from(r.bytes));
          out.binPath = outputBinPath;
        } else {
          out.tableBase64 = Buffer.from(r.bytes).toString("base64");
        }
      }
      return jsonContent(out);
  }

  server.tool(
    "encodeAudio",
    "Encode an external audio clip into a platform's native sample/music format, keyed by `target`.\n" +
    "• target:'brr' — raw 16-bit signed PCM (mono, LE) → SNES BRR (the SPC700's only sample format; 9-byte blocks ready to DMA into ARAM). Input `pcmBase64` or `pcmPath` (.pcm/.raw; strip the WAV header first if your source is .wav). `loop` sets the LOOP bit. Output `brrPath` (via `outputPath`) or `brrBase64`.\n" +
    "• target:'xgm2pcm' — WAV (or raw s16le PCM) → GENESIS XGM2 PCM SAMPLE (SGDK's XGM2_playPCM, for SFX). Bakes the fiddly rules: 8-bit SIGNED mono, resampled to 13.3 kHz (or 6.65 kHz with `halfRate`), zero-padded to a multiple of 256 bytes. Emits a ready-to-#include 256-byte-aligned C array + `<NAME>_LEN` define by default. Input `wavPath`/`wavBase64` (or `format:'pcm16'` + `pcmRate` for headerless). Output `outputCPath` (.c) / `cSource` inline / `outputPcmPath` (raw .pcm).\n" +
    "• target:'xgm2' — **GENESIS MUSIC: a `.vgm`/`.vgz` log → a COMPILED XGM2 blob you `XGM2_play()`.** This is the music sibling of xgm2pcm (which is sample SFX). `XGM2_play()` needs a compiled blob (split FM/PSG streams + sample table), NOT raw VGM — this does that compile (a pure-JS port of SGDK's `xgm2tool`; no Java). Emits a 256-aligned C array + `<NAME>_LEN`. PSG-only tracks coexist with XGM2 PCM SFX. Input `vgmPath` (.vgm/.vgz) or `vgmBase64`; `system` forces NTSC/PAL timing.\n" +
    "• target:'maxmod' — **GBA MUSIC: a tracker module (`.xm`/`.mod`/`.it`/`.s3m`) → a Maxmod SOUNDBANK** (.bin + .h). Pure-JS port of devkitPro `mmutil`, BYTE-IDENTICAL to it. Link the .bin as your soundbank, `mmInitDefault()`, then `mmStart(MOD_<NAME>, MM_PLAY_LOOP)`. Input `modulePath` or `moduleBase64`; output `outputBinPath` (+ `outputHeaderPath` for the .h) or inline base64 + `header`.\n" +
    "• target:'famitone' — **NES MUSIC: a FamiTracker text export (`.txt`) → FamiTone2 ca65 data.** Pure-JS port of `text2data` (text2data -ca65 compatible). Assemble with the bundled famitone2.s driver; `FamiToneInit(<name>_music_data)` then `FamiToneMusicPlay(song)`. Input `txtPath` or `txt` (the File→Export Text output from FamiTracker/Dn-FamiTracker); output `outputAsmPath` or inline `asmSource`.\n" +
    "• target:'spc' — **SNES MUSIC: a simple note/duration `song` → the bundled apu_blob driver's row table.** Single voice; each note re-triggers the loaded BRR sample at its pitch (P = baseP·2^(semitones/12)). `song` = `{ rows:[ {note:\"C4\", ticks:16} | \"C4:16\" | {p:0x0400, ticks:16} ] }` with `base` (note the sample sounds at `baseP`, default C4) + `baseP` (default 0x1000). Output `outputAsmPath` (paste at the apu_blob.asm `song:` label, rebuild apu_blob.bin) or raw `tableBase64`/`outputBinPath` for ARAM $5000.\n" +
    "• target:'gg'|'sms'|'c64'|'lynx'|'atari7800'|'gb'|'gbc' — **synth-chip MUSIC: a note/duration `song` → that platform's bundled-driver note table.** Most take `{ rows:[{note,dur/ticks}|\"C4:16\"] }`; **gb/gbc are MULTI-channel hUGEDriver** so they take `{ ticksPerRow?, channels:[ {rows:[\"C5\",\"-\"(sustain),\".\"(rest)]}, ... ] }` (1-4 channels). Note→native pitch per chip: gg/sms=SN76489 10-bit divider, c64=SID 16-bit freq word (3 voices), lynx=Mikey note index, atari7800=TIA 5-bit AUDF (32 pitches → snapped), gb/gbc=hUGE note index (C3..B8). Emits a drop-in `cSource` (paste over the demo song in <plat>_music.c / song_data.c) + raw `tableBase64`/`outputCPath`/`outputBinPath`. **These chips SYNTHESIZE — they play notes, not your recording; for arbitrary audio see the MUSIC_SOURCING guide (transcribe first).**",
    {
      target: z.enum(["brr", "xgm2pcm", "xgm2", "maxmod", "famitone", "spc", "gg", "sms", "c64", "lynx", "atari7800", "gb", "gbc"]).describe("SAMPLE: brr=SNES BRR; xgm2pcm=Genesis PCM SFX. MUSIC: xgm2=Genesis (VGM); maxmod=GBA (tracker module); famitone=NES (FamiTracker txt); spc=SNES note-song; gg/sms/c64/lynx/atari7800/gb/gbc=synth note-song → that driver's table."),
      // brr
      pcmBase64: z.string().optional().describe("target:'brr' — base64 raw 16-bit signed PCM (mono, LE)."),
      pcmPath: z.string().optional().describe("target:'brr' — absolute path to a raw PCM file (preferred over pcmBase64)."),
      loop: z.boolean().default(false).describe("target:'brr' — set the LOOP bit on the final block (sustained tones/instruments)."),
      // xgm2pcm
      wavPath: z.string().optional().describe("target:'xgm2pcm' — absolute path to a .wav (or raw s16le if format:'pcm16'); preferred over wavBase64."),
      wavBase64: z.string().optional().describe("target:'xgm2pcm' — base64 WAV (or raw s16le) bytes."),
      name: z.string().default("pcm_sample").describe("xgm2pcm/xgm2/maxmod/famitone/gg/sms/c64/lynx/atari7800/gb/gbc — C/asm identifier for the emitted data (xgm2pcm define <NAME>_LEN; maxmod → MOD_<NAME>; famitone → <NAME>_music_data). NOT used by target:'spc'."),
      halfRate: z.boolean().default(false).describe("target:'xgm2pcm' — encode for 6.65 kHz (XGM2_playPCMEx halfRate=TRUE); halves ROM size."),
      format: z.enum(["wav", "pcm16"]).default("wav").describe("target:'xgm2pcm' — 'wav' (parse RIFF) or 'pcm16' (raw s16le mono; then pass pcmRate)."),
      pcmRate: z.number().int().min(1).optional().describe("target:'xgm2pcm' — source sample rate (Hz), REQUIRED for format:'pcm16'."),
      outputCPath: z.string().optional().describe("xgm2pcm/xgm2/gg/sms/c64/lynx/atari7800/gb/gbc — write the C source here and return path-only (else cSource is inline)."),
      outputPcmPath: z.string().optional().describe("target:'xgm2pcm' — also/instead write the raw padded PCM bytes here."),
      // xgm2 (music)
      vgmPath: z.string().optional().describe("target:'xgm2' — absolute path to a .vgm or gzipped .vgz Mega Drive music log."),
      vgmBase64: z.string().optional().describe("target:'xgm2' — base64 .vgm/.vgz bytes."),
      system: z.enum(["ntsc", "pal"]).optional().describe("target:'xgm2' — force the timing flag (VGM offset 0x24): ntsc=60, pal=50. Omit to keep the VGM's own value."),
      outputBinPath: z.string().optional().describe("xgm2 — write the raw XGM2 blob (.xgc) here. maxmod — the soundbank .bin. spc/gg/sms/c64/lynx/atari7800/gb/gbc — the raw note-table bytes."),
      // maxmod (GBA music)
      modulePath: z.string().optional().describe("target:'maxmod' — absolute path to a tracker module (.xm/.mod/.it/.s3m)."),
      moduleBase64: z.string().optional().describe("target:'maxmod' — base64 module bytes."),
      outputHeaderPath: z.string().optional().describe("target:'maxmod' — write the soundbank .h (MOD_/MSL_ defines) here."),
      // famitone (NES music)
      txtPath: z.string().optional().describe("target:'famitone' — absolute path to a FamiTracker text export (.txt)."),
      txt: z.string().optional().describe("target:'famitone' — the FamiTracker text export contents inline."),
      outputAsmPath: z.string().optional().describe("famitone — write the ca65 .s music data here. spc — write the apu_blob song-table asm here (paste at the 'song:' label)."),
      noWarnings: z.boolean().default(false).describe("target:'famitone' — skip (instead of erroring on) effects FamiTone2 doesn't support."),
      keepInstruments: z.boolean().default(false).describe("target:'famitone' — don't remove unused instruments (text2data -keep_instruments)."),
      // spc (SNES song)
      song: z.any().optional().describe("spc + all synth targets (gg/sms/c64/lynx/atari7800/gb/gbc) — the song; object or JSON string. spc/single-voice shape: { rows:[ {note:'C4',ticks:16} | 'C4:16' | {p:0x400,ticks:16} ], base?, baseP?, defaultTicks? }. gb/gbc use the multi-channel shape (see tool description)."),
      base: z.union([z.string(), z.number()]).optional().describe("target:'spc' — note ('C4') or absolute semitone the sample sounds at baseP. Default 'C4'."),
      baseP: z.number().int().optional().describe("target:'spc' — DSP pitch P at which the sample plays `base`. Default 0x1000 (sample's native rate)."),
      defaultTicks: z.number().int().optional().describe("target:'spc' — ticks for shorthand rows that omit a duration. Default 16."),
      // shared
      outputPath: z.string().optional().describe("target:'brr' — write the .brr here and return path-only."),
    },
    safeTool(async (args) => {
      switch (args.target) {
        case "brr":      return await encBrr(args);
        case "xgm2pcm":  return await encXgm(args);
        case "xgm2":     return await encXgm2Music(args);
        case "maxmod":   return await encMaxmod(args);
        case "famitone": return await encFamitone(args);
        case "spc":      return await encSpcSong(args);
        case "gg": case "sms": case "c64": case "lynx": case "atari7800": case "gb": case "gbc":
          return await encSynthSong(args.target, args);
        default: throw new Error(`encodeAudio: unknown target '${args.target}'`);
      }
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
    "'inspect': decode a sound CHIP's per-channel state — no driver RE. `chip`: 'nes' (2A03: " +
    "pulse1/2/triangle/noise/dmc, timer→note/duty/vol/playing), 'gb'/'gba' (DMG APU; GBA + 2 DMA FIFO), 'dsp' " +
    "(SNES S-DSP per-voice vol/pitch/adsr + `env` 0=silent + `bufLastSamples` proves audio + `flg`), 'psg' " +
    "(Genesis/SMS SN76489), 'ym2612' (Genesis FM raw-blob for diffing), 'sid' (C64), 'mikey' (Lynx), 'pce' (PCE " +
    "PSG 6ch), 'ay8910' (MSX). All 14 systems. **GOTCHA: S-DSP FLG is $6C, KOFF is $5C (many refs swap them); " +
    "power-on FLG=$E0 → your driver MUST clear bit 6.**\n" +
    "Single-frame by default (a snapshot — can't assert a melody). **Pass `frames:N` to TRACE: it steps N frames, " +
    "samples the chip each frame, and returns a per-channel `timeline` (frequency/attenuation/note over time, " +
    "de-duplicated to transitions) — a headless NOTE-TIMELINE you can assert a tune on without a WAV.** `sampleEvery` " +
    "thins it; `setInputs` holds input during the trace. To ASSERT, use this; pair with watch(region:'nes_apu_regs').\n" +
    "'record': capture audio to a WAV over `frames` frames (`setInputs` to hold a button, e.g. 'press B for SFX'). " +
    "Sample rate is whatever the core emits (32000 SNES SPC / 48000 most / 44100). **A WAV is for a HUMAN to HEAR — " +
    "an agent can't listen; to verify a melody headlessly, prefer op:'inspect' with `frames`, or run a local FFT/" +
    "Goertzel pass on the WAV to pull the pitch contour.** Caveat: inspect can't see Genesis XGM2 PCM, so 'did this " +
    "sampled SFX fire' on Genesis is still record-and-FFT.",
    {
      op: z.enum(["inspect", "record"]).describe("inspect a sound chip's live state (single-frame, or a frames trace); or record audio to a WAV."),
      chip: z.enum(["nes", "gb", "gba", "dsp", "psg", "ym2612", "sid", "mikey", "pce", "ay8910", "spu", "ai", "aica", "acp"]).optional().describe("op=inspect: which sound chip to decode. Tile systems: nes/gb/gba/dsp(SNES)/psg(SN76489)/ym2612(Genesis FM)/sid(C64)/mikey(Lynx)/pce/ay8910(MSX). 3D systems: spu (PS1, 24 ADPCM voices), ai (N64 AI output), aica (Dreamcast, 64 PCM/ADPCM channels)."),
      frames: z.number().int().min(1).max(60000).optional().describe("op=record: emulator frames to capture (default 180 = 3s NTSC). op=inspect: if set, TRACE the chip over N frames into a per-channel timeline; OMIT for a single-frame snapshot."),
      sampleEvery: z.number().int().min(1).default(1).describe("op=inspect trace: sample the chip only every Nth frame (thins a long trace; the last frame is always sampled). Changes on skipped frames surface at the next sampled frame, so >1 loses fine timing — keep at 1 to catch every transition."),
      path: z.string().optional().describe("op=record: absolute path to write the WAV (required for record)."),
      setInputs: z.array(inputShape).max(2).optional().describe("op=record / op=inspect trace: button state to hold for the whole run, one entry per controller port ([P1] or [P1,P2]); e.g. [{b:true}] to fire SFX. Released after the run."),
    },
    safeTool(async (args) => {
      if (args.op === "inspect") {
        if (!args.chip) throw new Error("audioDebug({op:'inspect'}): `chip` is required.");
        // frames set → trace the chip over time into a note-timeline; else single-frame snapshot.
        if (args.frames != null && args.frames > 0) {
          return await traceAudioChip(sessionKey, args);
        }
        return await getAudioStateCore(args, sessionKey);
      }
      if (args.op !== "record") throw new Error(`audioDebug: unknown op '${args.op}'`);
      if (!args.path) throw new Error("audioDebug({op:'record'}): `path` is required.");
      const { path: outPath, setInputs } = args;
      const frames = args.frames ?? 180;
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

      // `||` not `??`: wasmcart carts may declare 0 = "host decides", and a
      // 0 Hz WAV header is unplayable (caught by the starfall dogfood run).
      const sampleRate = host.status.audioSampleRate || 48000;
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

// ── audioDebug({op:'inspect', frames}) — chip note-timeline ──────────────────
// The numeric per-channel fields worth tracking over time, in priority order.
// A chip decode returns channels under various keys (tones/voices/pulses/...);
// we time-series whichever of these fields each channel object exposes.
const TRACE_FIELDS = ["note", "frequency", "freq", "period", "attenuation", "volume", "vol", "playing", "enabled", "key", "env"];

/** Pull the per-channel state out of a chip decode into a flat {channelKey: {field:val}} map. */
function channelsOf(state) {
  const out = {};
  for (const [k, v] of Object.entries(state)) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") {
      // e.g. tones:[{...}], voices:[{...}], pulses:[{...}]
      v.forEach((ch, i) => {
        const picked = {};
        for (const f of TRACE_FIELDS) if (ch[f] !== undefined) picked[f] = ch[f];
        if (Object.keys(picked).length) out[`${k}[${i}]`] = picked;
      });
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      // e.g. noise:{...}
      const picked = {};
      for (const f of TRACE_FIELDS) if (v[f] !== undefined) picked[f] = v[f];
      if (Object.keys(picked).length) out[k] = picked;
    }
  }
  return out;
}

/**
 * Trace a sound chip over `frames` frames → a per-channel timeline of value
 * TRANSITIONS (so a held note is one entry, not N). The headless note-timeline
 * an agent can assert a melody on without recording a WAV.
 */
async function traceAudioChip(sessionKey, { chip, platform, frames, sampleEvery = 1, setInputs }) {
  const { getHost } = await import("../state.js");
  const host = getHost(sessionKey);
  if (!host.status.platform) throw new Error("audioDebug({op:'inspect', frames}): no media loaded — call loadMedia first.");

  if (setInputs && setInputs.length > 0) host.setInput({ ports: setInputs });

  // getAudioStateCore returns jsonContent({...}); pull the structured object.
  const decode = async () => {
    const r = await getAudioStateCore({ chip, platform }, sessionKey);
    const txt = r.content?.find?.((c) => c.type === "text")?.text;
    return txt ? JSON.parse(txt) : {};
  };

  // Per-channel timeline: list of { frame, ...changedFields } whenever a field changes.
  const timelines = {};
  const lastSeen = {};
  const startFrame = host.status.frameCount;
  for (let i = 0; i < frames; i++) {
    host.stepFrames(1);
    if (i % sampleEvery !== 0 && i !== frames - 1) continue;
    const chans = channelsOf(await decode());
    for (const [chKey, fields] of Object.entries(chans)) {
      const prev = lastSeen[chKey];
      // Record an entry only when something this channel reports changed.
      const changed = !prev || TRACE_FIELDS.some((f) => fields[f] !== undefined && fields[f] !== prev[f]);
      if (changed) {
        (timelines[chKey] ??= []).push({ frame: i, ...fields });
        lastSeen[chKey] = fields;
      }
    }
  }
  if (setInputs && setInputs.length > 0) host.setInput({ ports: [{}, {}] });

  const transitions = Object.values(timelines).reduce((n, t) => n + t.length, 0);
  return jsonContent({
    chip,
    framesTraced: frames,
    startFrame,
    endFrame: host.status.frameCount,
    ...(sampleEvery > 1 ? { sampleEvery } : {}),
    channels: Object.keys(timelines),
    transitions,
    timeline: timelines,
    note: transitions === 0
      ? "No channel state changed across the trace — either nothing is playing (check op:'inspect' single-frame first), or your driver writes the chip less often than sampled. For PCM-only Genesis SFX (XGM2 PCM), inspect can't see it — record + FFT instead."
      : `Per-channel note-timeline: each entry is a value TRANSITION at frame N (held notes collapse to one entry). Assert your melody on the 'frequency'/'note' sequence per channel; compare frame deltas for rhythm.`,
  });
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