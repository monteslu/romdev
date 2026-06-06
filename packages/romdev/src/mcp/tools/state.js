import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { getHost } from "../state.js";
import { jsonContent, safeTool } from "../util.js";

// Per-session state-diff baselines (op:'diff'). Module-local; keyed by sessionKey.
const _stateDiffSnaps = new Map();
function stateDiffSnapshots(key) {
  let m = _stateDiffSnaps.get(key);
  if (!m) { m = new Map(); _stateDiffSnaps.set(key, m); }
  return m;
}

// ── *Core functions: one per state operation. The `state` tool routes to them. ──

/** op:'save' — snapshot to an in-memory slot and/or a disk blob. */
async function saveStateCore({ name, path: outPath }, sessionKey) {
      if (!name && !outPath) throw new Error("state({op:'save'}): provide `name` (in-memory slot), `path` (disk), or both.");
      const host = getHost(sessionKey);
      const done = [];
      if (name) { host.saveState(name); done.push(`slot '${name}'`); }
      if (outPath) {
        const blob = host.serializeState();
        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, blob);
        done.push(`${blob.length} bytes → ${outPath}`);
      }
      return {
        saved: true,
        ...(name ? { name } : {}),
        ...(outPath ? { path: outPath } : {}),
        platform: host.status.platform,
        note: `Saved ${done.join(" + ")}.` + (outPath ? " Restore across sessions with state({op:'load', path}) after loading the same ROM." : ""),
      };
}

/** op:'export' — copy an EXISTING in-memory slot to disk without touching the host. */
async function exportStateCore({ fromSlot, path: outPath }, sessionKey) {
      const host = getHost(sessionKey);
      const blob = host.getStateBlob(fromSlot); // throws if the slot is missing — no host disturbance
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, blob);
      return {
        exported: true,
        fromSlot,
        path: outPath,
        bytes: blob.length,
        platform: host.status.platform,
        note: "Copied the slot to disk; the live host was not touched (no pause/resume needed).",
      };
}

/** op:'load' — restore from an in-memory slot OR a disk blob. */
async function loadStateCore({ name, path: inPath, render = true }, sessionKey) {
      if (!name && !inPath) throw new Error("state({op:'load'}): provide `name` (in-memory slot) or `path` (disk).");
      if (name && inPath) throw new Error("state({op:'load'}): provide `name` OR `path`, not both.");
      const host = getHost(sessionKey);
      let cheatsCleared = 0;
      if (inPath) {
        const blob = new Uint8Array(await readFile(inPath));
        cheatsCleared = host.unserializeState(blob) || 0;
      } else {
        cheatsCleared = host.loadState(name) || 0;
      }
      let rendered = false;
      if (render) { host.renderOneFrame(); rendered = true; }
      return {
        loaded: true,
        ...(inPath ? { path: inPath } : { name }),
        platform: host.status.platform,
        rendered,
        ...(host.status.paused && rendered ? { renderedWhilePaused: true } : {}),
        cheatsCleared, // a restore removes active cheats (frontend cheat state isn't in the blob)
      };
}

/** op:'list' — named in-memory slots. */
function listStatesCore(_args, sessionKey) {
  return { states: getHost(sessionKey).listStates() };
}

/** op:'dump' — raw libretro blob to disk for forensic inspection (+ optional findHex). */
async function dumpStateCore({ path: outPath, findHex, maxMatches = 32 }, sessionKey) {
      const host = getHost(sessionKey);
      const blob = host.serializeState();
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, blob);
      const result = {
        path: outPath,
        bytes: blob.length,
        platform: host.status.platform,
        note: "Raw libretro save-state blob. Use `xxd`, `hexdump -C`, or re-call with findHex to inspect. The blob's structure is core-specific — typically a header followed by concatenated subsystem dumps (CPU regs, RAM, VRAM, etc.).",
      };
      if (findHex) {
        const cleaned = findHex.replace(/[\s_]/g, "");
        if (!/^[0-9a-fA-F]+$/.test(cleaned) || cleaned.length % 2 !== 0) {
          throw new Error(`findHex must be an even-length hex string, got '${findHex}'`);
        }
        const needle = Buffer.from(cleaned, "hex");
        const offsets = [];
        let from = 0;
        while (offsets.length < maxMatches) {
          const i = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength).indexOf(needle, from);
          if (i < 0) break;
          offsets.push(i);
          from = i + 1;
        }
        result.findHex = cleaned;
        result.matches = offsets.length;
        result.offsets = offsets;
        result.offsetsHex = offsets.map((o) => "0x" + o.toString(16));
        result.truncated = offsets.length === maxMatches;
      }
      return result;
}

