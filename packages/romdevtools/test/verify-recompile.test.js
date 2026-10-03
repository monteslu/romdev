// frame({op:'verifyRecompile'}) and the recompile mode of findDiverge, driven
// end to end with a SYNTHETIC cart (a tiny WAT module assembled in-process and
// run by the real WasmcartHost) against a JS "reference core" that computes
// the same machine. Both render a moving picture that depends on the frame
// count since power-on AND on the input, so frame alignment, button mapping,
// the scores and every control are exercised for real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleWatSync } from "../src/analysis/recompile/wat/assemble.js";
import { WasmcartHost } from "../src/host/WasmcartHost.js";
import {
  verifyRecompile, findRecompileDivergence, parseInputSchedule, shiftSchedule, scorePictures,
  resolveOrigin, wrongInputSchedule, ScheduleDriver, fuzzRecompile,
} from "../src/host/verify-recompile.js";
import {
  readRecompileLayout, validateRecompileLayout, withRecompileSection, wascFromWasm, cartWasmBytes,
  readCustomSections, RECOMPILE_SECTION,
} from "../src/analysis/recompile/recompile-section.js";

const W = 64, H = 48, INFO = 1024, INPUT = 1280, TIME = 1408, VRAM = 2048, FB = 4096;
const vramPattern = Array.from({ length: 256 }, (_, i) => ((i * 37 + (i >> 3)) & 0x0f) * 16);

// The machine both sides model. RAM (linear 0..15): u32 frame, u32 x, u32 south
// presses, u32 spare. Each frame: frame++, RIGHT moves x, SOUTH counts. The
// picture scrolls with frame + x + 8*presses, so a wrong frame OR a wrong
// input moves every pixel; a white bar marks frame % W and the player column
// is green. With no input the picture repeats every 512 frames.
function cartWat({ inputPtr = INPUT, timePtr = TIME, southBit = 0, bootDelay = 0, still = false } = {}) {
  const hex = vramPattern.map((b) => "\\" + b.toString(16).padStart(2, "0")).join("");
  // bootDelay: the cart's machine starts that many frames BEHIND power-on
  // (the frame counter begins negative), like a recompiled cart whose boot
  // takes a game-dependent number of frames longer than the reference's.
  const f0 = (-bootDelay >>> 0).toString(16).padStart(8, "0").match(/../g).reverse().map((b) => "\\" + b).join("");
  const fr = still ? "(i32.const 0)" : "(local.get $f)";
  return `(module
  (memory (export "memory") 1)
  (data (i32.const ${VRAM}) "${hex}")
  (data (i32.const 0) "${f0}")
  (func (export "wc_get_info") (result i32)
    (i32.store (i32.const ${INFO}) (i32.const 4))
    (i32.store (i32.const ${INFO + 4}) (i32.const ${W}))
    (i32.store (i32.const ${INFO + 8}) (i32.const ${H}))
    (i32.store (i32.const ${INFO + 12}) (i32.const ${FB}))
    (i32.store (i32.const ${INFO + 28}) (i32.const ${inputPtr}))
    (i32.store (i32.const ${INFO + 40}) (i32.const ${timePtr}))
    (i32.const ${INFO}))
  (func (export "wc_init"))
  (func (export "wc_render")
    (local $b i32) (local $f i32) (local $x i32) (local $i i32) (local $col i32) (local $row i32) (local $c i32)
    (local.set $b (if (result i32) (i32.eqz (i32.const ${inputPtr})) (then (i32.const 0)) (else (i32.load16_u (i32.const ${inputPtr})))))
    (local.set $f (i32.add (i32.load (i32.const 0)) (i32.const 1)))
    (i32.store (i32.const 0) (local.get $f))
    (local.set $x (i32.load (i32.const 4)))
    (if (i32.and (local.get $b) (i32.const ${1 << 11})) (then (local.set $x (i32.add (local.get $x) (i32.const 1)))))
    (i32.store (i32.const 4) (local.get $x))
    (if (i32.and (local.get $b) (i32.const ${1 << southBit}))
      (then (i32.store (i32.const 8) (i32.add (i32.load (i32.const 8)) (i32.const 1)))))
    (local.set $i (i32.const 0))
    (block $done (loop $px
      (br_if $done (i32.ge_u (local.get $i) (i32.const ${W * H})))
      (local.set $col (i32.rem_u (local.get $i) (i32.const ${W})))
      (local.set $row (i32.div_u (local.get $i) (i32.const ${W})))
      (local.set $c
        (if (result i32) (i32.eq (local.get $col) (i32.rem_u ${fr} (i32.const ${W})))
          (then (i32.const 0xFFFFFF))
          (else (if (result i32) (i32.eq (local.get $col) (i32.rem_u (local.get $x) (i32.const ${W})))
            (then (i32.or (i32.const 0x00FF00) (i32.and (i32.load (i32.const 8)) (i32.const 0xFF))))
            (else (i32.mul (i32.const 0x010101)
              (i32.load8_u (i32.add (i32.const ${VRAM})
                (i32.and (i32.add (i32.mul (local.get $row) (i32.const 8))
                  (i32.shr_u (i32.add (i32.add (i32.add (local.get $col) ${fr}) (local.get $x))
                    (i32.shl (i32.load (i32.const 8)) (i32.const 3))) (i32.const 1)))
                  (i32.const 255))))))))))
      (i32.store (i32.add (i32.const ${FB}) (i32.shl (local.get $i) (i32.const 2))) (local.get $c))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $px))))
)`;
}

