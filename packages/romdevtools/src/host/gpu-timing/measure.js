// frame({op:'timing'}): run a span of frames and time each one. Host-kind
// agnostic: a host that implements the timing contract
//   timingInfo() -> {host, api, cpu, wall, gpu:{available, measure?|reason}, ...}
//   timingBegin(), timedFrame() -> {wallMs, cpuMs, gpuMs, gpuSpanMs, ...}, timingEnd()
// gets everything it can measure; any other host is timed around stepFrames(1)
// (wall = CPU, and GPU "unavailable" with the reason).
//
// One call: optional setup debug commands (`quality low`), a warmup that is
// run but not counted, then `frames` measured frames on an input schedule,
// cut into windows. Debug fields (cart counters) are read every frame; the
// pass-timer command (cartwheel's `pipeline`) is posted on the last frame of
// each window and its reply read after that frame, so it costs no extra
// frame. `variants` runs A/B settings interleaved over `rounds` in one hold.
//
// Isolation: the run holds the server's exclusive gate (mcp/exclusive-gate.js)
// so no other session's call runs between its frames, and reports what it
// could not stop (a playtest window, calls still in flight, other processes
// on the GPU, system load).
//
// Plain JS ESM + JSDoc.

import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseInputSchedule, splitPortButton } from "../verify-recompile.js";
import { postDebugCommand, takeDebugReply, runDebugCommand, hasDebugChannel } from "../debug-channel.js";
import { gpuPinInfo, drmUsage, otherGpuClients, gpuSysfs } from "../gpu-pin.js";
import { summary, median, mean, argmax, r3 } from "./stats.js";

/** Per-host fallback when the host has no timing contract. */
function fallbackInfo(host) {
  const caps = host.getCapabilities?.() ?? {};
  const kind = caps.kind ?? host.kind ?? "unknown";
  const hw = !!host.hwRender?.active;
  return {
    host: kind, api: hw ? "gl" : "cpu",
    cpu: "time inside stepFrames(1) (the core's whole frame)",
    wall: "the same as cpu: the frame runs synchronously",
    gpu: { available: false, reason: hw
      ? "this core renders through GL, but GPU timing is not wired for it yet: wall and CPU only"
      : `this ${kind} host renders on the CPU: there is no GPU work to time` },
  };
}

function applyButtons(host, names) {
  const ports = [{}];
  for (const n of names) {
    const [p, b] = splitPortButton(n);
    while (ports.length <= p) ports.push({});
    ports[p][b] = true;
  }
  host.setInput?.({ ports });
}

/** The buttons a schedule holds on frame f (relative to the run's first frame). */
function wantAt(schedule, f) {
  const set = new Set();
  for (const p of schedule) if (p.frame <= f && f < p.frame + p.hold) for (const n of p.buttons) set.add(n);
  return [...set].sort();
}

function readField(host, name) {
  try {
    const v = host.readDebugValue(name);
    if (typeof v?.value === "number" || typeof v?.value === "bigint") return Number(v.value);
    return null;
  } catch { return null; }
}

/** Run a setup command; a reply that is an error stops the run (a typo in
 *  'quality verylow' must not measure the wrong settings silently). */
async function setupCommand(host, text) {
  const r = await runDebugCommand(host, text, 30);
  const rep = r.reply;
  if (rep && typeof rep === "object" && !Array.isArray(rep) && typeof rep.error === "string") {
    throw new Error(`frame({op:'timing'}): debug command '${text}' answered an error: ${rep.error}`);
  }
  return { command: text, ...r };
}

