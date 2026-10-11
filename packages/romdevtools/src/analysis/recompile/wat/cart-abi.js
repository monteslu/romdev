// Shared wasmcart ABI helpers for the WAT recompile backends.
//
// Every backend ends in the same shell: a `wc_get_info` export returning a
// pointer to the wasmcart info struct, `wc_init`, `wc_render`, and a custom
// section `romdev.recompile` describing the cart's memory layout so the
// verify op needs no sidecar file. The helpers here make the parts that have
// already bitten several emitters impossible to write incompletely:
//
//   - inputPtr (info field 7) MUST be a real address. The host writes 80
//     bytes of pad state through it every frame (4 pads x 20 bytes, ABI v4)
//     with NO zero check, so 0 scribbles over linear memory offset 0 (the
//     SNES direct page, the NES zero page). Pad N is at inputPtr + 20 * N.
//     Under ABI v3 the pad was 16 bytes; a layout sized for 64 bytes now has
//     its last 16 bytes overwritten every frame, which is why every backend
//     runs its host-written spans through assertHostSpans() at build time.
//   - timePtr (info field 10) has the same contract, 20 bytes (two f64 and a
//     u32), and MUST be 8-byte aligned because the host stores the f64s
//     through a Float64Array index. On the NES cart a zero timePtr made
//     PPUCTRL track the host frame counter.
//
// Plain JS ESM + JSDoc.

import { validateAudioBlock } from "../recompile-section.js";

/** Byte offsets of the wc_info_t fields (wasmcart.h). */
export const WC_INFO = Object.freeze({
  version: 0, width: 4, height: 8, fbPtr: 12, audioPtr: 16, audioCap: 20,
  audioWritePtr: 24, inputPtr: 28, savePtr: 32, saveSize: 36, timePtr: 40,
  hostInfoPtr: 44, flags: 48, audioSampleRate: 52, pointerPtr: 56, keysPtr: 60,
  gpuApi: 64, wheelPtr: 68,
});

/**
 * The wasmcart ABI version every recompiled cart declares in wc_info_t.version.
 * wasmcart 0.31 (ABI v4) refuses any cart below 4: v4 widened the pad's
 * triggers to int16, which moved `connected` and grew the pad to 20 bytes.
 */
export const WC_ABI_VERSION = 4;

/** Size in bytes the host writes through each pointer (ABI v4). */
export const WC_SIZES = Object.freeze({ info: 72, input: 80, pad: 20, pads: 4, time: 20, hostInfo: 20 });

/**
 * wc_pad_t field offsets (ABI v4, 20 bytes): u32 buttons, i16 sticks,
 * i16 triggers (0..32767), u8 connected, 3 pad bytes.
 */
export const WC_PAD = Object.freeze({
  buttons: 0, leftX: 4, leftY: 6, rightX: 8, rightY: 10, leftTrigger: 12, rightTrigger: 14, connected: 16,
});

/**
 * Address of pad `n`'s wc_pad_t inside the input block.
 * @param {number} input  inputPtr
 * @param {number} n      pad index 0..3
 */
export function padAddr(input, n) {
  if (!(Number.isInteger(n) && n >= 0 && n < WC_SIZES.pads)) throw new Error(`cart-abi: pad index ${n} out of range 0..${WC_SIZES.pads - 1}`);
  return input + n * WC_SIZES.pad;
}

/**
 * Build-time check of every span the HOST writes into cart memory (or that
 * the cart hands the host), so a layout that lets one host write land on
 * another, or on emulated state, refuses to build instead of corrupting a
 * byte every frame. Every WAT backend calls this, whether or not it emits its
 * wc_get_info through wcGetInfoWat.
 *
 * @param {object} o
 * @param {number} o.info        wc_info_t address (72 bytes, 4-aligned)
 * @param {number} o.input       inputPtr (80 bytes, nonzero)
 * @param {number} o.time        timePtr (20 bytes, nonzero, 8-aligned)
 * @param {number} [o.hostInfo]  wc_host_info_t (20 bytes) if declared
 * @param {number} [o.audioWrite] the u32 audio write cursor
 * @param {number} [o.audio]     the audio ring (with o.audioBytes)
 * @param {number} [o.audioBytes]
 * @param {Array<[string, number, number]>} [o.others]  other cart state the
 *   host spans must not touch: [name, address, length]
 * @param {string} [o.who]       backend name for the error
 */