function cartBytes(opts = {}, layout = null) {
  const wasm = assembleWatSync(cartWat(opts));
  return layout ? withRecompileSection(wasm, layout) : wasm;
}

async function openCartFrom(wasm) {
  const h = new WasmcartHost();
  await h.loadMedia({ platform: "wasmcart", bytes: wascFromWasm(wasm, "synthetic") });
  return h;
}

// A JS stand-in for a libretro core running the SAME machine: libretro names,
// 5 settle frames at load, named memory regions.
class FakeCore {
  constructor({ bugAtTotalFrame = null, still = false } = {}) {
    this.still = still;
    this.ram = new Uint8Array(64);
    this.vram = Uint8Array.from(vramPattern);
    this.bugAt = bugAtTotalFrame;
    this.input = {};
    this.status = { platform: "fake", loaded: true, frameCount: 0, settleFramesUsed: 5, fbWidth: W, fbHeight: H };
    for (let i = 0; i < 5; i++) this._frame();
  }
  _u32(o) { return this.ram[o] | (this.ram[o + 1] << 8) | (this.ram[o + 2] << 16) | (this.ram[o + 3] << 24); }
  _set(o, v) { for (let k = 0; k < 4; k++) this.ram[o + k] = (v >>> (8 * k)) & 0xff; }
  _frame() {
    const f = this._u32(0) + 1;
    this._set(0, f);
    if (this.input.right) this._set(4, this._u32(4) + 1);
    if (this.input.b || this.input.south) this._set(8, this._u32(8) + 1);
    if (this.bugAt != null && f === this.bugAt) this.ram[12] = 0x55;
  }
  setInput({ ports }) { this.input = { ...(ports[0] ?? {}) }; }
  stepFrames(n) { for (let i = 0; i < n; i++) { this._frame(); this.status.frameCount++; } return n; }
  screenshotRgba() {
    const f = this.still ? 0 : this._u32(0), x = this._u32(4), presses = this._u32(8);
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const col = i % W, row = Math.floor(i / W);
      let c;
      if (col === f % W) c = 0xffffff;
      else if (col === x % W) c = 0x00ff00 | (presses & 0xff);
      else c = 0x010101 * this.vram[(row * 8 + ((col + f + x + presses * 8) >>> 1)) & 255];
      rgba[i * 4] = (c >> 16) & 0xff; rgba[i * 4 + 1] = (c >> 8) & 0xff; rgba[i * 4 + 2] = c & 0xff; rgba[i * 4 + 3] = 0xff;
    }
    return { width: W, height: H, rgba };
  }
  regionSize(r) { return r === "system_ram" ? 64 : r === "video_ram" ? 256 : 0; }
  readMemory(r, off, len) { return (r === "system_ram" ? this.ram : this.vram).slice(off, off + len); }
  dispose() {}
}