/** Sum a cartwheel `pipeline` reply's passes, keeping each pass's own ms. */
function passTimerView(reply) {
  if (!reply || typeof reply !== "object" || !Array.isArray(reply.passes)) return { raw: reply };
  const passes = {};
  for (const p of reply.passes) if (p && typeof p.name === "string") passes[p.name] = { gpuMs: r3(p.gpu_ms), cpuMs: r3(p.cpu_ms), ran: p.ran, ...(p.fused ? { fused: true } : {}) };
  // the frame's cost as the engine's quality-range gate sums it: every pass that ran, not fused into
  // another, with a GPU time (each its own 16-frame average)
  const timed = reply.passes.filter((p) => p.ran && !p.fused && p.gpu_ms > 0);
  return {
    timerQuery: reply.timer_query ?? null,
    totalGpuMs: r3(timed.reduce((s, p) => s + p.gpu_ms, 0)),
    lastFrameGpuMs: r3(reply.gpu_ms),
    passes,
  };
}

/**
 * Run and time one span. Returns the per-frame rows, windows, fields and
 * pass-timer replies (no contention block; the caller adds it).
 */
async function runSpan(host, info, opts, timed) {
  const { frames, warmup, window, schedule, fields, passTimers, maxMs, deadline } = opts;
  const rows = [];
  const fieldRows = fields.map(() => []);
  const passReplies = [];
  const clock = [], busy = [];
  const pci = gpuPinInfo().pinned ? gpuPinInfo().pci : null;
  let held = null;
  const total = warmup + frames;
  let truncated = null;
  for (let f = 0; f < total; f++) {
    if (Date.now() > deadline) { truncated = `stopped at the ${maxMs} ms budget after ${rows.length} measured frames`; break; }
    const want = wantAt(schedule, f);
    const key = want.join("+");
    if (key !== held) { applyButtons(host, want); held = key; }
    const measured = f >= warmup;
    const mi = f - warmup;
    // the pass-timer command rides on the last frame of each window
    let seq = null;
    if (measured && passTimers && ((mi + 1) % window === 0 || mi === frames - 1)) {
      try { seq = postDebugCommand(host, passTimers); } catch (e) { passReplies.push({ frame: mi, error: e.message }); }
    }
    let row;
    if (timed) row = await host.timedFrame();
    else {
      const t0 = performance.now();
      await host.stepFrames(1);
      const ms = performance.now() - t0;
      row = { wallMs: ms, cpuMs: ms, gpuMs: null, gpuSpanMs: null };
    }
    if (seq != null) {
      const reply = takeDebugReply(host, seq);
      passReplies.push({ frame: mi, ...(reply === undefined ? { error: "no reply on the frame it was posted for" } : { reply: passTimerView(reply) }) });
    }
    if (!measured) continue;
    rows.push(row);
    for (let k = 0; k < fields.length; k++) fieldRows[k].push(readField(host, fields[k]));
    if (pci && mi % 8 === 0) { const s = gpuSysfs(pci); if (s.sclkMhz != null) clock.push(s.sclkMhz); if (s.busyPercent != null) busy.push(s.busyPercent); }
  }
  return { rows, fieldRows, passReplies, clock, busy, truncated };
}

function windowsOf(rows, fieldRows, fields, passReplies, window) {
  const out = [];
  for (let at = 0; at < rows.length; at += window) {
    const w = rows.slice(at, at + window);
    const pr = passReplies.find((p) => p.frame >= at && p.frame < at + window);
    out.push({
      from: at, to: at + w.length - 1,
      wallMs: r3(mean(w.map((r) => r.wallMs))), cpuMs: r3(mean(w.map((r) => r.cpuMs))),
      gpuMs: r3(mean(w.map((r) => r.gpuMs))), gpuMaxMs: r3(Math.max(...w.map((r) => r.gpuMs ?? -Infinity)) === -Infinity ? null : Math.max(...w.map((r) => r.gpuMs ?? -Infinity))),
      ...(fields.length ? { fields: Object.fromEntries(fields.map((n, k) => {
        const v = fieldRows[k].slice(at, at + window);
        const s = summary(v);
        return [n, s ? { min: s.min, mean: s.mean, max: s.max, last: v[v.length - 1] } : null];
      })) } : {}),
      ...(pr ? { passTimers: pr.reply ?? { error: pr.error } } : {}),
    });
  }
  return out;
}

