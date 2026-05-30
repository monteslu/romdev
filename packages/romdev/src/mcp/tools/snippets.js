// getStarterSnippet / listStarterSnippets — vetted boilerplate the agent
// can include in their project instead of writing from scratch. Encodes
// the foot-guns we've already hit so the next agent doesn't have to.
//
// Snippets live in: src/platforms/<platform>/lib/[<language>/]<name>.<ext>
//   - Flat layout (current): lib/foo.s, lib/bar.s — language-implicit (asm)
//   - Language layout: lib/asm/foo.s, lib/c/baz.h — supports multiple
//     languages per platform without name collisions.
// Both layouts are supported simultaneously: language-specific dirs
// override flat names when a language is requested.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readdir, readFile, stat, mkdir, writeFile } from "node:fs/promises";

import { jsonContent, safeTool, textContent, writeOutput } from "../util.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LIB_ROOT = path.resolve(__dirname, "..", "..", "platforms");

// Map file extension → language id. Anything not listed is treated as "asm"
// for backward compat (the existing flat snippets are all .s/.asm).
const EXT_TO_LANG = {
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".s": "asm",
  ".asm": "asm",
  ".inc": "asm",
};

/**
 * Walk a platform's lib/ and return every snippet found, tagged with
 * language. Snippets in lib/<lang>/ are tagged with that language; flat
 * snippets are tagged by extension.
 *
 * @returns {Promise<Array<{name: string, file: string, language: string}>>}
 *   `name` is the bare logical name (no extension), `file` is the path
 *   relative to lib/, `language` is the inferred language id.
 */
async function listSnippetsForPlatform(platform) {
  const dir = path.join(LIB_ROOT, platform, "lib");
  /** @type {Array<{name: string, file: string, language: string}>} */
  const out = [];
  let entries;
  try { entries = await readdir(dir); } catch { return out; }
  for (const entry of entries.sort()) {
    if (entry.startsWith(".") || entry === "README.md") continue;
    const full = path.join(dir, entry);
    let s;
    try { s = await stat(full); } catch { continue; }
    if (s.isDirectory()) {
      // Language-specific subdir (e.g. lib/c/, lib/asm/).
      // ONLY list regular files inside — directory-shaped entries
      // (vendored SDK trees like lib/pvsneslib/include, lib/sgdk/
      // include) shouldn't appear as snippets because:
      //   1. They'd crash copyStarterSnippets with EISDIR.
      //   2. Multi-hundred-file SDK trees aren't "snippets" anyway.
      // Such trees ship via the createProject template's runtimeDirs
      // (vendor/<sdk>/...) which copies them recursively.
      const sub = await readdir(full).catch(() => []);
      for (const f of sub.sort()) {
        if (f.startsWith(".") || f === "README.md") continue;
        const subFull = path.join(full, f);
        let subStat;
        try { subStat = await stat(subFull); } catch { continue; }
        if (subStat.isDirectory()) continue;  // skip nested SDK trees
        const ext = path.extname(f).toLowerCase();
        out.push({
          name: f.slice(0, f.length - ext.length),
          file: `${entry}/${f}`,
          language: entry,  // dir name IS the language id
        });
      }
    } else {
      // Flat file at lib/ root — infer language from extension.
      const ext = path.extname(entry).toLowerCase();
      const lang = EXT_TO_LANG[ext] ?? "asm";
      out.push({
        name: entry.slice(0, entry.length - ext.length),
        file: entry,
        language: lang,
      });
    }
  }
  return out;
}