const LAYOUT = validateRecompileLayout({
  platform: "fake", buttons: "positional",
  regions: { ram: { offset: 0, length: 16, ref: "system_ram" }, vram: { offset: VRAM, length: 256, ref: "video_ram" } },
  fields: { frame: { offset: 0, size: 4, ref: "system_ram+0" }, x: { offset: 4, size: 4, ref: { region: "system_ram", offset: 4 } } },
});
const INPUTS = "10:right:20,40:b:3,60:right+b:10,90:right:25";
const BAR = { minContentPx: 1000, minMovingPx: 100 };

function run(overrides = {}, { cart = cartBytes(), core = {} } = {}) {
  return verifyRecompile({
    openCart: () => openCartFrom(cart), openRef: async () => new FakeCore(core), refPlatform: "fake",
    layout: LAYOUT, frames: [30, 70, 120], input: INPUTS, bar: BAR, ...overrides,
  });
}

function dispose(r) { r.cartHost.destroy?.(); r.refHost.dispose?.(); }

test("a correct cart VERIFIES: aligned by the computed offset, every region equal, every control fails", async () => {
  const r = await run({ sweep: 2 });
  try {
    const v = r.result;
    assert.equal(v.verdict, "VERIFIED", JSON.stringify(v.reasons));
    assert.equal(v.alignment.offset, 4, "core settle 5 - wasmcart settle 1 - warmup 0");
    assert.equal(v.alignment.source, "computed");
    for (const row of v.frames) {
      assert.equal(row.exactPct, 100);
      assert.equal(row.contentPct, 100);
      assert.ok(row.movingTotal > 100, "the picture moves, so the moving score carries weight");
      assert.equal(row.regions.ram.differ, 0);
      assert.equal(row.regions.vram.differ, 0);
      assert.equal(row.fields.frame.same, true);
      assert.equal(row.peak.d, 0, "the sweep peaks at the aligned frame");
      assert.ok(row.sharpness > 0, "and the peak is sharp");
    }
    for (const c of ["vramZero", "wrongFrame", "wrongInput"]) assert.equal(v.controls[c].failed, true, `${c} must fail`);
    assert.match(v.table, /\| 120 \| 124 \| 100% \|/);
  } finally { dispose(r); }
});

test("the same libretro name presses the same PHYSICAL button on the cart (positional mapping)", async () => {
  // A cart that read WC_BTN_A by NAME would see libretro 'a' as its south
  // button. Simulate the old by-name host by renaming b->a for the cart side:
  // the south presses now miss the cart, and the verifier must say so.
  const r = await run({ cartButtonMap: { b: "a" }, controls: [] });
  try {
    assert.equal(r.result.verdict, "NOT VERIFIED");
    const late = r.result.frames.find((f) => f.refFrame === 70);
    assert.ok(late.regions.ram.differ > 0, "the south-press counter diverged");
  } finally { dispose(r); }
});

test("a wrong frame offset is caught, and the sweep points at the right one", async () => {
  const r = await run({ cartFrameOffset: 3, sweep: 2, controls: [] });
  try {
    assert.equal(r.result.verdict, "NOT VERIFIED");
    assert.equal(r.result.alignment.source, "caller");
    // Input also reaches the cart a frame early, so check a frame before any press.
    const r2 = await run({ cartFrameOffset: 3, sweep: 2, controls: [], frames: [8], input: "" });
    try { assert.equal(r2.result.frames[0].peak.d, 1, "cart frame F+3+1 is the reference's F"); }
    finally { dispose(r2); }
  } finally { dispose(r); }
});

test("a control that cannot fail blocks the verdict (a still picture, no state to compare)", async () => {
  // With no input the picture repeats every 512 frames, so a reference 512
  // frames away is pixel-identical, and with no compared regions there is no
  // state signal either: the control CANNOT fail and must be reported as such
  // rather than counted.
  const layout = validateRecompileLayout({ ...LAYOUT, regions: {}, fields: {} });
  const r = await run({ input: "", controls: ["wrongFrame"], wrongFrameDelta: 512, frames: [600, 610], layout });
  try {
    assert.equal(r.result.controls.wrongFrame.failed, false);
    assert.equal(r.result.controls.wrongFrame.signal, "none");
    assert.equal(r.result.controls.wrongFrame.changeRegion.changedPx, 0);
    assert.match(r.result.controls.wrongFrame.couldNotFail, /changes in only 0 px/);
    assert.equal(r.result.verdict, "NOT VERIFIED");
    assert.match(r.result.reasons.join(" "), /control wrongFrame did NOT fail/);
  } finally { dispose(r); }
});

