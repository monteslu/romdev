// `watchMemory` — run the emulator forward and report every frame that changed
// a watched byte range. Cross-platform (no core patches): polls the region
// before/after each frame, diffs the result, records (frame, offset, before,
// after, PC).
//
// `runUntilWrite` — narrower: step until target address is written, then stop.
// Returns the same shape minus the full timeline.
//
// Granularity: this is frame-level, not instruction-level. If a single frame
// writes to the same address ten times, we only see the LAST value. For most
// ROM-hacking workflows this is enough — you usually just want "what code is
// touching this byte and what does the screen look like after," not a complete
// CPU trace. Instruction-level tracing would need core-side breakpoint hooks.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";
import { getCPUState } from "../../host/cpu-state.js";
import { MemoryRegionToRetro } from "../../host/types.js";
import { resolveButtonAlias } from "./input.js";
import { getCPUStateCore } from "./platform-tools.js";
import { traceVramSourceCore } from "./trace-vram-source.js";
import { resolveStatePath } from "./state.js";

// Restore a savestate (in-memory slot `fromState` OR disk file `fromStatePath`)
// before a trace, so on:'range'/'pc' run from a known moment. Returns a small
// {slot|path} descriptor for the response, or null if neither was given.
// Throws a clear error if both are given or the restore fails.
async function maybeRestoreState(host, fromState, fromStatePath) {
  if (fromState && fromStatePath) {
    throw new Error("watch: provide `fromState` (slot) OR `fromStatePath` (file), not both.");
  }
  if (fromStatePath) {
    const resolved = resolveStatePath(fromStatePath, host);
    let blob;
    try { blob = new Uint8Array(await readFile(resolved)); }
    catch (e) { throw new Error(`watch: can't read fromStatePath '${resolved}': ${e.message}`); }
    host.unserializeState(blob);
    return { path: resolved };
  }
  if (fromState) {
    host.loadState(fromState); // throws if the slot doesn't exist
    return { slot: fromState };
  }
  return null;
}

// Let a human watching /livestream (or a playtest window) SEE what a
// breakpoint/watch tool just did — the frozen breakpoint frame, the state when a
// write was caught — even though the AGENT gets only a small JSON result.
//
// CRITICAL: this must NOT slow the agent down. The PNG encode is the expensive
// part, so we do NOT encode here on the tool's critical path. Instead we attach a
// `_observerFrameProvider` thunk (just captures the host ref — free) and the
// observer wrapper encodes it ASYNCHRONOUSLY, after the agent's response has
// already gone out. The provider is stripped from the agent-visible result. The
// frame is captured by reference now (correct frozen state) but rasterized later.
export function attachObserverFrame(json, host) {
  json._observerFrameProvider = () => {
    try {
      const shot = host.screenshot(); // { pngBase64, width, height }
      return shot && shot.pngBase64
        ? { kind: "image", mimeType: "image/png", base64: shot.pngBase64 }
        : null;
    } catch { return null; }
  };
  return json;
}

// Drive scheduled `pressDuring` input through the host's ONLY input API
// (setInput) — the watch loop owns stepFrames, so this must never advance the
// emulator itself. Returns a stateful driver: call applyForFrame(i) at the top
// of each watched frame (before stepFrames) to set the held-button state, and
// finish() once at the end to release everything. `presses` is the sorted
// schedule; each press holds from its `frame` for `holdFrames` frames.
// frame({op:'stepInstruction'}) — execute exactly ONE CPU instruction and stop.
// Exported so the `frame` router (frame.js) can call it; takes sessionKey.
export async function stepInstructionCore(sessionKey) {
  const host = getHost(sessionKey);
  if (!host.pcBreakSupported || !host.pcBreakSupported()) {
    return jsonContent({
      stepped: false, notSupported: true,
      note: "This core build has no single-step (shipped on all 14 platforms as of 0.5.0 — update the core package if you see this).",
    });
  }
  const r = host.stepInstruction();
  return attachObserverFrame(jsonContent({
    stepped: true,
    pc: r.pc != null ? "$" + r.pc.toString(16).toUpperCase() : null,
    pcRaw: r.pc,
    note: "CPU is frozen one instruction later. cpu({op:'read'}) to read registers; frame({op:'stepInstruction'}) again to keep stepping.",
  }), host);
}

export function makePressDriver(host, presses) {
  let applied = 0;          // how many scheduled presses actually got a frame
  let lastSet = null;       // last setInput payload we pushed (to avoid churn)
  const platform = host.status?.platform;
  // When NO pressDuring schedule is given, the driver must NOT touch input at
  // all — it leaves whatever persistent state input({op:'set'}) established in
  // place, so a watch/breakpoint inherits the held pad exactly like
  // frame({op:'step'}) does. (Previously applyForFrame(0) pushed an empty
  // [{},{}] payload on the first frame, silently neutralizing a held Right+A —
  // the v0.16.0 movement-analysis bug.) A non-empty schedule still OWNS the
  // pad (deterministic capture): it drives the buttons and releases on finish.
  const driven = presses.length > 0;
  return {
    applied: () => applied,
    applyForFrame(i) {
      if (!driven) return;   // inherit persistent input({op:'set'}) state
      // Buttons whose [frame, frame+holdFrames) window covers frame i.
      const held = presses.filter((p) => i >= p.frame && i < p.frame + (p.holdFrames ?? 2));
      // Build a 2-port setInput payload from the held buttons.
      const ports = [{}, {}];
      for (const p of held) {
        const resolved = resolveButtonAlias(p.button, platform);
        ports[p.port ?? 0][resolved] = true;
      }
      const key = JSON.stringify(ports);
      if (key !== lastSet) { host.setInput({ ports }); lastSet = key; }
      // Count each scheduled press once, on the first frame it's actually held.
      for (const p of held) { if (p.frame === i) applied++; }
    },
    finish() {
      if (!driven) return;   // we never touched input; leave it as the caller set it
      if (lastSet !== null && lastSet !== "[{},{}]") host.setInput({ ports: [{}, {}] });
    },
  };
}

// Single source of truth: the same canonical region vocabulary readMemory
// uses (host/types.js). Previously this was a hand-maintained list that had
// drifted — it carried DEAD Genesis `md_*` names (which throw on read) and
// was MISSING nes_apu_regs / genesis_* / c64_*, so you couldn't watch the
// hardware-register regions readMemory could already read. Deriving from the
// host map means new regions flow through automatically and the two tools can
// never disagree again.
const MEMORY_REGIONS = /** @type {[string, ...string[]]} */ (Object.keys(MemoryRegionToRetro));

// Abort-guard for input-driven watchpoint runs: sample caller-named bytes each
// frame; the FIRST one to change stops the run with {label,addr,before,after}.
// Lets a derailed driven scenario (player died, scene flipped) return immediately
// with WHY, instead of burning all maxFrames on a meaningless miss.
function makeAbortGuard(host, abortIf) {
  const specs = Array.isArray(abortIf) ? abortIf : [];
  const watched = specs.map((s, i) => {
    const region = s.region ?? "system_ram";
    const offset = s.offset ?? 0;
    let before;
    try { before = host.readMemory(region, offset, 1)[0]; } catch { before = null; }
    const addr = "$" + (offset >>> 0).toString(16).toUpperCase();
    return { region, offset, addr, label: s.label ?? `${region}${addr}`, before };
  }).filter((w) => w.before != null);
  return {
    count: watched.length,
    check() {
      for (const w of watched) {
        let now;
        try { now = host.readMemory(w.region, w.offset, 1)[0]; } catch { continue; }
        if (now !== w.before) {
          return {
            label: w.label, addr: w.addr,
            before: "0x" + w.before.toString(16).padStart(2, "0").toUpperCase(),
            after: "0x" + now.toString(16).padStart(2, "0").toUpperCase(),
          };
        }
      }
      return null;
    },
  };
}

