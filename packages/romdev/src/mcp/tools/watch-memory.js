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

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";
import { getCPUState } from "../../host/cpu-state.js";
import { MemoryRegionToRetro } from "../../host/types.js";
import { resolveButtonAlias } from "./input.js";
import { getCPUStateCore } from "./platform-tools.js";

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
function attachObserverFrame(json, host) {
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
export function makePressDriver(host, presses) {
  let applied = 0;          // how many scheduled presses actually got a frame
  let lastSet = null;       // last setInput payload we pushed (to avoid churn)
  const platform = host.status?.platform;
  return {
    applied: () => applied,
    applyForFrame(i) {
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
    label: z.string().optional().describe("Optional name echoed on every event from this range — lets you tell disjoint ranges apart in one stream."),
    // Per-range overrides of the call-wide filters. The whole point: in a
    // multi-range watch, keep EVERY transition of a slow state byte while
    // sampling/suppressing a fast free-running counter in the SAME pass.
    onChange: z.enum(["any", "increase", "decrease", "reset"]).optional().describe("Per-range edge filter; overrides the call-wide `onChange` for THIS range only."),
    sampleEvery: z.number().int().min(1).optional().describe("Per-range downsample: keep every Nth change from THIS range (e.g. 8 to thin a noisy per-frame counter while other ranges stay full)."),
    valueFilter: z.object({ min: z.number().int().min(0).max(255).optional(), max: z.number().int().min(0).max(255).optional() }).optional().describe("Per-range value window; overrides the call-wide `valueFilter` for THIS range."),
  });

  server.tool(
    "watchMemory",
    "Use this to answer 'what code is touching this RAM byte?' (without an instruction tracer) OR to extract a " +
    "frame-accurate event timeline (e.g. music-driver note onsets). Runs N frames and reports every frame that " +
    "changed a watched byte as {frame, offset, before, after, pc} — the pc tells you which disasm line to patch. " +
    "POWER FEATURES: (1) `ranges:[{region,offset,length,label}]` watches MULTIPLE disjoint regions in ONE pass " +
    "(all sampled on identical frames — no separate passes, no offline correlation). (2) `onChange` filters by " +
    "edge: 'reset' (value jumped UP — the canonical note-onset signal for countdown counters), 'increase', " +
    "'decrease', 'any'. (3) `valueFilter:{min,max}` keeps only changes whose new value is in range. (4) " +
    "`outputPath` streams ALL events to disk as NDJSON and returns a compact summary — use it for dense watches " +
    "(thousands of frames) so the full log never floods your context. A countdown-and-reset counter watched with " +
    "onChange:'reset' goes from ~7000 noise events to a sparse onset list directly. " +
    "CAVEAT: frame-level, not instruction-level — if a frame writes a byte several times you see only the last " +
    "value (enough to find the code path, not cycle-exact tracing). Cross-platform.",
    {
      // Single-range args (back-compat). Ignored when `ranges` is given.
      region: z.enum(MEMORY_REGIONS).optional().describe("Memory region to watch — the SAME canonical set readMemory accepts (incl. hardware registers like nes_apu_regs, genesis_ym2612, c64_sid_regs). Omit when using `ranges`."),
      offset: z.number().int().min(0).default(0).describe("First byte of the watched range (single-range mode)."),
      length: z.number().int().min(1).max(4096).default(1).describe("How many bytes to watch (single-range mode, default 1)."),
      ranges: z.array(rangeShape).min(1).max(16).optional().describe("Watch several disjoint ranges in one pass. When given, `region`/`offset`/`length` are ignored. Each event carries its range's `label`. Ideal for music drivers, or tracing a state machine where a slow state byte and a noisy per-frame counter live in different bytes. Each range entry may OVERRIDE the call-wide filters with its own `onChange`/`sampleEvery`/`valueFilter` — so you can keep every transition of a slow state byte while sampling or suppressing a fast free-running counter in the SAME pass (the fix for one noisy byte burying the signal)."),
      frames: z.number().int().min(1).max(1_000_000).default(600).describe("How many frames to run (default 600 = ~10s NTSC)."),
      stopOnFirst: z.boolean().default(false).describe("If true, stop on the first detected (and filter-passing) change instead of running the full duration."),
      onChange: z.enum(["any", "increase", "decrease", "reset"]).default("any").describe("Edge filter. 'any' = every change (default). 'increase'/'decrease' = directional. 'reset' = value jumped UP vs prev (counter reload — the note-onset signal for countdown-based music drivers)."),
      valueFilter: z.object({
        min: z.number().int().min(0).max(255).optional(),
        max: z.number().int().min(0).max(255).optional(),
      }).optional().describe("Keep only changes whose NEW byte value is within [min,max]. Combine with onChange to catch e.g. only large reloads."),
      maxEvents: z.number().int().min(1).max(100_000).default(256).describe("Cap on RETURNED events; surplus dropped with a `truncated` flag. When `outputPath` is set, ALL matching events are written to the file regardless of this cap (the cap only bounds the inline preview). NOTE: with `format:\"series\"` this caps SAMPLES PER OFFSET and downsamples (keeps an evenly-spaced subset spanning the whole window) instead of truncating, so the series always reaches the last frame."),
      format: z.enum(["events", "series"]).default("events").describe("Output shape. 'events' (default) = one verbose object per change. 'series' = COMPACT columnar: per watched offset return parallel `frames:[...]` + `values:[...]` arrays (the value-vs-frame curve) with the repeated region/label/pc boilerplate hoisted into a one-time header. Use 'series' for a dense single-byte timeline — physics arcs, animation counters, a value ramp that changes every frame — where you want the trajectory cheaply, not N fat rows. ~10× smaller for a monotonic ramp. Drops `pc` (use groupByPC/'events' if you need per-change PCs)."),
      cheatLabels: z.string().optional().describe("Absolute path to the loaded ROM. When given, any watched RAM address that the bundled cheat DB has a label for is auto-annotated with that label (e.g. watching $00CD on Rygar tags events `Infinite Magic Attack`) — free semantic names from the crowd-sourced cheat map. Only annotates RAM-class regions where offset == CPU address (system_ram); a PROBABLE match (see gameCheats), so treat labels as strong hints, not gospel."),
      sampleEvery: z.number().int().min(1).default(1).describe("Keep only every Nth filter-passing change (1 = all). A cheap 'I want the trend, not every delta' knob — e.g. sampleEvery:4 on a per-frame ramp returns a quarter of the points, still spanning the full window. Applies in both 'events' and 'series' formats; combine with format:'series' for the most compact dense-timeline output."),
      groupByPC: z.boolean().default(false).describe("Collapse events by the sampled PC: return `byPC[]` = {pc, hits, firstFrame, lastFrame, offsets} (one row per PC seen at a write's frame boundary) instead of thousands of raw rows, and cap the inline `events[]` to a tiny sample (≤8). CAVEAT: `pc` is sampled at the frame boundary, NOT the writing instruction — for NMI/IRQ-driven writes (common on NES/GB) it is usually the interrupted main-thread PC (often an idle loop), so byPC rows can all collapse onto one idle-loop PC. Good for 'how often / which PCs', unreliable as 'which code wrote it' under interrupts — use `findWriter` for the EXACT writer. Composes with onChange/valueFilter; full per-event log still streams to `outputPath` if set."),
      outputPath: z.string().optional().describe("If given, stream every filter-passing event to this path as NDJSON (one JSON object per line) and return a compact summary {path, eventCount, ...} plus a small inline preview (first maxEvents). Use for long watches so the full event log never enters your context."),
      pressDuring: z.array(z.object({
        frame: z.number().int().min(0).describe("Frame on which to press."),
        button: z.string().describe("Button name (see input-layout.js)."),
        port: z.number().int().min(0).max(3).default(0),
        holdFrames: z.number().int().min(1).default(2),
      })).optional().describe("Schedule button presses while watching, so the agent can simulate user input mid-watch."),
    },
    safeTool(async ({ region, offset = 0, length = 1, ranges, frames = 600, stopOnFirst = false, onChange = "any", valueFilter, maxEvents = 256, format = "events", sampleEvery = 1, groupByPC = false, outputPath, pressDuring, cheatLabels }) => {
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
    }),
  );

  server.tool(
    "findWriter",
    "Find the EXACT instruction that writes a RAM byte — the precise answer to 'which code wrote $XX?', fixing the " +
    "frame-sampled-PC limitation of watchMemory/runUntilWrite. Arms a core-level WRITE WATCHPOINT on `address` (a " +
    "CPU address, e.g. 0x00CD), steps up to `maxFrames`, and returns the writing instruction's PC captured INSIDE " +
    "the CPU write path — correct even for NMI/IRQ-driven writes (where the frame-sampled pc is just the idle loop). " +
    "Returns { found, address, pc, value, hits, framesStepped }. Then `disassembleRom({ startAddress: pc })` lands " +
    "you on the real store instruction. Supported on ALL bundled CPU cores: NES, GB/GBC, Genesis, SMS/GG, SNES, " +
    "Atari 2600, Atari 7800, and C64 (6502/sm83/m68k/z80/65816/6510). (A core without the watchpoint would return " +
    "notSupported.) On banked mappers a $8000-$BFFF pc may be in a switchable bank — disassemble with the right `bank`.",
    {
      address: z.number().int().min(0).describe("CPU address to watch for writes (e.g. 0x00CD). For NES, low RAM CPU address == system_ram offset."),
      maxFrames: z.number().int().min(1).max(1_000_000).default(600).describe("Max frames to step while waiting for a write."),
      pressDuring: z.array(z.object({
        frame: z.number().int().min(0),
        button: z.string(),
        port: z.number().int().min(0).max(3).default(0),
        holdFrames: z.number().int().min(1).default(2),
      })).optional().describe("Schedule input while waiting (e.g. press A to trigger the write you're hunting)."),
    },
    safeTool(async ({ address, maxFrames, pressDuring }) => {
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
      let result = null;
      for (let i = 0; i < maxFrames; i++) {
        pressDriver.applyForFrame(i);
        host.stepFrames(1);
        const w = host.getWatchpoint();
        if (w.hits > 0) { result = { ...w, framesStepped: i + 1 }; break; }
      }
      pressDriver.finish();
      host.setWatchpoint(address, false); // disarm
      if (!result) {
        return jsonContent({
          found: false, address: "$" + address.toString(16).toUpperCase(), framesStepped: maxFrames,
          ...(presses.length ? { pressesScheduled: presses.length, pressesApplied: pressDriver.applied() } : {}),
          note: "No per-byte CPU write to that address within maxFrames. Two common reasons: " +
            "(1) the event didn't fire — increase maxFrames or drive the game with pressDuring to trigger it. " +
            "(2) this region is rebuilt as a BLOCK rather than written field-by-field — sprite/OAM shadow tables, " +
            "display lists, and VRAM are typically bulk-copied (memcpy/loop) or DMA'd from a SOURCE struct elsewhere, " +
            "so no single instruction writes this exact byte. In that case the address you want is the SOURCE: watch " +
            "the struct the copy reads from (find it with searchValue on the live value), or for graphics trace the " +
            "DMA/copy source (Genesis VRAM DMA source is in VDP regs). 'Address is wrong' is usually case (2), not a bad address.",
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
    }),
  );

  server.tool(
    "runUntilWrite",
    "Step the emulator forward until a target byte changes, then stop. Convenience wrapper around watchMemory " +
    "with stopOnFirst=true. Returns the writing frame + before/after values + the CPU PC sampled at that frame boundary. " +
    "CAVEAT: the returned `pc` is a frame-boundary sample, NOT the writing instruction — for NMI/IRQ-driven writes (common on " +
    "NES/GB) it is usually the interrupted main-thread PC (often an idle loop), not the writer. Use it as a lead and confirm " +
    "against the value trace; `disassembleRom` near that PC is a starting point, not a guaranteed hit. " +
    "**If you need the EXACT writing instruction, use `findWriter` instead** — it uses a core-level watchpoint that captures " +
    "the real writer's PC even under interrupts (all platforms). " +
    "(No screenshot is returned — call `screenshot` separately if you need the resulting frame.)",
    {
      region: z.enum(MEMORY_REGIONS),
      offset: z.number().int().min(0),
      length: z.number().int().min(1).max(4096).default(1),
      maxFrames: z.number().int().min(1).max(1_000_000).default(600),
      pressDuring: z.array(z.object({
        frame: z.number().int().min(0),
        button: z.string(),
        port: z.number().int().min(0).max(3).default(0),
        holdFrames: z.number().int().min(1).default(2),
      })).optional(),
    },
    safeTool(async ({ region, offset, length, maxFrames, pressDuring }) => {
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
    }),
  );

  server.tool(
    "runUntilPC",
    "Run until the CPU's program counter reaches `address`, then STOP with the CPU frozen EXACTLY at that instruction " +
    "— a real execution breakpoint. This is the RE primitive for 'read the register at this instruction': break at the " +
    "instruction, then call `getCPUState` to read the full register file at that exact moment (e.g. break at a decoder's " +
    "`move.b (a0),d0` and read A0 to get the source address — one read instead of hours of inference). Arms a core-level " +
    "PC breakpoint, runs up to `maxFrames` (driving any `pressDuring` input), and stops mid-frame on the first hit; the " +
    "breakpoint auto-disarms after. Returns { hit, pc, frame, framesRun, hits }. After a hit the emulator stays frozen at " +
    "the PC — call getCPUState / readMemory to inspect, then stepFrames/resume to continue. " +
    "Supported on all 14 platforms (every CPU family); returns notSupported only if the core package is out of date.",
    {
      address: z.number().int().min(0).describe("CPU address of the instruction to break on (e.g. 0x2A3FD4). Must be an instruction boundary."),
      maxFrames: z.number().int().min(1).max(1_000_000).default(600).describe("Max frames to run while waiting for the PC to be reached."),
      pressDuring: z.array(z.object({
        frame: z.number().int().min(0),
        button: z.string(),
        port: z.number().int().min(0).max(3).default(0),
        holdFrames: z.number().int().min(1).default(2),
      })).optional().describe("Schedule input while running (e.g. navigate a menu so the code path that hits this PC actually executes)."),
    },
    safeTool(async ({ address, maxFrames, pressDuring }) => {
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
        note: "CPU is FROZEN at this instruction. Call getCPUState({platform:'genesis'}) to read all registers at this exact " +
          "moment (the value you want — e.g. an address register holding a source pointer — is live now), then readMemory/readCartRom " +
          "at that pointer. stepInstruction to single-step, or stepFrames/resume to continue.",
      }), host);
    }),
  );

  server.tool(
    "runUntilRead",
    "Run until the CPU READS a watched address, then stop — the read-side mirror of findWriter. Returns the EXACT instruction " +
    "PC that read the byte (captured in the CPU read path). Use it to find who consumes a value: e.g. watch a ROM name-table " +
    "entry and learn which routine reads it, or watch a flag and find its reader. Arms a core-level READ watchpoint, runs up to " +
    "`maxFrames` (driving `pressDuring`), and returns { hit, pc, value, frame, hits }. Unlike runUntilPC it does NOT freeze " +
    "mid-frame — it records the reading PC and finishes the current frame. " +
    "Supported on all 14 platforms; returns notSupported only if the core package is out of date.",
    {
      address: z.number().int().min(0).describe("CPU address to watch for reads (e.g. a ROM/RAM byte you want to find the consumer of)."),
      maxFrames: z.number().int().min(1).max(1_000_000).default(600).describe("Max frames to run while waiting for a read."),
      pressDuring: z.array(z.object({
        frame: z.number().int().min(0),
        button: z.string(),
        port: z.number().int().min(0).max(3).default(0),
        holdFrames: z.number().int().min(1).default(2),
      })).optional().describe("Schedule input while running (drive the game to the state that reads this address)."),
    },
    safeTool(async ({ address, maxFrames, pressDuring }) => {
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
        note: "pc is the EXACT instruction that read this address. disassembleRom({ startAddress: pc }) to see it.",
      }), host);
    }),
  );

  server.tool(
    "stepInstruction",
    "Execute exactly ONE CPU instruction and stop (CPU-level single-step) — finer than stepFrames. Freezes the CPU right " +
    "after the instruction; returns { pc } = the address the CPU is now poised at. Pair with getCPUState to watch registers " +
    "change one instruction at a time while tracing a routine. Supported where the core exposes the romdev PC breakpoint " +
    "Supported on all 14 platforms. (One step advances the frame's other subsystems minimally; it's a " +
    "CPU single-step, the finest granularity the core exposes.)",
    {},
    safeTool(async () => {
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
        note: "CPU is frozen one instruction later. getCPUState to read registers; stepInstruction again to keep stepping.",
      }), host);
    }),
  );

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
          note: "This core build has no register-write (shipped on all 14 platforms as of 0.6.0 — update the core package). callSubroutine needs it." });
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
            : "Did not return within maxFrames (and the watchdog didn't trip) — try a larger maxFrames/maxInstructions or check the setup. finalPC/finalRegs show where it ended.";
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
      sentinelPC: z.number().int().min(0).default(0).describe("op:call — return address pushed on the stack; the run stops when PC reaches it. Default 0 (vector area). Override if it collides with real code."),
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

  server.tool(
    "watchRange",
    "DISCOVERY: log EVERY instruction that reads or writes ANYWHERE in [start,end] over `frames` — not stop-on-first. " +
    "The fix for 'I don't know which PC touches this'. Returns a list of {pc,address,value}. Use it to find an unknown " +
    "renderer/reader: watch the whole name pool / a struct / a flag region and SEE every PC that hits it, instead of " +
    "probing single addresses. Pair with disassembleRom on the returned PCs. (Frame-window + ring-buffered: a huge range " +
    "over many frames can overflow the buffer — `truncated:true` says so; narrow the range or frames.) notSupported where " +
    "the core lacks the watch hook.",
    {
      start: z.number().int().min(0).describe("Low CPU address of the watched range."),
      end: z.number().int().min(0).describe("High CPU address (inclusive)."),
      kind: z.enum(["read", "write", "both"]).default("both").describe("Watch reads, writes, or both."),
      frames: z.number().int().min(1).max(6000).default(120).describe("Frames to run while logging."),
      pressDuring: z.array(z.object({
        frame: z.number().int().min(0), button: z.string(),
        port: z.number().int().min(0).max(3).default(0), holdFrames: z.number().int().min(1).default(2),
      })).optional().describe("Drive input while watching (reach the screen/state that touches the range)."),
      limit: z.number().int().min(1).max(2000).default(200).describe("Max events to return (the full count is in `total`)."),
    },
    safeTool(async ({ start, end, kind, frames, pressDuring, limit }) => {
      const host = getHost(sessionKey);
      if (!host.rangeWatchSupported || !host.rangeWatchSupported()) {
        return jsonContent({ notSupported: true, events: [],
          note: "This core build has no range watch (shipped on all 14 platforms as of 0.6.0 — update the core package). Use findWriter/runUntilRead for a single address." });
      }
      if (end < start) throw new Error("watchRange: end must be >= start.");
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
        distinctPCs, events,
        note: "distinctPCs is the actionable summary — each is a routine that touches this range; disassembleRom one to identify the renderer/reader. " +
          (r.truncated ? "TRUNCATED: more events than the buffer held — narrow `start..end` or `frames` for the full set." : ""),
      }), host);
    }),
  );

  server.tool(
    "logPCRange",
    "DISCOVERY (coverage trace): record every DISTINCT PC executed within [start,end] over `frames` — 'what code runs " +
    "here?'. The RE way to FIND an unknown routine: log execution in the bank where you suspect the renderer lives " +
    "during the moment it draws, then disassembleRom the PCs. Returns { pcs:[...], distinct, total }. notSupported where " +
    "the core lacks the execute hook.",
    {
      start: z.number().int().min(0).describe("Low CPU address of the coverage window."),
      end: z.number().int().min(0).describe("High CPU address (inclusive)."),
      frames: z.number().int().min(1).max(6000).default(120),
      pressDuring: z.array(z.object({
        frame: z.number().int().min(0), button: z.string(),
        port: z.number().int().min(0).max(3).default(0), holdFrames: z.number().int().min(1).default(2),
      })).optional(),
      limit: z.number().int().min(1).max(4000).default(512),
    },
    safeTool(async ({ start, end, frames, pressDuring, limit }) => {
      const host = getHost(sessionKey);
      if (!host.rangeWatchSupported || !host.rangeWatchSupported()) {
        return jsonContent({ notSupported: true, pcs: [],
          note: "This core build has no coverage trace (shipped on all 14 platforms as of 0.6.0 — update the core package)." });
      }
      if (end < start) throw new Error("logPCRange: end must be >= start.");
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const pressDriver = makePressDriver(host, presses);
      if (presses.length) pressDriver.applyForFrame(0);
      const r = host.logPCRange(start, end, frames);
      pressDriver.finish();
      const pcs = r.pcs.slice(0, limit).map((p) => "$" + p.toString(16).toUpperCase());
      return attachObserverFrame(jsonContent({
        window: "$" + start.toString(16).toUpperCase() + "..$" + end.toString(16).toUpperCase(),
        distinct: r.distinct, total: r.total, returned: pcs.length, truncated: r.truncated,
        pcs,
        note: "Each PC is code that EXECUTED in this window. disassembleRom them to find the routine you're hunting. " +
          (r.truncated ? "TRUNCATED — narrow the window for the full distinct set." : ""),
      }), host);
    }),
  );

  // ── Targeted VDP-DMA watch (item 3, Genesis only) ───────────────────────────

  server.tool(
    "watchDma",
    "GENESIS ONLY. Log every mem→VDP DMA over `frames` with its VRAM DESTINATION, ROM SOURCE, length, and code — the " +
    "targeted answer to 'which DMA wrote the tile at VRAM 0xNNNN, and where in ROM did it come from?'. This is the " +
    "precise version of traceVramSource (which is frame-sampled and dest-agnostic): filter the returned list by " +
    "`vramDest` to find the exact source of a name/portrait/logo bitmap that's DMA'd (so findWriter can't catch it). " +
    "Returns { dmas:[{vramDest, source, lengthWords, lengthBytes, code, target}] }. notSupported on non-Genesis cores " +
    "(VDP DMA is a Genesis concept — use findWriter for CPU writes elsewhere).",
    {
      frames: z.number().int().min(1).max(6000).default(120),
      vramDest: z.number().int().min(0).optional().describe("If set, only return DMAs whose VRAM destination falls within ±`destWindow` of this address."),
      destWindow: z.number().int().min(0).default(0x40).describe("Match window around vramDest (default 64 bytes ≈ 1 tile)."),
      dedupe: z.boolean().default(true).describe("Collapse identical DMAs (same dest+source+length) to ONE entry with an `occurrences` count. ON by default — a full match-load fires the SAME per-frame refresh thousands of times; dedupe turns 7000 events into a handful of distinct uploads."),
      sourceFilter: z.enum(["all", "rom-only", "ram-only"]).default("all").describe("'rom-only' drops the RAM→VRAM per-frame sprite/scroll refresh (source >= a ROM/RAM split) — the noise. 'ram-only' keeps only those. Use 'rom-only' to find a compressed asset DMA'd straight from cart ROM."),
      pressDuring: z.array(z.object({
        frame: z.number().int().min(0), button: z.string(),
        port: z.number().int().min(0).max(3).default(0), holdFrames: z.number().int().min(1).default(2),
      })).optional().describe("Drive to the screen that uploads the graphic."),
      romPreviewBytes: z.number().int().min(0).max(64).default(0).describe("Bytes of the ROM source to preview per DMA (0 = none)."),
      limit: z.number().int().min(1).max(2000).default(200).describe("Max DMA entries to return (after dedupe/filter)."),
    },
    safeTool(async ({ frames, vramDest, destWindow, dedupe, sourceFilter, pressDuring, romPreviewBytes, limit }) => {
      const host = getHost(sessionKey);
      if (!host.dmaWatchSupported || !host.dmaWatchSupported()) {
        return jsonContent({ notSupported: true, dmas: [],
          note: "watchDma is Genesis-only (VDP DMA). On other platforms use findWriter (CPU writes) or the platform's source tracer." });
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
    }),
  );
}