test("wrong frame on a STILL screen fails by state: the frame counter moved, the picture did not", async () => {
  // Picture frozen on both sides (a still title), RAM frame counter running:
  // no pixel can tell frames apart, the compared RAM can.
  const r = await run({ input: "", controls: ["wrongFrame"], frames: [200, 300] }, { cart: cartBytes({ still: true }), core: { still: true } });
  try {
    const c = r.result.controls.wrongFrame;
    assert.equal(c.changeRegion.changedPx, 0, "nothing moved in the reference");
    assert.equal(c.failed, true);
    assert.equal(c.signal, "state");
    assert.ok(c.state.wrongFrameBytesDiffer > 0);
  } finally { dispose(r); }
});

test("wrong frame on a nearly-static screen is decided on the pixels that changed, at the delta that changed most", async () => {
  // Only the white frame bar and the scroll move; the whole-picture content
  // score of a wrong frame stays high, the changed-region score does not.
  const layout = validateRecompileLayout({ ...LAYOUT, regions: {}, fields: {} });
  const r = await run({ input: "", controls: ["wrongFrame"], frames: [300], layout });
  try {
    const c = r.result.controls.wrongFrame;
    assert.equal(c.signal, "pixels-changed-region", JSON.stringify(c));
    assert.equal(c.failed, true);
    assert.ok(c.changeRegion.rightMatchPct >= 99, "the cart matches the RIGHT frame where the two differ");
    assert.ok(c.changeRegion.wrongMatchPct < 95);
    const most = Math.max(...c.tried.map((t) => t.changedPx));
    assert.equal(c.changeRegion.changedPx, most, "the delta with the most reference change was used");
  } finally { dispose(r); }
});

test("wrong-input control is skipped (not faked) when there is no input schedule", async () => {
  const r = await run({ input: "", controls: ["wrongInput"] });
  try { assert.match(r.result.controls.wrongInput.skipped, /no input schedule/); }
  finally { dispose(r); }
});

test("a probe `trapped` field fails the verdict", async () => {
  const layout = { ...LAYOUT, probe: { trapped: { offset: 8, size: 4 } } }; // the south counter stands in for a trap flag
  const r = await run({ layout, controls: [] });
  try {
    assert.equal(r.result.verdict, "NOT VERIFIED");
    assert.match(r.result.reasons.join(" "), /trapped/);
  } finally { dispose(r); }
});

test("a region difference fails the verdict by default; requireStateMatch:false only reports it", async () => {
  const layout = validateRecompileLayout({ ...LAYOUT, regions: { ...LAYOUT.regions, spare: { offset: 12, length: 4, ref: "system_ram", refOffset: 8 } } });
  const r = await run({ layout, controls: [] });
  try {
    assert.equal(r.result.stateIdentical, false);
    assert.equal(r.result.verdict, "NOT VERIFIED", "matching pixels over differing memory is not verified");
    assert.match(r.result.reasons.join(" "), /state differs: .*spare/);
  } finally { dispose(r); }
  const r2 = await run({ layout, controls: [], requireStateMatch: false });
  try {
    assert.equal(r2.result.verdict, "VERIFIED", "explicit opt-out: pixels decide");
    assert.ok(r2.result.stateDiffs.some((d) => /spare/.test(d)));
  } finally { dispose(r2); }
});

test("findDiverge (recompile): identical run is no-divergence; an injected fault is found at its exact frame", async () => {
  const ok = await findRecompileDivergence({
    cartHost: await openCartFrom(cartBytes()), refHost: new FakeCore(), refPlatform: "fake",
    layout: LAYOUT, input: INPUTS, maxFrames: 150,
  });
  assert.equal(ok.diverged, false);
  assert.equal(ok.conclusion, "no-observed-divergence");
  assert.equal(ok.framesCompared, 150);

  // The reference writes RAM[12] on its 57th frame since power-on = reference
  // frame 52 (5 settle frames). The differ must name that frame and byte.
  const bad = await findRecompileDivergence({
    cartHost: await openCartFrom(cartBytes()), refHost: new FakeCore({ bugAtTotalFrame: 57 }), refPlatform: "fake",
    layout: LAYOUT, input: INPUTS, maxFrames: 150,
  });
  assert.equal(bad.diverged, true);
  assert.equal(bad.atRefFrame, 52);
  assert.equal(bad.atCartFrame, 56);
  assert.equal(bad.lastIdenticalRefFrame, 51);
  assert.deepEqual(bad.regions.map((x) => [x.region, x.firstDiff.offset]), [["ram", 12]]);

  const idle = await findRecompileDivergence({
    cartHost: await openCartFrom(cartBytes()), refHost: new FakeCore(), refPlatform: "fake",
    layout: { regions: { vram: LAYOUT.regions.vram } }, maxFrames: 20,
  });
  assert.equal(idle.conclusion, "inconclusive-no-observed-state-change", "a region that never changes proves nothing");
});