// No-hit note for bpFindWriter. The full "two reasons" explainer (~100 tokens)
// is useful ONCE; as a repeated payload it's pure overhead (v0.15.0 feedback
// #2b). Emit the long form only on the first miss per MCP session, a one-liner
// after.
const _bpNoHitSeen = new Set();
function noHitNote(sessionKey) {
  const short = "No per-byte CPU write to that address within maxFrames. Either the event didn't fire " +
    "(raise maxFrames / drive it with pressDuring; add abortIf to stop early if the scenario derails), " +
    "OR the region is rebuilt as a BLOCK (OAM/display-list/VRAM bulk-copy or DMA) so no single instruction " +
    "writes it — watch the SOURCE struct the copy reads from instead.";
  if (_bpNoHitSeen.has(sessionKey)) return short;
  _bpNoHitSeen.add(sessionKey);
  return "No per-byte CPU write to that address within maxFrames. Two common reasons: " +
    "(1) the event didn't fire — increase maxFrames or drive the game with pressDuring to trigger it " +
    "(and pass `abortIf` to abort early + say why if a driven run derails, e.g. the player dies). " +
    "(2) this region is rebuilt as a BLOCK rather than written field-by-field — sprite/OAM shadow tables, " +
    "display lists, and VRAM are typically bulk-copied (memcpy/loop) or DMA'd from a SOURCE struct elsewhere, " +
    "so no single instruction writes this exact byte. In that case the address you want is the SOURCE: watch " +
    "the struct the copy reads from (find it with searchValue on the live value), or for graphics trace the " +
    "DMA/copy source (Genesis VRAM DMA source is in VDP regs). 'Address is wrong' is usually case (2), not a bad address.";
}

function tryGetPC(host) {
  try {
    const platform = host.status?.platform;
    if (!platform) return null;
    const cpu = getCPUState(host, platform);
    if (cpu && typeof cpu.pc === "number") return cpu.pc;
    return null;
  } catch {
    return null;
  }
}

function hexPC(pc) {
  if (pc == null) return null;
  return "$" + pc.toString(16).toUpperCase().padStart(4, "0");
}

function snap(host, region, offset, length) {
  return Array.from(host.readMemory(region, offset, length));
}

function diffSnapshots(before, after, baseOffset, label) {
  const changes = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) {
      changes.push({
        ...(label ? { label } : {}),
        offset: baseOffset + i,
        offsetHex: "0x" + (baseOffset + i).toString(16).toUpperCase().padStart(4, "0"),
        before: before[i],
        after: after[i],
      });
    }
  }
  return changes;
}

// Edge classifier — a single byte's transition relative to its previous value.
// "reset" is the canonical music-driver signal: a countdown counter that
// reloads (jumps UP) marks a note onset. Filtering to resets turns a 7000-event
// decrement stream into the ~few-hundred-event note list directly.
function edgeMatches(onChange, before, after) {
  switch (onChange) {
    case "increase": return after > before;
    case "decrease": return after < before;
    case "reset":    return after > before;   // counter reload = jump up
    case "any":
    default:         return true;
  }
}

function valueMatches(valueFilter, after) {
  if (!valueFilter) return true;
  if (valueFilter.min != null && after < valueFilter.min) return false;
  if (valueFilter.max != null && after > valueFilter.max) return false;
  return true;
}

