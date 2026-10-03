// The `romdev.recompile` wasm custom section: a recompiled cart's own map of
// where the emulated machine lives in its linear memory, so a verifier can
// byte-compare it against the reference core with NO sidecar file.
//
// Written by the WAT backends (src/analysis/recompile/wat/<platform>/), read
// by frame({op:'verifyRecompile'}) and frame({op:'findDiverge', cart}).
//
// JSON schema (version 1). Every key but `regions` is optional.
//
//   {
//     "version": 1,
//     "platform": "sms",            source platform of the ROM the cart was built from
//     "reference": "sms",           loadMedia platform id of the reference core (default = platform)
//     "romSha1": "<hex>",           sha1 of the source ROM; checked against the reference ROM
//     "companionFiles": [".msu", "-1.pcm", "/STBIOS.bin"]
//                                   files the reference core opens beside its ROM (an
//                                   SNES MSU-1 pack, a Sufami Turbo / BS-X BIOS): the
//                                   verifier copies <rom stem><suffix>, or the named file
//                                   for a "/<name>" entry, from the reference ROM's
//                                   directory into the core's file system next to its ROM
//     "saveRam": { "name": "game.srm", "sha1": "<hex>", "length": 8192 }
//                                   the battery save the cart powers on with: the verifier
//                                   writes the named file (beside the reference ROM, sha1
//                                   checked) into the reference's save_ram before its first
//                                   frame, as a frontend restores a .srm
//     "saveRtc": { "name": "game.rtc", "sha1": "<hex>", "length": 20 }
//                                   the same for a battery-backed clock's registers: written
//                                   into the reference's rtc region (libretro RETRO_MEMORY_RTC)
//     "firmware": { "chip": "ST011", "name": "st011.rom", "sha1": "<hex>", "length": 53248 }
//                                   a coprocessor's firmware the cart was built with: the
//                                   verifier finds the file (the caller's firmware path, or
//                                   beside the reference ROM, or in a firmware/ directory
//                                   there; sha1 checked) and puts it in the reference core's
//                                   system directory under that name before the load
//     "referenceCore": "snes9x",    the reference core the cart follows (a platform's
//                                   default core, or one of its ALT_CORES)
//     "clock": { "baseMs": 1700000000000, "stepMs": 16.667 }
//                                   the cart reads the wasmcart host's frame clock (a
//                                   game-visible real-time clock); the verifier pins the
//                                   reference core's wall clock to the same one:
//                                   baseMs + (frames past settle) * stepMs, in UTC
//                                   (RTC_CLOCK below)
//     "frameAlignment": "settle",   "settle" (default): cart frame = reference frame + refSettle
//                                   - 1 - warmupFrames. "search": the cart's boot takes a
//                                   game-dependent number of frames, so the verifier FINDS the
//                                   offset by picture (a sharp peak, or it refuses)
//     "warmupFrames": 0,            frames the cart runs INSIDE its first wc_render beyond the
//                                   one the wasmcart host's loadMedia settle frame counts
//                                   (a GBA cart that runs 4 warm-up frames there declares 4)
//     "screen": { "origin": [x, y] } where the reference picture sits inside the cart
//                                   framebuffer (default: centred)
//     "buttons": "positional",      how the cart maps wasmcart pad bits. "positional" (the only
//                                   convention new carts should use): WC_BTN_A = south, B = east,
//                                   X = west, Y = north, so a libretro name reaches the same
//                                   physical button on the cart as on the core. "byName" marks a
//                                   legacy cart that reads WC_BTN_A as the console's "A"; the
//                                   verifier then sends the cart the swapped name.
//     "regions": {                  name -> linear-memory span compared against a core region
//       "vram": { "offset": 65536, "length": 16384, "ref": "sms_vram",
//                 "refOffset": 0,             byte offset into the reference region
//                 "transform": "lowbyte16",   applied to the REFERENCE bytes before comparing:
//                                             swap16 | lowbyte16 | highbyte16
//                 "mask": 63,                 AND-ed into both sides before comparing
//                 "compare": false }          optional: a DIAGNOSTIC region, read and reported
//                                             but never a verdict or divergence input (a
//                                             register page with computed-on-read values)
//     },
//     "fields": {                   scalar CPU/machine state, compared per frame by findDiverge
//       "pc":     { "offset": 32772, "size": 2, "ref": "cpu:pc" },
//       "a":      { "offset": 32776, "size": 1, "ref": "cpu:registers.A" },
//       "cycles": { "offset": 233544, "size": 4, "ref": { "region": "genesis_m68k", "offset": 5132 } }
//     },
//     "probe": {                    cart-only diagnostics; `trapped` != 0 fails a verification
//       "trapped": { "offset": 32772, "size": 4 }
//     },
//     "vramZero": ["vram"],         regions the VRAM-zero control wipes (default: regions whose
//                                   name contains vram/chr/nametable)
//     "trace": {                    the cart's instruction ring, read by findDiverge
//                                   level:'instruction' and frame({op:'traceInstructions'})
//       "offset": 36864,            ring base (or "baseField": {offset} where the base is stored)
//       "entries": 1024, "stride": 8,
//       "cursor": { "offset": 32852, "mode": "count" },  "count" = monotone entries written
//                                   (ring index = count % entries); "index" = the next slot,
//                                   restarted at 0 by the reader ("writable": true)
//       "enable": { "offset": 1234 },            optional: nonzero records
//       "pc": { "offset": 0, "mask": 65535 },    u32 LE at offset, >>> shift, & mask
//       "clock": { "offset": 4 },                optional per-instruction clock (compared as
//                                   per-instruction deltas with the core's trace clock)
//       "skipIf": { "offset": 0, "bit": 31 },    optional: entries with this bit set are events
//       "fields": { "sp": { "offset": 8, "mask": 65535 } },  per-entry values; a name the
//                                   reference core also records per instruction (GBA r0-r15,
//                                   cpsr; GB sp, hl, bc, de; NES a x y s p; SMS/GG af bc de hl
//                                   ix iy sp r af2 bc2 de2 hl2 i; Genesis d0-d7 a0-a7 sr; SNES
//                                   a x y s d db p: LibretroHost.traceRegisterNames) is
//                                   compared instruction by instruction
//       "filter": { "romOnly": "snesLoRom", "skip": [[lo, hi]] }  what the ring leaves out, so the
//                                   reference stream is filtered the same way
//     },
//     "audio": {                    the cart's sound output, compared by verifyRecompile audio:true
//                                   and findDiverge audio:true (contract: cart-abi.js AUDIO_CONTRACT)
//       "sampleRate": 48000,        rate of the wasmcart ring, = wc_info.audio_sample_rate; for an
//                                   exact compare it equals the reference stream's rate
//       "channels": 2,              the ring is always interleaved stereo (2)
//       "format": "s16",            ring format: "s16" (exact compare possible) | "f32"
//       "reference": "output",      the reference stream the ring must equal: "output" = what the
//                                   core hands libretro's audio_batch_cb, or the name of a per-frame
//                                   stream region the core exposes (RDAS header: AUDIO_STREAM in src/host/audio-verify.js)
//       "streams": {                optional debug buffers (pre-mix, per-channel, pre-resample),
//                                   rewritten every wc_render: u32 count of sample frames at
//                                   countOffset, samples at offset
//         "sq1": { "offset": 1234, "countOffset": 1230, "capacity": 1024, "channels": 1,  (1-4)
//                  "format": "s16",  s16 | s32 | f32
//                  "ref": "nes_apu_sq1",   optional: a reference stream region with the same content
//                  "compare": true }       false = reported only
//       },
//       "muteMask": { "offset": 1300, "size": 1, "channels": ["sq1", "sq2", "tri", "noise", "dmc"] }
//                                   optional: a cart byte/word whose bit i silences channel i in the
//                                   cart's mixer; the drop-channel must-fail control sets one bit
//     }
//   }

