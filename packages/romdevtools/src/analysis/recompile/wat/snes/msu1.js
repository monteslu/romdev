// The MSU-1 in a recompiled SNES cart: snes9x's msu1.cpp (compiled,
// chip-unit.js 'msu1') over a data file and PCM tracks the cart carries.
//
// snes9x turns the MSU-1 on when a `<rom>.msu` data file sits next to the
// ROM (S9xMSU1ROMExists) and opens `<rom>-<n>.pcm` when the game selects
// track n. The recompile does the same with the ROM's directory at build
// time and embeds what it finds; the verifier gives the reference core the
// same files (the section's `companionFiles`).
//
// Hooks (coproc.js composes them with the cart's coprocessor, if any):
//   $msu_b_rd / $msu_b_wr   ppu.cpp: $2000-$2007 before anything else
//   $msu_sample             SPC_DSP_OUT_HOOK: S9xMSU1Generate(2)
//   $msu_flush              libretro S9xSyncSpeed: avail = min(DSP, MSU),
//                           S9xMixSamples mixes the MSU stream in
//   $msu_power              retro_init / InitROM / S9xReset
//
// Plain JS ESM + JSDoc.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { unitWat, unitSize, unitFn, unitStart } from "./chip-unit.js";
import { AUDIO, AUDIO_FRAMES } from "./layout.js";

/**
 * @typedef {object} MsuPack
 * @property {Uint8Array} data                     the .msu data file
 * @property {{num: number, bytes: Uint8Array}[]} tracks  the -<n>.pcm tracks
 * @property {string[]} companions                 file-name suffixes the reference needs
 */

/**
 * The MSU-1 pack next to a ROM, as snes9x finds it (S9xMSU1ROMExists needs
 * the .msu data file; tracks without it are not an MSU-1 cart).
 * @param {string|undefined} romPath
 * @returns {MsuPack|null}
 */
export function findMsuPack(romPath) {
  if (!romPath) return null;
  const dir = path.dirname(romPath);
  const stem = path.basename(romPath).replace(/\.[^.]*$/, "");
  const dataPath = path.join(dir, stem + ".msu");
  if (!existsSync(dataPath)) return null;
  const tracks = [];
  const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)\\.pcm$`);
  for (const f of readdirSync(dir)) {
    const m = re.exec(f);
    if (!m) continue;
    const num = Number(m[1]);
    // "-" + std::to_string(track) + ".pcm": no leading zeros, track <= 65535
    if (String(num) !== m[1] || num > 0xffff) continue;
    tracks.push({ num, bytes: new Uint8Array(readFileSync(path.join(dir, f))) });
  }
  tracks.sort((a, b) => a.num - b.num);
  return {
    data: new Uint8Array(readFileSync(dataPath)),
    tracks,
    companions: [".msu", ...tracks.map((t) => `-${t.num}.pcm`)],
  };
}

const align = (n, a) => (n + a - 1) & ~(a - 1);

/**
 * Where the unit, the track table and the files go in the pack's region.
 * @param {MsuPack} pack
 */
function packLayout(pack) {
  let at = align(unitSize("msu1"), 0x1000);
  const table = at;
  at = align(at + pack.tracks.length * 12 + 4, 0x1000);
  const data = at;
  at = align(at + pack.data.length, 16);
  const tracks = pack.tracks.map((t) => { const a = at; at = align(at + t.bytes.length, 16); return a; });
  return { table, data, tracks, size: at };
}

/** 64KB pages the pack's region needs. */
export function msuPages(pack) { return Math.ceil(packLayout(pack).size / 0x10000); }

/**
 * Yield a WAT string literal's escaped bytes in pieces.
 * @param {Uint8Array} bytes
 */
function* esc(bytes, piece = 1 << 20) {
  for (let i = 0; i < bytes.length; i += piece) {
    const end = Math.min(bytes.length, i + piece);
    const buf = Buffer.allocUnsafe((end - i) * 3);
    let o = 0;
    for (let j = i; j < end; j++) {
      const v = bytes[j];
      buf[o++] = 0x5c;
      const hi = v >> 4, lo = v & 15;
      buf[o++] = hi < 10 ? 0x30 + hi : 0x57 + hi;
      buf[o++] = lo < 10 ? 0x30 + lo : 0x57 + lo;
    }
    yield buf.toString("latin1");
  }
}

/**
 * The pack's files as data segments (streamed: a pack can be hundreds of MB).
 * @param {number} base  lay.MSU
 * @param {MsuPack} pack
 */
export function* msuDataWat(base, pack) {
  const P = packLayout(pack);
  const tab = new Uint8Array(pack.tracks.length * 12);
  const dv = new DataView(tab.buffer);
  pack.tracks.forEach((t, i) => {
    dv.setUint32(i * 12, t.num, true);
    dv.setUint32(i * 12 + 4, base + P.tracks[i], true);
    dv.setUint32(i * 12 + 8, t.bytes.length, true);
  });
  const seg = function* (addr, bytes) {
    const CH = 1 << 24;   // one data segment per 16MB keeps each field small
    for (let i = 0; i < bytes.length; i += CH) {
      yield `\n  (data (i32.const ${addr + i}) "`;
      yield* esc(bytes.subarray(i, Math.min(bytes.length, i + CH)));
      yield '")';
    }
  };
  if (tab.length) yield* seg(base + P.table, tab);
  if (pack.data.length) yield* seg(base + P.data, pack.data);
  for (let i = 0; i < pack.tracks.length; i++) if (pack.tracks[i].bytes.length) yield* seg(base + P.tracks[i], pack.tracks[i].bytes);
}

