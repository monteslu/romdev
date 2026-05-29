import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHost } from "../state.js";
import { jsonContent, safeTool, textContent } from "../util.js";

export function registerStateTools(server, z, sessionKey) {
  server.tool(
    "saveState",
    "Snapshot the entire emulator state into a named slot. Use for checkpoint/restore workflows.",
    {
      name: z.string().min(1).describe("Slot name. Overwrites any existing slot with the same name."),
    },
    safeTool(async ({ name }) => {
      getHost(sessionKey).saveState(name);
      return textContent(`saved state '${name}'`);
    }),
  );

  server.tool(
    "loadState",
    "Restore a previously saved state by name. Resets the framebuffer/frame counters to whatever the snapshot held.",
    {
      name: z.string().min(1),
    },
    safeTool(async ({ name }) => {
      getHost(sessionKey).loadState(name);
      return textContent(`loaded state '${name}'`);
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
