// Automatic input and frame selection for frame({op:'verifyRecompile', auto:true}).
//
// A hand-run verification needs an `input` schedule that reaches real play and
// `atFrames` worth scoring; a bad pick gives NOT VERIFIED for reasons that say
// nothing about the cart ("fewer than 2000 content pixels", "wrongInput
// control did NOT fail", "reference is SILENT"). Auto mode makes those choices
// itself, from the REFERENCE core alone, so the cart under test cannot steer
// them:
//
//  1. EXPLORE. A no-input baseline run, then seeded candidate schedules (menu
//     presses of start / a at varied times, then seeded play from
//     PLAY_POOL), each on a FRESH reference host to `horizon` frames. Every
//     `sampleEvery` frames the reference picture is scored with the
//     verifier's own functions: content pixels (scorePictures), moving
//     pixels over the verifier's moving window, and whether the no-input
//     picture at that frame would FAIL the wrong-input control
//     (controlFailed). A frame is qualifying when it meets the content bar,
//     moves, and input visibly matters there.
//  2. CHOOSE. The candidate with the most qualifying frames wins (ties go to
//     the earlier candidate; the first candidate that is clearly good enough
//     stops the search). Scored frames are spread across its run, the last
//     one qualifying (the wrong-input control is scored at the last frame),
//     and the audio window is the stretch before it where the reference is
//     loudest.
//  3. VERIFY. The normal verifyRecompile runs on what was chosen, with the
//     normal bar. Nothing here lowers it: when no frame meets the bar the
//     answer is INCONCLUSIVE with the reason, never a pass.
//
// Determinism: candidates and play scripts derive from `seed` only, and the
// search cost is counted in emulated frames, so the same cart, ROM and seed
// choose the same schedule and frames. The wall-clock budget only aborts
// (reported as budgetHit); it never changes which candidate wins among the
// ones that ran.

import { ScheduleDriver, scorePictures, controlFailed, snap, disposeHost, seededPlay, DEFAULT_BAR } from "./verify-recompile.js";
import { drainAudioRing } from "./audio-verify.js";

export const AUTO_DEFAULTS = Object.freeze({
  seed: 1,
  horizon: 3600,      // reference frames each candidate runs
  candidates: 16,     // candidate schedules at most (the no-input baseline is extra)
  sampleEvery: 30,    // grid of reference frames scored per run
  frames: 6,          // scored frames chosen
  audioWindow: 600,   // audio frames compared at most (bounds the capture)
  budgetSec: 300,     // wall-clock cap on the exploration
});

/** Peak-to-peak range above which a block of reference audio counts as sound. */
export const LOUD_RANGE = 256;

const HOLD = 6;

/**
 * Menu plans tried in order: the shapes hand-made schedules take (start, then
 * a confirm press every 100-150 frames; start pressed through several
 * screens; a only; start and a alternated), at early, middle and late times.
 * Seeded play follows every plan from 60 frames after its last menu press.
 */
export const MENU_PLANS = Object.freeze([
  { kind: "start+a", t0: 300, gap: 100, n: 6 },
  { kind: "start+a", t0: 700, gap: 150, n: 6 },
  { kind: "start", t0: 300, gap: 120, n: 4 },
  { kind: "mash", t0: 150, gap: 60, until: 1200 },
  { kind: "start", t0: 150, gap: 0, n: 1 },
  { kind: "a", t0: 300, gap: 100, n: 6 },
  { kind: "start+a", t0: 1200, gap: 150, n: 6 },
  { kind: "mash", t0: 600, gap: 90, until: 2000 },
  { kind: "start", t0: 900, gap: 0, n: 1 },
  { kind: "start", t0: 1000, gap: 120, n: 4 },
  { kind: "a", t0: 900, gap: 150, n: 6 },
  { kind: "start+a", t0: 2000, gap: 150, n: 6 },
]);

/** The menu presses of one plan. */
export function menuPresses(plan) {
  const out = [];
  if (plan.kind === "mash") {
    for (let f = plan.t0, i = 0; f < plan.until; f += plan.gap, i++) out.push({ frame: f, buttons: [i % 2 ? "a" : "start"], hold: HOLD });
    return out;
  }
  for (let i = 0; i < plan.n; i++) {
    const b = plan.kind === "a" ? "a" : plan.kind === "start" ? "start" : i === 0 ? "start" : "a";
    out.push({ frame: plan.t0 + i * plan.gap, buttons: [b], hold: HOLD });
  }
  return out;
}