function describe(rows, fieldRows, fields, passReplies, window, info, series) {
  const wall = rows.map((r) => r.wallMs), cpu = rows.map((r) => r.cpuMs), gpu = rows.map((r) => r.gpuMs);
  const span = rows.map((r) => r.gpuSpanMs);
  const gpuOk = info.gpu.available && gpu.some((x) => x != null);
  const windows = windowsOf(rows, fieldRows, fields, passReplies, window);
  const wmeans = windows.map((w) => w.gpuMs);
  const worst = argmax(gpu);
  const notes = [...new Set(rows.map((r) => r.gpuNote).filter(Boolean))];
  const out = {
    measuredFrames: rows.length,
    wallMs: summary(wall),
    cpuMs: summary(cpu),
    gpuMs: gpuOk ? {
      ...summary(gpu), measure: info.gpu.measure,
      ...(info.gpu.measure === "busy" ? { spanMs: summary(span) } : {}),
      overWindows: { windowFrames: window, median: r3(median(wmeans)), mean: r3(mean(wmeans)), worstWindow: r3(Math.max(...wmeans.filter((x) => x != null))) },
      worstFrame: worst >= 0 ? { frame: worst, gpuMs: r3(gpu[worst]), wallMs: r3(wall[worst]) } : null,
      framesWithoutGpuTime: gpu.filter((x) => x == null).length,
      ...(rows.some((r) => r.passes != null) ? { passesPerFrame: summary(rows.map((r) => r.passes)), cartTimedPassesPerFrame: summary(rows.map((r) => r.cartTimedPasses)) } : {}),
      // a GPU timer that just echoes the frame's wall time is not measuring the GPU
      gpuToWallRatio: r3(mean(gpu) / mean(wall)),
      ...(notes.length ? { notes } : {}),
    } : { available: false, reason: info.gpu.available ? "no frame returned a GPU time" + (notes.length ? `: ${notes.join("; ")}` : "") : info.gpu.reason },
    windows,
  };
  if (fields.length) {
    out.fields = Object.fromEntries(fields.map((n, k) => {
      const s = summary(fieldRows[k]);
      return [n, s ? { min: s.min, mean: s.mean, max: s.max, last: fieldRows[k][fieldRows[k].length - 1] } : { unavailable: "not a numeric debug field of this cart" }];
    }));
  }
  if (passReplies.length) out.passTimers = passReplies.map((p) => ({ frame: p.frame, ...(p.reply ?? { error: p.error }) }));
  if (series) out.series = { wallMs: wall.map(r3), cpuMs: cpu.map(r3), gpuMs: gpu.map(r3), ...(fields.length ? { fields: Object.fromEntries(fields.map((n, k) => [n, fieldRows[k]])) } : {}) };
  return out;
}

/**
 * @param {object} p
 * @param {object} p.host
 * @param {string} p.sessionKey
 * @param {object} p.args - the frame tool's arguments (frames, warmup, window, input, commands, fields, passTimers, variants, rounds, series, exclusive, maxSeconds)
 * @param {{acquireExclusive?: Function, liveHosts?: () => object, playtest?: () => object}} p.env - server hooks (absent in unit tests)
 */
