// Ranged frame capture: step a loaded host N frames in ONE call and see every
// frame, box-filtered down in linear light. Two uses:
//   frame({op:'flash'})   the photosensitive flash check (./analysis.js) run on
//                         the frames as they come, plus its control (the same
//                         frames with an 8 Hz full-screen strobe, which must
//                         fail); returns the verdict and the worst second
//   frame({op:'record'})  every frame written to one file in cartwheel's
//                         CW_FRAME_DUMP layout ("CWFD", u32 width, u32 height,
//                         u32 0, then RGB bytes a frame, top row first)
// Host-kind agnostic: anything with stepFrames(n) and getFramebuffer() (wasmcart
// GL and WebGPU, libretro cores, sync32, jsgame). The frames run on the host's
// own fixed clock; nothing here reads wall time except the budget.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { framebufferToRgba } from "romdev-core-host/framebuffer.js";
import { RETRO_PIXEL_FORMAT_XRGB8888, ROMDEV_PIXEL_FORMAT_RGBA8888 } from "romdev-core-host/retroConstants.js";
import { parseInputSchedule } from "../verify-recompile.js";
import { runDebugCommand, hasDebugChannel, postDebugCommand, takeDebugReply } from "../debug-channel.js";
import { applyButtons, wantAt } from "../gpu-timing/measure.js";
import { LIN, createFlashAnalyser, judgeFlash, describeFlash, strobeFrame } from "./analysis.js";

// linear 0..1 -> sRGB byte, exactly as cartwheel's boxDown and native dump_frame encode it
function enc(v) { return Math.max(0, Math.min(255, Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)))); }

/**
 * A box filter in linear light from a w x h source to ow x oh RGB bytes: each output pixel the
 * mean of the source pixels that map to it (with an integer factor, exactly cartwheel's boxDown and
 * native dump_frame: a factor x factor block, the right and bottom remainders dropped).
 */
export function makeBoxFilter(w, h, ow, oh, factor = null) {
  const colOf = new Int32Array(w), rowOf = new Int32Array(h);
  for (let x = 0; x < w; x++) colOf[x] = factor ? (x < ow * factor ? Math.floor(x / factor) : -1) : Math.min(ow - 1, Math.floor((x * ow) / w));
  for (let y = 0; y < h; y++) rowOf[y] = factor ? (y < oh * factor ? Math.floor(y / factor) : -1) : Math.min(oh - 1, Math.floor((y * oh) / h));
  const count = new Float32Array(ow * oh);
  for (let y = 0; y < h; y++) if (rowOf[y] >= 0) for (let x = 0; x < w; x++) if (colOf[x] >= 0) count[rowOf[y] * ow + colOf[x]]++;
  const acc = new Float32Array(ow * oh * 3), out = new Uint8Array(ow * oh * 3);
  /** @param {Uint8Array} px @param {number} pitch @param {number} ri,gi,bi byte offsets of R,G,B in a 4-byte pixel */
  return function filter(px, pitch, ri, gi, bi) {
    acc.fill(0);
    for (let y = 0; y < h; y++) {
      const oy = rowOf[y];
      if (oy < 0) continue;
      const base = oy * ow, row = y * pitch;
      for (let x = 0, s = row; x < w; x++, s += 4) {
        const ox = colOf[x];
        if (ox < 0) continue;
        const o = (base + ox) * 3;
        acc[o] += LIN[px[s + ri]]; acc[o + 1] += LIN[px[s + gi]]; acc[o + 2] += LIN[px[s + bi]];
      }
    }
    for (let i = 0, o = 0; i < count.length; i++, o += 3) {
      const n = count[i] || 1;
      out[o] = enc(acc[o] / n); out[o + 1] = enc(acc[o + 1] / n); out[o + 2] = enc(acc[o + 2] / n);
    }
    return out;
  };
}