/** op:'diff' — whole-machine save-state diff (snapOrDiff:'snapshot'|'diff'). */
function diffStateCore({ name = "default", snapOrDiff }, sessionKey) {
      const host = getHost(sessionKey);
      const store = stateDiffSnapshots(sessionKey);
      if (snapOrDiff === "snapshot") {
        const blob = host.serializeState();
        store.set(name, Uint8Array.from(blob));
        return { name, mode: "snapshot", size: blob.length, note: "State baseline captured — trigger your event, then state({op:'diff', name, snapOrDiff:'diff'})." };
      }
      const base = store.get(name);
      if (!base) throw new Error(`state({op:'diff'}): no state snapshot named '${name}'. Call with snapOrDiff:'snapshot' first.`);
      const now = host.serializeState();
      let differingBytes = 0;
      const len = Math.min(base.length, now.length);
      for (let i = 0; i < len; i++) if (base[i] !== now[i]) differingBytes++;
      const sizeChanged = base.length !== now.length;
      return {
        name, mode: "diff",
        changed: differingBytes > 0 || sizeChanged,
        differingBytes,
        sizeChanged,
        baselineSize: base.length,
        currentSize: now.length,
        note: "State blobs are core-internal — for the actual changed RAM addresses use memory({op:'snapshot'/'diff'}).",
      };
}

export function registerStateTools(server, z, sessionKey) {
  server.tool(
    "state",
    "Save-state lifecycle for the emulator. `op`: 'save' | 'load' | 'list' | 'export' | 'dump' | 'diff'.\n" +
    "'save': `name` = fast in-memory slot (LOST on server restart / new session), `path` = disk blob that SURVIVES " +
    "across sessions — reload via op:'load'. Multi-session RE: save once at the state you care about, reload it " +
    "every session instead of re-running loadMedia + hundreds of stepFrames.\n" +
    "'load': restore from a `name` slot OR a `path` blob. A state captures RAM/CPU/PPU/APU — NOT the ROM — so it's " +
    "ROM-CONTENT-INDEPENDENT: a state saved on the stock ROM reloads into a rebuilt/patched ROM of the same core → " +
    "clean A/B patch test. KNOW: (1) `render:true` (default) steps one frame so the next screenshot isn't stale/" +
    "blank (works even while PAUSED); set false to stay at the exact restored instant. (2) `frameCount` is NOT " +
    "rewound — it keeps counting. (3) a restore REMOVES active cheats (`cheatsCleared:N`).\n" +
    "'export': copy an EXISTING slot's bytes to disk WITHOUT touching the host (persist a playtest-hotkey save; no " +
    "pause/resume). 'dump': raw libretro blob to disk for forensic inspection — the blob often contains internal " +
    "memory the region API doesn't expose (SPC700 ARAM, Z80 RAM); `findHex` greps it for a sentinel you wrote. " +
    "'list': named in-memory slots. 'diff': whole-machine 'did ANYTHING change?' (coarser than memory diff) — " +
    "snapOrDiff:'snapshot' captures, 'diff' compares.",
    {
      op: z.enum(["save", "load", "list", "export", "dump", "diff"]).describe("save/load a state; list slots; export a slot to disk; dump the raw blob; diff the whole machine."),
      name: z.string().min(1).optional().describe("op=save/load: in-memory slot name. op=diff: snapshot label (default 'default')."),
      path: z.string().optional().describe("op=save: also write the blob here (survives restarts). op=load: restore from this disk blob. op=export/dump: write the blob here (required)."),
      // load
      render: z.boolean().default(true).describe("op=load: step one frame after restoring so the framebuffer reflects it (fixes the stale-screenshot footgun). false = stay at the exact restored instant."),
      // export
      fromSlot: z.string().min(1).optional().describe("op=export: in-memory slot to copy to disk (required)."),
      // dump
      findHex: z.string().optional().describe("op=dump: even-length hex byte-pattern to grep the blob for (ws/underscores ok, no 0x prefix) — returns every offset. Locate sentinel bytes you wrote."),
      maxMatches: z.number().int().min(1).max(1000).default(32).describe("op=dump: cap on returned offsets when findHex is set."),
      // diff
      snapOrDiff: z.enum(["snapshot", "diff"]).optional().describe("op=diff: 'snapshot' captures the current state as baseline; 'diff' compares to it."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "save":   return jsonContent(await saveStateCore(args, sessionKey));
        case "load":   return jsonContent(await loadStateCore(args, sessionKey));
        case "list":   return jsonContent(listStatesCore(args, sessionKey));
        case "export": {
          if (!args.fromSlot) throw new Error("state({op:'export'}): `fromSlot` is required.");
          if (!args.path) throw new Error("state({op:'export'}): `path` is required.");
          return jsonContent(await exportStateCore(args, sessionKey));
        }
        case "dump": {
          if (!args.path) throw new Error("state({op:'dump'}): `path` is required.");
          return jsonContent(await dumpStateCore(args, sessionKey));
        }
        case "diff": {
          if (!args.snapOrDiff) throw new Error("state({op:'diff'}): `snapOrDiff` ('snapshot' or 'diff') is required.");
          return jsonContent(diffStateCore(args, sessionKey));
        }
        default: throw new Error(`state: unknown op '${args.op}'`);
      }
    }),
  );
}