export function assertHostSpans(o) {
  const who = o.who ? `${o.who}: ` : "";
  for (const k of ["info", "input", "time"]) {
    if (!Number.isInteger(o[k]) || o[k] <= 0) throw new Error(`cart-abi: ${who}${k} must be a nonzero address`);
  }
  if (o.info % 4) throw new Error(`cart-abi: ${who}the info struct must be 4-byte aligned`);
  if (o.time % 8) throw new Error(`cart-abi: ${who}timePtr 0x${o.time.toString(16)} must be 8-byte aligned (the host writes f64s through it)`);
  const spans = [["info", o.info, WC_SIZES.info], ["input", o.input, WC_SIZES.input], ["time", o.time, WC_SIZES.time]];
  if (o.hostInfo) spans.push(["hostInfo", o.hostInfo, WC_SIZES.hostInfo]);
  if (o.audioWrite) spans.push(["audioWrite", o.audioWrite, 4]);
  if (o.audio && o.audioBytes) spans.push(["audio ring", o.audio, o.audioBytes]);
  const host = spans.length;
  for (const [n, a, l] of o.others ?? []) if (l > 0) spans.push([n, a, l]);
  if (spans[1][2] !== WC_SIZES.pad * WC_SIZES.pads) throw new Error(`cart-abi: ${who}input span must be ${WC_SIZES.pad * WC_SIZES.pads} bytes`);
  for (let i = 0; i < host; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const [an, a, al] = spans[i], [bn, b, bl] = spans[j];
      if (a < b + bl && b < a + al) throw new Error(`cart-abi: ${who}${an} (0x${a.toString(16)}+${al}) overlaps ${bn} (0x${b.toString(16)}+${bl})`);
    }
  }
  return spans;
}

/** wasmcart pad button bits (wc_pad_t.buttons). */
export const WC_BTN = Object.freeze({
  A: 1 << 0, B: 1 << 1, X: 1 << 2, Y: 1 << 3, L: 1 << 4, R: 1 << 5, START: 1 << 6, SELECT: 1 << 7,
  UP: 1 << 8, DOWN: 1 << 9, LEFT: 1 << 10, RIGHT: 1 << 11, L3: 1 << 12, R3: 1 << 13,
  // ABI v4: the rest of the SDL2 button set (buttons is a u32 now).
  GUIDE: 1 << 14, MISC1: 1 << 15, PADDLE1: 1 << 16, PADDLE2: 1 << 17, PADDLE3: 1 << 18, PADDLE4: 1 << 19, TOUCHPAD: 1 << 20,
});

/** Info flags. */
export const WC_FLAG = Object.freeze({ AUDIO_F32: 1 << 0 });

/**
 * romdev's host settle convention: loadMedia runs this many frames before
 * the caller's frame 0. The wasmcart host runs 1 wc_render; libretro cores 5.
 * A recompiled cart and its reference are therefore compared at cart frame
 * F - (5 - 1) for reference frame F unless the cart models warm-up itself;
 * the verify op owns this, backends only record their own convention.
 */
export const HOST_SETTLE = Object.freeze({ wasmcart: 1, libretro: 5 });

/**
 * A standard scratch block for the ABI structs, 512 bytes at `base`
 * (base must be 8-byte aligned):
 *   base+0    wc_info_t (72 bytes)
 *   base+256  audio write cursor (u32)
 *   base+288  input: 4 pads x 20 bytes = 80 bytes (ABI v4)
 *   base+368  wc_time_t (20 bytes, 8-aligned)
 *   base+392  wc_host_info_t (20 bytes)
 * @param {number} base
 */
export function abiBlock(base) {
  if (base % 8 !== 0) throw new Error(`cart-abi: ABI block base 0x${base.toString(16)} must be 8-byte aligned`);
  return { info: base, audioWrite: base + 256, input: base + 288, time: base + 368, hostInfo: base + 392, end: base + 512 };
}