import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";

export const RECOMPILE_SECTION = "romdev.recompile";

/**
 * The real-time clock a recompiled cart with a clock chip (GB MBC3, GBA
 * GPIO RTC) runs on, and the `clock` a verifier pins the reference to. Both
 * reference cores read it through emscripten's time(): the whole seconds of
 * Date.now() / 1000. The cart reads the same f64 expression from the
 * wasmcart host's frame clock (timeMs = frame * stepMs):
 *   trunc((baseMs + timeMs) / 1000)
 * so boundary rounding is identical, not merely close. In play the date
 * starts at baseMs when the cart powers on.
 */
export const RTC_CLOCK = Object.freeze({ baseMs: 1700000000000, stepMs: 1000 / 60 });
export const RECOMPILE_SECTION_VERSION = 1;
export const REGION_TRANSFORMS = ["swap16", "lowbyte16", "highbyte16"];

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

function isWasm(bytes) {
  return bytes.length >= 8 && WASM_MAGIC.every((b, i) => bytes[i] === b);
}

function isZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function readLeb(bytes, pos) {
  let result = 0, shift = 0, b;
  do {
    if (pos >= bytes.length) throw new Error("truncated LEB128 in wasm section header");
    b = bytes[pos++];
    result += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return [result, pos];
}

function encodeLeb(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

/**
 * Every custom section with `name` in a wasm binary, as payload byte arrays.
 * Walks section headers only, so a 100 MB module costs a few thousand reads.
 * @param {Uint8Array} wasm
 * @param {string} name
 * @returns {Uint8Array[]}
 */
export function readCustomSections(wasm, name) {
  if (!isWasm(wasm)) throw new Error("not a wasm binary (missing \\0asm magic)");
  const out = [];
  let pos = 8;
  const dec = new TextDecoder();
  while (pos < wasm.length) {
    const id = wasm[pos++];
    let size;
    [size, pos] = readLeb(wasm, pos);
    const end = pos + size;
    if (end > wasm.length) throw new Error(`wasm section ${id} runs past the end of the module`);
    if (id === 0) {
      let nlen, p;
      [nlen, p] = readLeb(wasm, pos);
      const secName = dec.decode(wasm.subarray(p, p + nlen));
      if (secName === name) out.push(wasm.slice(p + nlen, end));
    }
    pos = end;
  }
  return out;
}

/**
 * The bytes of a complete custom section (id, size, name, JSON payload), ready
 * to append to a wasm module. The WAT backends call this; appending a custom
 * section after the last standard section is always valid.
 * @param {object} layout
 * @returns {Uint8Array}
 */
export function encodeRecompileSection(layout) {
  const checked = validateRecompileLayout(layout);
  const enc = new TextEncoder();
  const name = enc.encode(RECOMPILE_SECTION);
  const payload = enc.encode(JSON.stringify(checked));
  const body = [...encodeLeb(name.length), ...name, ...payload];
  return Uint8Array.from([0, ...encodeLeb(body.length), ...body]);
}

/**
 * Append the section to a wasm binary.
 * @param {Uint8Array} wasm
 * @param {object} layout
 */
export function withRecompileSection(wasm, layout) {
  if (!isWasm(wasm)) throw new Error("not a wasm binary");
  const sec = encodeRecompileSection(layout);
  const out = new Uint8Array(wasm.length + sec.length);
  out.set(wasm, 0);
  out.set(sec, wasm.length);
  return out;
}

/**
 * The cart module inside a .wasc (or the bytes themselves for a bare .wasm).
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function cartWasmBytes(bytes) {
  if (isWasm(bytes)) return bytes;
  if (!isZip(bytes)) throw new Error("cart is neither a .wasm module nor a .wasc (zip) archive");
  const manifestOnly = unzipSync(bytes, { filter: (f) => f.name === "manifest.json" });
  let entry = "cart.wasm";
  if (manifestOnly["manifest.json"]) {
    try { entry = JSON.parse(new TextDecoder().decode(manifestOnly["manifest.json"])).entry || entry; } catch { /* default entry */ }
  }
  const files = unzipSync(bytes, { filter: (f) => f.name === entry });
  if (!files[entry]) throw new Error(`.wasc has no ${entry}`);
  return files[entry];
}

