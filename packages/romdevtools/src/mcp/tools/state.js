import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { getHost } from "../state.js";
import { getCPUState } from "romdev-core-host/cpu-state.js";
import { attachObserverFrame } from "./watch-memory.js";
import { jsonContent, safeTool } from "../util.js";

// Resolve a state-file `path`. An ABSOLUTE path is used as-is. A RELATIVE path
// is resolved against the LOADED ROM's directory (the agent's mental model is
// "save states live next to my ROM") — NOT the server's CWD, which is opaque to
// the caller and was a silent ENOENT footgun (v0.15.0 feedback #1). Falls back
// to CWD only when no ROM path is known (e.g. ROM loaded from base64).
export function resolveStatePath(p, host) {
  if (!p || path.isAbsolute(p)) return p;
  const media = host?.status?.mediaPath;
  // mediaPath is "<memory…>" for base64 loads — not a real dir; skip those.
  if (media && !media.startsWith("<") && path.isAbsolute(media)) {
    return path.resolve(path.dirname(media), p);
  }
  return path.resolve(p);
}

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
      const resolvedOut = outPath ? resolveStatePath(outPath, host) : null;
      if (resolvedOut) {
        const blob = host.serializeState();
        await mkdir(path.dirname(resolvedOut), { recursive: true });
        await writeFile(resolvedOut, blob);
        done.push(`${blob.length} bytes → ${resolvedOut}`);
      }
      return {
        saved: true,
        ...(name ? { name } : {}),
        ...(resolvedOut ? { path: resolvedOut, ...(resolvedOut !== outPath ? { resolvedPath: resolvedOut } : {}) } : {}),
        platform: host.status.platform,
        note: `Saved ${done.join(" + ")}.` + (outPath ? " Restore across sessions with state({op:'load', path}) after loading the same ROM." : ""),
      };
}

/** op:'export' — copy an EXISTING in-memory slot to disk without touching the host. */
async function exportStateCore({ fromSlot, path: outPath }, sessionKey) {
      const host = getHost(sessionKey);
      const blob = host.getStateBlob(fromSlot); // throws if the slot is missing — no host disturbance
      const resolvedOut = resolveStatePath(outPath, host);
      await mkdir(path.dirname(resolvedOut), { recursive: true });
      await writeFile(resolvedOut, blob);
      return {
        exported: true,
        fromSlot,
        path: resolvedOut,
        ...(resolvedOut !== outPath ? { resolvedPath: resolvedOut } : {}),
        bytes: blob.length,
        platform: host.status.platform,
        note: "Copied the slot to disk; the live host was not touched (no pause/resume needed).",
      };
}

/** op:'load' — restore from an in-memory slot OR a disk blob. */
/**
 * Liveness probe (0.102.0): a state captured at a paused/transitional moment
 * can have its dispatchers not running — everything watched from it looks
 * dead. Probe by stepping a few frames and checking that the PC moves and the
 * framebuffer changes, then RE-RESTORE the exact state so the probe is
 * side-effect-free. Skippable with probeLiveness:false (frame-exact flows).
 */
function probeStateLiveness(host, reload) {
  const frameCount0 = host.status.frameCount; // the monotonic power-on counter must not observe the probe
  try {
    const pcOf = () => {
      try { return getCPUState(host)?.pc ?? null; } catch { return null; }
    };
    const pcs = new Set();
    const p0 = pcOf(); if (p0 != null) pcs.add(p0);
    const hash0 = host.framebufferHash();
    const FRAMES = 4;
    let framebufferChanged, pcVaried;
    try {
      for (let i = 0; i < FRAMES; i++) {
        host.stepFrames(1);
        const p = pcOf(); if (p != null) pcs.add(p);
      }
      framebufferChanged = host.framebufferHash() !== hash0;
      pcVaried = pcs.size > 1;
    } finally {
      reload(); // net-zero: the caller gets the state exactly as loaded
      host.status.frameCount = frameCount0;
    }
    const alive = pcVaried || framebufferChanged;
    return {
      alive, framesProbed: FRAMES, pcVaried, framebufferChanged,
      ...(alive ? {} : {
        note: "PROBE: the CPU PC never moved and the framebuffer never changed over " + FRAMES +
          " frames — this state looks FROZEN (captured mid-pause/transition; dispatchers not running). " +
          "Code you watch from here may never execute. Advance to a live moment and re-save, or " +
          "confirm with a breakpoint on a routine you know runs constantly (NMI, main loop). " +
          "(The probe re-restored the state; your session is at the exact loaded moment.)",
      }),
    };
  } catch { return null; } // best-effort — never fail the load over the probe
}