function describePlan(plan, round) {
  const menu = plan.kind === "mash" ? `start/a alternated every ${plan.gap} from ${plan.t0} to ${plan.until}`
    : `${plan.kind === "start+a" ? "start then a" : plan.kind} x${plan.n}${plan.n > 1 ? ` every ${plan.gap}` : ""} from ${plan.t0}`;
  return `${menu}, then seeded play${round ? ` (round ${round + 1})` : ""}`;
}

/**
 * The candidate schedules for a seed: MENU_PLANS in order (those starting at
 * least 300 frames before the horizon), cycled with a new play seed per round
 * until `count` candidates exist. Pure: same arguments, same schedules.
 * @returns {{index:number, plan:string, schedule:{frame:number,buttons:string[],hold:number}[]}[]}
 */
export function autoCandidates({ horizon = AUTO_DEFAULTS.horizon, count = AUTO_DEFAULTS.candidates, seed = AUTO_DEFAULTS.seed } = {}) {
  const plans = MENU_PLANS.filter((p) => p.t0 <= horizon - 300);
  const out = [];
  if (!plans.length) return out;
  for (let i = 0; out.length < count; i++) {
    const plan = plans[i % plans.length], round = Math.floor(i / plans.length);
    const menu = menuPresses(plan).filter((p) => p.frame < horizon);
    const end = Math.max(...menu.map((p) => p.frame + p.hold));
    const playSeed = ((seed * 7919 + i * 104729) & 0x7fffffff) || 1;
    const schedule = [...menu, ...seededPlay(end + 60, horizon, playSeed)].sort((a, b) => a.frame - b.frame);
    out.push({ index: out.length + 1, plan: describePlan(plan, round), schedule });
  }
  return out;
}

/** A schedule as the compact string verifyRecompile accepts ('frame:a+b:hold,...'). */
export function scheduleToString(schedule) {
  return schedule.map((p) => `${p.frame}:${p.buttons.join("+")}:${p.hold}`).join(",");
}

/** The reference frames a run scores: every `every` frames from the first that has a moving window behind it. */
export function sampleGrid(horizon, every, movingWindow) {
  const out = [];
  const first = Math.max(every, movingWindow + 1, 60);
  for (let f = first; f <= horizon; f += every) out.push(f);
  return out;
}

/** How much a frame can prove: pixels that are both content and moving, bounded by the smaller count (a fade moves every pixel of an empty screen). */
export const strength = (r) => Math.min(r.contentTotal ?? 0, r.movingTotal ?? 0);

const isEvidence = (r, bar) => r.status === "OK" && r.contentTotal >= bar.minContentPx;
const isMoving = (r, bar) => (r.movingTotal ?? 0) >= bar.minMovingPx;

/**
 * Classify a run's sampled rows: evidence (content bar), moving, and
 * qualifying (evidence + moving + input matters there).
 */
export function classifyRows(rows, bar = DEFAULT_BAR) {
  const evidence = rows.filter((r) => isEvidence(r, bar));
  const moving = evidence.filter((r) => isMoving(r, bar));
  const qualifying = moving.filter((r) => r.inputMatters);
  return { evidence, moving, qualifying };
}

/** A run's fitness: qualifying frames first, moving evidence a little, still evidence less. */
export function scoreRun(rows, bar = DEFAULT_BAR) {
  const c = classifyRows(rows, bar);
  return Math.round((c.qualifying.length + 0.25 * (c.moving.length - c.qualifying.length) + 0.05 * (c.evidence.length - c.moving.length)) * 100) / 100;
}

/** Good enough to stop searching: 2x the frames wanted qualify, spread over a third of the horizon. */
export function isGoodEnough(rows, { frames = AUTO_DEFAULTS.frames, horizon = AUTO_DEFAULTS.horizon, bar = DEFAULT_BAR } = {}) {
  const q = classifyRows(rows, bar).qualifying;
  if (q.length < 2 * frames) return false;
  return q[q.length - 1].frame - q[0].frame >= horizon / 3;
}

/**
 * Pick the scored frames from one run's rows (ascending by frame). The LAST
 * frame is the strongest (min of content and moving pixels) of the latest
 * quarter of the qualifying ones (the wrong-input control is scored there,
 * so input must matter at it); without any, the same pick among the evidence
 * frames where input matters, then the moving ones, then any evidence. The
 * others are spread over the evidence before it: the span is cut into equal
 * buckets and each bucket gives its strongest frame (qualifying first).
 * @returns {{atFrames:number[], last:object, inputMattersAtLast:boolean, pool:string}|null} null: no evidence frame
 */