/**
 * Emit the `wc_get_info` export. Every pointer the host writes through
 * without a zero check is REQUIRED here, so a backend cannot forget one.
 *
 * @param {object} o
 * @param {number} o.info        address of the info struct (4-aligned)
 * @param {number} o.width
 * @param {number} o.height
 * @param {number} o.fb          framebuffer address (RGBA8888, width*height*4)
 * @param {number} o.input       inputPtr: 80 writable bytes (4 x wc_pad_t), not 0
 * @param {number} o.time        timePtr: 20 writable bytes, not 0, 8-aligned
 * @param {number} [o.audio=0]   audio ring address (0 = no audio)
 * @param {number} [o.audioCap=0]
 * @param {number} [o.audioWrite=0] address of the u32 write cursor
 * @param {number} [o.hostInfo=0]
 * @param {number} [o.flags=0]
 * @param {number} [o.sampleRate=0]
 * @param {number} [o.version=WC_ABI_VERSION]
 * @param {string} [o.name='wc_get_info']  export name
 * @param {boolean} [o.allowOverlap=false]  permit input/time/info to overlap
 *   (only for reproducing a legacy cart byte-for-byte)
 * @returns {string} a WAT `(func (export ...))`
 */
export function wcGetInfoWat(o) {
  const need = (k) => { if (!Number.isInteger(o[k]) || o[k] <= 0) throw new Error(`cart-abi: wc_get_info needs a nonzero '${k}' address`); };
  need("info"); need("fb"); need("input"); need("time");
  if (o.info % 4) throw new Error("cart-abi: the info struct must be 4-byte aligned");
  if (o.time % 8) throw new Error(`cart-abi: timePtr 0x${o.time.toString(16)} must be 8-byte aligned (the host writes f64s through it)`);
  if ((o.version ?? WC_ABI_VERSION) < WC_ABI_VERSION) throw new Error(`cart-abi: version ${o.version} is below ABI v${WC_ABI_VERSION}; the host refuses it`);
  if (o.audio) {
    if (!(Number.isInteger(o.audioCap) && o.audioCap > 0)) throw new Error("cart-abi: an audio ring needs audioCap (capacity in stereo sample frames)");
    if (!(Number.isInteger(o.audioWrite) && o.audioWrite > 0)) throw new Error("cart-abi: an audio ring needs a nonzero audioWrite (address of the u32 write cursor)");
    if (!(o.sampleRate > 0)) throw new Error("cart-abi: an audio ring needs sampleRate (the reference stream's rate; 0 lets the host pick, which no recompiled cart may do)");
    if (o.audio % 4) throw new Error("cart-abi: the audio ring must be 4-byte aligned");
  }
  if (!o.allowOverlap) {
    assertHostSpans({ info: o.info, input: o.input, time: o.time, hostInfo: o.hostInfo, audioWrite: o.audioWrite,
      audio: o.audio, audioBytes: o.audio ? o.audioCap * ((o.flags ?? 0) & WC_FLAG.AUDIO_F32 ? 8 : 4) : 0, others: o.others });
  }
  const f = [
    [WC_INFO.version, o.version ?? WC_ABI_VERSION],
    [WC_INFO.width, o.width],
    [WC_INFO.height, o.height],
    [WC_INFO.fbPtr, o.fb],
    [WC_INFO.audioPtr, o.audio ?? 0],
    [WC_INFO.audioCap, o.audioCap ?? 0],
    [WC_INFO.audioWritePtr, o.audioWrite ?? 0],
    [WC_INFO.inputPtr, o.input],
    [WC_INFO.savePtr, 0],
    [WC_INFO.saveSize, 0],
    [WC_INFO.timePtr, o.time],
    [WC_INFO.hostInfoPtr, o.hostInfo ?? 0],
    [WC_INFO.flags, o.flags ?? 0],
    [WC_INFO.audioSampleRate, o.sampleRate ?? 0],
  ];
  const lines = f.map(([off, v]) => `    (i32.store (i32.const ${o.info + off}) (i32.const ${v >>> 0}))`);
  return `  (func (export "${o.name || "wc_get_info"}") (result i32)\n${lines.join("\n")}\n    (i32.const ${o.info}))\n`;
}