test("romdev.recompile section: written, read back from .wasm and .wasc, validated", () => {
  const wasm = cartBytes({}, { platform: "fake", warmupFrames: 2, regions: LAYOUT.regions, fields: LAYOUT.fields });
  assert.equal(readCustomSections(wasm, RECOMPILE_SECTION).length, 1);
  const fromWasm = readRecompileLayout(wasm);
  assert.equal(fromWasm.warmupFrames, 2);
  assert.equal(fromWasm.regions.vram.offset, VRAM);
  const wasc = wascFromWasm(wasm);
  assert.deepEqual(readRecompileLayout(wasc), fromWasm);
  assert.equal(cartWasmBytes(wasc).length, wasm.length);
  assert.equal(readRecompileLayout(cartBytes()), null, "a cart without the section reads as null, not {}");
  assert.throws(() => validateRecompileLayout({ regions: { v: { offset: 0, length: 4 } } }), /ref must name/);
  assert.throws(() => validateRecompileLayout({ regions: { v: { offset: 0, length: 4, ref: "x", transform: "rot13" } } }), /transform/);
  assert.throws(() => validateRecompileLayout({ version: 2, regions: {} }), /version 2/);
  assert.throws(() => validateRecompileLayout({ regions: {}, vramZero: ["nope"] }), /vramZero/);
  assert.throws(() => validateRecompileLayout({ regions: {}, fields: { pc: { offset: 0, ref: "bad ref!" } } }), /ref/);
});

test("warmupFrames in the section moves the computed offset", async () => {
  const r = await run({ layout: { ...LAYOUT, warmupFrames: 1 }, frames: [8], input: "", controls: [], sweep: 1 });
  try {
    assert.equal(r.result.alignment.offset, 3);
    assert.equal(r.result.verdict, "NOT VERIFIED", "this cart does NOT run a warm-up frame, so declaring one misaligns it");
    assert.equal(r.result.frames[0].peak.d, 1);
  } finally { dispose(r); }
});

test("WasmcartHost maps libretro names by POSITION (b=south=WC_A, a=east=WC_B) and accepts spatial names", () => {
  const h = new WasmcartHost();
  const bits = (p) => h._padFromInput(p).buttons;
  assert.equal(bits({ b: true }), 1 << 0);
  assert.equal(bits({ a: true }), 1 << 1);
  assert.equal(bits({ y: true }), 1 << 2);
  assert.equal(bits({ x: true }), 1 << 3);
  assert.equal(bits({ south: true }), 1 << 0);
  assert.equal(bits({ east: true }), 1 << 1);
  assert.equal(bits({ west: true }), 1 << 2);
  assert.equal(bits({ north: true }), 1 << 3);
  assert.equal(bits({ start: true, right: true }), (1 << 6) | (1 << 11));
});

test("WasmcartHost does not write pads/clock through a zero inputPtr/timePtr, and conformance fails it", async () => {
  const h = await openCartFrom(cartBytes({ inputPtr: 0, timePtr: 0 }));
  try {
    assert.deepEqual(h.status.abiWarnings.map((w) => w.code).sort(), ["input-ptr-zero", "time-ptr-zero"]);
    h.setInput({ ports: [{ start: true, b: true, right: true }] });
    h.stepFrames(9);
    // Linear 0 is the cart's frame counter: 1 settle + 9 frames, untouched by the host.
    const ram = h.readMemory(0, 16);
    assert.equal(ram[0] | (ram[1] << 8), 10);
    assert.deepEqual([...ram.slice(4, 16)], new Array(12).fill(0), "no pad bytes or clock landed on the emulated RAM");
    const c = h.checkConformance();
    assert.equal(c.conforms, false);
    assert.ok(c.issues.some((i) => i.code === "input-ptr-zero"));
    assert.ok(c.issues.some((i) => i.code === "time-ptr-zero"));
  } finally { h.destroy(); }
  const m = await openCartFrom(cartBytes({ timePtr: TIME + 4 }));
  try {
    assert.deepEqual(m.status.abiWarnings.map((w) => w.code), ["time-ptr-misaligned"]);
    assert.ok(m.checkConformance().issues.some((i) => i.code === "time-ptr-misaligned"));
  } finally { m.destroy(); }
});

