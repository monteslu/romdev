// Generic file I/O for agent-authored assets — the consolidated `files` tool.
//
// romdev tools can take {outputPath} on the build/patch tools, but agents often
// need to save/read/list arbitrary intermediate artifacts: a generated PNG, a
// backup ROM, a notes file, a work-in-progress source. `files({op})` covers that
// gap without every other tool growing a fs writer.
//
// Consolidation note: this replaces the former writeAsset / readAsset / listAssets
// tools with one `files` tool (op: read|write|list). Logic lives in the exported
// *Core functions so it's unit-testable and the router stays thin.

import { jsonContent, safeTool } from "../util.js";

/** write: bytes to a file (text utf-8 OR base64 binary); creates parent dirs. */
export async function writeFileCore({ path: filePath, text, base64 }) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const path = await import("node:path");
  if (text === undefined && base64 === undefined) {
    throw new Error("files({op:'write'}): either `text` or `base64` is required");
  }
  const dir = path.dirname(filePath);
  try { await mkdir(dir, { recursive: true }); } catch {}
  const bytes = text !== undefined ? Buffer.from(text, "utf-8") : Buffer.from(base64, "base64");
  await writeFile(filePath, bytes);
  return { path: filePath, bytes: bytes.length };
}

/** read: a file as text or base64, with a default 64 KB context-safety cap. */
export async function readFileCore({ path: filePath, as = "text", maxBytes = 65_536 }) {
  const { readFile, stat } = await import("node:fs/promises");
  const st = await stat(filePath);
  if (st.size > maxBytes) {
    return {
      path: filePath,
      bytes: st.size,
      truncated: true,
      note: `file is ${st.size} bytes, larger than the ${maxBytes}-byte cap. Raise maxBytes (up to 10000000) to read it in full, or read a slice with your own tooling.`,
    };
  }
  const buf = await readFile(filePath);
  if (as === "text") return { path: filePath, bytes: buf.length, text: buf.toString("utf-8") };
  return { path: filePath, bytes: buf.length, base64: buf.toString("base64") };
}

/** list: directory entries, optional case-insensitive substring filter. */
export async function listFilesCore({ path: dirPath, pattern }) {
  const { readdir, stat } = await import("node:fs/promises");
  const path = await import("node:path");
  const entries = await readdir(dirPath, { withFileTypes: true });
  const filter = pattern ? pattern.toLowerCase() : null;
  const items = [];
  for (const e of entries) {
    if (filter && !e.name.toLowerCase().includes(filter)) continue;
    const full = path.join(dirPath, e.name);
    const st = await stat(full).catch(() => null);
    items.push({ name: e.name, path: full, isDirectory: e.isDirectory(), size: st?.size ?? null });
  }
  return { path: dirPath, count: items.length, items };
}

export function registerAssetTools(server, z) {
  server.tool(
    "files",
    "Generic file I/O on disk for arbitrary agent artifacts (a generated PNG, a backup ROM, a notes file, a work-in-progress source). `op:'read'|'write'|'list'`. " +
    "`write` takes `text` (utf-8) OR `base64` (binary) and creates parent dirs. `read` returns `text` or `base64` per `as`, with a default 64 KB cap so a bare read can't dump a huge file into your context — if larger, it returns a note telling you to raise `maxBytes` (up to 10 MB) deliberately. `list` enumerates a directory with an optional case-insensitive `pattern` substring filter.",
    {
      op: z.enum(["read", "write", "list"]).describe("which file op to run."),
      path: z.string().describe("Absolute path: file to read/write, or directory to list."),
      // write
      text: z.string().optional().describe("op=write: UTF-8 text content (pass this OR base64)."),
      base64: z.string().optional().describe("op=write: base64 binary content (pass this OR text)."),
      // read
      as: z.enum(["text", "base64"]).default("text").describe("op=read: return as 'text' (utf-8, default) or 'base64'."),
      maxBytes: z.number().int().min(1).max(10_000_000).default(65_536).describe("op=read: max bytes (default 64 KB, max 10 MB). Over-cap reads return a note, not content."),
      // list
      pattern: z.string().optional().describe("op=list: case-insensitive substring filter on filenames."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "write": return jsonContent(await writeFileCore(args));
        case "read":  return jsonContent(await readFileCore(args));
        case "list":  return jsonContent(await listFilesCore(args));
        default: throw new Error(`files: unknown op '${args.op}'`);
      }
    }),
  );
}
