// Generic file I/O for agent-authored assets.
//
// romdev tools can take {outputPath} on the build/patch tools, but
// agents often need to save arbitrary intermediate artifacts: a PNG they
// generated, a backup of an existing ROM, a notes file, a partial work-
// in-progress source file. writeAsset / readAsset cover that gap without
// forcing every other tool to grow a fs writer.

import { jsonContent, safeTool, textContent } from "../util.js";

export function registerAssetTools(server, z) {
  server.tool(
    "writeAsset",
    "Write arbitrary bytes to a file on disk. Use for: saving an agent-generated PNG, dumping a backup ROM, persisting an in-progress source file. Provide either `text` (utf-8) or `base64` (binary). Creates parent dirs if needed.",
    {
      path: z.string().describe("Absolute path to write to."),
      text: z.string().optional().describe("UTF-8 text content."),
      base64: z.string().optional().describe("Base64-encoded binary content."),
    },
    safeTool(async ({ path: filePath, text, base64 }) => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const path = await import("node:path");
      if (text === undefined && base64 === undefined) {
        throw new Error("either `text` or `base64` is required");
      }
      const dir = path.dirname(filePath);
      try { await mkdir(dir, { recursive: true }); } catch {}
      const bytes = text !== undefined ? Buffer.from(text, "utf-8") : Buffer.from(base64, "base64");
      await writeFile(filePath, bytes);
      return jsonContent({ path: filePath, bytes: bytes.length });
    }),
  );

  server.tool(
    "readAsset",
    "Read a file from disk. Returns text or base64 depending on `as`. Useful for inspecting any non-ROM file (e.g. examining an agent-generated PNG, reading a source file in another directory). " +
    "Defaults to a 64 KB cap so a bare read can't dump a huge file into your context — if the file is larger, the tool returns a note telling you to raise `maxBytes` deliberately (up to 10 MB) or read a slice.",
    {
      path: z.string(),
      as: z.enum(["text", "base64"]).default("text"),
      maxBytes: z.number().int().min(1).max(10_000_000).default(65_536).describe("Max bytes to read (default 64 KB). Raise deliberately for larger files (up to 10 MB)."),
    },
    safeTool(async ({ path: filePath, as, maxBytes }) => {
      const { readFile, stat } = await import("node:fs/promises");
      const st = await stat(filePath);
      if (st.size > maxBytes) {
        return jsonContent({
          path: filePath,
          bytes: st.size,
          truncated: true,
          note: `file is ${st.size} bytes, larger than the ${maxBytes}-byte cap. Raise maxBytes (up to 10000000) to read it in full, or read a slice with your own tooling.`,
        });
      }
      const buf = await readFile(filePath);
      if (as === "text") {
        return jsonContent({ path: filePath, bytes: buf.length, text: buf.toString("utf-8") });
      }
      return jsonContent({ path: filePath, bytes: buf.length, base64: buf.toString("base64") });
    }),
  );

  server.tool(
    "listAssets",
    "List files in a directory. Useful when the agent has been told 'look at my collection of ROMs' and needs to enumerate what's there.",
    {
      path: z.string(),
      pattern: z.string().optional().describe("Substring filter applied to filenames (case-insensitive)."),
    },
    safeTool(async ({ path: dirPath, pattern }) => {
      const { readdir, stat } = await import("node:fs/promises");
      const path = await import("node:path");
      const entries = await readdir(dirPath, { withFileTypes: true });
      const filter = pattern ? pattern.toLowerCase() : null;
      const items = [];
      for (const e of entries) {
        if (filter && !e.name.toLowerCase().includes(filter)) continue;
        const full = path.join(dirPath, e.name);
        const st = await stat(full).catch(() => null);
        items.push({
          name: e.name,
          path: full,
          isDirectory: e.isDirectory(),
          size: st?.size ?? null,
        });
      }
      return jsonContent({ path: dirPath, count: items.length, items });
    }),
  );
}