test("scoring: content ignores the backdrop, moving needs the previous frame, BLANK/INCONCLUSIVE are not numbers", () => {
  const pic = (w, h, f) => { const rgba = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { const c = f(i % w, Math.floor(i / w)); rgba[i * 4] = c; rgba[i * 4 + 3] = 255; } return { width: w, height: h, rgba }; };
  const ref = pic(10, 10, (x) => (x < 2 ? 200 : 0));          // 20 content px on a black backdrop
  const cart = pic(10, 10, (x) => (x < 1 ? 200 : 0));         // half the content
  const s = scorePictures(cart, ref, { x: 0, y: 0 });
  assert.equal(s.contentTotal, 20);
  assert.equal(s.contentPct, 50);
  assert.equal(s.exactPct, 90);
  assert.equal(s.movingPct, null, "no previous frame, no moving score");
  const prev = pic(10, 10, () => 0);
  const m = scorePictures(cart, ref, { x: 0, y: 0 }, prev);
  assert.equal(m.movingTotal, 20);
  assert.equal(m.movingPct, 50);
  assert.equal(scorePictures(pic(10, 10, () => 7), ref, { x: 0, y: 0 }).status, "BLANK");
  assert.equal(scorePictures(cart, pic(10, 10, () => 0), { x: 0, y: 0 }).status, "INCONCLUSIVE");
  // origin: a 4x2 reference centred in a 10x10 cart framebuffer; misfit refused.
  assert.deepEqual(resolveOrigin(pic(10, 10, () => 0), pic(4, 2, () => 0)), { x: 3, y: 4, source: "centred" });
  assert.throws(() => resolveOrigin(pic(4, 4, () => 0), pic(10, 2, () => 0)), /does not fit/);
});

test("input schedule: compact string and object forms, shifting, edges applied before the frame", async () => {
  const a = parseInputSchedule("5:a+right:3,1:start:2");
  assert.deepEqual(a, [{ frame: 1, buttons: ["start"], hold: 2 }, { frame: 5, buttons: ["a", "right"], hold: 3 }]);
  assert.deepEqual(parseInputSchedule([{ frame: 2, buttons: { b: true, up: false }, hold: 1 }]), [{ frame: 2, buttons: ["b"], hold: 1 }]);
  assert.throws(() => parseInputSchedule("5:a"), /frame:buttons:hold/);
  assert.deepEqual(shiftSchedule(a, -2), [{ frame: 0, buttons: ["start"], hold: 1 }, { frame: 3, buttons: ["a", "right"], hold: 3 }]);
  const log = [];
  const host = { status: { frameCount: 0 }, setInput: ({ ports }) => log.push([host.status.frameCount, Object.keys(ports[0]).join("+")]), stepFrames(n) { host.status.frameCount += n; } };
  const d = new ScheduleDriver(host, a, { a: "b" });
  await d.to(10);
  assert.deepEqual(log, [[0, ""], [1, "start"], [3, ""], [5, "b+right"], [8, ""]]);
  const alt = wrongInputSchedule(parseInputSchedule("100:start:5,200:right:50"), 400);
  assert.ok(alt.some((p) => p.buttons.includes("start") && p.frame === 100), "start presses are kept");
  assert.ok(!alt.some((p) => p.frame === 200 && p.buttons.join() === "right" && p.hold === 50), "play presses are replaced");
});

