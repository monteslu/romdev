#!/usr/bin/env node
// Generate the sound tables the SMS/GG and Genesis WAT backends use, from
// genesis_plus_gx's own source (core/sound/blip_buf.c, psg.c, ym2612.c).
//
// Constant tables are PARSED out of the C source (never retyped). The two
// tables ym2612.c builds with floating point at init (tl_tab from pow(),
// sin_tab from sin()/log()) are computed here with the same double
// expressions, in the same order; `node gpgx-sound.mjs --check-core` then
// finds both tables inside the running reference core's memory (romdev's
// genesis_plus_gx wasm) and fails unless they are there byte for byte, so the
// data is proven to be what the reference itself computed.
//
// Run once; the output is committed as data so a recompile never needs
// emulator source on disk.
//
// usage: node gpgx-sound.mjs <genesis_plus_gx source root> [out.json]
//        node gpgx-sound.mjs --check-core [json]
//
// LICENSE: derived from Genesis Plus GX (non-commercial, see NOTICE).
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { revParseHead } from "../../src/git/index.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(HERE, "../../src/analysis/recompile/wat/sms/gpgx-sound.json");

/** Body text of the brace initialiser that follows `decl` in `src`. */
function initBody(src, decl) {
  const at = src.indexOf(decl);
  if (at < 0) throw new Error(`${decl} not found`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`${decl}: unterminated initialiser`);
}

/** Integers of a C initialiser, with macros applied by `mac` (name -> fn). */
function ints(body, mac = {}) {
  const text = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const out = [];
  for (let tok of text.replace(/[{}]/g, ",").split(",")) {
    tok = tok.trim();
    if (!tok) continue;
    const m = /^([A-Z]+)\s*\(\s*(-?[0-9.]+)\s*\)$/.exec(tok);
    if (m) {
      if (!mac[m[1]]) throw new Error(`unknown macro ${m[1]}`);
      out.push(mac[m[1]](Number(m[2])));
      continue;
    }
    const v = Number(tok);
    if (!Number.isFinite(v)) throw new Error(`not a number: ${tok}`);
    out.push(v);
  }
  return out;
}