export function pickFrames(rows, { frames = AUTO_DEFAULTS.frames, bar = DEFAULT_BAR } = {}) {
  const { evidence, moving, qualifying } = classifyRows(rows, bar);
  if (!evidence.length) return null;
  const inputEvidence = evidence.filter((r) => r.inputMatters);
  const lastPool = qualifying.length ? qualifying : inputEvidence.length ? inputEvidence : moving.length ? moving : evidence;
  // The last frame decides the wrong-input control and anchors the audio
  // window: among the pool's latest quarter, the strongest one (ties: the
  // later), so the run ends on a full, moving picture rather than on whatever
  // happened to be sampled last (or on a fade, where every pixel of a mostly
  // empty screen changes).
  const lo0 = lastPool[0].frame, hi0 = lastPool[lastPool.length - 1].frame;
  const late = lastPool.filter((r) => r.frame >= lo0 + 0.75 * (hi0 - lo0));
  const last = late.reduce((x, y) => (strength(y) >= strength(x) ? y : x));
  const restPool = (moving.length ? moving : evidence).filter((r) => r.frame < last.frame);
  const picked = [];
  const want = Math.max(0, frames - 1);
  if (restPool.length && want) {
    const lo = restPool[0].frame, hi = last.frame;
    const width = (hi - lo) / want;
    for (let b = 0; b < want; b++) {
      const from = lo + b * width, to = b === want - 1 ? hi : lo + (b + 1) * width;
      const inB = restPool.filter((r) => r.frame >= from && r.frame < to);
      if (!inB.length) continue;
      const best = inB.reduce((x, y) => {
        const kx = [x.inputMatters ? 1 : 0, strength(x)], ky = [y.inputMatters ? 1 : 0, strength(y)];
        return ky[0] > kx[0] || (ky[0] === kx[0] && ky[1] > kx[1]) ? y : x;
      });
      picked.push(best.frame);
    }
  }
  const atFrames = [...new Set([...picked, last.frame])].sort((x, y) => x - y);
  return { atFrames, last, inputMattersAtLast: !!last.inputMatters, pool: qualifying.length ? "qualifying" : inputEvidence.length ? "inputEvidence" : moving.length ? "moving" : "evidence" };
}

/**
 * The audio window: at most `width` frames ending at or before `last`, placed
 * where the reference's sampled blocks are loudest (ties: the later window).
 * @param {{from:number,to:number,loud:boolean}[]} blocks
 * @returns {{audioFrames:[number,number], loudFrames:number}|null} null: the reference is silent up to `last`
 */
export function pickAudioWindow(blocks, last, width = AUTO_DEFAULTS.audioWindow) {
  const ends = [...new Set([...blocks.map((b) => b.to).filter((t) => t <= last), last])].sort((x, y) => x - y);
  let best = null;
  for (const e of ends) {
    const s = Math.max(1, e - width + 1);
    let loud = 0;
    for (const b of blocks) if (b.loud) loud += Math.max(0, Math.min(b.to, e) - Math.max(b.from, s) + 1);
    if (loud > 0 && (!best || loud >= best.loudFrames)) best = { audioFrames: [s, e], loudFrames: loud };
  }
  return best;
}

class BudgetHit extends Error {}

/**
 * One reference run on a fresh host: the sampled rows (content, moving,
 * input-matters against `baseline`), the audio loudness per block, and, when
 * `keep`, the pictures at the grid frames (the baseline needs them).
 */