test("frame tool: verifyRecompile needs atFrames (or auto); step takes count as an alias; trace formats are routed", async () => {
  const { z } = await import("zod");
  const { registerFrameTools } = await import("../src/mcp/tools/frame.js");
  const { _setHostForTest, clearHost } = await import("../src/mcp/state.js");
  const key = "verify-recompile-dispatch", tools = {};
  registerFrameTools({ tool: (n, _d, _s, h) => { tools[n] = h; } }, z, key);
  const host = { status: { platform: "fake", loaded: true, frameCount: 0, fbWidth: 1, fbHeight: 1 }, stepFrames(n) { this.status.frameCount += n; return n; } };
  _setHostForTest(key, host);
  try {
    const cart = new URL("./fixtures/hello.wasc", import.meta.url).pathname;
    // Omitted atFrames means auto mode; auto:false restores the error.
    const r = await tools.frame({ op: "verifyRecompile", cart, reference: cart, platform: "nes", auto: false });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /pass atFrames/);
    const both = await tools.frame({ op: "verifyRecompile", cart, reference: cart, platform: "nes", auto: true, atFrames: [100] });
    assert.equal(both.isError, true);
    assert.match(both.content[0].text, /auto mode chooses atFrames itself/);
    const unknown = await tools.frame({ op: "verifyRecompile", cart, reference: cart, platform: "nes", auto: { seed: 2, sampleEvery: 30, bogus: 1 } });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /unknown auto option 'bogus'/);
    const s = JSON.parse((await tools.frame({ op: "step", count: 7, frames: 1 })).content[0].text);
    assert.equal(s.framesRun, 7);
    const bad = await tools.frame({ op: "step", count: 7, frames: 3 });
    assert.match(bad.content[0].text, /frames OR count/);
    const shot = await tools.frame({ op: "screenshot", format: "compact", inline: true });
    assert.match(shot.content[0].text, /stepInstructions trace format/);
    const big = await tools.frame({ op: "stepInstructions", count: 5000 });
    assert.match(big.content[0].text, /4096 cap/);
  } finally { clearHost(key); }
});

test("frameAlignment:'search' FINDS a game-dependent boot offset by a sharp picture peak", async () => {
  // The cart boots 7 frames later than the settle arithmetic assumes, so the
  // true offset is 4 + 7 = 11. No input before the search frame.
  const cart = cartBytes({ bootDelay: 7 });
  const layout = { ...LAYOUT, frameAlignment: "search" };
  const r = await run({ layout, frames: [40, 150, 300], input: "60:right:20,100:b:3", searchWindow: 20 }, { cart });
  try {
    const v = r.result;
    assert.equal(v.alignment.source, "search");
    assert.equal(v.alignment.offset, 11);
    assert.equal(v.alignment.computedOffset, 4);
    assert.ok(v.alignment.search.sharpness >= 2, `sharp peak (${v.alignment.search.sharpness})`);
    assert.equal(v.alignment.search.candidates, 41, "cost bound: 2*window+1 scores");
    assert.equal(v.verdict, "VERIFIED", JSON.stringify(v.reasons));
    assert.ok(v.frames.every((f) => f.refinedBy == null && f.cartFrame === f.refFrame + 11));
  } finally { dispose(r); }
  // Without the search, the same cart is (correctly) not verified.
  const r2 = await run({ frames: [40, 150], input: "", controls: [] }, { cart });
  try { assert.equal(r2.result.verdict, "NOT VERIFIED"); } finally { dispose(r2); }
  // cartFrameOffset:'auto' asks for the same search on a cart without the flag.
  const r3 = await run({ cartFrameOffset: "auto", frames: [40], input: "", controls: [], searchWindow: 10 }, { cart });
  try { assert.equal(r3.result.alignment.offset, 11); } finally { dispose(r3); }
});

test("the offset search REFUSES a picture that does not pin a frame, naming the candidates", async () => {
  const cart = cartBytes({ still: true });
  await assert.rejects(
    run({ cartFrameOffset: "auto", frames: [40], input: "", controls: [], searchWindow: 6 }, { cart, core: { still: true } }),
    /offset search refused: \d+ offsets tie.*best candidates/s);
  // A too-high sharpness demand on a good cart is refused too, not guessed.
  await assert.rejects(
    run({ cartFrameOffset: "auto", frames: [40], input: "", controls: [], searchWindow: 6, minSharpness: 101 }),
    /not sharp/);
});

