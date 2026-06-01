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

export function registerWatchMemoryTools(server, z, sessionKey) {
  const rangeShape = z.object({
    region: z.enum(MEMORY_REGIONS),
    offset: z.number().int().min(0),
    length: z.number().int().min(1).max(4096).default(1),
    label: z.string().optional().describe("Optional name echoed on every event from this range — lets you tell disjoint ranges apart in one stream."),
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
      ranges: z.array(rangeShape).min(1).max(16).optional().describe("Watch several disjoint ranges in one pass. When given, `region`/`offset`/`length` are ignored. Each event carries its range's `label`. Ideal for music drivers where pitch and rhythm live in non-adjacent bytes."),
      frames: z.number().int().min(1).max(1_000_000).default(600).describe("How many frames to run (default 600 = ~10s NTSC)."),
      stopOnFirst: z.boolean().default(false).describe("If true, stop on the first detected (and filter-passing) change instead of running the full duration."),
      onChange: z.enum(["any", "increase", "decrease", "reset"]).default("any").describe("Edge filter. 'any' = every change (default). 'increase'/'decrease' = directional. 'reset' = value jumped UP vs prev (counter reload — the note-onset signal for countdown-based music drivers)."),
      valueFilter: z.object({
        min: z.number().int().min(0).max(255).optional(),
        max: z.number().int().min(0).max(255).optional(),
      }).optional().describe("Keep only changes whose NEW byte value is within [min,max]. Combine with onChange to catch e.g. only large reloads."),
      maxEvents: z.number().int().min(1).max(100_000).default(256).describe("Cap on RETURNED events; surplus dropped with a `truncated` flag. When `outputPath` is set, ALL matching events are written to the file regardless of this cap (the cap only bounds the inline preview)."),
      outputPath: z.string().optional().describe("If given, stream every filter-passing event to this path as NDJSON (one JSON object per line) and return a compact summary {path, eventCount, ...} plus a small inline preview (first maxEvents). Use for long watches so the full event log never enters your context."),
      pressDuring: z.array(z.object({
        frame: z.number().int().min(0).describe("Frame on which to press."),
        button: z.string().describe("Button name (see input-layout.js)."),
        port: z.number().int().min(0).max(3).default(0),
        holdFrames: z.number().int().min(1).default(2),
      })).optional().describe("Schedule button presses while watching, so the agent can simulate user input mid-watch."),
    },
    safeTool(async ({ region, offset = 0, length = 1, ranges, frames = 600, stopOnFirst = false, onChange = "any", valueFilter, maxEvents = 256, outputPath, pressDuring }) => {
      const host = getHost(sessionKey);

      // Normalize to a list of ranges. Single-range mode requires `region`.
      const watchRanges = (ranges && ranges.length)
        ? ranges.map((r) => ({ length: 1, ...r }))
        : (() => {
            if (!region) throw new Error("watchMemory: pass `region` (single-range) or `ranges` (multi-range).");
            return [{ region, offset, length }];
          })();

      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);
      const startFrame = host.status.frameCount;

      // Per-range previous snapshots.
      let prevs = watchRanges.map((r) => snap(host, r.region, r.offset, r.length));

      const preview = [];          // bounded inline events
      let totalMatched = 0;        // ALL filter-passing events (file-backed)
      let truncated = false;       // inline preview hit maxEvents
      let stoppedEarly = false;
      const fileLines = [];        // NDJSON lines when outputPath set

      const pushEvent = (ev) => {
        totalMatched++;
        if (outputPath) fileLines.push(JSON.stringify(ev));
        if (preview.length < maxEvents) preview.push(ev);
        else { truncated = true; }
      };

      outer:
      for (let i = 0; i < frames; i++) {
        while (presses.length && presses[0].frame === i) {
          const p = presses.shift();
          try { host.pressButton(p.port, p.button, p.holdFrames); } catch { /* unknown button name */ }
        }
        host.stepFrames(1);
        const frameAbs = startFrame + i + 1;
        let pcCached;
        const pcOnce = () => (pcCached !== undefined ? pcCached : (pcCached = tryGetPC(host)));

        for (let ri = 0; ri < watchRanges.length; ri++) {
          const r = watchRanges[ri];
          const cur = snap(host, r.region, r.offset, r.length);
          const changes = diffSnapshots(prevs[ri], cur, r.offset, r.label);
          prevs[ri] = cur;
          for (const c of changes) {
            if (!edgeMatches(onChange, c.before, c.after)) continue;
            if (!valueMatches(valueFilter, c.after)) continue;
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
            // continuing to count — but with a file we want the full total.
            if (!outputPath && truncated) break outer;
          }
        }
      }

      const base = {
        framesStepped: stoppedEarly ? undefined : frames,
        watched: watchRanges,
        onChange,
        valueFilter: valueFilter ?? null,
        eventCount: totalMatched,
        stoppedEarly,
        truncated,
        note: totalMatched === 0
          ? "No matching changes in the watched window. Try (a) onChange:'any' to confirm the byte moves at all, (b) longer `frames`, (c) `pressDuring` to drive the game past the event, (d) a different region/offset."
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

      return jsonContent({ ...base, events: preview });
    }),
  );

  server.tool(
    "runUntilWrite",
    "Step the emulator forward until a target byte changes, then stop. Convenience wrapper around watchMemory " +
    "with stopOnFirst=true. Returns the writing frame + PC + before/after values + a screenshot of the resulting state. " +
    "Pair this with `disassembleRom` + the returned PC to immediately locate the code line that did the write.",
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
      let prev = snap(host, region, offset, length);
      const startFrame = host.status.frameCount;

      for (let i = 0; i < maxFrames; i++) {
        while (presses.length && presses[0].frame === i) {
          const p = presses.shift();
          try { host.pressButton(p.port, p.button, p.holdFrames); } catch { /* ignore */ }
        }
        host.stepFrames(1);
        const cur = snap(host, region, offset, length);
        const changes = diffSnapshots(prev, cur, offset);
        if (changes.length > 0) {
          const pc = tryGetPC(host);
          const frameAbs = startFrame + i + 1;
          return jsonContent({
            written: true,
            frame: frameAbs,
            frameRelative: i + 1,
            changes,
            pc: hexPC(pc),
            pcRaw: pc,
            hint: pc != null
              ? `Use disassembleRom near ${hexPC(pc)} on this ROM to find the writing instruction. The mapper-aware @0xNNNN file-offset comment on each line tells you what bytes to patch.`
              : "PC was not available — check that getCPUState is wired for this platform.",
          });
        }
        prev = cur;
      }
      return jsonContent({
        written: false,
        framesStepped: maxFrames,
        note: "Target byte was not written within maxFrames. Try increasing maxFrames or driving the game with pressDuring.",
      });
    }),
  );
}