/**
 * Wrap a bare cart .wasm into an in-memory .wasc so the wasmcart host (which
 * loads archives) can run it. Stored, not deflated: this never touches disk.
 * @param {Uint8Array} wasm
 * @param {string} [name]
 */
export function wascFromWasm(wasm, name = "cart") {
  const manifest = new TextEncoder().encode(JSON.stringify({ name, version: "1.0.0", entry: "cart.wasm" }));
  return zipSync({ "cart.wasm": [wasm, { level: 0 }], "manifest.json": [manifest, { level: 0 }] });
}

/**
 * Read + validate the cart's `romdev.recompile` layout.
 * @param {string|Uint8Array} cart path or bytes of a .wasm / .wasc
 * @returns {object|null} the layout, or null when the cart carries no section
 */
export function readRecompileLayout(cart) {
  const bytes = typeof cart === "string" ? new Uint8Array(readFileSync(cart)) : cart;
  const secs = readCustomSections(cartWasmBytes(bytes), RECOMPILE_SECTION);
  if (!secs.length) return null;
  if (secs.length > 1) throw new Error(`cart carries ${secs.length} '${RECOMPILE_SECTION}' sections; exactly one is allowed`);
  let obj;
  try { obj = JSON.parse(new TextDecoder().decode(secs[0])); }
  catch (e) { throw new Error(`'${RECOMPILE_SECTION}' section is not valid JSON: ${e.message}`); }
  return validateRecompileLayout(obj);
}

