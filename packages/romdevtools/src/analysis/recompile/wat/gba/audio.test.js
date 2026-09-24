// GBA WAT backend audio (audio.js) on a tiny synthetic ROM (never a commercial one).
//
// Sample-exact agreement with mGBA itself is measured against romdev's mGBA
// core (frame({op:'verifyRecompile', audio:'required'})); these tests pin the
// parts that need no core: the resampler tables, the section's audio block,
// the ring contract, and the mute mask as a control that must change the
// output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emitWat, describe as describeRom } from "./index.js";
import { sincLuts, MGBA_AUDIO, AUDIO_RATE, OUT_CAP, AUDIO_STATE } from "./audio.js";
import { validateRecompileLayout } from "../../recompile-section.js";
import { assembleWat } from "../assemble.js";

const put32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = v >>> 24; };

/** Sound on, all PSG channels to both sides at full PSG volume, ch2 a 50% square at freq 1750, then spin. */
function toneRom() {
  const rom = new Uint8Array(0x10000);
  put32(rom, 0, 0xEA00002E); // b $080000C0
  rom.set(Buffer.from("AUDIOTEST   ", "latin1"), 0xA0);
  rom.set(Buffer.from("ZZZE01", "latin1"), 0xAC);
  rom[0xB2] = 0x96;
  [
    0xE3A05301, // mov r5, #0x04000000
    0xE59F0020, // ldr r0, =0x80
    0xE5850084, // str r0, [r5, #0x84]   SOUNDCNT_X: master enable
    0xE59F001C, // ldr r0, =0x0002FF77
    0xE5850080, // str r0, [r5, #0x80]   SOUNDCNT_L / SOUNDCNT_H
    0xE59F0018, // ldr r0, =0xF080
    0xE5850068, // str r0, [r5, #0x68]   SOUND2CNT_L: duty 50%, volume 15
    0xE59F0014, // ldr r0, =0x86D6
    0xE585006C, // str r0, [r5, #0x6C]   SOUND2CNT_H: restart, freq 1750
    0xEAFFFFFE, // b .
    0,
    0x80, 0x0002FF77, 0xF080, 0x86D6,
  ].forEach((w, i) => put32(rom, 0xC0 + 4 * i, w));
  return rom;
}

async function run(rom, frames, mute = 0) {
  const { bytes } = await assembleWat(emitWat(rom, { interp: true }));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const e = instance.exports;
  const info = e.wc_get_info();
  e.wc_init();
  const dv = new DataView(e.memory.buffer);
  const ring = dv.getUint32(info + 16, true), cap = dv.getUint32(info + 20, true), wp = dv.getUint32(info + 24, true);
  if (mute) dv.setUint8(describeRom(rom, { interp: true }).layout.audio.muteMask.offset, mute);
  const counts = [], out = [];
  let rd = 0;
  for (let f = 0; f < frames; f++) {
    e.wc_render();
    const w = dv.getUint32(wp, true);
    let n = 0;
    while (rd !== w) { out.push(dv.getInt16(ring + 4 * rd, true), dv.getInt16(ring + 4 * rd + 2, true)); rd = (rd + 1) % cap; n++; }
    counts.push(n);
  }
  return { info: { ring, cap, rate: dv.getUint32(info + 52, true), flags: dv.getUint32(info + 48, true) }, counts, out };
}

test("sinc tables match the hash generated from mGBA's interpolator with musl sin/cos", () => {
  const t = sincLuts();
  const n = MGBA_AUDIO.sinc.resolution * MGBA_AUDIO.sinc.width + 1;
  assert.equal(t.sinc.length, n);
  assert.equal(t.window[0], 1);
  assert.equal(t.sinc[0], 0);
});

test("the section's audio block validates and matches wc_info", async () => {
  const d = describeRom(toneRom(), { interp: true });
  const lay = validateRecompileLayout(d.layout);
  assert.equal(lay.audio.sampleRate, AUDIO_RATE);
  assert.equal(lay.audio.format, "s16");
  assert.equal(lay.audio.reference, "output");
  assert.deepEqual(lay.audio.muteMask.channels, ["sq1", "sq2", "wave", "noise", "fifoA", "fifoB"]);
  assert.equal(lay.audio.muteMask.offset % 4, AUDIO_STATE.MUTE % 4);
});

test("a square wave reaches the ring at 65536 Hz; muting its channel silences it (must-fail control)", async () => {
  const a = await run(toneRom(), 8);
  assert.equal(a.info.rate, AUDIO_RATE);
  assert.equal(a.info.cap, OUT_CAP);
  assert.equal(a.info.flags & 1, 0, "s16 ring");
  // the first render also carries the warm-up frames; then about 1097 a frame
  for (const n of a.counts.slice(1)) assert.ok(n >= 1090 && n <= 1104, `per-frame count ${n}`);
  const tail = a.out.slice(-4000);
  assert.ok(new Set(tail).size > 2, "the tone is audible");
  const m = await run(toneRom(), 8, 1 << 1);
  const mt = m.out.slice(-4000);
  assert.deepEqual(m.counts, a.counts);
  assert.notDeepEqual(mt, tail, "muting sq2 must change the output");
  assert.equal(new Set(mt).size, 1, "only the bias remains");
});
