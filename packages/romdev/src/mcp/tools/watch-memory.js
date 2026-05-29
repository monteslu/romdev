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

import { getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";
import { getCPUState } from "../../host/cpu-state.js";

const MEMORY_REGIONS = [
  "system_ram", "save_ram", "video_ram", "rtc",
  "nes_nametables", "nes_palette", "nes_oam", "nes_chr",
  "snes_cgram", "snes_oam", "snes_aram", "snes_fillram",
  "gb_vram", "gb_oam", "gb_io", "gb_hram", "gb_bgpdata", "gb_objpdata",
  "sms_vram", "sms_cram", "sms_vdp_regs", "sms_z80_regs", "gg_vram", "gg_cram",
  "md_cram", "md_vsram", "md_vdp_regs", "md_z80_ram", "md_m68k_ram", "md_ym2612", "md_psg", "md_vram",
  "a26_tia_regs", "a26_cpu_regs", "a78_cpu_regs",
];

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

function diffSnapshots(before, after, baseOffset) {
  const changes = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) {
      changes.push({
        offset: baseOffset + i,
        offsetHex: "0x" + (baseOffset + i).toString(16).toUpperCase().padStart(4, "0"),
        before: before[i],
        after: after[i],
      });
    }
  }
  return changes;
}

export function registerWatchMemoryTools(server, z, sessionKey) {
  server.tool(
    "watchMemory",
    "Use this to answer 'what code is touching this RAM byte?' without an instruction tracer: runs N frames " +
    "and reports every frame that changed a byte in the watched region as {frame, offset, before, after, " +
    "pc} — the pc tells you which disasm line to patch. Supports `pressDuring` to drive input at specific " +
    "frames. CAVEAT: frame-level, not instruction-level — if a frame writes the byte several times you only " +
    "see the last value (enough to find the code path, not for cycle-exact tracing). Cross-platform.",
    {
      region: z.enum(MEMORY_REGIONS).describe("Memory region to watch (matches readMemory's region arg)."),
      offset: z.number().int().min(0).describe("First byte of the watched range."),
      length: z.number().int().min(1).max(4096).default(1).describe("How many bytes to watch (default 1)."),
      frames: z.number().int().min(1).max(1_000_000).default(600).describe("How many frames to run (default 600 = ~10s NTSC)."),
      stopOnFirst: z.boolean().default(false).describe("If true, stop on the first detected change instead of running for the full duration."),
      maxEvents: z.number().int().min(1).max(10_000).default(256).describe("Cap on returned events; surplus events are dropped with a `truncated` flag."),
      pressDuring: z.array(z.object({
        frame: z.number().int().min(0).describe("Frame on which to press."),
        button: z.string().describe("Button name (see input-layout.js)."),
        port: z.number().int().min(0).max(3).default(0),
        holdFrames: z.number().int().min(1).default(2),
      })).optional().describe("Schedule button presses while watching, so the agent can simulate user input mid-watch."),
    },
    safeTool(async ({ region, offset, length, frames, stopOnFirst, maxEvents, pressDuring }) => {
      const host = getHost(sessionKey);
      const events = [];
      let truncated = false;
      const presses = (pressDuring ?? []).slice().sort((a, b) => a.frame - b.frame);

      let prev = snap(host, region, offset, length);
      const startFrame = host.status.frameCount;

      for (let i = 0; i < frames; i++) {
        // Schedule any inputs that fire on this frame.
        while (presses.length && presses[0].frame === i) {
          const p = presses.shift();
          try { host.pressButton(p.port, p.button, p.holdFrames); } catch { /* button name may be unknown */ }
        }
        host.stepFrames(1);
        const cur = snap(host, region, offset, length);
        const changes = diffSnapshots(prev, cur, offset);
        if (changes.length > 0) {
          const pc = tryGetPC(host);
          const frameAbs = startFrame + i + 1;
          for (const c of changes) {
            if (events.length >= maxEvents) { truncated = true; break; }
            events.push({
              frame: frameAbs,
              frameRelative: i + 1,
              ...c,
              pc: hexPC(pc),
              pcRaw: pc,
            });
          }
          if (stopOnFirst) {
            prev = cur;
            return jsonContent({
              region,
              offset,
              length,
              framesStepped: i + 1,
              eventCount: events.length,
              events,
              truncated,
              stoppedEarly: true,
              note: tryGetPC(host) == null
                ? "PC not available for this platform (getCPUState returned no pc field)."
                : undefined,
            });
          }
          if (truncated) break;
          prev = cur;
        } else {
          prev = cur;
        }
      }

      return jsonContent({
        region,
        offset,
        length,
        framesStepped: frames,
        eventCount: events.length,
        events,
        truncated,
        stoppedEarly: false,
        note: events.length === 0
          ? "No writes observed in the watched window. Try (a) longer `frames`, (b) `pressDuring` to drive the game past the event, (c) a wider `length` or a different region."
          : undefined,
      });
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
