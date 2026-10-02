#!/usr/bin/env node
// Generate the Game Boy WAT backend's APU tables from gambatte's OWN source -
// the core romdev verifies GB/GBC recompiles against.
//
//   node scripts/recompile-gen/gen-gb-apu.mjs <gambatte-libretro checkout> \
//        src/analysis/recompile/wat/gb/apu-tables.json
//
// What it produces:
//   - blipper: the fixed-point band-limited step resampler gambatte-libretro
//     feeds its ~2 MHz PSG stream through (libgambatte/libretro/blipper.c,
//     created by audio_resampler_init with blipper_new(taps, cutoff, beta,
//     decimation, ...) in libretro.cpp). Its polyphase filter bank is COMPUTED
//     here exactly as blipper_create_filter_bank computes it (double sinc x
//     Kaiser window, float prefilter/interleave, then quantised to int16), so
//     the recompiled cart's 32768 Hz output can be sample-exact.
//   - duty: DutyUnit's waveform/step tables (libgambatte/src/sound/duty_unit.cpp).
//   - initstate: the power-on SPU state setInitState writes
//     (libgambatte/src/initstate.cpp), parsed from its text.
//
// Every piece of source text the numbers depend on is checked verbatim; if
// gambatte's code changes, the generator refuses instead of emitting a stale
// model. The output is committed so a recompile never needs C source on disk.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { revParseHead, remoteUrl } from "../../src/git/index.js";
import path from "node:path";

const [root, out] = process.argv.slice(2);
if (!root || !out) {
  console.error("usage: gen-gb-apu.mjs <gambatte-libretro checkout> <out.json>");
  process.exit(2);
}
function fail(msg) {
  console.error(`gen-gb-apu: ${msg}`);
  process.exit(1);
}
const files = {
  blipperC: "libgambatte/libretro/blipper.c",
  blipperH: "libgambatte/libretro/blipper.h",
  libretro: "libgambatte/libretro/libretro.cpp",
  duty: "libgambatte/src/sound/duty_unit.cpp",
  initstate: "libgambatte/src/initstate.cpp",
};
const text = {};
const sha = {};
for (const [k, rel] of Object.entries(files)) {
  const buf = readFileSync(path.join(root, rel));
  text[k] = buf.toString("utf8");
  sha[rel] = createHash("sha256").update(buf).digest("hex");
}
/** Whitespace-insensitive "does the source contain this fragment". */
const squash = (s) => s.replace(/\s+/g, " ").trim();
function expectFrag(k, frag) {
  if (!squash(text[k]).includes(squash(frag))) fail(`${files[k]}: expected text not found: ${frag}`);
}