/** The output size for a source frame: downscale (an integer factor), or size {width, height},
 *  or by default the integer factor nearest to a 240-pixel-wide picture. */
export function outputSize(w, h, { downscale, size } = {}) {
  if (size) {
    const ow = Math.min(w, size.width | 0), oh = Math.min(h, size.height | 0);
    if (!(ow > 0 && oh > 0)) throw new Error(`size ${JSON.stringify(size)}: want positive width and height`);
    if (w % ow === 0 && h % oh === 0 && w / ow === h / oh) return { ow, oh, factor: w / ow };
    return { ow, oh, factor: null };
  }
  const f = downscale ?? Math.max(1, Math.round(w / 240));
  if (!(Number.isInteger(f) && f >= 1)) throw new Error(`downscale ${downscale}: want an integer factor of 1 or more`);
  return { ow: Math.floor(w / f), oh: Math.floor(h / f), factor: f };
}

/**
 * Step the host and hand every captured frame (box-filtered RGB) to onFrame(rgb, index, hostFrame).
 * @param {object} p
 * @param {object} p.host
 * @param {string} p.op - for error text
 * @param {number} p.frames - frames captured
 * @param {number} [p.warmup] - frames run first and not captured
 * @param {string|object[]} [p.input] - schedule, frames counted from the call's first frame (warmup included)
 * @param {{input:{ports:object[]}, frames:number}[]} [p.steps] - input({op:'sequence'}) steps instead of input: each
 *   step's ports held for its frames from the call's first frame (warmup included), the last held to the end
 * @param {{frame:number, command:string}[]} [p.commandsAt] - debug commands posted before the call's frame `frame`
 *   (0 = its first, warmup included) and answered in it: a mid-range change (a boss phase, a preset)
 * @param {string[]} [p.commands] - debug commands answered first (their frames are neither warmup nor captured)
 * @param {number} [p.downscale] @param {{width:number,height:number}} [p.size]
 * @param {number} [p.maxMs]
 * @param {(info:{width:number,height:number,ow:number,oh:number,factor:number|null}) => void} [p.onSize]
 * @param {(rgb: Uint8Array, i: number, hostFrame: number) => void} p.onFrame
 */