test("compare:false regions are diagnostic: reported, never in stateIdentical or findDiverge", async () => {
  const layout = validateRecompileLayout({ ...LAYOUT, regions: { ...LAYOUT.regions, io: { offset: 12, length: 4, ref: "system_ram", refOffset: 8, compare: false } } });
  const r = await run({ layout, controls: [] });
  try {
    assert.equal(r.result.stateIdentical, true);
    assert.equal(r.result.frames[1].regions.io.diagnostic, true);
    assert.ok(r.result.frames[1].regions.io.differ > 0, "it does differ; it just is not a gate");
    assert.match(r.result.table, /\(diag\)/);
  } finally { dispose(r); }
  const d = await findRecompileDivergence({ cartHost: await openCartFrom(cartBytes()), refHost: new FakeCore(), refPlatform: "fake", layout, input: INPUTS, maxFrames: 80 });
  assert.equal(d.diverged, false);
});

test("a broken cart's reasons name the actual failure, not a missing-evidence message", async () => {
  const r = await run({ controls: [] }, { cart: cartBytes({ still: true }) });
  try {
    assert.equal(r.result.verdict, "NOT VERIFIED");
    assert.match(r.result.reasons[0], /pixels do not match/);
    assert.ok(!r.result.reasons.some((x) => /no scored frame/.test(x)));
  } finally { dispose(r); }
});

test("wrong-input control: withholding all input is tried first; a control no variant can fail says so", async () => {
  const r = await run({ controls: ["wrongInput"] });
  try {
    assert.equal(r.result.controls.wrongInput.variant, "no-input");
    assert.equal(r.result.controls.wrongInput.failed, true);
  } finally { dispose(r); }
  // A "wrong" schedule that differs only by a button this machine ignores.
  const r2 = await run({ controls: ["wrongInput"], wrongInput: `${INPUTS},5:up:3` });
  try {
    assert.equal(r2.result.controls.wrongInput.failed, false);
    assert.match(r2.result.controls.wrongInput.couldNotFail, /no input variant changed the picture/);
    assert.equal(r2.result.verdict, "NOT VERIFIED");
  } finally { dispose(r2); }
});

test("fuzzRecompile reports the first trap frame per seed, and nothing when nothing traps", async () => {
  // the south-press counter stands in for a trap flag: random play presses south sooner or later
  const trapLayout = validateRecompileLayout({ ...LAYOUT, probe: { trapped: { offset: 8, size: 4 } } });
  const r = await fuzzRecompile({ openCart: () => openCartFrom(cartBytes()), layout: trapLayout, frames: 600, seeds: [1, 2] });
  assert.equal(r.verdict, "TRAPPED");
  for (const run of r.runs) {
    assert.equal(run.trapped, true);
    assert.ok(run.atCartFrame > 60 && run.atCartFrame <= 600, `trap after the play script starts (${run.atCartFrame})`);
    assert.ok(run.probe.trapped > 0);
  }
  // control: a probe word nothing writes (offset 12) never reads as a trap
  const quiet = validateRecompileLayout({ ...LAYOUT, probe: { trapped: { offset: 12, size: 4 } } });
  const q = await fuzzRecompile({ openCart: () => openCartFrom(cartBytes()), layout: quiet, frames: 300, seeds: [1] });
  assert.equal(q.verdict, "NO TRAP");
  await assert.rejects(() => fuzzRecompile({ openCart: () => openCartFrom(cartBytes()), layout: validateRecompileLayout({ regions: {} }) }), /probe.trapped/);
});

test("input schedule: 'p2.' addresses controller 2 on both hosts, and a byName map still applies", async () => {
  const s = parseInputSchedule("0:p2.a+b:2,1:p2.start:1");
  assert.deepEqual(s[0].buttons, ["p2.a", "b"]);
  assert.throws(() => parseInputSchedule("0:p5.a:1"), /invalid button name/);
  const seen = [];
  const host = { setInput: (i) => seen.push(JSON.parse(JSON.stringify(i))), stepFrames: async () => {} };
  const d = new ScheduleDriver(host, s, { a: "b", b: "a" });
  await d.to(3);
  assert.deepEqual(seen[0], { ports: [{ a: true }, { b: true }] });
  assert.deepEqual(seen[1], { ports: [{ a: true }, { b: true, start: true }] });
  assert.deepEqual(seen[2], { ports: [{}] });
});
