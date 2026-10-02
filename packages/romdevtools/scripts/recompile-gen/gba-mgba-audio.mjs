// Maintainer-only mechanical data regeneration, not an agent/API tool.
//
//   node scripts/recompile-gen/gba-mgba-audio.mjs [--mgba <dir>] [--musl <math dir>] [--write]
//
// Produces src/analysis/recompile/wat/gba/mgba-audio.json: everything the GBA
// WAT backend's audio (wat/gba/audio.js) takes from mGBA 0.11 and musl, so
// the cart emits the samples romdev's mGBA core emits:
//
//   gb        src/gb/audio.c: the square duty table, the noise LFSR batch
//             tables (noiseMaskTable / noisePopulationTable), the frame
//             sequencer period (DMG_SM83_FREQUENCY >> 9) and the GBA timing
//             factor
//   gba       src/gba/audio.c + include/mgba/internal/gba/audio.h: the sample
//             event interval (GBA_ARM7TDMI_FREQUENCY / 0x4000), FIFO depth,
//             GBA_MAX_SAMPLES, GBA_AUDIO_VOLUME_MAX; the PSG's audio buffer
//             (AUDIO_BUFFER_SAMPLES)
//   libretro  src/platform/libretro/libretro.c: GBA_RESAMPLED_RATE (the rate
//             the core hands the frontend when it does not ask for another),
//             the resampler's interpolator (mINTERPOLATOR_SINC)
//   sinc      src/util/interpolator.c: mSINC_RESOLUTION, mSINC_WIDTH and the
//             three-term Nuttall window coefficients; the lookup tables are
//             computed from these by wat/gba/musl-trig.js, and `lutSha256`
//             pins the result (checked against the tables in romdev's live
//             mGBA heap: identical, all 2 x 65537 doubles)
//   musl      the sin/cos kernel coefficients and argument-reduction
//             constants (src/math/__sin.c, __cos.c, __rem_pio2.c): Emscripten
//             links musl, so mGBA's sin()/cos() are musl's
//
// --mgba defaults to romdev's pinned checkout (build/mgba/src), read from the
// pinned commit's git objects so romdev's local core patch never leaks in.
// Default mode verifies the committed JSON; --write replaces it.
//
// License: mGBA is MPL-2.0 (the values are data extracted from the files
// listed; provenance recorded per MPL-2.0 section 3.2). musl is MIT.
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { revParseHead, showFile } from "../../src/git/index.js";
import assert from "node:assert/strict";
import { muslTrig, sincTables } from "../../src/analysis/recompile/wat/gba/musl-trig.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const PKG = path.resolve(here, "../..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MGBA = path.resolve(opt("--mgba", path.join(process.env.ROMDEV_BUILD_DIR ?? path.join(PKG, "build"), "mgba/src")));
const MUSL = opt("--musl", path.join(process.env.EMSDK ?? path.resolve(PKG, "../../../emsdk"),
  "upstream/emscripten/system/lib/libc/musl/src/math"));
const OUT = path.join(PKG, "src/analysis/recompile/wat/gba/mgba-audio.json");
const versions = JSON.parse(await readFile(path.join(PKG, "scripts/versions.json"), "utf8"));
const pin = versions.cores?.mgba ?? Object.values(versions).find((v) => v?.mgba)?.mgba;

const isGit = existsSync(path.join(MGBA, ".git"));
let commit = null;
if (isGit) commit = revParseHead(MGBA);
if (pin?.commit) assert.equal(commit, pin.commit, `mGBA checkout ${commit} is not the pinned ${pin.commit}`);