const isInt = (v) => Number.isInteger(v) && v >= 0;

function checkSpan(kind, name, s, needLength) {
  if (!s || typeof s !== "object") throw new Error(`${kind} '${name}' must be an object`);
  if (!isInt(s.offset)) throw new Error(`${kind} '${name}'.offset must be a non-negative integer`);
  if (needLength && !(isInt(s.length) && s.length > 0)) throw new Error(`${kind} '${name}'.length must be a positive integer`);
}

/** Normalise a field's `ref` into {cpu} | {region, offset, size}. */
export function normalizeFieldRef(name, ref, size) {
  if (ref == null) return null;
  if (typeof ref === "string") {
    if (ref.startsWith("cpu:")) return { cpu: ref.slice(4) };
    const m = /^([A-Za-z0-9_]+)(?:\+(\d+|0x[0-9a-fA-F]+))?$/.exec(ref);
    if (!m) throw new Error(`field '${name}'.ref '${ref}' must be 'cpu:<path>' or '<region>[+offset]'`);
    return { region: m[1], offset: m[2] ? Number(m[2]) : 0, size };
  }
  if (typeof ref === "object") {
    if (typeof ref.cpu === "string") return { cpu: ref.cpu };
    if (typeof ref.region === "string") return { region: ref.region, offset: ref.offset ?? 0, size: ref.size ?? size, signed: !!ref.signed };
  }
  throw new Error(`field '${name}'.ref must be 'cpu:<path>', '<region>[+offset]', {cpu} or {region, offset}`);
}

/**
 * Validate a layout object and return it with defaults filled in. Throws with
 * the offending key named, so a malformed section is refused rather than
 * compared wrongly.
 * @param {object} layout
 */