export async function captureRange({ host, op, frames, warmup = 0, input, steps, commandsAt = [], commands = [], downscale, size, maxMs = 900_000, onSize, onFrame }) {
  if (!host?.status?.loaded && typeof host?.getFramebuffer !== "function") throw new Error(`frame({op:'${op}'}): nothing is loaded in this session - loadMedia first`);
  if (typeof host.getFramebuffer !== "function") throw new Error(`frame({op:'${op}'}): this host cannot hand over its frames`);
  if (input != null && steps != null) throw new Error(`frame({op:'${op}'}): pass input (a press schedule) or steps (input sequence steps), not both`);
  const schedule = parseInputSchedule(input);
  // steps: [start frame, ports] of each step, in order
  const stepPlan = [];
  if (steps != null) {
    if (!Array.isArray(steps)) throw new Error(`frame({op:'${op}'}): steps must be an array of {input:{ports}, frames}`);
    let at = 0;
    for (const [k, st] of steps.entries()) {
      if (!st || !st.input || !(Number.isInteger(st.frames) && st.frames >= 0)) throw new Error(`frame({op:'${op}'}): steps[${k}] must be {input:{ports:[...]}, frames:<integer>}`);
      stepPlan.push([at, st.input]);
      at += st.frames;
    }
  }
  const drives = input != null || steps != null; // a call with neither leaves the held input alone
  let stepIdx = -1;
  const timed = [...commandsAt].sort((a, b) => a.frame - b.frame), pending = [], timedReplies = [];
  for (const c of timed) if (!(Number.isInteger(c.frame) && c.frame >= 0 && typeof c.command === "string")) throw new Error(`frame({op:'${op}'}): commandsAt entries are {frame:<integer from 0>, command:<text>}`);
  if ((commands.length || commandsAt.length) && !hasDebugChannel(host)) throw new Error(`frame({op:'${op}'}): commands need the cart's debug channel (dbg.cmd/dbg.reply in its debug table), and this cart has none`);
  const t0 = performance.now(), deadline = t0 + maxMs;
  const setup = [];
  for (const c of commands) {
    const r = await runDebugCommand(host, c, 30);
    const rep = r.reply;
    if (rep && typeof rep === "object" && !Array.isArray(rep) && typeof rep.error === "string") throw new Error(`frame({op:'${op}'}): debug command '${c}' answered an error: ${rep.error}`);
    setup.push({ command: c, framesRun: r.framesRun, reply: rep });
  }
  const startFrame = host.status?.frameCount ?? null;
  let filter = null, dims = null, held = null, captured = 0, truncated = null;
  let stepMs = 0, filterMs = 0, useMs = 0;
  const total = warmup + frames;
  for (let f = 0; f < total; f++) {
    if (performance.now() > deadline) { truncated = `stopped at the ${Math.round(maxMs / 1000)} s budget after ${captured} of ${frames} captured frames`; break; }
    if (stepPlan.length) {
      let k = stepIdx;
      while (k + 1 < stepPlan.length && stepPlan[k + 1][0] <= f) k++;
      if (k !== stepIdx && k >= 0) { host.setInput?.(stepPlan[k][1]); stepIdx = k; }
    } else if (drives) {
      const want = wantAt(schedule, f);
      const key = want.join("+");
      if (key !== held) { applyButtons(host, want); held = key; }
    }
    while (timed.length && timed[0].frame === f) { const c = timed.shift(); pending.push({ ...c, seq: postDebugCommand(host, c.command) }); }
    let t = performance.now();
    await host.stepFrames(1);
    stepMs += performance.now() - t;
    for (let k = 0; k < pending.length; k++) {
      const rep = takeDebugReply(host, pending[k].seq);
      if (rep === undefined) { if (f - pending[k].frame >= 30) throw new Error(`frame({op:'${op}'}): debug command '${pending[k].command}' at frame ${pending[k].frame}: no reply after 30 frames`); continue; }
      if (rep && typeof rep === "object" && !Array.isArray(rep) && typeof rep.error === "string") throw new Error(`frame({op:'${op}'}): debug command '${pending[k].command}' at frame ${pending[k].frame} answered an error: ${rep.error}`);
      timedReplies.push({ frame: pending[k].frame, answeredAt: f, command: pending[k].command, reply: rep });
      pending.splice(k--, 1);
    }
    // a GL or libretro frame is synchronous: give the process's timers (the runner's heartbeat) a turn
    if ((f & 31) === 31) await new Promise((r) => setImmediate(r));
    if (f < warmup) continue;
    t = performance.now();
    const fb = host.getFramebuffer();
    let px = fb.pixels, pitch = fb.pitch, ri = 0, gi = 1, bi = 2;
    if (fb.format === RETRO_PIXEL_FORMAT_XRGB8888) { ri = 2; bi = 0; }
    else if (fb.format !== ROMDEV_PIXEL_FORMAT_RGBA8888) { px = framebufferToRgba(fb.width, fb.height, fb.pixels, fb.pitch, fb.format); pitch = fb.width * 4; }
    if (!dims) {
      const s = outputSize(fb.width, fb.height, { downscale, size });
      dims = { width: fb.width, height: fb.height, ...s };
      filter = makeBoxFilter(fb.width, fb.height, s.ow, s.oh, s.factor);
      onSize?.(dims);
    } else if (fb.width !== dims.width || fb.height !== dims.height) {
      throw new Error(`frame({op:'${op}'}): the frame size changed from ${dims.width}x${dims.height} to ${fb.width}x${fb.height} at captured frame ${captured}; capture a range of one size`);
    }
    const rgb = filter(px, pitch, ri, gi, bi);
    filterMs += performance.now() - t;
    t = performance.now();
    onFrame(rgb, captured, (host.status?.frameCount ?? 0));
    useMs += performance.now() - t;
    captured++;
  }
  if (drives) host.setInput?.({ ports: [{}] });
  return {
    setup, timedReplies, startFrame, captured, truncated, dims,
    timing: { totalMs: Math.round(performance.now() - t0), stepMs: Math.round(stepMs), readAndFilterMs: Math.round(filterMs), analyseMs: Math.round(useMs) },
    inputPresses: schedule.length, inputSteps: stepPlan.length,
  };
}