/**
 * The MSU-1 unit and its hooks.
 * @param {any} lay     the cart layout (lay.MSU, lay.ABI, lay.fixes)
 * @param {MsuPack} pack
 */
export function msuWat(lay, pack) {
  const base = lay.MSU;
  const P = packLayout(pack);
  const speed = lay.fixes?.apuSpeedup ?? 0;
  const start = unitStart("msu1");
  const fn = (n) => unitFn("msu1", n);
  return unitWat("msu1", base) + `
  ;; ---- MSU-1 (msu1.js): snes9x's msu1.cpp over the cart's ${pack.tracks.length} track(s) and ${pack.data.length}-byte data file
  ;; the stereo frame S9xSyncSpeed last handed to the host (the DSP's
  ;; samples past it wait in snes9x's resampler for the next frame)
  (global $msu_pub (mut i32) (i32.const 0))
  ;; ppu.cpp S9xGetPPU: if (Settings.MSU1 && (Address & 0xfff8) == 0x2000)
  ;; return S9xMSU1ReadPort(Address & 7), ahead of the (H)DMA rules
  (func $msu_b_rd (param $x i32) (result i32)
    (if (i32.and (call ${fn("romdev_msu_enabled")}) (i32.eq (i32.and (local.get $x) (i32.const 0xFFF8)) (i32.const 0x2000)))
      (then (return (call ${fn("romdev_msu_read")} (i32.and (local.get $x) (i32.const 7))))))
    (i32.const -1))
  ;; S9xSetPPU: an A-bus write during (H)DMA is dropped first; then the MSU ports
  (func $msu_b_wr (param $x i32) (param $v i32) (result i32)
    (if (i32.eqz (i32.and (call ${fn("romdev_msu_enabled")}) (i32.eq (i32.and (local.get $x) (i32.const 0xFFF8)) (i32.const 0x2000))))
      (then (return (i32.const 0))))
    (if (i32.eqz (global.get $indma))
      (then (call ${fn("romdev_msu_write")} (i32.and (local.get $x) (i32.const 7)) (local.get $v))))
    (i32.const 1))
  ;; SPC_DSP_OUT_HOOK: if (Settings.MSU1) S9xMSU1Generate(2)
  (func $msu_sample
    (if (call ${fn("romdev_msu_enabled")}) (then (call ${fn("romdev_msu_generate")}))))
  ;; S9xSyncSpeed: avail = S9xGetSampleCount() = min(DSP avail, MSU avail);
  ;; S9xMixSamples(avail): the DSP's samples as they are, plus the MSU's
  (func $msu_flush
    (local $n i32) (local $m i32)
    (local.set $n (i32.shl (i32.and (i32.sub (global.get $apu_nout) (global.get $msu_pub)) (i32.const ${AUDIO_FRAMES - 1})) (i32.const 1)))
    (if (call ${fn("romdev_msu_enabled")})
      (then (local.set $m (call ${fn("romdev_msu_avail")}))
            (if (i32.lt_s (local.get $m) (local.get $n)) (then (local.set $n (local.get $m))))
            (call ${fn("romdev_msu_mix")} (i32.const ${AUDIO}) (i32.const ${AUDIO_FRAMES}) (i32.and (global.get $msu_pub) (i32.const ${AUDIO_FRAMES - 1})) (local.get $n))))
    (global.set $msu_pub (i32.add (global.get $msu_pub) (i32.shr_u (local.get $n) (i32.const 1))))
    (i32.store (i32.const ${lay.ABI + 0x100}) (i32.and (global.get $msu_pub) (i32.const ${AUDIO_FRAMES - 1}))))
  (func $msu_power
    ${start ? `(call ${start})` : ""}
    (call ${fn("romdev_msu_init")} (i32.const ${base + P.data}) (i32.const ${pack.data.length})
      (i32.const ${base + P.table}) (i32.const ${pack.tracks.length}) (i32.const ${256 - speed})))`;
}