export function registerSnippetTools(server, z) {
  // ── Shared implementations for the three snippet modes ──────────
  async function snippetsList(platform, language) {
    const all = await listSnippetsForPlatform(platform);
    const filtered = language ? all.filter((s) => s.language === language) : all;
    const languages = [...new Set(all.map((s) => s.language))].sort();
    return jsonContent({
      platform, languages, snippets: filtered,
      note: filtered.length === 0
        ? `No snippets matched for '${platform}'${language ? ` (language=${language})` : ""}.`
        : `Fetch one with starterSnippets({ platform, mode:'get', name${language ? ", language" : ""} }), or all with mode:'getAll'.`,
    });
  }
  async function snippetsGet(platform, name, language) {
    if (!name) throw new Error("starterSnippets mode:'get' requires `name`.");
    if (name.includes("..") || (name.includes("/") && !/^[a-z]+\/[\w.-]+$/i.test(name))) {
      throw new Error("snippet name must not contain '..' or arbitrary path separators");
    }
    const all = await listSnippetsForPlatform(platform);
    const bare = name.replace(/\.\w+$/, "");
    let hit = all.find((s) => s.file === name);
    if (!hit && language) hit = all.find((s) => s.name === bare && s.language === language);
    if (!hit) hit = all.find((s) => s.name === bare);
    if (!hit) {
      const available = all.map((s) => `${s.name} (${s.language})`).sort().join(", ");
      throw new Error(`no snippet '${name}' for platform '${platform}'. Available: ${available || "(none)"}`);
    }
    const contents = await readFile(path.join(LIB_ROOT, platform, "lib", hit.file), "utf-8");
    return jsonContent({ platform, name: hit.name, file: hit.file, language: hit.language, contents });
  }
  async function snippetsGetAll(platform, language, outputPath, inline) {
    const all = await listSnippetsForPlatform(platform);
    const filtered = language ? all.filter((s) => s.language === language) : all;
    if (filtered.length === 0) {
      return textContent(`No snippets available for '${platform}'${language ? ` (language=${language})` : ""}.`);
    }
    if (!inline && !outputPath) {
      throw new Error("starterSnippets mode:'getAll': pass outputPath (write the joined snippets to disk, returns {path}) or inline:true (return `combined` in the response). Or use copyStarterSnippets to write each snippet as its own file.");
    }
    const parts = [];
    for (const s of filtered) {
      const contents = await readFile(path.join(LIB_ROOT, platform, "lib", s.file), "utf-8");
      const sep = s.language === "c" ? "// =====" : "; =====";
      parts.push(`${sep} ${s.file} =====\n${contents}`);
    }
    const combined = parts.join("\n\n");
    const meta = {
      platform, language: language ?? null,
      snippets: filtered.map((s) => ({ name: s.name, file: s.file, language: s.language })),
    };
    if (inline) {
      return jsonContent({ ...meta, combined });
    }
    const { path: outPath, bytes } = writeOutput(combined, { outputPath, what: "joined snippets" });
    return jsonContent({ ...meta, path: outPath, bytes });
  }

  server.tool(
    "starterSnippets",
    "Use this to browse/fetch a platform's vetted starter snippets (known-good boilerplate to copy instead " +
    "of writing from scratch). `mode:'list'` (DEFAULT) returns {name, file, language} for each — cheap, no " +
    "file bytes. `mode:'get'` fetches one named snippet's contents (`name` required). `mode:'getAll'` joins " +
    "every snippet into one string — DEFAULT writes that to outputPath and returns {path}; pass inline:true to " +
    "get `combined` in the response (you must pass one or the other for getAll). Optional `language` filter " +
    "('c'/'asm'). NOTE: to drop snippets into a project dir, prefer copyStarterSnippets (writes each snippet as " +
    "its own file without spending your context).",
    {
      platform: z.string(),
      mode: z.enum(["list", "get", "getAll"]).default("list").describe("'list' (default) = names only; 'get' = one snippet's contents (needs `name`); 'getAll' = every snippet joined."),
      name: z.string().optional().describe("mode:'get' only — logical name ('read_pad') or filename ('read_pad.s')."),
      language: z.string().optional().describe("Optional filter — 'c' or 'asm'."),
      outputPath: z.string().optional().describe("mode:'getAll' only — absolute path to write the joined snippets to. Required for getAll unless inline:true."),
      inline: z.boolean().default(false).describe("mode:'getAll' only — if true, return `combined` in the response instead of writing to disk. Default false — then outputPath is required for getAll."),
    },
    safeTool(async ({ platform, mode, name, language, outputPath, inline }) => {
      if (mode === "get") return snippetsGet(platform, name, language);
      if (mode === "getAll") return snippetsGetAll(platform, language, outputPath, inline);
      return snippetsList(platform, language);
    }),
  );


  server.tool(
    "copyStarterSnippets",
    "Use this to write every vetted starter snippet for a platform straight to a directory on disk — the " +
    "bytes never pass through your context (vs. starterSnippets({mode:'getAll'}) which returns them inline). Files " +
    "land flattened as siblings. Optional `language` filter and `include` whitelist to cherry-pick a " +
    "subset. Overwrites by default (vetted boilerplate, not user data; `overwrite:false` to fail on " +
    "collision).",
    {
      platform: z.string().describe("Platform id (e.g. 'nes', 'gg', 'snes')."),
      destinationDir: z.string().describe("Absolute path to the directory that will receive the files. Created if it doesn't exist."),
      language: z.string().optional().describe("Optional language filter ('c' | 'asm'). Omit to copy every language."),
      include: z.array(z.string()).optional().describe("Optional whitelist of bare snippet names. If set, only matching snippets are copied. Example: [\"vdp_init\", \"joypad_read\"]."),
      overwrite: z.boolean().default(true).describe("Default true — vetted boilerplate is meant to be regenerated. Pass false to fail when a destination file already exists."),
    },
    safeTool(async ({ platform, destinationDir, language, include, overwrite }) => {
      const all = await listSnippetsForPlatform(platform);
      let filtered = language ? all.filter((s) => s.language === language) : all;
      if (include && include.length > 0) {
        const wanted = new Set(include);
        filtered = filtered.filter((s) => wanted.has(s.name));
      }
      if (filtered.length === 0) {
        const langPart = language ? ` (language=${language})` : "";
        const includePart = include ? ` (include=${JSON.stringify(include)})` : "";
        throw new Error(`copyStarterSnippets: no snippets matched for platform '${platform}'${langPart}${includePart}.`);
      }
      await mkdir(destinationDir, { recursive: true });
      const written = [];
      const skipped = [];
      for (const s of filtered) {
        const srcPath = path.join(LIB_ROOT, platform, "lib", s.file);
        const bareName = path.basename(s.file);                       // flatten lib/<lang>/<file>
        const dstPath = path.join(destinationDir, bareName);
        if (!overwrite) {
          try {
            await stat(dstPath);
            skipped.push({ name: s.name, file: s.file, dstPath, reason: "exists" });
            continue;
          } catch { /* doesn't exist — proceed */ }
        }
        const bytes = await readFile(srcPath);
        await writeFile(dstPath, bytes);
        written.push({
          name: s.name,
          srcFile: s.file,           // relative to platforms/<p>/lib/
          dstPath,                   // absolute
          language: s.language,
          bytes: bytes.length,
        });
      }
      return jsonContent({
        platform,
        destinationDir,
        language: language ?? null,
        include: include ?? null,
        written,
        skipped,
        summary: `Copied ${written.length} snippet${written.length === 1 ? "" : "s"}` +
                 (skipped.length ? ` (skipped ${skipped.length} existing)` : "") +
                 ` into ${destinationDir}.`,
      });
    }),
  );
}
