// frame({op:'verifyRecompile', auto:true}): the deterministic selection logic
// (src/host/auto-verify.js) and the whole auto path end to end with a JS
// "game" that has a still title screen, gameplay that only Start reaches, a
// picture that moves and responds to input, and sound only in gameplay. The
// reference and the cart run the same game; a broken cart must still come out
// NOT VERIFIED.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoCandidates, autoPlan, menuPresses, MENU_PLANS, scheduleToString, sampleGrid, classifyRows, scoreRun,
  pickFrames, pickAudioWindow, isGoodEnough, AUTO_DEFAULTS,
} from "../src/host/auto-verify.js";
import { verifyRecompile, parseInputSchedule, wrongInputSchedule, seededPlay, DEFAULT_BAR } from "../src/host/verify-recompile.js";

// ─── pure selection logic ────────────────────────────────────────────────────

test("candidates are a pure function of (horizon, count, seed)", () => {
  const a = autoCandidates({ horizon: 3600, count: 16, seed: 1 });
  const b = autoCandidates({ horizon: 3600, count: 16, seed: 1 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 16);
  assert.deepEqual(a.map((c) => c.index), Array.from({ length: 16 }, (_, i) => i + 1));
  const c = autoCandidates({ horizon: 3600, count: 16, seed: 2 });
  assert.notDeepEqual(a.map((x) => x.schedule), c.map((x) => x.schedule), "another seed plays differently");
  assert.deepEqual(a.map((x) => x.plan), c.map((x) => x.plan), "but tries the same menu plans in the same order");
  for (const cand of a) {
    for (const p of cand.schedule) assert.ok(p.frame < 3600, "nothing is scheduled past the horizon");
    assert.ok(!cand.schedule.some((p) => p.buttons.includes("start") && p.hold !== 6), "start only comes from the menu phase");
  }
});

test("plans that start too close to the horizon are left out", () => {
  const short = autoCandidates({ horizon: 600, count: 4, seed: 1 });
  for (const c of short) assert.ok(c.schedule[0].frame <= 300, c.plan);
  assert.equal(autoCandidates({ horizon: 200, count: 4 }).length, 0, "no plan fits a 200-frame horizon");
});

test("menu plans produce the presses they describe", () => {
  assert.deepEqual(menuPresses({ kind: "start+a", t0: 100, gap: 50, n: 3 }).map((p) => `${p.frame}:${p.buttons}`), ["100:start", "150:a", "200:a"]);
  assert.deepEqual(menuPresses({ kind: "mash", t0: 0, gap: 10, until: 40 }).map((p) => p.buttons[0]), ["start", "a", "start", "a"]);
  assert.ok(MENU_PLANS.length >= 8);
});

test("a schedule string round-trips through parseInputSchedule", () => {
  const s = autoCandidates({ horizon: 1200, count: 1 })[0].schedule;
  assert.deepEqual(parseInputSchedule(scheduleToString(s)), s);
});

test("the wrong-input script is unchanged by the seededPlay refactor (same LCG, same presses)", () => {
  // The script the control used before seededPlay existed, inlined.
  const old = (schedule, endFrame, seed = 99) => {
    const keep = schedule.filter((p) => p.buttons.some((b) => b === "start" || b === "select"));
    const play = schedule.filter((p) => !keep.includes(p));
    const from = play.length ? play[0].frame : Math.max(...keep.map((p) => p.frame + p.hold)) + 60;
    const pool = ["right", "left", "up", "down", "a", "b", "a+right", "b+left", "a+left", "b+right"];
    const out = [...keep];
    let x = seed & 0x7fffffff, f = from;
    while (f < endFrame) {
      x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
      const b = pool[(x >> 8) % pool.length];
      const h = 4 + ((x >> 4) % 40);
      out.push({ frame: f, buttons: b.split("+"), hold: h });
      f += h + ((x >> 12) % 12);
    }
    return out.sort((a, b) => a.frame - b.frame);
  };
  const s = parseInputSchedule("100:start:5,200:right:50");
  assert.deepEqual(wrongInputSchedule(s, 2000), old(s, 2000));
  assert.deepEqual(wrongInputSchedule(s, 2000, 7), old(s, 2000, 7));
  assert.ok(seededPlay(0, 500, 3).length > 5);
});

test("the sample grid starts after the moving window and stays inside the horizon", () => {
  assert.deepEqual(sampleGrid(200, 30, 10), [60, 90, 120, 150, 180]);
  assert.deepEqual(sampleGrid(100, 5, 80), [81, 86, 91, 96]);
});

const row = (frame, contentTotal, movingTotal, inputMatters = false, status = "OK") => ({ frame, contentTotal, movingTotal, inputMatters, status });

test("rows classify against the verifier's own bar", () => {
  const rows = [row(60, 100, 0), row(90, 5000, 0), row(120, 5000, 500), row(150, 5000, 500, true), row(180, 5000, 500, true, "INCONCLUSIVE")];
  const c = classifyRows(rows, DEFAULT_BAR);
  assert.deepEqual(c.evidence.map((r) => r.frame), [90, 120, 150]);
  assert.deepEqual(c.moving.map((r) => r.frame), [120, 150]);
  assert.deepEqual(c.qualifying.map((r) => r.frame), [150]);
  assert.equal(scoreRun(rows), 1 + 0.25 + 0.05);
});

test("pickFrames: the last frame responds to input, the rest spread over the evidence", () => {
  const rows = [];
  for (let f = 60; f <= 3600; f += 30) rows.push(row(f, f < 600 ? 50 : 6000, f % 90 === 0 ? 1000 : 300, f >= 1200 && f <= 3000));
  const p = pickFrames(rows, { frames: 6 });
  assert.equal(p.pool, "qualifying");
  assert.equal(p.inputMattersAtLast, true);
  const last = p.atFrames[p.atFrames.length - 1];
  assert.ok(last <= 3000 && last >= 2550, `the last frame is in the latest quarter of the qualifying span (${last})`);
  assert.equal(last % 90, 0, "and the most-moving one there");
  assert.equal(p.atFrames.length, 6);
  assert.ok(p.atFrames[0] >= 600, "no frame below the content bar");
  assert.deepEqual([...p.atFrames].sort((a, b) => a - b), p.atFrames);
  const gaps = p.atFrames.slice(1).map((f, i) => f - p.atFrames[i]);
  assert.ok(Math.min(...gaps) >= 30, "spread, not bunched");
  assert.deepEqual(pickFrames(rows, { frames: 6 }), p, "deterministic");
});

test("pickFrames returns null without evidence, and falls back without input", () => {
  assert.equal(pickFrames([row(60, 10, 900), row(90, 1999, 900)]), null);
  const p = pickFrames([row(60, 3000, 0), row(90, 3000, 400), row(120, 3000, 0)], { frames: 3 });
  assert.equal(p.pool, "moving");
  assert.equal(p.inputMattersAtLast, false);
  assert.deepEqual(p.atFrames, [90]);
});

test("pickAudioWindow: loudest stretch before the last frame, null when silent", () => {
  const blocks = [];
  for (let f = 1; f <= 3000; f += 30) blocks.push({ from: f, to: f + 29, loud: f >= 1200 && f < 1800 });
  const w = pickAudioWindow(blocks, 2700, 600);
  assert.deepEqual(w.audioFrames, [1201, 1800]);
  assert.equal(w.loudFrames, 600);
  assert.ok(pickAudioWindow(blocks, 2700, 300).audioFrames[1] <= 1800);
  assert.equal(pickAudioWindow(blocks.map((b) => ({ ...b, loud: false })), 2700), null);
  const all = blocks.map((b) => ({ ...b, loud: true }));
  assert.deepEqual(pickAudioWindow(all, 2700, 600).audioFrames, [2101, 2700], "ties go to the later window");
});

test("isGoodEnough needs 2x the frames, spread over a third of the horizon", () => {
  const q = (n, step) => Array.from({ length: n }, (_, i) => row(60 + i * step, 5000, 500, true));
  assert.equal(isGoodEnough(q(12, 120), { frames: 6, horizon: 3600 }), true);
  assert.equal(isGoodEnough(q(12, 30), { frames: 6, horizon: 3600 }), false, "bunched");
  assert.equal(isGoodEnough(q(11, 200), { frames: 6, horizon: 3600 }), false, "too few");
});

// ─── a JS game, run as both the reference core and the "cart" ────────────────

const W = 80, H = 60, RATE = 48000, SPF = 800;

/**
 * Title (static logo, 2500 content px) until Start; then gameplay: a
 * scrolling background, a player column moved by left/right, a score A
 * raises, and a tone. `ignoreInput` = an attract loop that plays by itself;
 * `blank` = a one-colour screen; `bugAt` = the game breaks from that frame.
 */
class Game {
  constructor({ ignoreInput = false, blank = false, bugAt = null } = {}) {
    Object.assign(this, { ignoreInput, blank, bugAt });
    this.f = 0; this.skew = 0; this.playing = false; this.x = 10; this.score = 0; this.input = {}; this.sample = 0;
    this.state = { audioRing: [] };
  }
  frame() {
    this.f++;
    const i = this.input;
    if (this.ignoreInput) { if (this.f >= 120) this.playing = true; }
    else {
      if (i.start && this.f >= 60) this.playing = true;
      if (this.playing) { if (i.right) this.x++; if (i.left) this.x--; if (i.a || i.b) this.score++; }
    }
    if (this.bugAt != null && this.f >= this.bugAt) this.skew += 3;
    const buf = new Int16Array(SPF * 2);
    if (this.playing) for (let k = 0; k < SPF; k++) { const v = ((this.sample++ * 7) % 113 < 56) ? 3000 : -3000; buf[2 * k] = v; buf[2 * k + 1] = v >> 1; }
    this.state.audioRing.push(buf);
  }
  picture() {
    const rgba = new Uint8Array(W * H * 4);
    for (let p = 0; p < W * H; p++) {
      const col = p % W, row = Math.floor(p / W);
      let c = 0x101040;
      if (!this.blank) {
        if (!this.playing) { if (col >= 15 && col < 65 && row >= 5 && row < 55) c = ((col >> 3) + (row >> 3)) & 1 ? 0xffcc00 : 0xcc3300; }
        else if (col === ((this.x % W) + W) % W) c = 0x00ff00 | (this.score & 0xff);
        else if (row >= 10) c = 0x010101 * (((col + this.f + this.skew + row * 3) >> 2) & 0x3f) * 4 + 0x20;
      }
      rgba[p * 4] = (c >> 16) & 0xff; rgba[p * 4 + 1] = (c >> 8) & 0xff; rgba[p * 4 + 2] = c & 0xff; rgba[p * 4 + 3] = 0xff;
    }
    return { width: W, height: H, rgba };
  }
  ram() { const r = new Uint8Array(16); const dv = new DataView(r.buffer); dv.setUint32(0, this.f, true); dv.setInt32(4, this.x, true); dv.setUint32(8, this.score, true); r[12] = this.playing ? 1 : 0; return r; }
}

/** The reference: 5 settle frames at load, libretro-shaped. */
class RefHost {
  constructor(opts) { this.g = new Game(opts); for (let i = 0; i < 5; i++) this.g.frame(); this.g.state.audioRing.length = 0; this.state = this.g.state; this.status = { frameCount: 0, settleFramesUsed: 5, audioSampleRate: RATE, fbWidth: W, fbHeight: H }; }
  setInput({ ports }) { this.g.input = { ...(ports[0] ?? {}) }; }
  stepFrames(n) { for (let i = 0; i < n; i++) { this.g.frame(); this.status.frameCount++; } return n; }
  screenshotRgba() { return this.g.picture(); }
  regionSize(r) { return r === "system_ram" ? 16 : 0; }
  readMemory(r, off, len) { return this.g.ram().slice(off, off + len); }
  dispose() {}
}

/** The cart: one settle frame, linear memory = the RAM block, an audio ring. */
class CartHost {
  constructor(opts) { this.g = new Game(opts); this.g.frame(); this.g.state.audioRing.length = 0; this.state = this.g.state; this.status = { frameCount: 1 }; }
  setInput({ ports }) { this.g.input = { ...(ports[0] ?? {}) }; }
  stepFrames(n) { for (let i = 0; i < n; i++) { this.g.frame(); this.status.frameCount++; } return n; }
  screenshotRgba() { return this.g.picture(); }
  readMemory(off, len) { return this.g.ram().slice(off, off + len); }
  wasmMemorySize() { return 16; }
  writeMemory() {}
  audioInfo() { return { ring: true, rate: RATE, f32: false, cap: SPF * 8 }; }
  destroy() {}
}

const LAYOUT = { regions: { ram: { offset: 0, length: 16, ref: "system_ram" } }, fields: {}, probe: {} };
const SMALL = { horizon: 900, candidates: 6, sampleEvery: 30, frames: 5, audioWindow: 300 };

async function autoVerify(refOpts = {}, cartOpts = refOpts, auto = SMALL) {
  const plan = await autoPlan({ openRef: async () => new RefHost(refOpts), ...auto });
  if (!plan.ok) return { plan };
  const { result, cartHost, refHost } = await verifyRecompile({
    openCart: async () => new CartHost(cartOpts), openRef: async () => new RefHost(refOpts), refPlatform: "fake", layout: LAYOUT,
    frames: plan.atFrames, input: plan.input, audio: plan.audioFrames ? "required" : undefined, audioFrames: plan.audioFrames ?? undefined,
  });
  cartHost.destroy(); refHost.dispose();
  return { plan, result };
}

test("auto: reaches gameplay through the title, and the cart VERIFIES with AUDIO VERIFIED", async () => {
  const { plan, result } = await autoVerify();
  assert.equal(plan.ok, true, plan.reason);
  assert.ok(plan.schedule.some((p) => p.buttons.includes("start")), "the chosen schedule presses Start");
  assert.equal(plan.report.inputMattersAtLast, true);
  assert.ok(plan.audioFrames, "the reference makes sound in gameplay");
  assert.equal(result.verdict, "VERIFIED", JSON.stringify(result.reasons));
  assert.equal(result.controls.wrongInput.failed, true, "input matters at the last frame, so the wrong-input control fails");
  assert.equal(result.controls.wrongInput.variant, "no-input");
  assert.equal(result.controls.wrongFrame.failed, true);
  assert.equal(result.audio.verdict, "AUDIO VERIFIED", JSON.stringify(result.audio.reasons));
  for (const r of result.frames) assert.ok(r.evidence && r.pass, `frame ${r.refFrame} is evidence and passes`);
  for (const f of plan.atFrames) assert.ok(plan.report.predicted[f].contentPx >= DEFAULT_BAR.minContentPx);
});

test("auto: the same game and seed choose the same schedule and frames", async () => {
  const a = await autoPlan({ openRef: async () => new RefHost(), ...SMALL });
  const b = await autoPlan({ openRef: async () => new RefHost(), ...SMALL });
  assert.equal(a.input, b.input);
  assert.deepEqual(a.atFrames, b.atFrames);
  assert.deepEqual(a.audioFrames, b.audioFrames);
  assert.deepEqual(a.report.candidates, b.report.candidates);
  const c = await autoPlan({ openRef: async () => new RefHost(), ...SMALL, seed: 5 });
  assert.equal(c.ok, true);
  assert.equal(c.report.seed, 5);
});

test("auto: a broken cart is NOT VERIFIED (the selection cannot be steered by the cart)", async () => {
  const { plan, result } = await autoVerify({}, { bugAt: 400 });
  assert.equal(plan.ok, true);
  assert.equal(result.verdict, "NOT VERIFIED");
  assert.ok(result.frames.some((r) => r.evidence && !r.pass), "a scored frame after the bug fails");
});

test("auto: a one-colour game is INCONCLUSIVE with the reason, never a pass", async () => {
  const plan = await autoPlan({ openRef: async () => new RefHost({ blank: true }), ...SMALL });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /no reference frame reached the content bar \(2000/);
  assert.match(plan.reason, /bar is not lowered/);
});

test("auto: a game that ignores input verifies with NO input and says input was not exercised", async () => {
  const plan = await autoPlan({ openRef: async () => new RefHost({ ignoreInput: true }), ...SMALL });
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.input, "");
  assert.equal(plan.report.chosen.index, 0);
  assert.match(plan.report.notes.join(" "), /input handling is NOT exercised/);
});

test("auto: a caller schedule is kept; only frames and audio are chosen", async () => {
  const fixed = parseInputSchedule("200:start:5,300:right:60,400:a:10");
  const plan = await autoPlan({ openRef: async () => new RefHost(), ...SMALL, fixedSchedule: fixed });
  assert.equal(plan.ok, true);
  assert.equal(plan.input, scheduleToString(fixed));
  assert.equal(plan.report.candidates.length, 1);
  assert.equal(plan.report.candidates[0].plan, "caller input");
});

test("auto: the wall-clock budget aborts honestly", async () => {
  const plan = await autoPlan({ openRef: async () => new RefHost(), ...SMALL, budgetSec: 0 });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /budget ran out/);
  assert.equal(plan.report.budgetHit, true);
});

test("auto defaults are documented values", () => {
  assert.deepEqual(Object.keys(AUTO_DEFAULTS).sort(), ["audioWindow", "budgetSec", "candidates", "frames", "horizon", "sampleEvery", "seed"]);
});