const files = {};
/** `git show HEAD:<rel>` of the mGBA checkout, read without a git process. */
function committedText(rel) {
  const buf = showFile(MGBA, rel, "HEAD");
  if (buf === null) throw new Error(`${rel} is not in the mGBA checkout's HEAD`);
  return buf.toString("utf8");
}
function src(rel) {
  const text = isGit
    ? committedText(rel)
    : execFileSync("cat", [path.join(MGBA, rel)], { encoding: "utf8", maxBuffer: 1 << 26 });
  files[rel] = createHash("sha256").update(text).digest("hex");
  return text;
}
const muslFiles = {};
async function msrc(name) {
  const text = await readFile(path.join(MUSL, name), "utf8");
  muslFiles[name] = createHash("sha256").update(text).digest("hex");
  return text;
}
const clean = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
/** C integer / float / hex-float literal -> Number */
function cnum(s) {
  s = s.trim();
  if (!/^[+-]?0x/i.test(s)) s = s.replace(/[fFuUlL]+$/, "");
  else s = s.replace(/p/i.test(s) ? /[fFlL]+$/ : /[uUlL]+$/, "");
  const hf = /^([+-]?)0x([0-9a-f]*)\.?([0-9a-f]*)p([+-]?\d+)$/i.exec(s);
  if (hf) {
    const mant = BigInt(`0x${hf[2] || "0"}${hf[3]}`);
    const v = Number(mant) * 2 ** (Number(hf[4]) - 4 * hf[3].length);
    assert.ok(mant < 2n ** 53n, "hex float mantissa wider than a double");
    return hf[1] === "-" ? -v : v;
  }
  const v = Number(s);
  assert.ok(Number.isFinite(v), `not a C number: ${s}`);
  return v;
}
/** Numbers of a C initializer `name[...] = { ... }` (nested braces flattened). */
function cArray(text, name) {
  const m = new RegExp(`${name}\\s*(?:\\[[^\\]]*\\])+\\s*=\\s*\\{([^;]*?)\\};`).exec(clean(text));
  assert.ok(m, `missing ${name}`);
  return m[1].replace(/[{}]/g, " ").split(",").map((s) => s.trim()).filter(Boolean).map(cnum);
}
/** `name = <literal>` inside a declaration list */
function cConst(text, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*([-+0-9a-fA-FxXpP.]+)`).exec(clean(text));
  assert.ok(m, `missing ${name}`);
  return cnum(m[1]);
}
function cDefine(text, name) {
  const m = new RegExp(`#define\\s+${name}\\s+(\\S+)`).exec(text);
  assert.ok(m, `missing #define ${name}`);
  return m[1];
}