// ---- blipper parameters (libretro.cpp audio_resampler_init) ----
const m = text.libretro.match(/resampler_l = blipper_new\((\d+),\s*([\d.]+),\s*([\d.]+),\s*(\d+),\s*BLIP_BUFFER_SIZE,\s*NULL\);/);
if (!m) fail("blipper_new(...) call not found in libretro.cpp");
const taps = Number(m[1]), cutoff = Number(m[2]), beta = Number(m[3]), phases = Number(m[4]);
expectFrag("libretro", `resampler_r = blipper_new(${m[1]}, ${m[2]}, ${m[3]}, ${m[4]}, BLIP_BUFFER_SIZE, NULL);`);
expectFrag("libretro", "#define SOUND_SAMPLES_PER_FRAME 35112");
expectFrag("libretro", "#define SOUND_SAMPLE_RATE_BLIPPER (SOUND_SAMPLE_RATE_NATIVE / 64)");
expectFrag("libretro", "#define SOUND_SAMPLE_RATE_NATIVE (VIDEO_REFRESH_RATE * (double)SOUND_SAMPLES_PER_FRAME)");
expectFrag("libretro", "#define BLIP_BUFFER_SIZE (1024 + 512)");
expectFrag("libretro", "if (read_avail >= (BLIP_BUFFER_SIZE >> 1))");
expectFrag("libretro", "static bool use_cc_resampler = false;");
const vr = text.libretro.match(/#define VIDEO_REFRESH_RATE\s+\(([\d.]+)\s*\/\s*([\d.]+)\)/);
if (!vr) fail("VIDEO_REFRESH_RATE not found");
const sampleRate = (Number(vr[1]) / Number(vr[2])) * 35112 / 64;
if (sampleRate !== 32768) fail(`blipper sample rate ${sampleRate}, expected 32768`);
// the default build is fixed point
expectFrag("blipperH", "#ifndef BLIPPER_FIXED_POINT\n#define BLIPPER_FIXED_POINT 1");
expectFrag("blipperH", "typedef int16_t blipper_sample_t;\ntypedef int32_t blipper_long_sample_t;");

// ---- blipper filter bank (blipper.c), step by step ----
for (const frag of [
  "for (i = 0; i < 18; i++) { sum += x_pow * two_div_pow / (factorial * factorial); factorial_mult += 1.0; x_pow *= x_sqr; two_div_pow *= 0.25; factorial *= factorial_mult; }",
  "if (fabs(v) < 0.00001) return 1.0; else return sin(v) / v;",
  "return besseli0(beta * sqrt(1.0 - index * index));",
  "sidelobes = taps / 2.0; window_mod = 1.0 / kaiser_window(0.0, beta); filter_len = phases * taps;",
  "double window_phase = (double)i / filter_len; /* [0, 1) */ window_phase = 2.0 * window_phase - 1.0; /* [-1, 1) */ sinc_phase = window_phase * sidelobes; /* [-taps / 2, taps / 2) */ filter[i] = cutoff * sinc(M_PI * sinc_phase * cutoff) * kaiser_window(window_phase, beta) * window_mod;",
  "float filter_amp = 0.75f / phases;",
  "new_filter[0] = filter[0]; for (i = 1; i < phases * taps; i++) new_filter[i] = new_filter[i - 1] + filter[i]; for (i = phases * taps; i < phases * taps + phases; i++) new_filter[i] = new_filter[phases * taps - 1]; taps++;",
  "memcpy(filter, new_filter, phases * sizeof(*filter)); for (i = phases; i < phases * taps; i++) filter[i] = new_filter[i] - new_filter[i - phases];",
  "for (i = 0; i < phases * taps; i++) filter[i] *= filter_amp;",
  "new_filter[p * taps + t] = filter[t * phases + p];",
  "filt[t] = (blipper_sample_t)floor(filter[t] * 0x7fff + 0.5);",
  "if (taps <= 1) return 0; taps--;",
  "#define M_PI 3.14159265358979323846",
  // the runtime parts the WAT port implements
  "target_output = (blip->phase + blip->phases - 1) >> blip->phases_log2; filter_phase = (target_output << blip->phases_log2) - blip->phase; response = blip->filter_bank + blip->taps * filter_phase;",
  "sum += (out[s] >> 1) - (sum >> 9);",
  "quant = (sum + 0x4000) >> 15;",
  "if ((blipper_sample_t)quant != quant) { quant = (quant >> 16) ^ 0x7fff; sum = quant << 15; }",
]) expectFrag("blipperC", frag);

const f32 = Math.fround;
function besseli0(x) {
  let sum = 0, factorial = 1, factorialMult = 0, xPow = 1, twoDivPow = 1;
  const xSqr = x * x;
  for (let i = 0; i < 18; i++) {
    sum += xPow * twoDivPow / (factorial * factorial);
    factorialMult += 1;
    xPow *= xSqr;
    twoDivPow *= 0.25;
    factorial *= factorialMult;
  }
  return sum;
}
const sinc = (v) => (Math.abs(v) < 0.00001 ? 1 : Math.sin(v) / v);
const kaiser = (index, b) => besseli0(b * Math.sqrt(1 - index * index));
const M_PI = 3.14159265358979323846;
const t0 = taps - 1;                       // blipper_create_filter_bank: taps--
const len = phases * t0;
const sincF = new Float32Array(len + phases);
{
  const sidelobes = t0 / 2;
  const windowMod = 1 / kaiser(0, beta);
  for (let i = 0; i < len; i++) {
    let wp = i / len;
    wp = 2 * wp - 1;
    const sp = wp * sidelobes;
    sincF[i] = cutoff * sinc(M_PI * sp * cutoff) * kaiser(wp, beta) * windowMod;
  }
}
// prefilter: float integrate, float differentiate by `phases`, float gain
const filterAmp = f32(f32(0.75) / phases);
const integ = new Float32Array(len + phases);
integ[0] = sincF[0];
for (let i = 1; i < len; i++) integ[i] = f32(integ[i - 1] + sincF[i]);
for (let i = len; i < len + phases; i++) integ[i] = integ[len - 1];
const t1 = t0 + 1;
const pre = new Float32Array(phases * t1);
for (let i = 0; i < phases; i++) pre[i] = integ[i];
for (let i = phases; i < phases * t1; i++) pre[i] = f32(integ[i] - integ[i - phases]);
for (let i = 0; i < phases * t1; i++) pre[i] = f32(pre[i] * filterAmp);
if (t1 !== taps) fail("tap count bookkeeping");
// interleave: phase-major rows of `taps`
const inter = new Float32Array(phases * taps);
for (let t = 0; t < taps; t++) for (let p = 0; p < phases; p++) inter[p * taps + t] = pre[t * phases + p];
// quantise: float * 0x7fff is a FLOAT multiply, then + 0.5 in double
const bank = new Int16Array(phases * taps);
for (let i = 0; i < bank.length; i++) bank[i] = Math.floor(f32(inter[i] * 0x7fff) + 0.5);

// ---- DutyUnit tables (duty_unit.cpp) ----
expectFrag("duty", "return 0x7EE18180 >> (duty * 8 + pos) & 1;");
expectFrag("duty", "return (2048 - freq) * 2;");
function carray(k, name) {
  const mm = text[k].match(new RegExp(`${name}\\[[^\\]]*\\] = \\{([^}]*)\\}`));
  if (!mm) fail(`${files[k]}: array ${name} not found`);
  return mm[1].split(",").map((s) => s.trim()).filter(Boolean).map(Number);
}
const nextStateDistance = carray("duty", "nextStateDistance");
const dutyInc = carray("duty", "inc");
if (nextStateDistance.length !== 32 || dutyInc.length !== 8) fail("duty table sizes");

// ---- power-on SPU state (initstate.cpp setInitState) ----
for (const frag of [
  "state.cpu.cycleCounter = cgb ? 0x102A0 : 0x102A0 + 0x8D2C;",
  "state.spu.cycleCounter = (cgb ? 0x1E00 : 0x2400) | (state.cpu.cycleCounter >> 1 & 0x1FF);",
  "state.spu.ch1.sweep.counter = SoundUnit::counter_disabled; state.spu.ch1.sweep.shadow = 0; state.spu.ch1.sweep.nr0 = 0; state.spu.ch1.sweep.negging = false;",
  "state.spu.ch1.duty.nextPosUpdate = (state.spu.cycleCounter & ~1ul) + 37 * 2; state.spu.ch1.duty.pos = 6; state.spu.ch1.duty.high = true;",
  "state.spu.ch1.duty.nextPosUpdate = (state.spu.cycleCounter & ~1ul) + 69 * 2; state.spu.ch1.duty.pos = 3; state.spu.ch1.duty.high = false;",
  "state.spu.ch1.duty.nr3 = 0xC1; state.spu.ch1.env.counter = SoundUnit::counter_disabled; state.spu.ch1.env.volume = 0; state.spu.ch1.lcounter.counter = SoundUnit::counter_disabled; state.spu.ch1.lcounter.lengthCounter = 0x40; state.spu.ch1.nr4 = 0x07; state.spu.ch1.master = true;",
  "state.spu.ch2.duty.nextPosUpdate = SoundUnit::counter_disabled; state.spu.ch2.duty.nr3 = 0; state.spu.ch2.duty.pos = 0; state.spu.ch2.duty.high = false; state.spu.ch2.env.counter = SoundUnit::counter_disabled; state.spu.ch2.env.volume = 0; state.spu.ch2.lcounter.counter = SoundUnit::counter_disabled; state.spu.ch2.lcounter.lengthCounter = 0x40; state.spu.ch2.nr4 = 0; state.spu.ch2.master = false;",
  "std::memcpy(state.spu.ch3.waveRam.ptr, state.mem.ioamhram.get() + 0x130, 0x10); state.spu.ch3.lcounter.counter = SoundUnit::counter_disabled; state.spu.ch3.lcounter.lengthCounter = 0x100; state.spu.ch3.waveCounter = SoundUnit::counter_disabled; state.spu.ch3.lastReadTime = SoundUnit::counter_disabled; state.spu.ch3.nr3 = 0; state.spu.ch3.nr4 = 0; state.spu.ch3.wavePos = 0; state.spu.ch3.sampleBuf = 0; state.spu.ch3.master = false;",
  "state.spu.ch4.lfsr.counter = state.spu.cycleCounter + 4; state.spu.ch4.lfsr.reg = 0xFF; state.spu.ch4.env.counter = SoundUnit::counter_disabled; state.spu.ch4.env.volume = 0; state.spu.ch4.lcounter.counter = SoundUnit::counter_disabled; state.spu.ch4.lcounter.lengthCounter = 0x40; state.spu.ch4.nr4 = 0; state.spu.ch4.master = false;",
]) expectFrag("initstate", frag);
const spuInit = (cgb) => {
  const cpuCc = cgb ? 0x102A0 : 0x102A0 + 0x8D2C;
  const spuCc = ((cgb ? 0x1E00 : 0x2400) | ((cpuCc >>> 1) & 0x1FF)) >>> 0;
  return {
    cpuCycleCounter: cpuCc, spuCycleCounter: spuCc,
    ch1: {
      dutyNextPosUpdate: (spuCc & ~1) + (cgb ? 37 : 69) * 2, dutyPos: cgb ? 6 : 3, dutyHigh: cgb ? 1 : 0,
      nr3: 0xC1, lengthCounter: 0x40, nr4: 0x07, master: 1,
    },
    ch2: { lengthCounter: 0x40 },
    ch3: { lengthCounter: 0x100 },
    ch4: { lfsrCounter: spuCc + 4, lfsrReg: 0xFF, lengthCounter: 0x40 },
  };
};

// ---- provenance ----
let commit = null, remote = null;
try {
  commit = revParseHead(root);
  remote = commit === null ? null : remoteUrl(root, "origin");
} catch { /* not a checkout: provenance records the hashes only */ }

const json = {
  provenance: {
    source: "gambatte-libretro: libgambatte/libretro/blipper.c + libretro.cpp (audio_resampler_init), libgambatte/src/sound/duty_unit.cpp, libgambatte/src/initstate.cpp (setInitState, spu)",
    repository: remote, commit,
    sourceSha256: sha,
    generator: "scripts/recompile-gen/gen-gb-apu.mjs",
    generatedAt: new Date().toISOString(),
  },
  blipper: {
    taps, phases, cutoff, beta, sampleRate,
    fixedPoint: true,
    bufferSamples: 1024 + 512,
    // int16 little-endian, phase-major: bank[phase * taps + tap]
    filterBank: Buffer.from(bank.buffer).toString("hex"),
    filterBankSha256: createHash("sha256").update(Buffer.from(bank.buffer)).digest("hex"),
  },
  duty: { outStates: 0x7EE18180, nextStateDistance, inc: dutyInc },
  initstate: { cgb: spuInit(true), dmg: spuInit(false) },
};
writeFileSync(out, JSON.stringify(json, null, 1) + "\n");
console.log(`gen-gb-apu: wrote ${out} (filter bank ${bank.length} taps, sha256 ${json.blipper.filterBankSha256.slice(0, 16)})`);