function generate(root) {
  const rd = (p) => readFileSync(path.join(root, p), "latin1");
  const files = ["core/sound/blip_buf.c", "core/sound/psg.c", "core/sound/ym2612.c", "core/sound/sound.c", "core/system.c", "libretro/libretro.c"];
  const sha = Object.fromEntries(files.map((f) => [f, createHash("sha256").update(readFileSync(path.join(root, f))).digest("hex")]));
  let commit = null;
  try { commit = revParseHead(root); } catch { /* an unreadable checkout: provenance without a commit */ }

  // blip_buf.c: bl_step[phase_count + 1][half_width], Sinc_Generator( 0.9, 0.55, 4.5 )
  const blip = rd("core/sound/blip_buf.c");
  const blStep = ints(initBody(blip, "bl_step [phase_count + 1] [half_width]"));
  if (blStep.length !== 33 * 8) throw new Error(`bl_step: ${blStep.length} entries`);

  // psg.c: chanVolume[16] = PSG_MAX_VOLUME * factor, truncated to uint16 at compile time
  const psg = rd("core/sound/psg.c");
  const maxVol = Number(/#define PSG_MAX_VOLUME\s+(\d+)/.exec(psg)[1]);
  const volText = initBody(psg, "chanVolume[16]").replace(/\/\*[\s\S]*?\*\//g, "");
  const chanVolume = volText.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
    if (t === "PSG_MAX_VOLUME") return maxVol;
    if (t === "0") return 0;
    const m = /^PSG_MAX_VOLUME\s*\*\s*([0-9.]+)$/.exec(t);
    if (!m) throw new Error(`chanVolume entry ${t}`);
    return Math.trunc(maxVol * Number(m[1]));
  });
  if (chanVolume.length !== 16) throw new Error("chanVolume length");
  const psgRatio = /#define PSG_MCYCLES_RATIO \((\d+)\*(\d+)\)/.exec(psg);
  const noiseFeedback = ints(initBody(psg, "noiseFeedback[10]"));

  // ym2612.c constant tables
  const ym = rd("core/sound/ym2612.c");
  const ENV_BITS = Number(/#define ENV_BITS\s+(\d+)/.exec(ym)[1]);
  const ENV_LEN = 1 << ENV_BITS, ENV_STEP = 128.0 / ENV_LEN;
  const RATE_STEPS = 8;
  const slTable = ints(initBody(ym, "sl_table[16]"), { SC: (db) => Math.trunc(db * (4.0 / ENV_STEP)) });
  const egInc = ints(initBody(ym, "eg_inc[19*RATE_STEPS]"));
  const egRateSelect = ints(initBody(ym, "eg_rate_select[32+64+32]"), { O: (a) => a * RATE_STEPS });
  const egRateShift = ints(initBody(ym, "eg_rate_shift[32+64+32]"), { O: (a) => a });
  const dtTab = ints(initBody(ym, "dt_tab[4 * 32]"));
  const opnFktable = ints(initBody(ym, "opn_fktable[16]"));
  const lfoSamplesPerStep = ints(initBody(ym, "lfo_samples_per_step[8]"));
  const lfoAmsDepthShift = ints(initBody(ym, "lfo_ams_depth_shift[4]"));
  const lfoPmOutput = ints(initBody(ym, "lfo_pm_output[7*8][8]"));
  const want = { slTable: 16, egInc: 19 * 8, egRateSelect: 128, egRateShift: 128, dtTab: 128, opnFktable: 16, lfoSamplesPerStep: 8, lfoAmsDepthShift: 4, lfoPmOutput: 7 * 8 * 8 };
  const got = { slTable, egInc, egRateSelect, egRateShift, dtTab, opnFktable, lfoSamplesPerStep, lfoAmsDepthShift, lfoPmOutput };
  for (const [k, n] of Object.entries(want)) if (got[k].length !== n) throw new Error(`${k}: ${got[k].length} entries, want ${n}`);

  // init_tables(): tl_tab (Linear Power Table) and sin_tab (Logarithmic Sinus table)
  const TL_RES_LEN = 256, SIN_BITS = 10, SIN_LEN = 1 << SIN_BITS;
  const tlTab = new Array(13 * 2 * TL_RES_LEN).fill(0);
  for (let x = 0; x < TL_RES_LEN; x++) {
    let m = (1 << 16) / Math.pow(2, (x + 1) * (ENV_STEP / 4.0) / 8.0);
    m = Math.floor(m);
    let n = m | 0;
    n >>= 4;
    n = (n & 1) ? (n >> 1) + 1 : n >> 1;
    n <<= 2;
    tlTab[x * 2 + 0] = n;
    tlTab[x * 2 + 1] = -n;
    for (let i = 1; i < 13; i++) {
      tlTab[x * 2 + 0 + i * 2 * TL_RES_LEN] = tlTab[x * 2] >> i;
      tlTab[x * 2 + 1 + i * 2 * TL_RES_LEN] = -tlTab[x * 2 + 0 + i * 2 * TL_RES_LEN];
    }
  }
  const sinTab = new Array(SIN_LEN);
  for (let i = 0; i < SIN_LEN; i++) {
    const m = Math.sin(((i * 2) + 1) * Math.PI / SIN_LEN);
    let o = m > 0.0 ? 8 * Math.log(1.0 / m) / Math.log(2) : 8 * Math.log(-1.0 / m) / Math.log(2);
    o = o / (ENV_STEP / 4);
    let n = Math.trunc(2.0 * o);
    n = (n & 1) ? (n >> 1) + 1 : n >> 1;
    sinTab[i] = n * 2 + (m >= 0.0 ? 0 : 1);
  }

  return {
    source: "genesis_plus_gx core/sound/{blip_buf,psg,ym2612}.c (tables parsed from the source; tl_tab/sin_tab computed as ym2612.c init_tables does)",
    generator: "scripts/recompile-gen/gpgx-sound.mjs",
    gpgxCommit: commit,
    sourceSha256: sha,
    licenseNote: "Derived from Genesis Plus GX (non-commercial license, see NOTICE). Carts built with it inherit that.",
    blip: { blStep, halfWidth: 8, phaseBits: 5, deltaBits: 15, bassShift: 9, endFrameExtra: 2 },
    psg: { maxVolume: maxVol, chanVolume, mcyclesRatio: Number(psgRatio[1]) * Number(psgRatio[2]), noiseFeedback },
    ym2612: { envBits: ENV_BITS, slTable, egInc, egRateSelect, egRateShift, dtTab, opnFktable, lfoSamplesPerStep, lfoAmsDepthShift, lfoPmOutput, tlTab, sinTab },
  };
}

/** Find `tab` (as little-endian i32s) in the reference core's linear memory. */
async function checkCore(jsonPath) {
  const d = JSON.parse(readFileSync(jsonPath, "utf8"));
  const { resolveCore } = await import("../../src/cores/registry.js");
  const { LibretroHost } = await import("romdev-core-host/index.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const r = resolveCore("genesis");
  const h = new LibretroHost();
  await h.loadCore(r.jsPath, r.wasmPath, {});
  // a blank 128KB cart with a Genesis header: YM2612Init runs at load
  const dir = mkdtempSync(path.join(os.tmpdir(), "gpgx-sound-check-"));
  const rom = new Uint8Array(0x20000);
  rom.set(Buffer.from("SEGA MEGA DRIVE "), 0x100);
  rom[4] = 0; rom[5] = 0; rom[6] = 2; rom[7] = 0;
  rom.set([0x60, 0xFE], 0x200);
  const rp = path.join(dir, "blank.md");
  writeFileSync(rp, rom);
  await h.loadMedia({ platform: "genesis", path: rp });
  const heap = h.mod.HEAPU8;
  const res = {};
  for (const [name, tab] of [["tlTab", d.ym2612.tlTab], ["sinTab", d.ym2612.sinTab]]) {
    const b = Buffer.alloc(tab.length * 4);
    tab.forEach((v, i) => b.writeInt32LE(v, i * 4));
    const at = Buffer.from(heap.buffer, heap.byteOffset, heap.length).indexOf(b);
    res[name] = at;
    if (at < 0) { rmSync(dir, { recursive: true, force: true }); throw new Error(`${name} is NOT in the reference core's memory: the computed table differs from gpgx's`); }
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`tl_tab found at 0x${res.tlTab.toString(16)}, sin_tab at 0x${res.sinTab.toString(16)} in genesis_plus_gx's memory: identical`);
}

const args = process.argv.slice(2);
if (args[0] === "--check-core") {
  await checkCore(args[1] || DEFAULT_OUT);
  process.exit(0);
}
if (!args[0]) {
  console.error("usage: node gpgx-sound.mjs <genesis_plus_gx source root> [out.json] | --check-core [json]");
  process.exit(2);
}
const out = args[1] || DEFAULT_OUT;
writeFileSync(out, JSON.stringify(generate(args[0])) + "\n");
console.log(`wrote ${out}`);