// Downsample an array to at most `n` evenly-spaced elements, ALWAYS keeping the
// first and last (so a value-vs-frame curve still spans the whole window). For
// n>=length returns the array unchanged; for n<=1 returns just the last point.
function downsample(arr, n) {
  const len = arr.length;
  if (len <= n) return arr;
  if (n <= 1) return [arr[len - 1]];
  const out = [];
  const step = (len - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

export function registerWatchMemoryTools(server, z, sessionKey) {
  const rangeShape = z.object({
    region: z.enum(MEMORY_REGIONS),
    offset: z.number().int().min(0),
    length: z.number().int().min(1).max(4096).default(1),
    label: z.string().optional().describe("Name echoed on every event from this range — tells disjoint ranges apart in one stream."),
    // Per-range overrides of the call-wide filters. The whole point: in a
    // multi-range watch, keep EVERY transition of a slow state byte while
    // sampling/suppressing a fast free-running counter in the SAME pass.
    onChange: z.enum(["any", "increase", "decrease", "reset"]).optional().describe("Per-range edge filter; overrides the call-wide `onChange` for THIS range only."),
    sampleEvery: z.number().int().min(1).optional().describe("Per-range downsample: keep every Nth change from THIS range (e.g. 8 to thin a noisy counter while other ranges stay full)."),
    valueFilter: z.object({ min: z.number().int().min(0).max(255).optional(), max: z.number().int().min(0).max(255).optional() }).optional().describe("Per-range value window; overrides the call-wide `valueFilter` for THIS range."),
  });

  // watch({on:mem|range|pc}) LOG-ALL. on:mem=watchMem (the power tool below),
  // on:range=wRange, on:pc=wLogPC.
  async function watchMem({ region, offset = 0, length = 1, ranges, frames = 600, stopOnFirst = false, onChange = "any", valueFilter, maxEvents = 256, format = "events", sampleEvery = 1, groupByPC = false, outputPath, pressDuring, cheatLabels }) {
      const host = getHost(sessionKey);

      // Normalize to a list of ranges. Single-range mode requires `region`.
      const watchRanges = (ranges && ranges.length)
        ? ranges.map((r) => ({ length: 1, ...r }))
        : (() => {
            if (!region) throw new Error("watchMemory: pass `region` (single-range) or `ranges` (multi-range).");
            return [{ region, offset, length }];
          })();

      // Optional: auto-label watched RAM addresses from the cheat DB. Builds an
      // address→desc map from the matched game's RAM cheats and fills in `label`
      // for any range whose CPU address lines up (system_ram offset == address)
      // and that the caller didn't already label. Free semantic names; PROBABLE
      // match (see gameCheats) — labels are strong hints, not gospel.
      let cheatLabelInfo;
      if (cheatLabels) {
        try {
          const idMod = await import("../../rom-id/identifier.js");
          const { lookupCheats } = await import("../../cheats/lookup.js");
          const id = await idMod.identifyFile(cheatLabels).catch(() => null);
          const res = await lookupCheats({ platform: id?.platform, fileName: path.basename(cheatLabels), romName: id?.title || undefined });
          if (res.matched) {
            const addrToDesc = new Map();
            for (const e of res.entries) {
              for (const p of (e.parts || [])) {
                if (p && p.kind === "ram" && !addrToDesc.has(p.address)) addrToDesc.set(p.address, e.desc);
              }
            }
            for (const r of watchRanges) {
              if (r.label) continue;
              // Only RAM-class regions where offset maps 1:1 to CPU address.
              if (!/(^system_ram$|_ram$|_wram$|^gb_hram$)/.test(r.region)) continue;
              const desc = addrToDesc.get(r.offset);
              if (desc) r.label = desc;
            }
            cheatLabelInfo = { matched: true, game: res.game, confidence: res.confidence, labeled: watchRanges.filter((r) => r.label).length };
          } else {
            cheatLabelInfo = { matched: false };
          }
        } catch { cheatLabelInfo = { matched: false }; }
      }

      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      const startFrame = host.status.frameCount;

      // Per-range previous snapshots.
      let prevs = watchRanges.map((r) => snap(host, r.region, r.offset, r.length));
      const rangeSample = new Array(watchRanges.length).fill(0); // per-range sampleEvery counters

      const preview = [];          // bounded inline events
      let totalMatched = 0;        // ALL filter-passing events (file-backed)
      let sampleCounter = 0;       // for sampleEvery: keep every Nth match
      let truncated = false;       // inline preview hit maxEvents
      let stoppedEarly = false;
      const fileLines = [];        // NDJSON lines when outputPath set
      // groupByPC accumulator: pc -> {hits, firstFrame, lastFrame, offsets:Set}.
      // Collapses "which instructions touched this byte" — the canonical
      // "find the hot-path writer" question — into one row per PC regardless of
      // how many thousands of times each fired.
      const byPc = groupByPC ? new Map() : null;
      // format:"series" accumulator: offsetHex -> {offset, offsetHex, label,
      // region, frames:[], values:[]}. The compact value-vs-frame curve, with
      // the repeated boilerplate hoisted into the per-offset header (set once).
      const seriesMap = format === "series" ? new Map() : null;

      const pushEvent = (ev) => {
        totalMatched++;
        // sampleEvery: keep only every Nth filter-passing change (1 = all).
        if (sampleEvery > 1) {
          const keep = (sampleCounter % sampleEvery) === 0;
          sampleCounter++;
          if (!keep) return;
        }
        if (seriesMap) {
          const key = ev.offsetHex ?? String(ev.offset);
          let s = seriesMap.get(key);
          if (!s) {
            s = { offset: ev.offset, offsetHex: ev.offsetHex, region: ev.region, frames: [], values: [] };
            if (ev.label != null) s.label = ev.label;
            seriesMap.set(key, s);
          }
          s.frames.push(ev.frame);
          s.values.push(ev.after);
        }
        if (byPc) {
          const key = ev.pc ?? "(unknown)";
          let g = byPc.get(key);
          if (!g) { g = { pc: key, hits: 0, firstFrame: ev.frame, lastFrame: ev.frame, offsets: new Set() }; byPc.set(key, g); }
          g.hits++;
          g.lastFrame = ev.frame;
          g.offsets.add(ev.offsetHex ?? ev.offset);
        }
        if (outputPath) fileLines.push(JSON.stringify(ev));
        // When grouping, the per-event preview is redundant with the summary —
        // keep only a tiny sample for context (the byPC[] rows are the answer;
        // a 30-event watch shouldn't dump ~360 lines of raw events too).
        const cap = byPc ? Math.min(maxEvents, 8) : maxEvents;
        if (preview.length < cap) preview.push(ev);
        else { truncated = true; }
      };

      outer:
      for (let i = 0; i < frames; i++) {
        // Set held-button state for this frame BEFORE stepping (the loop owns
        // stepFrames; the driver only calls setInput).
        pressDriver.applyForFrame(i);
        host.stepFrames(1);
        const frameAbs = startFrame + i + 1;
        let pcCached;
        const pcOnce = () => (pcCached !== undefined ? pcCached : (pcCached = tryGetPC(host)));

        for (let ri = 0; ri < watchRanges.length; ri++) {
          const r = watchRanges[ri];
          const cur = snap(host, r.region, r.offset, r.length);
          const changes = diffSnapshots(prevs[ri], cur, r.offset, r.label);
          prevs[ri] = cur;
          // Per-range filter overrides fall back to the call-wide values.
          const rOnChange = r.onChange ?? onChange;
          const rValueFilter = r.valueFilter ?? valueFilter;
          const rSampleEvery = r.sampleEvery ?? 1;
          for (const c of changes) {
            if (!edgeMatches(rOnChange, c.before, c.after)) continue;
            if (!valueMatches(rValueFilter, c.after)) continue;
            // Per-range downsample (independent of the call-wide sampleEvery,
            // which still applies globally inside pushEvent).
            if (rSampleEvery > 1) {
              rangeSample[ri] = (rangeSample[ri] ?? 0) + 1;
              if ((rangeSample[ri] - 1) % rSampleEvery !== 0) continue;
            }
            const pc = pcOnce();
            pushEvent({
              frame: frameAbs,
              frameRelative: i + 1,
              region: r.region,
              ...c,
              pc: hexPC(pc),
              pcRaw: pc,
            });
            if (stopOnFirst) { stoppedEarly = true; break outer; }
            // Without a file, once the inline preview is full there's no point
            // continuing — EXCEPT when grouping (byPC[] needs every event) or in
            // series mode (the curve needs every point before its own downsample).
            if (!outputPath && !byPc && !seriesMap && truncated) break outer;
          }
        }
      }
      pressDriver.finish();   // release any still-held buttons

      // Build the grouped-by-PC summary (sorted by hit count, descending).
      const byPCSummary = byPc
        ? Array.from(byPc.values())
            .sort((a, b) => b.hits - a.hits)
            .map((g) => ({ pc: g.pc, hits: g.hits, firstFrame: g.firstFrame, lastFrame: g.lastFrame, offsets: Array.from(g.offsets) }))
        : undefined;

      const base = {
        framesStepped: stoppedEarly ? undefined : frames,
        watched: watchRanges,
        onChange,
        valueFilter: valueFilter ?? null,
        eventCount: totalMatched,
        ...(byPCSummary ? { byPC: byPCSummary, distinctPCs: byPCSummary.length } : {}),
        // When the caller scheduled input, ALWAYS report what landed — so a
        // press that never registered is visible, not a silent eventCount:0.
        ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
        ...(cheatLabelInfo ? { cheatLabels: cheatLabelInfo } : {}),
        stoppedEarly,
        truncated,
        note: totalMatched === 0
          ? "No matching changes in the watched window. Try (a) onChange:'any' to confirm the byte moves at all, (b) longer `frames`, (c) `pressDuring` to drive the game past the event, (d) a different region/offset. If the byte never moves even with onChange:'any', this region may be REBUILT as a block (sprite/OAM shadow, display list, VRAM) rather than written in place — watch the SOURCE struct the copy/DMA reads from instead (find it with searchValue)."
          : (tryGetPC(host) == null ? "PC not available for this platform (getCPUState returned no pc field)." : undefined),
      };

      if (outputPath) {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, fileLines.length ? fileLines.join("\n") + "\n" : "");
        return jsonContent({
          ...base,
          path: outputPath,
          format: "ndjson",
          previewCount: preview.length,
          preview,
          previewNote: truncated
            ? `Inline preview capped at ${maxEvents} of ${totalMatched} events; the COMPLETE log is in the file.`
            : "All events fit inline AND are in the file.",
        });
      }

      // format:"series" — compact columnar value-vs-frame curve per offset.
      // maxEvents caps SAMPLES PER OFFSET by DOWNSAMPLING (evenly-spaced subset
      // that always keeps the first and last point) rather than truncating, so
      // the curve spans the whole window in one call.
      if (seriesMap) {
        let anyDownsampled = false;
        const series = Array.from(seriesMap.values()).map((s) => {
          const total = s.frames.length;
          let { frames: fr, values: va } = s;
          if (total > maxEvents) {
            anyDownsampled = true;
            fr = downsample(fr, maxEvents);
            va = downsample(va, maxEvents);
          }
          return {
            offset: s.offset, offsetHex: s.offsetHex, region: s.region,
            ...(s.label != null ? { label: s.label } : {}),
            points: fr.length, totalChanges: total,
            ...(total > maxEvents ? { downsampledFrom: total } : {}),
            frames: fr, values: va,
          };
        });
        return jsonContent({
          ...base,
          format: "series",
          ...(sampleEvery > 1 ? { sampleEvery } : {}),
          series,
          ...(anyDownsampled
            ? { seriesNote: `One or more offsets had >maxEvents (${maxEvents}) changes and were DOWNSAMPLED to an evenly-spaced subset spanning the full window (first+last kept). Raise maxEvents or lower sampleEvery for more resolution; use outputPath for every raw delta.` }
            : {}),
        });
      }

      return jsonContent({ ...base, events: preview, ...(sampleEvery > 1 ? { sampleEvery } : {}) });
  }

  // breakpoint({on:write|read|pc}) STOP-on-first. on:write precision:exact=bpFindWriter
  // (core watchpoint, true PC under IRQ), precision:sampled=bpRunUntilWrite (frame PC).
  async function bpFindWriter({ address, maxFrames = 600, pressDuring, abortIf }) {
      const host = getHost(sessionKey);
      if (!host.watchpointSupported || !host.watchpointSupported()) {
        return jsonContent({
          found: false, notSupported: true, address: "$" + address.toString(16).toUpperCase(),
          note: "This core build has no instruction-level write watchpoint (shipped on all 14 platforms — update the core package if you see this; only PC Engine lacked it before 0.6.0). " +
            "Use watchMemory/runUntilWrite here — their pc is frame-sampled, so cross-check the value trace.",
        });
      }
      host.setWatchpoint(address, true);
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      // Abort-guard: sample caller-named "still valid?" bytes each frame; if any
      // changes, a driven run that DERAILED (player died → title screen, scene
      // flipped, …) stops immediately instead of burning all maxFrames and
      // returning a meaningless found:false. (v0.15.0 feedback #2.)
      const guard = makeAbortGuard(host, abortIf);
      let result = null;
      let aborted = null;
      for (let i = 0; i < maxFrames; i++) {
        pressDriver.applyForFrame(i);
        host.stepFrames(1);
        const w = host.getWatchpoint();
        if (w.hits > 0) { result = { ...w, framesStepped: i + 1 }; break; }
        const ab = guard.check();
        if (ab) { aborted = { ...ab, framesStepped: i + 1 }; break; }
      }
      pressDriver.finish();
      host.setWatchpoint(address, false); // disarm
      if (aborted) {
        return jsonContent({
          found: false, aborted: true, abortedBy: aborted.label,
          abortAddress: aborted.addr, before: aborted.before, after: aborted.after,
          framesStepped: aborted.framesStepped,
          ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
          note: `Run aborted early: the watched abort byte ${aborted.label} (${aborted.addr}) changed ` +
            `${aborted.before}→${aborted.after} at frame ${aborted.framesStepped}, so the driven scenario left the ` +
            `expected state (e.g. player died / scene changed) before the write fired. The found:false is NOT a real ` +
            `miss — fix the input plan or pick a different start state, then re-run.`,
        });
      }
      if (!result) {
        return jsonContent({
          found: false, address: "$" + address.toString(16).toUpperCase(), framesStepped: maxFrames,
          ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
          ...(abortIf && abortIf.length ? { abortIfArmed: guard.count } : {}),
          // One-line hint by default; the full "two reasons" explainer is verbose
          // boilerplate as a repeated payload (v0.15.0 feedback #2b) — gated to the
          // FIRST miss per session.
          note: noHitNote(sessionKey),
        });
      }
      // When the core reports a PRG-ROM offset for the PC (fceumm/NES), it
      // disambiguates the BANK — turn it into the iNES bank index + the prg.bin
      // offset so disassembleRom can target the exact bank, no $FF-padding from
      // the wrong (fixed) bank on a banked mapper.
      const prgOffset = result.prgOffset;
      const bankInfo = (prgOffset != null)
        ? { prgOffset: "0x" + prgOffset.toString(16).toUpperCase(), bank: Math.floor(prgOffset / 0x4000) }
        : null;
      return attachObserverFrame(jsonContent({
        found: true,
        address: "$" + address.toString(16).toUpperCase(),
        pc: result.lastPC != null ? "$" + result.lastPC.toString(16).toUpperCase() : null,
        pcRaw: result.lastPC,
        value: "0x" + result.lastValue.toString(16).toUpperCase().padStart(2, "0"),
        hits: result.hits,
        framesStepped: result.framesStepped,
        ...(bankInfo ? bankInfo : {}),
        ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
        note: "pc is the EXACT writing instruction (captured in the CPU write path), not a frame sample. " +
          (bankInfo
            ? `pc is in PRG bank ${bankInfo.bank} (prg offset ${bankInfo.prgOffset}) — disassembleRom({ startAddress: ${result.lastPC != null ? "0x" + result.lastPC.toString(16) : "pc"}, bank: ${bankInfo.bank} }) targets the exact bank (no fixed-bank $FF padding).`
            : `disassembleRom({ startAddress: ${result.lastPC != null ? "0x" + result.lastPC.toString(16) : "pc"} }) to see it. On a banked mapper a $8000-$BFFF pc may be in a switchable bank — pass the right \`bank\`.`),
      }), host);
  }

  async function bpRunUntilWrite({ region, offset, length = 1, maxFrames = 600, pressDuring }) {
      const host = getHost(sessionKey);
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      let prev = snap(host, region, offset, length);
      const startFrame = host.status.frameCount;

      for (let i = 0; i < maxFrames; i++) {
        // Hold scheduled input via setInput before stepping (loop owns stepFrames).
        pressDriver.applyForFrame(i);
        host.stepFrames(1);
        const cur = snap(host, region, offset, length);
        const changes = diffSnapshots(prev, cur, offset);
        if (changes.length > 0) {
          const pc = tryGetPC(host);
          const frameAbs = startFrame + i + 1;
          pressDriver.finish();
          return attachObserverFrame(jsonContent({
            written: true,
            frame: frameAbs,
            frameRelative: i + 1,
            changes,
            ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
            pc: hexPC(pc),
            pcRaw: pc,
            // NOTE: this PC is sampled at the frame boundary AFTER the write, not
            // captured at the writing instruction. For NMI/IRQ-driven writes
            // (the common case on NES/GB) it is usually the interrupted
            // main-thread PC (often an idle loop), NOT the writer. Treat it as a
            // lead, and confirm against the value trace / a manual disasm.
            pcCaveat: "pc is a frame-boundary sample, not the writing instruction; for ISR-driven writes it is typically the interrupted main-thread PC (e.g. an idle loop), not the code that wrote the byte.",
            hint: pc != null
              ? `disassembleRom near ${hexPC(pc)} is a STARTING point — but if this ROM writes from an NMI/IRQ handler, ${hexPC(pc)} is likely the interrupted idle loop, not the writer. Cross-check with the value trace.`
              : "PC was not available — check that getCPUState is wired for this platform.",
          }), host);
        }
        prev = cur;
      }
      pressDriver.finish();
      return jsonContent({
        written: false,
        framesStepped: maxFrames,
        ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
        note: "Target byte was not written within maxFrames. Try increasing maxFrames or driving the game with pressDuring.",
      });
  }

  async function bpRunUntilPC({ address, maxFrames = 600, pressDuring }) {
      const host = getHost(sessionKey);
      if (!host.pcBreakSupported || !host.pcBreakSupported()) {
        return jsonContent({
          hit: false, notSupported: true, address: "$" + address.toString(16).toUpperCase(),
          note: "This core build has no PC breakpoint (shipped on all 14 platforms as of 0.5.0 — update the core package if you see this). " +
            "Interim: use runUntilWrite/findWriter to anchor on a write, or stepFrames + getCPUState sampling.",
        });
      }
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      host.setPCBreak(address, true, false);
      let hit = false, framesRun = 0, last = null;
      try {
        for (let i = 0; i < maxFrames; i++) {
          pressDriver.applyForFrame(i);
          host.stepFrames(1);
          framesRun++;
          const st = host.getPCBreak(false);
          if (st.hit) { hit = true; last = st; break; }
        }
      } finally {
        pressDriver.finish();
        host.setPCBreak(0, false, false); // disarm
      }
      if (!hit) {
        return attachObserverFrame(jsonContent({
          hit: false, address: "$" + address.toString(16).toUpperCase(), framesRun,
          ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
          note: "PC never reached that address within maxFrames. Either the code path didn't execute (drive it with pressDuring " +
            "to reach the right game state), or the address isn't an instruction boundary (a mid-instruction address never matches REG_PC).",
        }), host);
      }
      const fin = host.getPCBreak(true); // clear hit
      return attachObserverFrame(jsonContent({
        hit: true,
        address: "$" + address.toString(16).toUpperCase(),
        pc: last.lastPC != null ? "$" + last.lastPC.toString(16).toUpperCase() : null,
        pcRaw: last.lastPC,
        frame: host.status.frameCount,
        framesRun,
        hits: fin.hits,
        ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
        note: "CPU is FROZEN at this instruction. Call cpu({op:'read'}) to read all registers at this exact " +
          "moment (the value you want — e.g. an address register holding a source pointer — is live now), then memory({op:'read'/'readCart'}) " +
          "at that pointer. frame({op:'stepInstruction'}) to single-step, or frame({op:'step'})/host({op:'resume'}) to continue.",
      }), host);
  }

  async function bpRunUntilRead({ address, maxFrames = 600, pressDuring }) {
      const host = getHost(sessionKey);
      if (!host.readWatchSupported || !host.readWatchSupported()) {
        return jsonContent({
          hit: false, notSupported: true, address: "$" + address.toString(16).toUpperCase(),
          note: "This core build has no read watchpoint (shipped on all 14 platforms as of 0.5.0 — update the core package if you see this).",
        });
      }
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      host.setReadWatch(address, true);
      let hit = false, framesRun = 0, last = null;
      try {
        for (let i = 0; i < maxFrames; i++) {
          pressDriver.applyForFrame(i);
          host.stepFrames(1);
          framesRun++;
          const st = host.getReadWatch(false);
          if (st.hits > 0) { hit = true; last = st; break; }
        }
      } finally {
        pressDriver.finish();
        host.setReadWatch(0, false);
      }
      if (!hit) {
        return jsonContent({
          hit: false, address: "$" + address.toString(16).toUpperCase(), framesRun,
          ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
          note: "Address was not read within maxFrames. Drive the game to the state that reads it (pressDuring), or increase maxFrames.",
        });
      }
      const fin = host.getReadWatch(true);
      return attachObserverFrame(jsonContent({
        hit: true,
        address: "$" + address.toString(16).toUpperCase(),
        pc: last.lastPC != null ? "$" + last.lastPC.toString(16).toUpperCase() : null,
        pcRaw: last.lastPC,
        value: "0x" + (last.lastValue & 0xFF).toString(16).toUpperCase().padStart(2, "0"),
        frame: host.status.frameCount,
        framesRun,
        hits: fin.hits,
        ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
        note: "pc is the EXACT instruction that read this address. disasm({ target:'rom', startAddress: pc }) to see it.",
      }), host);
  }

  server.tool(
    "breakpoint",
    "STOP-on-first dynamic breakpoints — run until a condition hits, then stop. One tool keyed by `on`. (For LOG-ALL " +
    "coverage over many frames use `watch`; for a value-predicate closure use `runUntil`.)\n" +
    "• on:'write' — break when a CPU `address` is written. **`precision` is the key axis here:**\n" +
    "    – precision:'exact' (default) — arms a core-level WRITE WATCHPOINT and returns the writing instruction's PC " +
    "captured INSIDE the CPU write path — **correct even for NMI/IRQ-driven writes** (where a frame sample is just the idle loop). " +
    "The precise answer to 'which code wrote $XX?'. On banked NES mappers it also reports the prg bank.\n" +
    "    – precision:'sampled' — the cheap wrapper: steps until a memory `region`/`offset` byte changes and returns the PC " +
    "**sampled at the frame boundary**. **CAVEAT: that PC is NOT the writing instruction — under interrupts it's usually the " +
    "interrupted main-thread PC (an idle loop), a LIE. Use 'exact' when you need the real writer.**\n" +
    "• on:'read' — break when the CPU READS `address` (the read-side mirror of on:'write' exact): the EXACT instruction PC that " +
    "read the byte. Finds who CONSUMES a value. Does NOT freeze mid-frame — records the PC and finishes the frame.\n" +
    "• on:'pc' — break when the PC reaches `address`, freezing the CPU EXACTLY at that instruction (a real execution breakpoint). " +
    "**The RE primitive for 'read the register at this instruction': break, then cpu({op:'read'}) the live register file** " +
    "(e.g. break at a decoder's `move.b (a0),d0` and read A0 = the source address). After a hit the CPU stays FROZEN mid-frame — " +
    "inspect, then frame({op:'step'/'stepInstruction'}) to continue. (on:'read'/'write' finish the frame; on:'pc' freezes.)\n" +
    "All supported on every CPU core; out-of-date core packages return notSupported.",
    {
      on: z.enum(["write", "read", "pc"])
        .describe("write=break on a write to address (precision:exact=true writer PC / sampled=frame PC, a lie under IRQ); read=break on a read (exact PC, who consumes it); pc=break when PC reaches address (freezes mid-instruction)."),
      precision: z.enum(["exact", "sampled"]).default("exact")
        .describe("on:'write' ONLY. exact=core watchpoint, the real writing instruction PC even under interrupts (uses `address`). sampled=cheap frame-boundary PC (uses region/offset/length) — NOT the writer under IRQ. Ignored for on:read/pc (always exact)."),
      address: z.number().int().min(0).optional().describe("on:'write' exact / on:'read' / on:'pc' — CPU address to break on (write target, read target, or instruction boundary). Required for those."),
      region: z.enum(MEMORY_REGIONS).optional().describe("on:'write' precision:'sampled' — region whose byte to watch for change."),
      offset: z.number().int().min(0).optional().describe("on:'write' precision:'sampled' — offset within the region."),
      length: z.number().int().min(1).max(4096).default(1).describe("on:'write' precision:'sampled' — bytes to watch from offset."),
      maxFrames: z.number().int().min(1).max(1_000_000).default(600).describe("Max frames to run while waiting for the condition."),
      pressDuring: z.array(z.object({
        frame: z.number().int().min(0),
        button: z.string(),
        port: z.number().int().min(0).max(3).default(0),
        holdFrames: z.number().int().min(1).default(2),
      })).optional().describe("Schedule input while waiting (drive the game to the state that triggers the condition). If OMITTED, this run inherits whatever input({op:'set'}) last held — same as frame({op:'step'}). If GIVEN, the schedule OWNS the pad for the whole run (a prior input({op:'set'}) is ignored); use it to drive the watched window itself."),
      abortIf: z.array(z.object({
        region: z.enum(MEMORY_REGIONS).optional().describe("memory region (default system_ram)"),
        offset: z.number().int().min(0).describe("byte offset within the region"),
        label: z.string().optional().describe("human name for this guard byte"),
      })).optional().describe("on:'write' exact — ABORT GUARD for a pressDuring run: caller-named 'is this scenario still valid?' bytes (e.g. the area/scene id, the player object-active flag). If ANY changes mid-run the watchpoint stops IMMEDIATELY and returns {aborted:true, abortedBy, before, after} — so a driven scenario that derailed (player died → title screen) doesn't burn all maxFrames and return a meaningless found:false. Each is sampled once per frame (cheap)."),
    },
    safeTool(async (args) => {
      switch (args.on) {
        case "write": {
          if (args.precision === "sampled") {
            if (!args.region || args.offset == null) throw new Error("breakpoint({on:'write', precision:'sampled'}): `region` and `offset` are required.");
            return await bpRunUntilWrite(args);
          }
          if (args.address == null) throw new Error("breakpoint({on:'write', precision:'exact'}): `address` is required.");
          return await bpFindWriter(args);
        }
        case "read": {
          if (args.address == null) throw new Error("breakpoint({on:'read'}): `address` is required.");
          return await bpRunUntilRead(args);
        }
        case "pc": {
          if (args.address == null) throw new Error("breakpoint({on:'pc'}): `address` is required.");
          return await bpRunUntilPC(args);
        }
        default: throw new Error(`breakpoint: unknown on '${args.on}'`);
      }
    }),
  );

  // stepInstruction folded into frame({op:'stepInstruction'}) (frame.js, which
  // imports stepInstructionCore). Nothing registered here.

  // ── register write/read + callSubroutine / decompressWith (item 1) ──────────
  // reg-id convention (m68k family): 0..7=D0..D7, 8..15=A0..A7, 16=PC, 17=SR, 18=SP.

  // cpu({op:read|setReg|call|decompress}) router. op:read -> getCPUStateCore
  // (platform-tools.js). The other 3 are closure impls below (they need the
  // per-session host). regSchema is shared by the call op.
  const regSchema = z.record(z.string(), z.number().int()).optional().describe(
    "op:call — registers to set before the call, keyed by romdev reg-id (m68k: 0-7=D0-D7, 8-15=A0-A7, 16=PC, 17=SR, 18=SP). " +
    "e.g. {\"8\":2863118} sets A0. PC is set from the `pc` arg, not here.");

  async function cpuSetReg({ regId, value }) {
      const host = getHost(sessionKey);
      if (!host.setRegSupported || !host.setRegSupported()) {
        return jsonContent({ notSupported: true, note: "This core build has no register-write (shipped on all 14 platforms as of 0.6.0 — update the core package if you see this)." });
      }
      host.setReg(regId, value >>> 0);
      const now = host.getReg(regId);
      return jsonContent({ regId, value: "0x" + (now >>> 0).toString(16).toUpperCase(), valueRaw: now });
  }

  async function cpuCall({ pc, regs, sentinelPC = 0, stopAtPC, presetMemory, maxFrames = 600, maxInstructions, sandbox = false }) {
      const host = getHost(sessionKey);
      if (!host.setRegSupported || !host.setRegSupported()) {
        return jsonContent({ returned: false, notSupported: true,
          note: "This core build has no register-write (shipped on all 14 platforms as of 0.6.0 — update the core package). cpu({op:'call'}) needs it." });
      }
      const numRegs = {};
      for (const [k, v] of Object.entries(regs ?? {})) numRegs[Number(k)] = v >>> 0;
      const r = host.callSubroutine({
        pc, regs: numRegs, sentinelPC, stopAtPC,
        presetMemory: (presetMemory ?? []).map((m) => ({ addr: m.addr, hex: m.hex })),
        maxFrames, ...(maxInstructions ? { maxInstructions } : {}), sandbox,
      });
      const note = r.returned
        ? "Routine RETURNED. readMemory the buffer it wrote (e.g. the decompressor's A1 dest) now — sandbox:false leaves it live. (regs by reg-id: m68k 8=A0,9=A1,0=D0.)"
        : r.watchdog
          ? "WATCHDOG tripped (ran the instruction budget without returning) — almost always a wrong entry setup, not a long routine. Check finalPC (where it's spinning) + finalRegs (is A0 where you set it, or did it walk off?). Common fixes: correct A0 to the real block start (with its length header), add a presetMemory the codec reads, or pass a WRAPPER entryPC that sets up dest. Raise maxInstructions only if you're sure it's legitimately huge."
          : r.stoppedAtPC
            ? `Stopped at ${r.stoppedAtPC} (your stopAtPC) with PARTIAL output — readMemory the dst to see what's been written so far.`
            : "Did not return within maxFrames AND the watchdog didn't trip — this usually means the entry FELL BACK INTO THE GAME (a wrapper PC with a wrong source, so it never reaches the sentinel) and the game is just free-running. finalPC is inside the main loop, not your routine. Re-check the entry PC (use the routine body, not a wrapper) and the source regs; or lower maxInstructions to fail fast while probing. Bump maxFrames/maxInstructions only if you're sure it's a legitimately huge decompress.";
      return jsonContent({
        returned: r.returned, framesRun: r.framesRun, sandbox,
        ...(r.watchdog ? { watchdog: true, reason: r.reason } : {}),
        ...(r.stoppedAtPC ? { stoppedAtPC: r.stoppedAtPC } : {}),
        ...(r.finalPC ? { finalPC: r.finalPC } : {}),
        ...(r.finalRegs ? { finalRegs: r.finalRegs } : {}),
        note,
      });
  }

  async function cpuDecompress({ entryPC, sourceAddress, destAddress, maxFrames = 600 }) {
      const host = getHost(sessionKey);
      if (!host.setRegSupported || !host.setRegSupported()) {
        return jsonContent({ returned: false, notSupported: true,
          note: "This core build has no register-write (shipped on all 14 platforms as of 0.6.0 — update the core package). decompressWith needs it." });
      }
      const regs = { 8: sourceAddress >>> 0 };
      if (destAddress !== undefined) regs[9] = destAddress >>> 0;
      const r = host.callSubroutine({ pc: entryPC, regs, sentinelPC: 0, maxFrames, sandbox: false });
      return jsonContent({
        returned: r.returned, framesRun: r.framesRun,
        ...(destAddress !== undefined ? { destAddress: "$" + (destAddress >>> 0).toString(16).toUpperCase() } : {}),
        note: r.returned
          ? `Decompressor returned. readMemory at ${destAddress !== undefined ? "$" + (destAddress >>> 0).toString(16).toUpperCase() : "the routine's dest"} to get the decompressed bytes (the live core ran the game's own codec — no codec reimplementation needed).`
          : "Decompressor did NOT return within maxFrames. Confirm entryPC is the routine start, A0=source is right, and bump maxFrames. (Some codecs expect more setup regs — use cpu({op:'call'}) with the full regs map.)",
      });
  }

  server.tool(
    "cpu",
    "Read or drive a CPU, one tool keyed by `op`.\n" +
    "OP CHEAT-SHEET (the params each op uses): " +
    "read → {cpu?, platform?}; " +
    "setReg → {regId, value}; " +
    "call → {pc, regs?, sandbox?, maxInstructions?, sentinelPC?, stopAtPC?, presetMemory?, maxFrames?}; " +
    "decompress → {entryPC, sourceAddress, destAddress?, maxFrames?}.\n" +
    "• op:'read' — read a CPU's {pc, registers, flags, sp}. Main CPU wired for all 14 tier-1 systems (nes, snes, " +
    "genesis, sms, gg, gb, gbc, atari2600, atari7800, c64, lynx, gba (ARM7TDMI: 16 gprs + cpsr/spsr + execPc for " +
    "pipeline prefetch), pce, msx). Secondary CPUs via `cpu`: 'spc700' (SNES audio — 'stuck in IPL' vs 'running' vs " +
    "'crashed'), 'z80' (Genesis sound — held in reset until the 68k releases it via $A11100, so a fresh boot reads all-zero).\n" +
    "• op:'setReg' — write a single register by romdev reg-id (the inverse of op:'read'). **m68k reg-ids: 0-7=D0-D7, " +
    "8-15=A0-A7, 16=PC, 17=SR, 18=SP.** Returns the value read back. notSupported where the core lacks register-write.\n" +
    "• op:'call' — drive the ROM's OWN subroutine and run until it returns — the RE primitive for compressed assets. Set " +
    "up the CPU (`regs` by reg-id, PC=`pc`), push a sentinel return, run until RTS. **SANDBOXED off by default so the dst " +
    "buffer it wrote stays live for memory({op:'read'}).** Classic use: drive a decompressor (A0=source, A1=dest) then read " +
    "the dst. **NEVER HANGS: an instruction WATCHDOG (`maxInstructions`) force-stops a runaway and returns PROGRESS — " +
    "finalPC + finalRegs + watchdog:true — so you can tell 'wrong A0' from 'needs a preset' from 'legitimately long'.** " +
    "`stopAtPC` halts mid-routine for partial output; `presetMemory` for codecs that read a global from RAM first.\n" +
    "• op:'decompress' — convenience wrapper over op:'call' for the common decompressor shape: call `entryPC` with " +
    "A0=`sourceAddress` (and optionally A1=`destAddress`), run until it returns, then read `destAddress`. For the " +
    "NBA-Jam-style 'name + portrait are LZ-compressed' wall: point it at the game's own decompressor.",
    {
      op: z.enum(["read", "setReg", "call", "decompress"])
        .describe("read=CPU registers/flags; setReg=write one register; call=drive a subroutine until it returns; decompress=call shortcut (A0=source, A1=dest)."),
      // read
      platform: z.string().optional().describe("op:read — override platform; defaults to the loaded ROM."),
      cpu: z.enum(["main", "spc700", "z80"]).default("main").describe("op:read — which CPU: main (primary), spc700 (SNES audio), z80 (Genesis sound)."),
      // setReg
      regId: z.number().int().min(0).max(31).optional().describe("op:setReg — romdev reg-id (m68k: 0-7=D, 8-15=A, 16=PC, 17=SR, 18=SP)."),
      value: z.number().int().optional().describe("op:setReg — 32-bit value to write."),
      // call
      pc: z.number().int().min(0).optional().describe("op:call — entry PC of the subroutine (may be a WRAPPER that sets up regs then tail-calls; sentinel-return is detected from the final RTS regardless)."),
      regs: regSchema,
      sentinelPC: z.number().int().min(0).default(0).describe("op:call — return address pushed on the stack; run stops when PC reaches it. Default 0 (vector area); override if it collides with real code."),
      stopAtPC: z.number().int().min(0).optional().describe("op:call — STOP when PC reaches this address and return the partial output instead of waiting for the sentinel return."),
      presetMemory: z.array(z.object({
        addr: z.number().int().min(0).describe("CPU address to write before the call."),
        hex: z.string().describe("Bytes as hex (e.g. '00FF')."),
      })).optional().describe("op:call — memory writes applied before the call (codecs that read a global from RAM, not just registers)."),
      maxFrames: z.number().int().min(1).max(100000).default(600).describe("op:call/decompress — frame cap (the outer bound)."),
      maxInstructions: z.number().int().min(1000).optional().describe("op:call — instruction watchdog budget (the REAL cap; default ~maxFrames*500k). Raise for a huge decompress; lower to fail fast while probing the right A0."),
      sandbox: z.boolean().default(false).describe("op:call — snapshot+restore core state around the call (default FALSE — you want the dst buffer left live to read). True leaves the live game untouched."),
      // decompress
      entryPC: z.number().int().min(0).optional().describe("op:decompress — decompressor entry PC."),
      sourceAddress: z.number().int().min(0).optional().describe("op:decompress — compressed-source address → A0 (reg-id 8 on m68k)."),
      destAddress: z.number().int().min(0).optional().describe("op:decompress — destination buffer address → A1 (reg-id 9). Omit if the routine picks its own dest."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "read":     return await getCPUStateCore(args);
        case "setReg": {
          if (args.regId == null || args.value == null) throw new Error("cpu({op:'setReg'}): `regId` and `value` are required.");
          return await cpuSetReg(args);
        }
        case "call": {
          if (args.pc == null) throw new Error("cpu({op:'call'}): `pc` (entry PC) is required.");
          return await cpuCall(args);
        }
        case "decompress": {
          if (args.entryPC == null || args.sourceAddress == null) throw new Error("cpu({op:'decompress'}): `entryPC` and `sourceAddress` are required.");
          return await cpuDecompress(args);
        }
        default: throw new Error(`cpu: unknown op '${args.op}'`);
      }
    }),
  );

  // ── Range watch + coverage trace (item 2, discovery) ────────────────────────

  async function wRange({ start, end, kind = "both", frames = 120, pressDuring, limit = 200, fromState, fromStatePath }) {
      const host = getHost(sessionKey);
      if (!host.rangeWatchSupported || !host.rangeWatchSupported()) {
        return jsonContent({ notSupported: true, events: [],
          note: "This core build has no range watch (shipped on all 14 platforms as of 0.6.0 — update the core package). Use breakpoint({on:'write'/'read'}) for a single address." });
      }
      if (end < start) throw new Error("watch({on:'range'}): end must be >= start.");
      // Optionally restore a savestate FIRST, so the trace runs from a known
      // moment (the deterministic "jump to the boss fight, then see what writes
      // HP" loop) instead of from wherever the live session happens to be.
      const stateInfo = await maybeRestoreState(host, fromState, fromStatePath);
      // pressDuring is driven inside the frame loop; watchRange's host method owns
      // stepping, so for now apply presses up front if any (simple: hold for the run).
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      if (presses.length) pressDriver.applyForFrame(0);
      const r = host.watchRange(start, end, kind, frames);
      pressDriver.finish();
      const events = r.events.slice(0, limit).map((e) => ({
        pc: "$" + e.pc.toString(16).toUpperCase(),
        address: "$" + e.address.toString(16).toUpperCase(),
        value: "0x" + e.value.toString(16).toUpperCase().padStart(2, "0"),
      }));
      // distinct PCs are the actionable summary
      const distinctPCs = [...new Set(r.events.map((e) => e.pc))].slice(0, 64)
        .map((p) => "$" + p.toString(16).toUpperCase());
      return attachObserverFrame(jsonContent({
        range: "$" + start.toString(16).toUpperCase() + "..$" + end.toString(16).toUpperCase(),
        kind, total: r.total, returned: events.length, truncated: r.truncated,
        ...(stateInfo ? { restoredFrom: stateInfo } : {}),
        distinctPCs, events,
        note: "distinctPCs is the actionable summary — each is a routine that touches this range; disasm({target:'rom'}) one to identify the renderer/reader. " +
          (r.truncated ? "TRUNCATED: more events than the buffer held — narrow `start..end` or `frames` for the full set." : ""),
      }), host);
  }

  async function wLogPC({ start, end, frames = 120, pressDuring, limit = 512, fromState, fromStatePath }) {
      const host = getHost(sessionKey);
      if (!host.rangeWatchSupported || !host.rangeWatchSupported()) {
        return jsonContent({ notSupported: true, pcs: [],
          note: "This core build has no coverage trace (shipped on all 14 platforms as of 0.6.0 — update the core package)." });
      }
      if (end < start) throw new Error("watch({on:'pc'}): end must be >= start.");
      const stateInfo = await maybeRestoreState(host, fromState, fromStatePath);
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      if (presses.length) pressDriver.applyForFrame(0);
      const r = host.logPCRange(start, end, frames);
      pressDriver.finish();
      const pcs = r.pcs.slice(0, limit).map((p) => "$" + p.toString(16).toUpperCase());
      return attachObserverFrame(jsonContent({
        window: "$" + start.toString(16).toUpperCase() + "..$" + end.toString(16).toUpperCase(),
        distinct: r.distinct, total: r.total, returned: pcs.length, truncated: r.truncated,
        ...(stateInfo ? { restoredFrom: stateInfo } : {}),
        pcs,
        note: "Each PC is code that EXECUTED in this window. disasm({target:'rom'}) them to find the routine you're hunting. " +
          (r.truncated ? "TRUNCATED — narrow the window for the full distinct set." : ""),
      }), host);
  }

  server.tool(
    "watch",
    "LOG-ALL dynamic tracing — run N frames and log EVERY hit (not stop-on-first; for stop-on-first use `breakpoint`). One tool keyed by `on`.\n" +
    "• on:'mem' — the power tool: answer 'what code is touching this RAM byte?' OR extract a frame-accurate event timeline (music-driver note onsets, physics arcs). Reports every frame that changed a watched byte as {frame,offset,before,after,pc}. " +
    "Extras: `ranges:[{region,offset,length,label}]` watches MANY disjoint regions in ONE pass (identical frames); `onChange:'reset'|'increase'|'decrease'|'any'` edge filter (reset = counter-reload = the note-onset signal); `valueFilter:{min,max}`; `format:'series'` = compact columnar value-vs-frame curve (~10× smaller for a ramp); `sampleEvery`; `groupByPC` (collapse by sampled PC); `cheatLabels` (auto-name addresses from the cheat DB); `outputPath` streams all events as NDJSON; `stopOnFirst` exits on the first match. " +
    "**CAVEAT: frame-level, not instruction-level (last value per frame); the sampled `pc` is a frame-boundary sample — for ISR-driven writes use breakpoint({on:'write', precision:'exact'}) for the real writer.**\n" +
    "• on:'range' — DISCOVERY: log EVERY instruction that reads or writes ANYWHERE in [start,end]. The fix for 'I don't know which PC touches this'. Returns {pc,address,value}[] + the actionable distinctPCs. (Ring-buffered: `truncated:true` if it overflows.) `fromState`/`fromStatePath` restores a savestate FIRST so the trace runs from a known moment (jump to the boss, then see what writes HP) — deterministic + repeatable.\n" +
    "• on:'pc' — DISCOVERY (coverage trace): record every DISTINCT PC executed within [start,end] — 'what code runs here?'. Log execution in the bank where you suspect the renderer lives during the moment it draws, then disassemble the PCs. Also takes `fromState`/`fromStatePath` to trace from a restored moment.\n" +
    "• on:'dma' — GENESIS ONLY: trace mem→VDP DMAs (the answer to 'this name/portrait/logo is a pre-rendered bitmap DMA'd into VRAM — WHERE in ROM?', which on:'write' can't catch). `precision:'exact'` (default) logs every mem→VDP DMA with its VRAM DESTINATION + ROM SOURCE + length (filter by `vramDest`±`destWindow`; `dedupe` collapses the per-frame refresh; `sourceFilter:'rom-only'` drops RAM→VRAM noise; catches a same-frame second DMA). `precision:'sampled'` is the cheap frame-sampled source-register read (may miss two DMAs in one frame, dest-agnostic). On non-Genesis cores returns `notSupported`.",
    {
      on: z.enum(["mem", "range", "pc", "dma"])
        .describe("mem=watch a RAM byte/ranges for value changes over frames (the power tool); range=log every read/write PC in [start,end]; pc=coverage trace of distinct PCs executed in [start,end]; dma=Genesis-only mem→VDP DMA source/dest trace."),
      // on:'mem'
      region: z.enum(MEMORY_REGIONS).optional().describe("on:'mem' single-range — the region to watch (same canonical set memory uses, incl. nes_apu_regs, genesis_ym2612, c64_sid_regs). Omit when using `ranges`."),
      offset: z.number().int().min(0).default(0).describe("on:'mem' single-range — first byte of the watched range."),
      length: z.number().int().min(1).max(4096).default(1).describe("on:'mem' single-range — bytes to watch (default 1)."),
      ranges: z.array(rangeShape).min(1).max(16).optional().describe("on:'mem' — watch several disjoint ranges in one pass (region/offset/length ignored). Each event carries its range's `label`; each range may OVERRIDE call-wide `onChange`/`sampleEvery`/`valueFilter` (keep a slow state byte while suppressing a noisy counter in the same pass)."),
      onChange: z.enum(["any", "increase", "decrease", "reset"]).default("any").describe("on:'mem' edge filter. 'any' (default); 'increase'/'decrease' directional; 'reset' = value jumped UP (counter reload — the note-onset signal)."),
      valueFilter: z.object({ min: z.number().int().min(0).max(255).optional(), max: z.number().int().min(0).max(255).optional() }).optional().describe("on:'mem' — keep only changes whose NEW value is within [min,max]."),
      maxEvents: z.number().int().min(1).max(100_000).default(256).describe("on:'mem' — cap RETURNED events (outputPath gets ALL). With format:'series' caps SAMPLES PER OFFSET and downsamples to span the full window."),
      format: z.enum(["events", "series"]).default("events").describe("on:'mem' — 'events' (verbose per change) or 'series' (compact columnar frames[]/values[] curve, ~10× smaller for a ramp; drops pc)."),
      sampleEvery: z.number().int().min(1).default(1).describe("on:'mem' — keep only every Nth filter-passing change (trend, not every delta)."),
      groupByPC: z.boolean().default(false).describe("on:'mem' — collapse events by sampled PC into byPC[]. CAVEAT: that PC is frame-boundary-sampled, NOT the writer under interrupts — use breakpoint({on:'write', precision:'exact'}) for the EXACT writer."),
      cheatLabels: z.string().optional().describe("on:'mem' — absolute path to the loaded ROM; auto-annotate watched RAM-region addresses (system_ram/*_ram/*_wram/gb_hram) from the bundled cheat DB (a PROBABLE match — strong hints, not gospel)."),
      stopOnFirst: z.boolean().default(false).describe("on:'mem' — stop on the first filter-passing change instead of running the full duration. (For a true stop-on-first breakpoint, prefer the `breakpoint` tool.)"),
      // on:'range'
      kind: z.enum(["read", "write", "both"]).default("both").describe("on:'range' — watch reads, writes, or both."),
      // on:'range' / on:'pc' window
      start: z.number().int().min(0).optional().describe("on:'range'/'pc' — low CPU address of the window."),
      end: z.number().int().min(0).optional().describe("on:'range'/'pc' — high CPU address (inclusive)."),
      // shared
      frames: z.number().int().min(1).max(1_000_000).default(600).describe("Frames to run while logging (default 600). on:'range'/'pc' windows are usually short (~120) — pass a smaller value to keep the ring buffer from overflowing."),
      limit: z.number().int().min(1).max(4000).default(200).describe("on:'range'/'pc' — max events/PCs returned (default 200; full count is in `total`)."),
      outputPath: z.string().optional().describe("on:'mem' — stream every filter-passing event to this path as NDJSON + return a compact summary. Use for long watches so the full log never enters your context."),
      // on:'dma' (Genesis VDP DMA trace)
      precision: z.enum(["exact", "sampled"]).default("exact").describe("on:'dma' — exact=per-DMA core log with VRAM dest + ROM source (catches same-frame DMAs); sampled=frame-sampled source-register read (cheaper, may miss two DMAs in one frame, dest-agnostic)."),
      vramDest: z.number().int().min(0).optional().describe("on:'dma' precision:'exact' — keep only DMAs whose VRAM destination is within ±`destWindow` of this address."),
      destWindow: z.number().int().min(0).default(0x40).describe("on:'dma' precision:'exact' — match window around vramDest (default 64 bytes ≈ 1 tile)."),
      dedupe: z.boolean().default(true).describe("on:'dma' precision:'exact' — collapse identical DMAs (same dest+source+length+code) to one entry with an `occurrences` count (default on)."),
      sourceFilter: z.enum(["all", "rom-only", "ram-only"]).default("all").describe("on:'dma' precision:'exact' — 'rom-only' drops the RAM→VRAM per-frame refresh noise; 'ram-only' keeps only it."),
      romPreviewBytes: z.number().int().min(0).max(64).default(0).describe("on:'dma' — bytes of the ROM source to preview per DMA (exact default 0; sampled default 16)."),
      minLengthBytes: z.number().int().min(0).max(65536).default(0).describe("on:'dma' precision:'sampled' — ignore DMAs shorter than this many bytes (filters tiny scroll/sprite updates so graphic uploads stand out)."),
      pressDuring: z.array(z.object({
        frame: z.number().int().min(0),
        button: z.string(),
        port: z.number().int().min(0).max(3).default(0),
        holdFrames: z.number().int().min(1).default(2),
      })).optional().describe("Schedule input while watching (drive the game to the state that touches the watched bytes/range, or uploads the graphic for on:'dma'). If OMITTED, this run inherits whatever input({op:'set'}) last held — same as frame({op:'step'}). If GIVEN, the schedule OWNS the pad for the whole run (a prior input({op:'set'}) is ignored)."),
      fromState: z.string().optional().describe("on:'range'/'pc' — restore an in-memory savestate SLOT (from state({op:'save', name})) BEFORE tracing, so the log runs from a known moment (jump to the boss fight, then see what writes HP). Deterministic + repeatable."),
      fromStatePath: z.string().optional().describe("on:'range'/'pc' — like fromState but restore from a savestate FILE on disk (state({op:'save', path})). Relative path resolves against the loaded ROM's dir."),
    },
    safeTool(async (args) => {
      switch (args.on) {
        case "mem":   return await watchMem(args);
        case "range": {
          if (args.start == null || args.end == null) throw new Error("watch({on:'range'}): `start` and `end` are required.");
          return await wRange({ ...args, frames: args.frames ?? 120, limit: args.limit ?? 200 });
        }
        case "pc": {
          if (args.start == null || args.end == null) throw new Error("watch({on:'pc'}): `start` and `end` are required.");
          return await wLogPC({ ...args, frames: args.frames ?? 120, limit: args.limit ?? 512 });
        }
        case "dma": {
          const a = { ...args, frames: args.frames ?? 120, limit: args.limit ?? 200 };
          if (a.precision === "sampled") {
            return await traceVramSourceCore({ ...a, romPreviewBytes: a.romPreviewBytes || 16, sessionKey });
          }
          return await dmaExact(a);
        }
        default: throw new Error(`watch: unknown on '${args.on}'`);
      }
    }),
  );

  // ── watch({on:'dma'}) helpers (Genesis only) ────────────────────────────────
  // precision:exact = dmaExact (watchDma, per-DMA core log), precision:sampled =
  // traceVramSourceCore (frame-sampled, dest-agnostic). Routed by the `watch`
  // tool's switch (case 'dma'); folded in from the old standalone dmaTrace tool.
  async function dmaExact({ frames = 120, vramDest, destWindow = 0x40, dedupe = true, sourceFilter = "all", pressDuring, romPreviewBytes = 0, limit = 200 }) {
      const host = getHost(sessionKey);
      if (!host.dmaWatchSupported || !host.dmaWatchSupported()) {
        return jsonContent({ notSupported: true, dmas: [],
          note: "watch({on:'dma'}) is Genesis-only (VDP DMA). On other platforms use breakpoint({on:'write'}) (CPU writes) or the platform's source tracer." });
      }
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      if (presses.length) pressDriver.applyForFrame(0);
      const r = host.watchDma(frames);
      pressDriver.finish();
      let rom = null;
      if (romPreviewBytes > 0) { try { rom = host.getCartRom(); } catch { /* no preview */ } }
      // VDP code low bits: 1=VRAM, 3=CRAM, 5=VSRAM (write codes). Decode the target.
      const targetOf = (code) => { const c = code & 0x0F; return c === 1 ? "VRAM" : c === 3 ? "CRAM" : c === 5 ? "VSRAM" : "VRAM?"; };
      // Genesis 68k bus: ROM is the low address space (< $400000 typically), work
      // RAM is $E00000-$FFFFFF. A DMA `source` is a 68k byte address — split on the
      // RAM window so 'rom-only' drops the RAM→VRAM sprite/scroll refresh.
      const isRam = (src) => (src >>> 0) >= 0xE00000;
      let dmas = r.dmas;
      if (vramDest !== undefined) dmas = dmas.filter((d) => Math.abs((d.vramDest >>> 0) - vramDest) <= destWindow);
      if (sourceFilter === "rom-only") dmas = dmas.filter((d) => !isRam(d.source));
      else if (sourceFilter === "ram-only") dmas = dmas.filter((d) => isRam(d.source));
      let collapsedCount = 0;
      if (dedupe) {
        const seen = new Map();
        for (const d of dmas) {
          const k = `${d.vramDest >>> 0}:${d.source >>> 0}:${d.lengthWords}:${d.code}`;
          if (seen.has(k)) { seen.get(k).occurrences++; collapsedCount++; }
          else seen.set(k, { ...d, occurrences: 1 });
        }
        dmas = [...seen.values()];
      }
      const totalDistinct = dmas.length;
      const out = dmas.slice(0, limit).map((d) => {
        const o = {
          vramDest: "$" + (d.vramDest >>> 0).toString(16).toUpperCase(),
          source: "0x" + (d.source >>> 0).toString(16).toUpperCase(),
          lengthWords: d.lengthWords, lengthBytes: d.lengthWords * 2,
          target: targetOf(d.code),
          from: isRam(d.source) ? "RAM" : "ROM",
          ...(dedupe ? { occurrences: d.occurrences } : {}),
        };
        if (rom && rom.bytes && !isRam(d.source) && (d.source >>> 0) < rom.bytes.length) {
          const a = d.source >>> 0, e = Math.min(a + romPreviewBytes, rom.bytes.length);
          o.romPreview = Array.from(rom.bytes.subarray(a, e), (b) => b.toString(16).padStart(2, "0")).join("");
        }
        return o;
      });
      return attachObserverFrame(jsonContent({
        totalEvents: r.total, distinctDmas: totalDistinct, returned: out.length,
        ...(dedupe && collapsedCount ? { collapsed: collapsedCount } : {}),
        ...(r.truncated ? { coreBufferTruncated: true } : {}),
        ...(vramDest !== undefined ? { filteredToVramDest: "$" + vramDest.toString(16).toUpperCase(), destWindow } : {}),
        ...(sourceFilter !== "all" ? { sourceFilter } : {}),
        dmas: out,
        note: "`source` is the 68k byte address the tiles were copied from — for a ROM source (`from:ROM`) edit the tiles THERE. " +
          "dedupe collapses the per-frame refresh; sourceFilter:'rom-only' drops the RAM→VRAM sprite/scroll noise (use it to find a cart-ROM asset DMA). " +
          (totalDistinct > limit ? `Showing ${out.length}/${totalDistinct} distinct — raise limit or narrow vramDest.` : ""),
      }), host);
  }
  // dmaExact + traceVramSourceCore are reached via watch({on:'dma'}) above —
  // dmaTrace was folded into `watch` (it's a log-all VDP-DMA trace, same family
  // as on:'mem'/'range'/'pc'), so there's no separate top-level tool.
}