/**
 * WAT that reads pad 0's button word (low 16 bits of the u32) from inputPtr into a local.
 * @param {number} input  inputPtr address
 * @param {string} local  local name including '$'
 */
export function readPad0Wat(input, local) {
  return `(local.set ${local} (i32.load16_u (i32.const ${input})))`;
}

// ---------------------------------------------------------------------------
// romdev.recompile custom section

export const RECOMPILE_SECTION = "romdev.recompile";

/**
 * Build the custom section for the assembler's `customSections` option.
 * Required fields are checked so the verify op can rely on them.
 *
 * @param {object} json
 * @param {string} json.platform         source platform id (sms, gg, nes, ...)
 * @param {string} [json.reference]     loadMedia platform id of the reference (default = platform)
 * @param {string|null} json.romSha1
 * @param {Record<string, {offset: number, length: number, ref?: string}>} json.regions
 *   linear-memory regions the verify op compares, with the reference's
 *   memory() region name in `ref`
 * @returns {{name: string, data: Uint8Array, json: object}}
 */
export function recompileSectionBytes(json) {
  // Schema: src/analysis/recompile/recompile-section.js (the verify op's
  // reader). Only `regions` is required there; platform is required here
  // because every recompiled cart knows it.
  for (const k of ["platform", "regions"]) {
    if (json[k] === undefined) throw new Error(`cart-abi: romdev.recompile section needs '${k}'`);
  }
  const full = { version: 1, ...json };
  return { name: RECOMPILE_SECTION, data: new Uint8Array(Buffer.from(JSON.stringify(full), "utf8")), json: full };
}

/**
 * Normalise what a backend's recompileSection() returns ({name, json} or
 * {name, data}) into {name, data} for the assembler.
 * @param {{name?: string, json?: object, data?: Uint8Array|string}} s
 */
export function toCustomSection(s) {
  if (s.data !== undefined) return { name: s.name || RECOMPILE_SECTION, data: typeof s.data === "string" ? new Uint8Array(Buffer.from(s.data, "utf8")) : s.data };
  const b = recompileSectionBytes(s.json);
  return { name: s.name || RECOMPILE_SECTION, data: b.data };
}

/**
 * Read every custom section with `name` from a wasm binary WITHOUT compiling
 * it (a recompiled cart can be hundreds of MB; WebAssembly.Module would
 * compile all of it just to list sections).
 * @param {Uint8Array} wasm
 * @param {string} [name]
 * @returns {Uint8Array[]}
 */