export function validateRecompileLayout(layout) {
  if (!layout || typeof layout !== "object") throw new Error("recompile layout must be an object");
  const v = layout.version ?? RECOMPILE_SECTION_VERSION;
  if (v !== RECOMPILE_SECTION_VERSION) throw new Error(`recompile layout version ${v} is not supported (this romdev reads version ${RECOMPILE_SECTION_VERSION})`);
  const out = { ...layout, version: v };
  if (out.warmupFrames != null && !isInt(out.warmupFrames)) throw new Error("warmupFrames must be a non-negative integer");
  if (out.buttons != null && !["positional", "byName"].includes(out.buttons)) throw new Error("buttons must be 'positional' or 'byName'");
  if (out.frameAlignment != null && !["settle", "search"].includes(out.frameAlignment)) throw new Error("frameAlignment must be 'settle' or 'search'");
  if (out.clock != null) {
    const c = out.clock;
    if (typeof c !== "object" || !(Number.isInteger(c.baseMs) && c.baseMs % 1000 === 0) || !(c.stepMs > 0)) {
      throw new Error("clock must be {baseMs: whole seconds in ms, stepMs > 0}");
    }
  }
  if (out.companionFiles != null) {
    const c = out.companionFiles;
    if (!Array.isArray(c) || !c.every((f) => typeof f === "string" && /^\/?[^\\/]+$/.test(f))) {
      throw new Error("companionFiles must be file-name suffixes (e.g. '.msu', '-1.pcm') or '/<file name>', with no other path separators");
    }
  }
  for (const key of ["saveRam", "saveRtc", "firmware"]) {
    const r = out[key];
    if (r == null) continue;
    if (typeof r !== "object" || typeof r.name !== "string" || !/^[^\\/]+$/.test(r.name) || !/^[0-9a-f]{40}$/.test(r.sha1 ?? "") || !(Number.isInteger(r.length) && r.length > 0)) {
      throw new Error(`${key} must be {name: a file name with no path, sha1: 40 hex digits, length > 0}`);
    }
  }
  if (out.screen?.origin != null) {
    const o = out.screen.origin;
    if (!Array.isArray(o) || o.length !== 2 || !o.every((n) => Number.isInteger(n) && n >= 0)) throw new Error("screen.origin must be [x, y]");
  }
  const regions = out.regions ?? {};
  if (typeof regions !== "object") throw new Error("regions must be an object of name -> {offset, length, ref}");
  for (const [name, r] of Object.entries(regions)) {
    checkSpan("region", name, r, true);
    if (typeof r.ref !== "string" || !r.ref) throw new Error(`region '${name}'.ref must name a reference memory region (e.g. 'sms_vram')`);
    if (r.refOffset != null && !isInt(r.refOffset)) throw new Error(`region '${name}'.refOffset must be a non-negative integer`);
    if (r.transform != null && !REGION_TRANSFORMS.includes(r.transform)) throw new Error(`region '${name}'.transform must be one of ${REGION_TRANSFORMS.join(" | ")}`);
    if (r.mask != null && !(Number.isInteger(r.mask) && r.mask >= 0 && r.mask <= 255)) throw new Error(`region '${name}'.mask must be a byte (0-255)`);
    if (r.compare != null && typeof r.compare !== "boolean") throw new Error(`region '${name}'.compare must be a boolean`);
  }
  out.regions = regions;
  for (const key of ["fields", "probe"]) {
    const fields = out[key] ?? {};
    for (const [name, f] of Object.entries(fields)) {
      checkSpan(key === "fields" ? "field" : "probe", name, f, false);
      const size = f.size ?? 4;
      if (![1, 2, 4].includes(size)) throw new Error(`${key} '${name}'.size must be 1, 2 or 4`);
      if (key === "fields") normalizeFieldRef(name, f.ref, size);
    }
    out[key] = fields;
  }
  if (out.trace != null) {
    const t = out.trace;
    if (typeof t !== "object") throw new Error("trace must be an object");
    if (!(isInt(t.entries) && t.entries > 0) || !(isInt(t.stride) && t.stride >= 4)) throw new Error("trace.entries and trace.stride must be positive integers (stride >= 4)");
    if (!isInt(t.offset) && !isInt(t.baseField?.offset)) throw new Error("trace needs offset (the ring base) or baseField:{offset}");
    if (!isInt(t.cursor?.offset) || !["count", "index"].includes(t.cursor.mode ?? "count")) throw new Error("trace.cursor must be {offset, mode:'count'|'index'}");
    if (t.cursor.mode === "index" && !t.cursor.writable) throw new Error("trace.cursor mode 'index' must be writable (the reader restarts it at 0)");
    for (const [n, f] of Object.entries(t.fields ?? {})) if (!isInt(f?.offset) || f.offset + 4 > t.stride) throw new Error(`trace.fields.${n}.offset must lie inside the ${t.stride}-byte entry`);
    if (t.pc && (!isInt(t.pc.offset) || t.pc.offset + 4 > t.stride)) throw new Error("trace.pc.offset must lie inside the entry");
  }
  if (out.vramZero != null) {
    if (!Array.isArray(out.vramZero)) throw new Error("vramZero must be an array of region names");
    for (const n of out.vramZero) if (!regions[n]) throw new Error(`vramZero names region '${n}', which is not in regions`);
  }
  if (out.audio != null) out.audio = validateAudioBlock(out.audio);
  return out;
}