// --- GB PSG (src/gb/audio.c)
const gbAudio = src("src/gb/audio.c");
const duty = cArray(gbAudio, "_squareChannelDuty");
assert.equal(duty.length, 32);
const noiseMask = cArray(gbAudio, "noiseMaskTable");
const noisePop = cArray(gbAudio, "noisePopulationTable");
assert.equal(noiseMask.length, 64); assert.equal(noisePop.length, 64);
assert.equal(cDefine(gbAudio, "FRAME_CYCLES"), "(DMG_SM83_FREQUENCY");
const dmgFreq = cConst(gbAudio, "DMG_SM83_FREQUENCY");
const audioBufferSamples = cnum(cDefine(gbAudio, "AUDIO_BUFFER_SAMPLES"));
assert.ok(/if \(style == GB_AUDIO_GBA\) \{\s*audio->timingFactor = 4;/.test(gbAudio), "GBA timing factor");
const gbVolumeMax = cConst(gbAudio, "GB_AUDIO_VOLUME_MAX");

// --- GBA audio (src/gba/audio.c, audio.h)
const gbaAudio = src("src/gba/audio.c");
const gbaAudioH = src("include/mgba/internal/gba/audio.h");
assert.ok(/SAMPLE_INTERVAL = GBA_ARM7TDMI_FREQUENCY \/ 0x4000;/.test(gbaAudio), "SAMPLE_INTERVAL");
const gbaVolumeMax = cConst(gbaAudio, "GBA_AUDIO_VOLUME_MAX");
const fifoSize = cnum(cDefine(gbaAudioH, "GBA_AUDIO_FIFO_SIZE"));
const maxSamples = cnum(cDefine(gbaAudioH, "GBA_MAX_SAMPLES"));
const gbaH = src("include/mgba/internal/gba/gba.h");
const cpuFreq = cnum(cDefine(gbaH, "GBA_ARM7TDMI_FREQUENCY"));

// --- libretro frontend (resample target + interpolator)
const lr = src("src/platform/libretro/libretro.c");
const resampledRate = cnum(cDefine(lr, "GBA_RESAMPLED_RATE"));
assert.ok(/mAudioResamplerInit\(&audioResampler, mINTERPOLATOR_SINC\)/.test(lr), "libretro resamples with the sinc interpolator");
assert.ok(/audioLowPassEnabled = false;/.test(lr), "low-pass filter defaults off");
src("src/util/audio-resampler.c");
src("src/util/audio-buffer.c");

// --- sinc interpolator (src/util/interpolator.c)
const interp = src("src/util/interpolator.c");
const sincRes = cConst(interp, "mSINC_RESOLUTION");
const sincWidth = cConst(interp, "mSINC_WIDTH");
const wm = /windowLut\[i\]\s*=\s*([0-9.]+)\s*\+\s*([0-9.]+)\s*\*\s*cos\(y\)\s*\+\s*([0-9.]+)\s*\*\s*cos\(2 \* y\)/.exec(interp);
assert.ok(wm, "Nuttall window");
const window = [cnum(wm[1]), cnum(wm[2]), cnum(wm[3])];

// --- musl sin/cos
const kS = await msrc("__sin.c"), kC = await msrc("__cos.c"), rp = await msrc("__rem_pio2.c");
await msrc("sin.c"); await msrc("cos.c");
const muslConst = {};
for (const n of ["S1", "S2", "S3", "S4", "S5", "S6"]) muslConst[n] = cConst(kS, n);
for (const n of ["C1", "C2", "C3", "C4", "C5", "C6"]) muslConst[n] = cConst(kC, n);
for (const n of ["pio4", "invpio2", "pio2_1", "pio2_1t", "pio2_2", "pio2_2t", "pio2_3", "pio2_3t"]) muslConst[n] = cConst(rp, n);
assert.ok(/toint\s*=\s*1\.5\/EPS/.test(rp), "toint = 1.5/EPS");
muslConst.toint = 1.5 / Number.EPSILON;

const t = sincTables(muslTrig(muslConst), sincRes, sincWidth, window, Math.PI);
const lutSha256 = createHash("sha256").update(Buffer.from(t.sinc.buffer)).update(Buffer.from(t.window.buffer)).digest("hex");

const generated = {
  provenance: {
    source: "mGBA (libretro/mgba) at romdev's pinned core commit; musl libm (Emscripten's)",
    mgbaVersion: "0.11",
    mgbaCommit: commit,
    mgbaLicense: "MPL-2.0 (data extracted from the files listed; source: https://github.com/libretro/mgba)",
    mgbaFilesSha256: files,
    musl: { files: muslFiles, license: "MIT" },
    generator: "scripts/recompile-gen/gba-mgba-audio.mjs",
  },
  gb: { dmgFrequency: dmgFreq, frameCycles: dmgFreq / 512, timingFactor: 4, duty, noiseMask, noisePopulation: noisePop,
    audioBufferSamples, volumeMax: gbVolumeMax },
  gba: { cpuFrequency: cpuFreq, sampleEventCycles: cpuFreq / 0x4000, fifoSize, maxSamples, volumeMax: gbaVolumeMax,
    resetSampleInterval: cpuFreq / 0x8000 },
  libretro: { resampledRate, interpolator: "sinc", lowPass: false },
  sinc: { resolution: sincRes, width: sincWidth, window, pi: Math.PI, lutSha256 },
  musl: muslConst,
};
const text = JSON.stringify(generated, null, 1) + "\n";
if (args.includes("--write")) await writeFile(OUT, text);
else assert.deepEqual(JSON.parse(await readFile(OUT, "utf8")), generated, "sources changed: review then regenerate with --write");
console.log(`${args.includes("--write") ? "Generated" : "Verified"} ${path.relative(PKG, OUT)}: sinc ${sincRes}x${sincWidth} lut ${lutSha256.slice(0, 16)}, resample ${resampledRate} Hz, mGBA ${commit}`);