export function readCustomSections(wasm, name = RECOMPILE_SECTION) {
  if (wasm.length < 8 || wasm[0] !== 0 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) throw new Error("not a wasm binary");
  const out = [];
  let p = 8;
  const leb = () => { let r = 0, s = 0, b; do { b = wasm[p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  while (p < wasm.length) {
    const id = wasm[p++];
    const size = leb();
    const end = p + size;
    if (id === 0) {
      const nl = leb();
      const nm = Buffer.from(wasm.subarray(p, p + nl)).toString("utf8");
      if (nm === name) out.push(wasm.subarray(p + nl, end));
    }
    p = end;
  }
  return out;
}

/**
 * Parse the romdev.recompile JSON of a cart, or null if it has none.
 * @param {Uint8Array} wasm
 */
export function readRecompileInfo(wasm) {
  const s = readCustomSections(wasm, RECOMPILE_SECTION);
  if (!s.length) return null;
  return JSON.parse(Buffer.from(s[s.length - 1]).toString("utf8"));
}

/**
 * Escape bytes for a WAT data string, in the exact form the earlier Python emitters
 * used (printable ASCII literal, `"` as \22, `\` as \5c, everything else \hh),
 * so ported backends produce byte-identical text.
 * @param {Uint8Array} b
 */
export function watBytes(b) {
  let out = "";
  const parts = [];
  for (let i = 0; i < b.length; i++) {
    const x = b[i];
    if (x === 0x22) out += "\\22";
    else if (x === 0x5c) out += "\\5c";
    else if (x >= 0x20 && x < 0x7f) out += String.fromCharCode(x);
    else out += "\\" + HEX2[x];
    if (out.length > 1 << 16) { parts.push(out); out = ""; }
  }
  parts.push(out);
  return parts.join("");
}
const HEX2 = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

// ---------------------------------------------------------------------------
// Audio

/**
 * The audio contract a recompiled cart follows so frame({op:'verifyRecompile',
 * audio}) and findDiverge audio:true can prove it sample-exact against the
 * reference core. Kept as data so tools and docs quote one text.
 */
export const AUDIO_CONTRACT = Object.freeze({
  ring: "wc_info audio_ptr/audio_cap/audio_write_ptr: a ring of audio_cap STEREO sample frames (L,R interleaved). The u32 at audio_write_ptr is the next frame index (0..audio_cap-1, wrapping); the host drains from its read cursor to it after every wc_render, so the cart must never write audio_cap or more frames in one wc_render (capacity >= 2x the largest per-frame count; a power of two keeps the wrap an AND).",
  format: "s16 (flags without WC_FLAG_AUDIO_F32): the sample format every libretro core hands audio_batch_cb. An f32 ring is converted by the host (x32768 negative / x32767 positive) and can only match approximately.",
  rate: "wc_info audio_sample_rate = the reference stream's rate exactly (fceumm 48000 by default, the core's retro_get_system_av_info sample_rate). 0 (host decides) is not allowed for a recompiled cart.",
  perFrame: "Each wc_render writes EXACTLY the samples the reference core hands audio_batch_cb during the corresponding retro_run: the same count (cores count with fractional accumulators or blip buffers, so port the counting, not an average) and the same values, L and R both (a mono core duplicates: write L = R).",
  timing: "Samples belong to the frame that produced them: reference frame F pairs with cart frame F + offset (the same axis as the picture). Produce the audio inside wc_render, never ahead or behind by a frame.",
  mono: "The ring is always stereo; channels:2 in the section.",
  debugStreams: "Optional per-channel / pre-mix / pre-resample buffers (section audio.streams): the cart rewrites each every wc_render, a u32 count of sample frames at countOffset (reset to 0 at the top of wc_render) and the samples at offset; `ref` pairs one with a reference stream region ('RDAS' header, src/host/audio-verify.js AUDIO_STREAM) for an exact per-stage compare.",
  muteMask: "Optional (section audio.muteMask): a byte/word the cart's mixer reads every wc_render, bit i silencing channel i (0 at power-on, never written by the cart). The verifier's channelDrop control sets one bit on a fresh cart and requires the audio compare to FAIL.",
});

/**
 * Where an s16 (or f32) stereo ring of `capacity` sample frames lives.
 * @param {number} base 4-byte aligned address
 * @param {number} capacity stereo sample frames
 * @param {"s16"|"f32"} [format]
 */
export function audioRingLayout(base, capacity, format = "s16") {
  if (base % 4) throw new Error("cart-abi: the audio ring must be 4-byte aligned");
  if (!(Number.isInteger(capacity) && capacity > 0)) throw new Error("cart-abi: audio ring capacity must be a positive integer");
  const frameBytes = format === "f32" ? 8 : 4;
  return { ring: base, capacity, format, frameBytes, bytes: capacity * frameBytes, end: base + capacity * frameBytes };
}

/**
 * WAT for `(func $audio_push (param $l i32) (param $r i32))`: store one s16
 * stereo sample frame at the ring's write cursor and advance it. Values are
 * clamped to s16 (a core's own clamp belongs in the backend; this one only
 * guards the store). The cursor lives at `cursor` (the address wc_info's
 * audio_write_ptr points at).
 * @param {{ring:number, capacity:number, cursor:number, name?:string, clamp?:boolean}} o
 */
export function audioPushWat(o) {
  const name = o.name ?? "$audio_push";
  const cap = o.capacity;
  const wrap = (cap & (cap - 1)) === 0
    ? `(i32.and (i32.add (local.get $c) (i32.const 1)) (i32.const ${cap - 1}))`
    : `(select (i32.const 0) (i32.add (local.get $c) (i32.const 1)) (i32.ge_u (i32.add (local.get $c) (i32.const 1)) (i32.const ${cap})))`;
  const clamp = (v) => o.clamp === false ? `(local.get ${v})`
    : `(select (i32.const -32768) (select (i32.const 32767) (local.get ${v}) (i32.gt_s (local.get ${v}) (i32.const 32767))) (i32.lt_s (local.get ${v}) (i32.const -32768)))`;
  return `  (func ${name} (param $l i32) (param $r i32)
    (local $c i32) (local $a i32)
    (local.set $c (i32.load (i32.const ${o.cursor})))
    (local.set $a (i32.add (i32.const ${o.ring}) (i32.shl (local.get $c) (i32.const 2))))
    (i32.store16 (local.get $a) ${clamp("$l")})
    (i32.store16 offset=2 (local.get $a) ${clamp("$r")})
    (i32.store (i32.const ${o.cursor}) ${wrap}))
`;
}

/**
 * WAT for a debug stream (section audio.streams.<name>): `$<name>_reset`
 * (call at the top of wc_render) and `$<name>_push` (one sample frame; one
 * param per channel: $v, $l $r, or $c0..$c3 for a 3-4 channel event stream). Pushes beyond capacity still count, so the verifier
 * reports the overflow instead of comparing a truncated frame silently.
 * @param {string} name  identifier (letters, digits, _)
 * @param {{offset:number, countOffset:number, capacity:number, channels?:number, format?:"s16"|"s32"|"f32"}} s
 */
export function audioStreamWat(name, s) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`cart-abi: stream name '${name}' must be an identifier`);
  const ch = s.channels ?? 1, fmt = s.format ?? "s16", size = fmt === "s16" ? 2 : 4;
  const ty = fmt === "f32" ? "f32" : "i32";
  const store = fmt === "s16" ? "i32.store16" : fmt === "f32" ? "f32.store" : "i32.store";
  if (![1, 2, 3, 4].includes(ch)) throw new Error(`cart-abi: stream '${name}' channels must be 1-4`);
  // 1 channel: $v; 2: $l $r; 3-4 (event streams, e.g. time/delta_l/delta_r): $c0..$c3
  const names = ch === 1 ? ["$v"] : ch === 2 ? ["$l", "$r"] : Array.from({ length: ch }, (_, i) => `$c${i}`);
  const params = names.map((n) => `(param ${n} ${ty})`).join(" ");
  const stores = names.map((n, i) => `      (${store}${i ? ` offset=${i * size}` : ""} (local.get $a) (local.get ${n}))`).join("\n");
  return `  (func $${name}_reset (i32.store (i32.const ${s.countOffset}) (i32.const 0)))
  (func $${name}_push ${params}
    (local $n i32) (local $a i32)
    (local.set $n (i32.load (i32.const ${s.countOffset})))
    (if (i32.lt_u (local.get $n) (i32.const ${s.capacity}))
      (then
      (local.set $a (i32.add (i32.const ${s.offset}) (i32.mul (local.get $n) (i32.const ${size * ch}))))
${stores}))
    (i32.store (i32.const ${s.countOffset}) (i32.add (local.get $n) (i32.const 1))))
`;
}

/**
 * The section's `audio` block, validated (throws naming the bad key).
 * @param {{sampleRate:number, format?:"s16"|"f32", reference?:string, streams?:object, muteMask?:object}} o
 */
export function audioSection(o) {
  return validateAudioBlock({ channels: 2, format: "s16", reference: "output", ...o });
}

/**
 * Which reference stream a recompiled cart must match, per platform, with the
 * core's chain from chip to audio_batch_cb (default core options; romdev sets
 * no audio options and does not answer GET_TARGET_SAMPLE_RATE). "output" is
 * the libretro stream; the named regions are RDAS streams the romdev core
 * patches expose (frame({op:'verifyRecompile', audio, audioStream}) or a cart
 * debug stream's `ref`). Every chain listed is integer and deterministic
 * unless it says otherwise.
 */
export const AUDIO_REFERENCE = Object.freeze({
  nes: {
    core: "fceumm", rate: 48000, match: "output",
    chain: "low-quality renderer (fceumm_sndquality Low): DoSQ1/DoSQ2/DoTriangle/DoNoise/DoPCM accumulate into int32 Wave[] in 16 sub-steps per output sample, flushed before every $4000-$4017 write and at frame end; FlushEmulateSound runs SexyFilter (volume 179 from fceumm_sndvolume 7, two-pole integer high-pass, int16 clamp); mono duplicated to L = R; lowpass and stereo delay off",
    perFrame: "one audio_batch_cb per retro_run, 798/799 samples (the 1/16-sample remainder carries over)",
    streams: {},
  },
  gb: {
    core: "gambatte", rate: 32768, match: "output (needs the blipper port) or gb_apu_raw through a cart debug stream",
    chain: "PSG writes stereo deltas at 2097152 Hz (one sample per 2 CPU clocks), fillBuffer prefix-sums them to int16; the libretro port resamples with fixed-point blipper (32 taps, cutoff 0.85, Kaiser beta 6.5, decimation 64; its int16 filter table is built once in double: dump it, do not recompute) with a leaky integrator, >>15 and a clamp (gambatte_audio_resampler 'sinc'; 'cc' gives 65536 Hz)",
    perFrame: "blipper is drained mid-frame once 768 samples are available and at frame end; one audio_batch_cb, 548/549 samples",
    streams: { gb_apu_raw: "stereo s16 at 2097152 Hz, every sample frame runFor produced this retro_run (35112 +- a few): the blipper input" },
  },
  gbc: { alias: "gb" },
  sms: {
    core: "genesis_plus_gx", rate: 44100, match: "output (port blip_buf)",
    chain: "SN76489 deltas every 240 master clocks (psg_preamp 150) into blip_buf; YM2413 FM 'auto'; blip_buf (stereo, hq: blip_add_delta) is read with its bass_shift 9 high-pass and clamp; audio_filter disabled (no low-pass, no EQ)",
    perFrame: "one audio_batch_cb, 735/736 samples NTSC, about 887 PAL (blip fractional time)",
    streams: { gpgx_blip_deltas: "s32 x 3 events (blip clock time, delta_l, delta_r): every nonzero delta into the main blip buffer this retro_run, i.e. the chip output before blip_buf" },
  },
  gg: { alias: "sms" },
  genesis: {
    core: "genesis_plus_gx", rate: 44100, match: "output (port blip_buf)",
    chain: "YM2612 (ym2612 'mame', discrete, not ym3438) samples every 1008 master clocks (~53267 Hz) into fm_buffer, scaled by fm_preamp 100/100 and added to blip_buf as deltas; PSG as on sms (psg_preamp 150); blip_buf read with its high-pass and clamp; audio_filter disabled",
    perFrame: "one audio_batch_cb, 735/736 samples NTSC, about 887 PAL",
    streams: { gpgx_blip_deltas: "as on sms: FM and PSG deltas in time order" },
  },
  snes: {
    core: "snes9x", rate: 32040, match: "output",
    chain: "the integer S-DSP (gaussian interpolation, echo, master volume, clamp inside) pushes one stereo sample per 32 SPC clocks into the resampler ring; the resampler's time_ratio is 1.0, so output IS the DSP stream sample for sample (a per-game APU speedup hack or MSU-1 switches to a float Hermite path; those are not exact)",
    perFrame: "one audio_batch_cb from S9xSyncSpeed at VBlank START, not at the end of retro_run: 533/534 samples, set by how far the SPC has been caught up (ratio 15664/328125)",
    streams: {},
  },
  gba: {
    core: "mgba", rate: 65536, match: "output when SOUNDBIAS resolution is 1 (native 65536 Hz is copied straight through); otherwise gba_audio_raw",
    chain: "GBAAudioSample mixes PSG (>> 4 - volume) and FIFO A/B, applies SOUNDBIAS (clamp 0..0x3FF, masterVolume) every 1024 cycles, 2 << resolution samples, native rate 16777216/sampleInterval; when that is not 65536 the libretro port resamples with a DOUBLE-precision sinc (sin() from libm), which is not integer-portable; the low-pass is off",
    perFrame: "native samples arrive in pairs, 548/550 per frame at resolution 0 (1096/1100 at 1); the resampled output is ~1097 and lags by the resampler's high-water mark",
    streams: { gba_audio_raw: "stereo s16 at 16777216/sampleInterval Hz (the header's rate follows SOUNDBIAS): GBAAudioSample's output this retro_run, before the resampler" },
  },
});