function cleanResult(m, firstFrame) {
  const { opts, ...rest } = m;
  const hostFrame = (at) => (at >= 0 && firstFrame != null ? firstFrame + at : null);
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return {
    ...rest,
    flicker: { ...rest.flicker, amp: r3(rest.flicker.amp), hz: r3(rest.flicker.hz) },
    rise: { ...rest.rise, amount: r3(rest.rise.amount) },
    motion: Math.round(rest.motion * 1e5) / 1e5,
    ...(rest.worstSecond ? { worstSecond: { ...rest.worstSecond, hostFrame: hostFrame(rest.worstSecond.from) } } : {}),
  };
}

/**
 * frame({op:'flash'}): capture a range, check it and its control.
 * @param {object} host @param {object} args - the frame tool's arguments
 */
export async function runFlashCheck(host, args) {
  const frames = args.frames === 1 ? 600 : args.frames;
  const fo = args.flash ?? {};
  const opts = { fps: fo.fps, maxFlashes: fo.maxFlashes, flickerAmp: fo.flickerAmp, maxRise: fo.maxRise, minMotion: fo.minMotion };
  const ctl = { hz: args.control?.hz ?? 8, mix: args.control?.mix ?? 0.7, fps: fo.fps ?? 60 };
  let run = null, control = null, scratch = null, fd = null, file = null;
  try {
    const cap = await captureRange({
      host, op: "flash", frames, warmup: args.warmup ?? 0, input: args.input, steps: args.steps, commandsAt: args.commandsAt ?? [], commands: args.commands ?? [],
      downscale: args.downscale, size: args.size, maxMs: (args.maxSeconds ?? 900) * 1000,
      onSize: (d) => {
        run = createFlashAnalyser(d.ow, d.oh, opts);
        if (args.control !== false) control = createFlashAnalyser(d.ow, d.oh, opts);
        scratch = new Uint8Array(d.ow * d.oh * 3);
        if (args.path) { file = openDump(args.path, d.ow, d.oh); fd = file.fd; }
      },
      onFrame: (rgb, i) => {
        run.push(rgb);
        if (control) control.push(strobeFrame(rgb, i, scratch, ctl));
        if (fd != null) fs.writeSync(fd, rgb);
      },
    });
    if (!run || cap.captured < 2) throw new Error(`frame({op:'flash'}): only ${cap.captured} frame(s) captured${cap.truncated ? ` (${cap.truncated})` : ""}; a check needs a run of frames`);
    const m = run.result(), problems = judgeFlash(m);
    const out = {
      op: "flash",
      verdict: problems.length ? "FAIL" : "ok",
      pass: problems.length === 0,
      problems,
      summary: describeFlash(m),
      frames: { captured: cap.captured, warmup: args.warmup ?? 0, firstFrame: cap.startFrame != null ? cap.startFrame + (args.warmup ?? 0) + 1 : null, inputPresses: cap.inputPresses, inputSteps: cap.inputSteps },
      size: { source: [cap.dims.width, cap.dims.height], analysed: [cap.dims.ow, cap.dims.oh], factor: cap.dims.factor, filter: "box, linear light" },
      bounds: { maxFlashes: m.opts.maxFlashes, flickerAmp: m.opts.flickerAmp, maxRise: m.opts.maxRise, minMotion: m.opts.minMotion, fps: m.opts.fps },
      result: cleanResult(m, cap.startFrame != null ? cap.startFrame + (args.warmup ?? 0) + 1 : null),
    };
    if (control) {
      const c = control.result();
      const cp = judgeFlash(c).filter((p) => !/proves nothing/.test(p));
      out.control = {
        what: `the same frames with a ${ctl.hz} Hz full-screen strobe (white mixed in at ${ctl.mix}); it must fail`,
        failsAsItMust: cp.length > 0,
        problems: cp,
        summary: describeFlash(c),
      };
      out.checkOk = out.pass && cp.length > 0;
      if (!cp.length) out.verdict = "CONTROL PASSED (the check saw no strobe: it proves nothing)";
    }
    if (cap.setup.length) out.setup = cap.setup;
    if (cap.timedReplies.length) out.commandsAt = cap.timedReplies;
    if (file) out.dump = { path: file.path, format: "CWFD (cartwheel CW_FRAME_DUMP): 'CWFD', u32 width, u32 height, u32 0, then RGB bytes a frame, top row first", bytes: 16 + cap.captured * cap.dims.ow * cap.dims.oh * 3 };
    if (cap.truncated) { out.truncated = cap.truncated; out.pass = false; out.checkOk = false; out.verdict = `INCOMPLETE: ${cap.truncated}`; }
    out.timing = cap.timing;
    return out;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function openDump(p, w, h) {
  if (!path.isAbsolute(p)) throw new Error(`path ${p}: want an absolute path`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, "w");
  const head = Buffer.alloc(16);
  head.writeUInt32LE(0x44465743, 0); head.writeUInt32LE(w, 4); head.writeUInt32LE(h, 8);
  fs.writeSync(fd, head);
  return { fd, path: p };
}

/**
 * frame({op:'record'}): capture a range into one CW_FRAME_DUMP file.
 * @param {object} host @param {object} args
 */
export async function runRecord(host, args) {
  if (!args.path) throw new Error("frame({op:'record'}): path (an absolute file path on the server's machine) is required");
  if (args.format && args.format !== "raw" && args.format !== "png") throw new Error(`frame({op:'record'}): format '${args.format}': only 'raw' (CW_FRAME_DUMP) is written`);
  let file = null;
  try {
    const cap = await captureRange({
      host, op: "record", frames: args.frames, warmup: args.warmup ?? 0, input: args.input, steps: args.steps, commandsAt: args.commandsAt ?? [], commands: args.commands ?? [],
      downscale: args.downscale, size: args.size, maxMs: (args.maxSeconds ?? 900) * 1000,
      onSize: (d) => { file = openDump(args.path, d.ow, d.oh); },
      onFrame: (rgb) => fs.writeSync(file.fd, rgb),
    });
    return {
      op: "record", path: args.path,
      format: "CWFD (cartwheel CW_FRAME_DUMP): 'CWFD', u32 width, u32 height, u32 0, then RGB bytes a frame, top row first",
      width: cap.dims?.ow ?? 0, height: cap.dims?.oh ?? 0, frames: cap.captured,
      source: cap.dims ? [cap.dims.width, cap.dims.height] : null, factor: cap.dims?.factor ?? null, filter: "box, linear light",
      firstFrame: cap.startFrame != null ? cap.startFrame + (args.warmup ?? 0) + 1 : null,
      bytes: cap.dims ? 16 + cap.captured * cap.dims.ow * cap.dims.oh * 3 : 0,
      ...(cap.setup.length ? { setup: cap.setup } : {}),
      ...(cap.timedReplies.length ? { commandsAt: cap.timedReplies } : {}),
      ...(cap.truncated ? { truncated: cap.truncated } : {}),
      timing: cap.timing,
    };
  } finally {
    if (file) fs.closeSync(file.fd);
  }
}
