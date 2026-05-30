// Platform documentation tools — exposes the MENTAL_MODEL.md and
// TROUBLESHOOTING.md files that live under src/platforms/<platform>/
// to the agent via MCP. Templates reference these docs in their
// comments ("read MENTAL_MODEL.md first"); without this tool the
// agent has no way to actually read them through the protocol.
//
// MENTAL_MODEL.md — one-page architecture brief (memory map, video
//   chip, frame heartbeat, build pipeline). Read once per platform
//   before writing code.
// TROUBLESHOOTING.md — symptom→cause→fix table. Read when stuck.
//
// Currently shipped for: nes, gb, snes, genesis, sms, atari7800,
// atari2600. Others are blank (the tool returns an empty list).

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";

import { jsonContent, safeTool, textContent } from "../util.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLATFORMS_ROOT = path.resolve(__dirname, "..", "..", "platforms");

/** Known doc-file names. Add new ones here when shipping more. */
const DOC_FILES = ["MENTAL_MODEL.md", "TROUBLESHOOTING.md", "UPSTREAM_SOURCES.md"];

/**
 * For a single platform, list which docs exist on disk.
 *
 * @returns {Promise<Array<{name: string, file: string, bytes: number}>>}
 */
async function listDocsForPlatform(platform) {
  const dir = path.join(PLATFORMS_ROOT, platform);
  const out = [];
  for (const f of DOC_FILES) {
    const full = path.join(dir, f);
    try {
      const s = await stat(full);
      if (s.isFile()) {
        out.push({ name: f.replace(/\.md$/, "").toLowerCase(), file: f, bytes: s.size });
      }
    } catch {
      /* not present — skip */
    }
  }
  return out;
}

export function registerPlatformDocsTools(server, z) {
  server.tool(
    "listPlatformDocs",
    "List the platform-specific docs available for a given platform. Today: MENTAL_MODEL.md (one-page architecture brief — memory map, PPU/VDP, frame heartbeat, build pipeline), TROUBLESHOOTING.md (symptom→cause→fix index), and UPSTREAM_SOURCES.md (R58 — pointers to bundled library source + upstream GitHub for compilers/emulators, so you can grep for ground truth when our examples aren't enough). Read MENTAL_MODEL before writing code; read TROUBLESHOOTING when stuck; read UPSTREAM_SOURCES when you need to dig deeper than what we expose.",
    {
      platform: z.string().describe("Platform id (e.g. 'nes', 'genesis', 'sms')."),
    },
    safeTool(async ({ platform }) => {
      const docs = await listDocsForPlatform(platform);
      return jsonContent({
        platform,
        docs,
        note: docs.length === 0
          ? `No docs shipped for '${platform}' yet. Try a different platform or call starterSnippets for boilerplate.`
          : `Call getPlatformDoc({ platform, name }) to read one. 'name' is 'mental_model' or 'troubleshooting'.`,
      });
    }),
  );

  server.tool(
    "getPlatformDoc",
    "Fetch the full contents of a platform doc. Returns markdown verbatim — render or quote as-is. Use `name: 'mental_model'` for MENTAL_MODEL.md, `'troubleshooting'` for TROUBLESHOOTING.md, `'upstream_sources'` for UPSTREAM_SOURCES.md. Templates reference these files in their comments; this tool is how the agent actually reads them.",
    {
      platform: z.string().describe("Platform id."),
      name: z.string().describe("'mental_model' | 'troubleshooting' | 'upstream_sources'."),
    },
    safeTool(async ({ platform, name }) => {
      const lower = name.toLowerCase();
      let docFile;
      if (lower === "mental_model" || lower === "mental-model" || lower === "mentalmodel") {
        docFile = "MENTAL_MODEL.md";
      } else if (lower === "troubleshooting") {
        docFile = "TROUBLESHOOTING.md";
      } else if (lower === "upstream_sources" || lower === "upstream-sources" || lower === "upstreamsources" || lower === "upstream" || lower === "sources") {
        docFile = "UPSTREAM_SOURCES.md";
      } else {
        throw new Error(`unknown doc '${name}'. Valid: 'mental_model' | 'troubleshooting' | 'upstream_sources'.`);
      }
      const full = path.join(PLATFORMS_ROOT, platform, docFile);
      try {
        const contents = await readFile(full, "utf-8");
        return jsonContent({ platform, name: lower, file: docFile, contents });
      } catch (e) {
        if (e.code === "ENOENT") {
          throw new Error(
            `No ${docFile} for platform '${platform}'. Call listPlatformDocs({platform}) to see what's shipped.`
          );
        }
        throw e;
      }
    }),
  );
}
