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

import { jsonContent } from "../util.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLATFORMS_ROOT = path.resolve(__dirname, "..", "..", "platforms");

/** Known doc-file names. Add new ones here when shipping more. */
const DOC_FILES = ["MENTAL_MODEL.md", "TROUBLESHOOTING.md", "UPSTREAM_SOURCES.md", "DECOMP.md"];

// Docs that are not markdown in the platform dir but a file romdev already
// ships elsewhere. sync32's API header IS the platform (no registers, no VRAM
// — a struct of function pointers), and it was reachable only by `find /`
// (jaymcgavren, 2026-09-05): an agent without shell access could not write a
// line of sync32 code. Resolved lazily off the installed SDK package so it can
// never drift from what build() compiles against.
const EXTRA_DOCS = {
  sync32: {
    abi: {
      file: "share/sync32/include/sync32.h",
      describe: "the console API header (sync32.h): the sync32_api_t struct, S32_PAD_* bits, S32_* limits — the exact header build() injects",
      resolve: async () => {
        const { createRequire } = await import("node:module");
        const { sdk } = createRequire(import.meta.url)("romdev-platform-sync32");
        return sdk.headers["sync32.h"];
      },
    },
  },
};

// Cross-platform GUIDES (not tied to one platform). Surfaced through the same
// getPlatformDoc tool under a pseudo-platform id so agents have one way to read
// docs. e.g. getPlatformDoc({platform:'romhacking', name:'playbook'}).
const GUIDES = {
  romhacking: { playbook: "_guides/ROMHACKING_PLAYBOOK.md" },
};

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

/** platform({op:'docs'}) — list the docs available for a platform. */
export async function listPlatformDocsCore({ platform }) {
      if (GUIDES[platform]) {
        const docs = Object.keys(GUIDES[platform]).map((name) => ({ name, file: GUIDES[platform][name] }));
        return {
          platform,
          docs,
          note: `Cross-platform guide(s). Call platform({ op:'doc', platform: '${platform}', name: '${docs[0]?.name}' }) to read.`,
        };
      }
      const docs = await listDocsForPlatform(platform);
      for (const [name, extra] of Object.entries(EXTRA_DOCS[platform] ?? {})) {
        try {
          const full = await extra.resolve();
          const s = await stat(full);
          docs.push({ name, file: extra.file, bytes: s.size, describe: extra.describe });
        } catch { /* SDK package absent — skip rather than advertise a doc that will 404 */ }
      }
      return {
        platform,
        docs,
        note: docs.length === 0
          ? `No docs shipped for '${platform}' yet. Try a different platform, or fork an example game (examples({op:'fork'})) for boilerplate. (For RE/patching workflow, see platform({op:'doc', platform:'romhacking', name:'playbook'}).)`
          : `Call platform({op:'doc', platform, name}) to read one. 'name' is 'mental_model', 'troubleshooting', or 'upstream_sources' (whichever this platform ships — see the docs[] list above)${EXTRA_DOCS[platform] ? `, plus ${Object.keys(EXTRA_DOCS[platform]).map((n) => `'${n}'`).join(", ")} (the console API header itself)` : ""}. For RE/patching workflow across platforms, see platform({op:'doc', platform:'romhacking', name:'playbook'}).`,
      };
}

/** platform({op:'doc'}) — full markdown of one platform doc. Returns jsonContent. */
export async function getPlatformDocCore({ platform, name }) {
      const lower = name.toLowerCase();
      // Cross-platform guide lookup.
      if (GUIDES[platform]) {
        const rel = GUIDES[platform][lower];
        if (!rel) throw new Error(`unknown guide '${name}' for '${platform}'. Valid: ${Object.keys(GUIDES[platform]).join(", ")}.`);
        const full = path.join(PLATFORMS_ROOT, rel);
        const contents = await readFile(full, "utf-8");
        return jsonContent({ platform, name: lower, file: rel, contents });
      }
      const extra = EXTRA_DOCS[platform]?.[lower === "api" || lower === "header" || lower === "sync32.h" ? "abi" : lower];
      if (extra) {
        const full = await extra.resolve();
        const contents = await readFile(full, "utf-8");
        return jsonContent({ platform, name: lower, file: extra.file, path: full, contents });
      }
      let docFile;
      if (lower === "mental_model" || lower === "mental-model" || lower === "mentalmodel") {
        docFile = "MENTAL_MODEL.md";
      } else if (lower === "troubleshooting") {
        docFile = "TROUBLESHOOTING.md";
      } else if (lower === "upstream_sources" || lower === "upstream-sources" || lower === "upstreamsources" || lower === "upstream" || lower === "sources") {
        docFile = "UPSTREAM_SOURCES.md";
      } else if (lower === "decomp" || lower === "matching" || lower === "decompilation") {
        docFile = "DECOMP.md";
      } else {
        const extras = Object.keys(EXTRA_DOCS[platform] ?? {}).map((n) => `'${n}'`);
        throw new Error(`unknown doc '${name}'. Valid: 'mental_model' | 'troubleshooting' | 'upstream_sources' | 'decomp' (where shipped)${extras.length ? " | " + extras.join(" | ") : ""}.`);
      }
      const full = path.join(PLATFORMS_ROOT, platform, docFile);
      try {
        const contents = await readFile(full, "utf-8");
        return jsonContent({ platform, name: lower, file: docFile, contents });
      } catch (e) {
        if (e.code === "ENOENT") {
          throw new Error(
            `No ${docFile} for platform '${platform}'. Call platform({op:'docs', platform}) to see what's shipped.`
          );
        }
        throw e;
      }
}

// listPlatformDocs/getPlatformDoc folded into the `platform` tool (op:'docs'/'doc').
export function registerPlatformDocsTools() { /* folded into `platform` */ }