export const AUDIO_FORMATS = ["s16", "f32"];
export const AUDIO_STREAM_FORMATS = ["s16", "s32", "f32"];

/**
 * Validate the section's `audio` block (see the schema comment at the top)
 * and return it with defaults filled in.
 * @param {object} a
 */
export function validateAudioBlock(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) throw new Error("audio must be an object");
  const out = { channels: 2, format: "s16", reference: "output", ...a };
  if (!(Number.isFinite(out.sampleRate) && out.sampleRate > 0)) throw new Error("audio.sampleRate must be a positive number (the ring's rate, = wc_info.audio_sample_rate)");
  if (out.channels !== 2) throw new Error("audio.channels must be 2: the wasmcart ring is interleaved stereo (write mono as L = R)");
  if (!AUDIO_FORMATS.includes(out.format)) throw new Error(`audio.format must be one of ${AUDIO_FORMATS.join(" | ")}`);
  if (typeof out.reference !== "string" || !out.reference) throw new Error("audio.reference must be 'output' or the name of a reference stream region");
  const streams = out.streams ?? {};
  if (typeof streams !== "object" || Array.isArray(streams)) throw new Error("audio.streams must be an object of name -> {offset, countOffset, capacity, channels, format}");
  for (const [n, s] of Object.entries(streams)) {
    if (!s || typeof s !== "object") throw new Error(`audio.streams.${n} must be an object`);
    for (const k of ["offset", "countOffset"]) if (!isInt(s[k])) throw new Error(`audio.streams.${n}.${k} must be a non-negative integer`);
    if (!(isInt(s.capacity) && s.capacity > 0)) throw new Error(`audio.streams.${n}.capacity must be a positive integer (sample frames the buffer holds)`);
    const ch = s.channels ?? 1;
    if (![1, 2, 3, 4].includes(ch)) throw new Error(`audio.streams.${n}.channels must be 1-4 (3 for an event stream such as gpgx_blip_deltas: time, delta_l, delta_r)`);
    if (s.format != null && !AUDIO_STREAM_FORMATS.includes(s.format)) throw new Error(`audio.streams.${n}.format must be one of ${AUDIO_STREAM_FORMATS.join(" | ")}`);
    if (s.ref != null && (typeof s.ref !== "string" || !s.ref)) throw new Error(`audio.streams.${n}.ref must name a reference stream region`);
    if (s.compare != null && typeof s.compare !== "boolean") throw new Error(`audio.streams.${n}.compare must be a boolean`);
  }
  out.streams = streams;
  if (out.muteMask != null) {
    const m = out.muteMask;
    if (!m || typeof m !== "object" || !isInt(m.offset)) throw new Error("audio.muteMask must be {offset, size, channels:[...]}");
    if (![1, 2, 4].includes(m.size ?? 1)) throw new Error("audio.muteMask.size must be 1, 2 or 4");
    if (!Array.isArray(m.channels) || !m.channels.length || m.channels.length > 8 * (m.size ?? 1) || !m.channels.every((c) => typeof c === "string" && c)) {
      throw new Error("audio.muteMask.channels must list the channel names, bit 0 first, no more than the mask has bits");
    }
  }
  return out;
}