async function loadStateCore({ name, path: inPath, render = true, probeLiveness = true }, sessionKey) {
      if (!name && !inPath) throw new Error("state({op:'load'}): provide `name` (in-memory slot) or `path` (disk).");
      if (name && inPath) throw new Error("state({op:'load'}): provide `name` OR `path`, not both.");
      const host = getHost(sessionKey);
      let cheatsCleared = 0;
      const resolvedIn = inPath ? resolveStatePath(inPath, host) : null;
      if (resolvedIn) {
        const blob = new Uint8Array(await readFile(resolvedIn));
        cheatsCleared = host.unserializeState(blob) || 0;
      } else {
        cheatsCleared = host.loadState(name) || 0;
      }
      let liveness = null;
      if (probeLiveness) {
        const blobForReload = resolvedIn ? new Uint8Array(await readFile(resolvedIn)) : null;
        liveness = probeStateLiveness(host, () => {
          if (blobForReload) host.unserializeState(blobForReload);
          else host.loadState(name);
        });
      }
      let rendered = false;
      if (render) { host.renderOneFrame(); rendered = true; }
      return {
        loaded: true,
        ...(liveness ? { liveness } : {}),
        ...(resolvedIn ? { path: resolvedIn, ...(resolvedIn !== inPath ? { resolvedPath: resolvedIn } : {}) } : { name }),
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

// SRAM presence: the battery-backed cartridge save RAM size for the loaded ROM
// (0 = this cart/system has no battery save). Used by exportSram/importSram and
// surfaced so an agent knows whether a save file even exists.
function sramSize(host) {
  try { return host.regionSize("save_ram"); } catch { return 0; }
}

/** op:'exportSram' — write the cartridge's battery SAVE RAM to a .sav file.
 * This is the actual save-game file (distinct from a whole-machine savestate):
 * the bytes a real cart keeps on its battery. Empty on a no-battery cart. */
async function exportSramCore({ path: outPath }, sessionKey) {
  const host = getHost(sessionKey);
  const size = sramSize(host);
  if (!size) {
    throw new Error(
      `state({op:'exportSram'}): the loaded ROM has no battery save RAM ` +
      `(platform '${host.status.platform}', size 0). Either this cart has no battery ` +
      `save, or this system never had cartridge saves (Atari 2600/7800, Lynx; C64 saves ` +
      `are disk-based). Use state({op:'save', path}) for a full-machine savestate instead.`);
  }
  const blob = host.readMemory("save_ram", 0, size);
  const resolved = resolveStatePath(outPath, host);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, Buffer.from(blob));
  return {
    exportedSram: true,
    path: resolved,
    ...(resolved !== outPath ? { resolvedPath: resolved } : {}),
    bytes: size,
    platform: host.status.platform,
    note: "Wrote the cartridge's battery SAVE RAM (the .sav save-game file). Restore with " +
      "state({op:'importSram', path}) after loading the same ROM. This is the SAVE FILE, " +
      "not a savestate — edit it offline (it's raw SRAM) or inject one a player made elsewhere.",
  };
}

/** op:'importSram' — load a .sav file back into the cartridge's battery SAVE RAM. */
async function importSramCore({ path: inPath }, sessionKey) {
  const host = getHost(sessionKey);
  const size = sramSize(host);
  if (!size) {
    throw new Error(
      `state({op:'importSram'}): the loaded ROM has no battery save RAM ` +
      `(platform '${host.status.platform}', size 0) — nowhere to load a .sav into.`);
  }
  const resolved = resolveStatePath(inPath, host);
  const blob = new Uint8Array(await readFile(resolved));
  if (blob.length !== size) {
    // Size mismatch is the classic wrong-game/wrong-region footgun — surface it,
    // but allow a smaller blob (zero-pad) since some dumps trim trailing zeros.
    if (blob.length > size) {
      throw new Error(
        `state({op:'importSram'}): .sav is ${blob.length} bytes but this cart's SAVE RAM is ${size} ` +
        `— too large (wrong game/region?). Refusing to truncate.`);
    }
  }
  host.writeMemory("save_ram", 0, blob);
  return {
    importedSram: true,
    path: resolved,
    ...(resolved !== inPath ? { resolvedPath: resolved } : {}),
    bytes: blob.length,
    sramSize: size,
    ...(blob.length < size ? { zeroPadded: size - blob.length } : {}),
    platform: host.status.platform,
    note: "Loaded the .sav into the cartridge's battery SAVE RAM. The running game sees it " +
      "on its next save-RAM read (some games re-read only on a load/menu). " +
      (blob.length < size ? `Blob was smaller than SRAM (${blob.length}<${size}); the tail kept its prior bytes.` : ""),
  };
}

/** op:'exportDisk' — write the LIVE mounted C64 .d64 disk image to a file.
 * The C64 analogue of exportSram: a game saves by writing files to its disk, and
 * this snapshots the whole disk (incl. any saves the game wrote). C64/VICE only. */
async function exportDiskCore({ path: outPath, unit = 8 }, sessionKey) {
  const host = getHost(sessionKey);
  if (!host.diskImageSupported || !host.diskImageSupported()) {
    throw new Error("state({op:'exportDisk'}): disk images are a C64 feature (VICE). " +
      `The loaded platform is '${host.status.platform}'.`);
  }
  const blob = host.exportDiskImage(unit); // throws if no .d64 mounted
  const resolved = resolveStatePath(outPath, host);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, Buffer.from(blob));
  return {
    exportedDisk: true,
    path: resolved,
    ...(resolved !== outPath ? { resolvedPath: resolved } : {}),
    bytes: blob.length,
    unit,
    note: "Wrote the LIVE 1541 disk image (.d64) — the C64 save medium. Re-load it later " +
      "with loadMedia({platform:'c64', path}) (it autostarts), or push it back into a " +
      "running session with state({op:'importDisk', path}). This captures any files the " +
      "game wrote to disk.",
  };
}