async function sampleRun({ openRef, schedule, grid, movingWindow, bar, baseline, keep, deadline }) {
  const h = await openRef();
  try {
    drainAudioRing(h);
    const d = new ScheduleDriver(h, schedule);
    const rows = [], blocks = [], pics = keep ? new Map() : null;
    let blockFrom = 1;
    const audioBlock = (to) => {
      const s = drainAudioRing(h);
      let lo = 0, hi = 0;
      for (let i = 0; i < s.length; i++) { const v = s[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (to >= blockFrom) blocks.push({ from: blockFrom, to, loud: hi - lo > LOUD_RANGE });
      blockFrom = to + 1;
    };
    for (const F of grid) {
      let prev = null;
      if (F - movingWindow > d.at) {
        await d.to(F - movingWindow);
        audioBlock(F - movingWindow);
        prev = snap(h.screenshotRgba());
      }
      await d.to(F);
      audioBlock(F);
      const pic = snap(h.screenshotRgba());
      const s = scorePictures(pic, pic, { x: 0, y: 0 }, prev);
      const row = { frame: F, status: s.status, contentTotal: s.contentTotal, movingTotal: s.movingTotal ?? 0 };
      if (baseline) {
        const b = baseline.get(F);
        // A picture of another size cannot be scored in place; it is not
        // counted as evidence that input matters.
        row.inputMatters = !!b && b.width === pic.width && b.height === pic.height && controlFailed(scorePictures(b, pic, { x: 0, y: 0 }, prev), bar);
      }
      if (pics) pics.set(F, pic);
      rows.push(row);
      if (Date.now() > deadline) throw new BudgetHit();
    }
    return { rows, blocks, pics };
  } finally {
    disposeHost(h);
  }
}

/**
 * Explore input on the reference and choose the schedule, scored frames and
 * audio window.
 *
 * @param {object} a
 * @param {() => Promise<object>} a.openRef   loads a FRESH reference host
 * @param {object} [a.bar]                    the verifier's bar (default DEFAULT_BAR)
 * @param {number} [a.movingWindow]           the verifier's moving window (default 10)
 * @param {Array|null} [a.fixedSchedule]      a caller schedule: only frames and audio are chosen
 * @param {number} [a.seed] @param {number} [a.horizon] @param {number} [a.candidates]
 * @param {number} [a.sampleEvery] @param {number} [a.frames] @param {number} [a.audioWindow] @param {number} [a.budgetSec]
 * @returns {Promise<object>} {ok, reason?, schedule, atFrames, audioFrames, report}
 */
export async function autoPlan(a) {
  const o = { ...AUTO_DEFAULTS };
  for (const k of Object.keys(AUTO_DEFAULTS)) if (a[k] != null) o[k] = a[k];
  const bar = { ...DEFAULT_BAR, ...(a.bar ?? {}) };
  const mw = a.movingWindow ?? 10;
  const t0 = Date.now(), deadline = t0 + o.budgetSec * 1000;
  const grid = sampleGrid(o.horizon, o.sampleEvery, mw);
  if (!grid.length) throw new Error(`auto: the horizon (${o.horizon}) leaves no frame to sample`);
  const report = { seed: o.seed, horizon: o.horizon, sampleEvery: o.sampleEvery, maxCandidates: o.candidates, budgetSec: o.budgetSec, bar, candidates: [], notes: [] };
  let framesRun = 0, budgetHit = false;

  // The no-input baseline: the wrong-input control's first variant, run on
  // the reference. Where a candidate's picture would fail against it, input
  // visibly matters.
  let base;
  try { base = await sampleRun({ openRef: a.openRef, schedule: [], grid, movingWindow: mw, bar, baseline: null, keep: true, deadline }); }
  catch (e) { if (e instanceof BudgetHit) return { ok: false, reason: `auto: the ${o.budgetSec}s budget ran out during the no-input baseline run (raise auto.budgetSec or lower auto.horizon)`, report: { ...report, budgetHit: true } }; throw e; }
  framesRun += o.horizon;
  report.baseline = { evidenceFrames: classifyRows(base.rows, bar).evidence.length, movingFrames: classifyRows(base.rows, bar).moving.length };

  const cands = a.fixedSchedule ? [{ index: 1, plan: "caller input", schedule: a.fixedSchedule }]
    : autoCandidates({ horizon: o.horizon, count: o.candidates, seed: o.seed });
  let best = null;
  for (const c of cands) {
    let run;
    try {
      run = a.fixedSchedule && !a.fixedSchedule.length
        ? { rows: base.rows.map((r) => ({ ...r, inputMatters: false })), blocks: base.blocks }
        : await sampleRun({ openRef: a.openRef, schedule: c.schedule, grid, movingWindow: mw, bar, baseline: base.pics, keep: false, deadline });
    } catch (e) {
      if (e instanceof BudgetHit) { budgetHit = true; break; }
      throw e;
    }
    framesRun += o.horizon;
    const cls = classifyRows(run.rows, bar), score = scoreRun(run.rows, bar);
    const sum = { index: c.index, plan: c.plan, presses: c.schedule.length, score, qualifying: cls.qualifying.length, movingEvidence: cls.moving.length, evidence: cls.evidence.length,
      ...(cls.qualifying.length ? { qualifyingSpan: [cls.qualifying[0].frame, cls.qualifying[cls.qualifying.length - 1].frame] } : {}) };
    report.candidates.push(sum);
    if (!best || score > best.score) best = { ...c, run, score };
    if (isGoodEnough(run.rows, { frames: o.frames, horizon: o.horizon, bar })) { report.stoppedEarly = `candidate ${c.index} qualifies on ${cls.qualifying.length} frames spread over ${sum.qualifyingSpan[1] - sum.qualifyingSpan[0]} frames`; break; }
    if (Date.now() > deadline) { budgetHit = true; break; }
  }
  // No candidate shows input mattering: the baseline itself may still verify
  // the picture (input is then not exercised and the wrong-input control is
  // skipped by the verifier, as for any run without input).
  const inputShows = best ? classifyRows(best.run.rows, bar).evidence.some((r) => r.inputMatters) : false;
  let chosen = best;
  if (!a.fixedSchedule && !inputShows && classifyRows(base.rows, bar).evidence.length) {
    const baseScore = scoreRun(base.rows, bar);
    chosen = { index: 0, plan: "no input (no candidate changed the picture where it met the bar)", schedule: [], run: { rows: base.rows.map((r) => ({ ...r, inputMatters: false })), blocks: base.blocks }, score: baseScore };
  }
  report.framesRun = framesRun;
  report.seconds = Math.round((Date.now() - t0) / 100) / 10;
  if (budgetHit) {
    report.budgetHit = true;
    report.notes.push(`the ${o.budgetSec}s wall-clock budget stopped the search after ${report.candidates.length} of ${cands.length} candidates: a faster or slower machine may choose differently (raise auto.budgetSec for a reproducible choice)`);
  }
  if (!chosen) return { ok: false, reason: "auto: no candidate schedule ran within the budget", report };
  const picks = pickFrames(chosen.run.rows, { frames: o.frames, bar });
  if (!picks) {
    const top = [...chosen.run.rows, ...base.rows].filter((r) => r.status === "OK").sort((x, y) => y.contentTotal - x.contentTotal)[0];
    return { ok: false, report,
      reason: `auto: no reference frame reached the content bar (${bar.minContentPx} non-backdrop pixels) in ${report.candidates.length + 1} runs of ${o.horizon} frames${top ? ` (the most was ${top.contentTotal} px at frame ${top.frame})` : " (every sampled picture was one colour)"}. The verifier cannot score this game's pictures as evidence; the bar is not lowered. Try a longer auto.horizon or another auto.seed, or verify by hand at frames you can defend.` };
  }
  report.chosen = { index: chosen.index, plan: chosen.plan, score: chosen.score };
  report.pool = picks.pool;
  report.inputMattersAtLast = picks.inputMattersAtLast;
  if (chosen.schedule.length && !picks.inputMattersAtLast) report.notes.push(`input did not change the reference picture at the last chosen frame ${picks.last.frame}; the wrong-input control is expected to fail to fail there`);
  if (!chosen.schedule.length) report.notes.push("no schedule made input visibly matter at a frame meeting the bar, so the run uses no input: the wrong-input control is skipped and input handling is NOT exercised by this verdict");
  if (picks.pool === "evidence") report.notes.push("no chosen frame moves (>= minMovingPx changed pixels over the moving window): the wrong-frame control may be unable to fail");
  report.predicted = Object.fromEntries(picks.atFrames.map((f) => { const r = chosen.run.rows.find((x) => x.frame === f); return [f, { contentPx: r.contentTotal, movingPx: r.movingTotal, inputMatters: !!r.inputMatters }]; }));
  const last = picks.atFrames[picks.atFrames.length - 1];
  const aw = pickAudioWindow(chosen.run.blocks, last, o.audioWindow);
  report.audio = aw ? { audioFrames: aw.audioFrames, loudFrames: aw.loudFrames } : { silent: true, note: `the reference made no sound (peak-to-peak <= ${LOUD_RANGE}) in frames 1..${last} of the chosen run` };
  if (!aw) report.notes.push(`audio is not part of this verdict: ${report.audio.note}`);
  return { ok: true, schedule: chosen.schedule, input: scheduleToString(chosen.schedule), atFrames: picks.atFrames, audioFrames: aw?.audioFrames ?? null, report };
}