export async function measureFrameTiming({ host, sessionKey, args, env = {} }) {
  const frames = args.frames ?? 300;
  const warmup = args.warmup ?? 0;
  const window = Math.max(1, Math.min(args.window ?? 120, frames));
  const schedule = parseInputSchedule(args.input);
  const fields = args.fields ?? [];
  const passTimers = args.passTimers === true ? "pipeline" : (args.passTimers || null);
  const maxMs = Math.round((args.maxSeconds ?? 240) * 1000);
  const timed = typeof host.timedFrame === "function";
  const needsChannel = passTimers || (args.commands?.length) || (args.variants || []).some((v) => v.commands?.length);
  if (needsChannel && !hasDebugChannel(host)) throw new Error("frame({op:'timing'}): commands/passTimers/variants need the cart's debug channel (dbg.cmd/dbg.reply in its debug table), and this cart has none");

  // ── take the server: no other session's call runs between our frames ──
  const exclusive = args.exclusive !== false && typeof env.acquireExclusive === "function";
  const gate = exclusive ? await env.acquireExclusive(sessionKey, { drainMs: (args.drainSeconds ?? 10) * 1000 }) : null;

  const pin = gpuPinInfo();
  const eld = monitorEventLoopDelay({ resolution: 5 });
  try {
    const drm0 = drmUsage();
    const others0 = pin.pinned ? otherGpuClients(pin.pci) : null;
    const cpu0 = process.cpuUsage(), t0 = performance.now();
    const load0 = os.loadavg()[0];
    eld.enable();
    const deadline = Date.now() + maxMs;
    const opts = { frames, warmup, window, schedule, fields, passTimers, maxMs, deadline };
    const setupReplies = [];
    for (const c of args.commands || []) setupReplies.push(await setupCommand(host, c));

    let result;
    // timingBegin first: a host finds out there what it can measure (a GL
    // context that refuses a timer query), which timingInfo then reports
    if (timed) await host.timingBegin();
    const info = timed ? host.timingInfo() : fallbackInfo(host);
    try {
      if (Array.isArray(args.variants) && args.variants.length) {
        const rounds = args.rounds ?? 3;
        const per = args.variants.map(() => ({ rows: [], fieldRows: fields.map(() => []), passReplies: [], roundMeans: [], clock: [], busy: [], replies: null }));
        let truncated = null;
        for (let r = 0; r < rounds && !truncated; r++) {
          for (let v = 0; v < args.variants.length && !truncated; v++) {
            const vv = args.variants[v];
            if (timed) await host.timingEnd();
            const replies = [];
            for (const c of vv.commands || []) replies.push(await setupCommand(host, c));
            per[v].replies ??= replies;
            if (timed) await host.timingBegin();
            const s = await runSpan(host, info, opts, timed);
            const acc = per[v];
            const off = acc.rows.length;
            acc.rows.push(...s.rows);
            s.fieldRows.forEach((fr, k) => acc.fieldRows[k].push(...fr));
            acc.passReplies.push(...s.passReplies.map((p) => ({ ...p, frame: p.frame + off })));
            acc.clock.push(...s.clock); acc.busy.push(...s.busy);
            acc.roundMeans.push({ round: r, gpuMs: r3(mean(s.rows.map((x) => x.gpuMs))), wallMs: r3(mean(s.rows.map((x) => x.wallMs))), cpuMs: r3(mean(s.rows.map((x) => x.cpuMs))) });
            truncated = s.truncated;
          }
        }
        result = {
          variants: args.variants.map((vv, v) => ({
            name: vv.name ?? `variant${v}`, commands: vv.commands ?? [], ...(per[v].replies?.length ? { replies: per[v].replies.map((x) => x.reply) } : {}),
            ...describe(per[v].rows, per[v].fieldRows, fields, per[v].passReplies, window, info, !!args.series),
            rounds: per[v].roundMeans,
          })),
          ...(truncated ? { truncated } : {}),
        };
        result._clock = per.flatMap((p) => p.clock); result._busy = per.flatMap((p) => p.busy);
      } else {
        const s = await runSpan(host, info, opts, timed);
        result = { ...describe(s.rows, s.fieldRows, fields, s.passReplies, window, info, !!args.series), ...(s.truncated ? { truncated: s.truncated } : {}) };
        result._clock = s.clock; result._busy = s.busy;
      }
    } finally {
      if (timed) await host.timingEnd();
    }
    eld.disable();
    const elapsedMs = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const drm1 = drmUsage();
    const others1 = pin.pinned ? otherGpuClients(pin.pci) : null;

    // which GPU did this process's work, measured by the kernel
    let workByDevice = null;
    if (drm0 && drm1) {
      workByDevice = {};
      for (const [pci, d] of Object.entries(drm1)) workByDevice[pci] = r3((d.gfxNs - (drm0[pci]?.gfxNs ?? 0)) / 1e6);
    }
    const clock = result._clock, busy = result._busy;
    delete result._clock; delete result._busy;

    const reasons = [];
    const live = env.liveHosts?.(sessionKey) ?? null;
    const play = env.playtest?.() ?? null;
    if (!exclusive) reasons.push(args.exclusive === false ? "run with exclusive:false: other sessions' calls ran between frames" : "no exclusive gate on this server");
    if (gate?.stillInflight) reasons.push(`${gate.stillInflight} call(s) from other sessions were still running when the drain timed out`);
    if (play?.windowOpen) reasons.push("a playtest window is open: its frames run on their own timer between ours");
    if (live?.otherActiveBursts) reasons.push(`${live.otherActiveBursts} other WebGPU host(s) were mid-step`);
    const otherGpuMs = others0 && others1 ? r3((others1.gfxNs - others0.gfxNs) / 1e6) : null;
    const ourGpuMs = pin.pinned && workByDevice ? workByDevice[pin.pci] ?? 0 : null;
    if (otherGpuMs != null && otherGpuMs > Math.max(5, 0.05 * elapsedMs)) reasons.push(`other processes used the GPU for ${otherGpuMs} ms during the ${r3(elapsedMs)} ms run`);
    const load1 = os.loadavg()[0], ncpu = os.cpus().length;
    if (Math.max(load0, load1) > ncpu * 0.75) reasons.push(`system load ${Math.max(load0, load1).toFixed(1)} on ${ncpu} CPUs`);
    if (pin.pinned && workByDevice) {
      for (const [pci, ms] of Object.entries(workByDevice)) if (pci !== pin.pci && ms > 1) reasons.push(`GPU work went to ${pci}, not the pinned GPU ${pin.pci}`);
    }
    return {
      host: info.host, api: info.api,
      ...(info.size ? { size: info.size } : {}),
      frames: { warmup, measured: frames, window, inputPresses: schedule.length },
      what: { wall: info.wall, cpu: info.cpu, gpu: info.gpu.available ? info.gpu.method : `unavailable: ${info.gpu.reason}` },
      gpu: {
        pin: pin.pinned ? { pci: pin.pci, vendorId: pin.vendorId, deviceId: pin.deviceId, power: pin.power, source: pin.source } : { pinned: false, reason: pin.reason },
        ...(info.adapter ? { adapter: info.adapter } : {}),
        ...(info.glRenderer ? { glRenderer: info.glRenderer } : {}),
        workByDeviceMs: workByDevice,
        onPinnedGpu: pin.pinned && workByDevice ? Object.entries(workByDevice).every(([pci, ms]) => pci === pin.pci || ms <= 1) : null,
        clockMhz: summary(clock) ? { min: summary(clock).min, mean: summary(clock).mean, max: summary(clock).max, samples: clock.length } : { unavailable: pin.pinned ? "the GPU's pp_dpm_sclk is not readable" : "no pinned GPU to read" },
        busyPercent: summary(busy) ? { mean: summary(busy).mean, max: summary(busy).max } : null,
      },
      ...(setupReplies.length ? { setup: setupReplies } : {}),
      ...result,
      contention: {
        exclusive,
        noisy: reasons.length > 0,
        reasons,
        ...(gate ? { waitedForGateMs: gate.waitedMs, drainMs: gate.drainMs, otherCallsHeld: gate.heldCalls() } : {}),
        ...(live ? { otherLiveHosts: live.otherLiveHosts } : {}),
        playtestWindowOpen: play?.windowOpen ?? null,
        otherProcessesGpuMs: otherGpuMs,
        thisProcessGpuMs: ourGpuMs,
        eventLoopDelayMs: { mean: r3(eld.mean / 1e6), max: r3(eld.max / 1e6) },
        processCpuMs: r3((cpu.user + cpu.system) / 1000),
        elapsedMs: r3(elapsedMs),
        loadavg1: [r3(load0), r3(load1)],
        cpus: ncpu,
      },
    };
  } finally {
    eld.disable();
    gate?.release();
  }
}