/** op:'importDisk' — write a .d64 file back into the LIVE mounted C64 disk image. */
async function importDiskCore({ path: inPath, unit = 8 }, sessionKey) {
  const host = getHost(sessionKey);
  if (!host.diskImageSupported || !host.diskImageSupported()) {
    throw new Error("state({op:'importDisk'}): disk images are a C64 feature (VICE). " +
      `The loaded platform is '${host.status.platform}'.`);
  }
  const resolved = resolveStatePath(inPath, host);
  const blob = new Uint8Array(await readFile(resolved));
  if (blob.length !== 174848) {
    throw new Error(`state({op:'importDisk'}): '${resolved}' is ${blob.length} bytes — not a ` +
      `standard 174848-byte 35-track .d64. Only that format round-trips through the live drive.`);
  }
  const n = host.importDiskImage(blob, unit);
  return {
    importedDisk: true,
    path: resolved,
    ...(resolved !== inPath ? { resolvedPath: resolved } : {}),
    bytes: n,
    unit,
    note: "Wrote the .d64 into the running C64's mounted disk. The game sees it on its next " +
      "disk access (a load/menu). Use this to inject a save disk a player made elsewhere.",
  };
}

/** op:'putDiskFile' — write ONE PRG file into the LIVE mounted C64 disk (inject a save). */
async function putDiskFileCore({ path: inPath, name, unit = 8 }, sessionKey) {
  const host = getHost(sessionKey);
  if (!host.diskImageSupported || !host.diskImageSupported()) {
    throw new Error("state({op:'putDiskFile'}): disk files are a C64 feature (VICE). " +
      `The loaded platform is '${host.status.platform}'.`);
  }
  if (!inPath) throw new Error("state({op:'putDiskFile'}): `path` (the file to write) is required.");
  const resolved = resolveStatePath(inPath, host);
  const blob = new Uint8Array(await readFile(resolved));
  // file name on disk: explicit `name`, else the source basename (sans extension), uppercased
  const fname = (name || path.basename(resolved).replace(/\.[^.]+$/, ""))
    .toUpperCase().replace(/[^A-Z0-9 ]/g, "").slice(0, 16) || "FILE";
  host.putDiskFile(fname, blob, unit);
  return {
    wroteDiskFile: true,
    name: fname,
    path: resolved,
    bytes: blob.length,
    unit,
    note: "Wrote one PRG file into the running C64's mounted disk via the drive. Read the " +
      "whole disk back with state({op:'exportDisk', path}) or cart({op:'extract'}).",
  };
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
      op: z.enum(["save", "load", "list", "export", "dump", "diff", "exportSram", "importSram", "exportDisk", "importDisk", "putDiskFile"]).describe("save/load a savestate (whole machine); list slots; export a slot to disk; dump the raw blob; diff the whole machine. SRAM (the cartridge BATTERY SAVE FILE, distinct from a savestate): exportSram writes the .sav, importSram loads one back. C64 DISK (VICE; the C64 save medium is a floppy, not battery SRAM): exportDisk writes the live .d64, importDisk pushes a .d64 back into the running drive, putDiskFile injects one PRG file into the live disk."),
      name: z.string().min(1).optional().describe("op=save/load: in-memory slot name. op=diff: snapshot label (default 'default'). op=putDiskFile: file name on the disk (≤16 chars; default = source basename)."),
      unit: z.number().int().min(8).max(11).default(8).describe("op=exportDisk/importDisk/putDiskFile (C64): drive unit (default 8)."),
      path: z.string().optional().describe("op=save: also write the blob here (survives restarts). op=load: restore from this disk blob. op=export/dump: write the blob here (required). A RELATIVE path resolves against the loaded ROM's directory (NOT the server CWD); an absolute path is used as-is. The result echoes `resolvedPath` when they differ."),
      // load
      render: z.boolean().default(true).describe("op=load: step one frame after restoring so the framebuffer reflects it (fixes the stale-screenshot footgun). false = stay at the exact restored instant."),
      probeLiveness: z.boolean().default(true).describe("op=load: probe that the restored state is LIVE (step 4 frames: does the PC move / framebuffer change?), then RE-RESTORE the exact state — net-zero side effects. A state captured mid-pause/transition has its dispatchers stopped and everything watched from it looks dead; the probe says so up front. false = skip (saves 4 emulated frames of work)."),
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
        case "load":   return attachObserverFrame(jsonContent(await loadStateCore(args, sessionKey)), getHost(sessionKey), `state load ${args.name ?? args.path ?? ""}`.trim());
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
        case "exportSram": {
          if (!args.path) throw new Error("state({op:'exportSram'}): `path` (where to write the .sav) is required.");
          return jsonContent(await exportSramCore(args, sessionKey));
        }
        case "importSram": {
          if (!args.path) throw new Error("state({op:'importSram'}): `path` (the .sav to load) is required.");
          return jsonContent(await importSramCore(args, sessionKey));
        }
        case "exportDisk": {
          if (!args.path) throw new Error("state({op:'exportDisk'}): `path` (where to write the .d64) is required.");
          return jsonContent(await exportDiskCore(args, sessionKey));
        }
        case "importDisk": {
          if (!args.path) throw new Error("state({op:'importDisk'}): `path` (the .d64 to load) is required.");
          return jsonContent(await importDiskCore(args, sessionKey));
        }
        case "putDiskFile": {
          if (!args.path) throw new Error("state({op:'putDiskFile'}): `path` (the PRG file to inject) is required.");
          return jsonContent(await putDiskFileCore(args, sessionKey));
        }
        default: throw new Error(`state: unknown op '${args.op}'`);
      }
    }),
  );
}

