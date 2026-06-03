import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { getHost } from "../state.js";
import { jsonContent, safeTool, textContent } from "../util.js";

export function registerStateTools(server, z, sessionKey) {
  server.tool(
    "saveState",
    "Snapshot the entire emulator state. Pass `name` for an in-memory slot (fast, but LOST when the MCP " +
    "server restarts or a new session begins), and/or `path` to also write the blob to disk so it SURVIVES " +
    "across sessions — then `loadState({path})` restores it without replaying the boot sequence. For a " +
    "multi-session reverse-engineering project, save once to a path at the state you care about (e.g. " +
    "gameplay) and reload it every session instead of re-running loadMedia + hundreds of stepFrames.",
    {
      name: z.string().min(1).optional().describe("In-memory slot name (overwrites any existing slot with the same name). Provide `name`, `path`, or both."),
      path: z.string().optional().describe("Absolute path to ALSO write the raw save-state blob to (survives restarts). Reload with loadState({path}). The blob is core/platform-specific — load the matching ROM before restoring."),
    },
    safeTool(async ({ name, path: outPath }) => {
      if (!name && !outPath) throw new Error("saveState: provide `name` (in-memory slot), `path` (disk), or both.");
      const host = getHost(sessionKey);
      const done = [];
      if (name) { host.saveState(name); done.push(`slot '${name}'`); }
      if (outPath) {
        const blob = host.serializeState();
        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, blob);
        done.push(`${blob.length} bytes → ${outPath}`);
      }
      return jsonContent({
        saved: true,
        ...(name ? { name } : {}),
        ...(outPath ? { path: outPath } : {}),
        platform: host.status.platform,
        note: `Saved ${done.join(" + ")}.` + (outPath ? " Restore across sessions with loadState({path}) after loading the same ROM." : ""),
      });
    }),
  );

  server.tool(
    "loadState",
    "Restore a previously saved state — from an in-memory `name` slot OR a `path` on disk (a blob written by " +
    "saveState({path}) or dumpState). Resets the framebuffer/frame counters to whatever the snapshot held. " +
    "Load-from-path is the cross-session escape hatch: skip the boot replay by restoring a disk snapshot " +
    "(the matching ROM must already be loaded — the blob is core-specific and a mismatch errors clearly). " +
    "A state captures RAM/CPU/PPU/APU — NOT the ROM — so it is ROM-CONTENT-INDEPENDENT: a state saved on the " +
    "stock ROM reloads cleanly into a rebuilt/patched ROM of the same core (same size/mapper). That enables a " +
    "clean A/B patch test: save a gameplay state on the original, load the patched ROM, loadState, and the only " +
    "difference between the two runs is your bytes.",
    {
      name: z.string().min(1).optional().describe("In-memory slot name (from saveState({name})). Provide `name` OR `path`."),
      path: z.string().optional().describe("Absolute path to a save-state blob on disk (from saveState({path}) or dumpState). Load the matching ROM first."),
    },
    safeTool(async ({ name, path: inPath }) => {
      if (!name && !inPath) throw new Error("loadState: provide `name` (in-memory slot) or `path` (disk).");
      if (name && inPath) throw new Error("loadState: provide `name` OR `path`, not both.");
      const host = getHost(sessionKey);
      if (inPath) {
        const blob = new Uint8Array(await readFile(inPath));
        host.unserializeState(blob);
        return jsonContent({ loaded: true, path: inPath, bytes: blob.length, platform: host.status.platform });
      }
      host.loadState(name);
      return jsonContent({ loaded: true, name, platform: host.status.platform });
    }),
  );

  server.tool(
    "listStates",
    "List all named save state slots currently held in memory.",
    {},
    safeTool(async () => {
      return jsonContent({ states: getHost(sessionKey).listStates() });
    }),
  );

  server.tool(
    "dumpState",
    "Write the raw libretro save-state blob to disk for forensic inspection. " +
    "Every core's serialize format is different and undocumented in headers, " +
    "BUT the contiguous regions inside almost always include the full internal " +
    "memory (e.g. SNES SPC700 ARAM, Genesis Z80 RAM, GB hardware regs) that the " +
    "standard memory-region API doesn't expose. Workflow: write a known sentinel " +
    "byte pattern into the memory you care about (via the running ROM), call this " +
    "tool, then grep the dump for that pattern to locate the region's offset. " +
    "Once you know the offset, future dumps let you verify writes landed where " +
    "you expected. Pair with `findHex` to skip the manual xxd step. " +
    "Works for any platform — `retro_serialize` is libretro-standard.",
    {
      path: z.string().describe("Absolute path to write the raw state blob to (typically /tmp/something.state)."),
      findHex: z.string().optional().describe(
        "Optional hex byte-pattern (no spaces, no '0x') to search for in the dump. " +
        "Returns every offset where the pattern occurs. Example: 'deadbeef' finds " +
        "{0xDE, 0xAD, 0xBE, 0xEF}. Useful for locating sentinel bytes you wrote " +
        "into a known memory location.",
      ),
      maxMatches: z.number().int().min(1).max(1000).default(32).describe("Cap on returned offsets when findHex is set."),
    },
    safeTool(async ({ path: outPath, findHex, maxMatches }) => {
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

      return jsonContent(result);
    }),
  );
}
