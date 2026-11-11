// native-pack - the "compile" step for the native-runtime kinds (wasmcart / jsgame).
//
// These game artifacts are ZIP archives, so packing a source directory into one is the
// build verb for them (there is NO compiler here - wasmcart is language-agnostic, bring
// your own WASM; jsgame is plain JS). romdev just assembles the archive.
//
//   .wasc  (wasmcart): zip of { manifest.json, cart.wasm, assets/... }. If the source dir
//           lacks a manifest but has a single .wasm, a minimal manifest is generated.
//   .jsgame (jsgame):  zip of the game directory as-is (must contain package.json with a
//           "main", or an index.html / main.js entry - same as rungame expects).

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import { jsonContent, safeTool } from "../util.js";
import { resolveCartVersion } from "wasmcart";

/**
 * Zip entries carry a fixed timestamp so the same inputs always pack to the
 * same bytes (a recompile run twice must produce an identical .wasc). DOS zip
 * time is local, so this is the 1980-01-01 local epoch in every timezone.
 */
const FIXED_ZIP_TIME = new Date(1980, 0, 1);

/** Recursively collect files under `dir` into a { relPath: Uint8Array } map for zipSync. */
function collectDir(dir, baseDir = dir, out = {}) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = path.relative(baseDir, full).split(path.sep).join("/");
    const st = statSync(full);
    if (st.isDirectory()) collectDir(full, baseDir, out);
    else out[rel] = new Uint8Array(readFileSync(full));
  }
  return out;
}

/**
 * Pack a wasmcart source dir (or a bare .wasm) into a .wasc archive.
 * @param {object} a
 * @param {string} [a.source]  source directory (dev layout) to zip.
 * @param {string} [a.wasm]    a single cart .wasm (a manifest is generated around it).
 * @param {string} [a.assets]  optional assets dir (used with `wasm`).
 * @param {string} a.outputPath  where to write the .wasc.
 * @param {string} [a.name]     manifest name (generated-manifest case).
 * @param {number} [a.players]  manifest players count (generated-manifest case).
 * @param {string} [a.title]    manifest display name as people read it ("Tux Racer"; `name` stays the short id).
 *   Hosts may cut it after 64 characters; a longer one is packed with a warning in the result.
 * @param {string} [a.version]  the cart's version (semver). Without it, the version of
 *   the git checkout holding `source` (else the wasm's dir, else `assets`): the tag at a
 *   clean v<semver> tag, else <last tag>-dev.g<commit>; outside git a source manifest's
 *   own version, else 0.1.0. Same rule as wasmcart-pack and cartwheel's build.
 */
export function packWasc({ source, wasm, assets, outputPath, name, players, version, title } = {}) {
  if (!outputPath) throw new Error("pack(wasmcart): `outputPath` is required.");
  let files;
  /** The version: `version`, else git, else the source manifest's (a placeholder), else 0.1.0. */
  const cartVersion = (fallback) => {
    const v = resolveCartVersion({
      set: version,
      dirs: [source, wasm && path.dirname(path.resolve(wasm)), assets],
      fallback,
    });
    if (v.error) throw new Error(`pack(wasmcart): ${v.error}`);
    return v.version;
  };

  if (source) {
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      throw new Error(`pack(wasmcart): source '${source}' is not a directory.`);
    }
    files = collectDir(source);
    if (!files["manifest.json"]) {
      // No manifest in the dir - synthesize one pointing at the single .wasm present.
      const wasmEntry = Object.keys(files).find((f) => f.endsWith(".wasm"));
      if (!wasmEntry) throw new Error("pack(wasmcart): source dir has no manifest.json and no .wasm to derive one.");
      const manifest = { name: name || path.basename(outputPath, ".wasc"), version: cartVersion(null), entry: wasmEntry };
      if (players) manifest.players = players;
      if (title !== undefined) manifest.title = title;
      files["manifest.json"] = new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2)));
    } else {
      // The dir's own manifest is kept, except its version: a committed "1.0.0" is a
      // placeholder whenever `version` or git can say better.
      let manifest;
      try {
        manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString("utf8"));
      } catch (e) {
        throw new Error(`pack(wasmcart): manifest.json in '${source}' is not valid JSON: ${e.message}`);
      }
      manifest.version = cartVersion(manifest.version ?? null);
      if (title !== undefined) manifest.title = title;
      files["manifest.json"] = new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2)));
    }
  } else if (wasm) {
    if (!existsSync(wasm)) throw new Error(`pack(wasmcart): wasm '${wasm}' not found.`);
    files = { "cart.wasm": new Uint8Array(readFileSync(wasm)) };
    const manifest = { name: name || path.basename(outputPath, ".wasc"), version: cartVersion(null), entry: "cart.wasm" };
    if (players) manifest.players = players;
    if (title !== undefined) manifest.title = title;
    if (assets) {
      if (!existsSync(assets) || !statSync(assets).isDirectory()) throw new Error(`pack(wasmcart): assets '${assets}' is not a directory.`);
      manifest.assets = "assets/";
      const assetFiles = collectDir(assets);
      for (const [rel, buf] of Object.entries(assetFiles)) files["assets/" + rel] = buf;
    }
    files["manifest.json"] = new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2)));
  } else {
    throw new Error("pack(wasmcart): provide `source` (a dir) or `wasm` (a cart .wasm).");
  }

  const zipped = zipSync(files, { level: 6, mtime: FIXED_ZIP_TIME });
  writeFileSync(outputPath, zipped);
  const out = { outputPath, entries: Object.keys(files).length, bytes: zipped.length };
  if (title !== undefined && title.length > 64) out.warning = `title is ${title.length} characters; hosts may cut it after 64`;
  return out;
}

/**
 * Pack a jsgame source dir into a .jsgame archive (a plain zip of the dir).
 * @param {object} a
 * @param {string} a.source  the game directory (must have package.json main / index.html / main.js).
 * @param {string} a.outputPath  where to write the .jsgame.
 */
export function packJsgame({ source, outputPath } = {}) {
  if (!source || !existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`pack(jsgame): source '${source}' is not a directory.`);
  }
  if (!outputPath) throw new Error("pack(jsgame): `outputPath` is required.");
  const files = collectDir(source);
  // Sanity: a jsgame needs an entry rungame can resolve.
  const hasEntry = files["package.json"] || files["index.html"] || files["main.js"] ||
    Object.keys(files).some((f) => f.endsWith("/main.js") || f === "index.js");
  if (!hasEntry) {
    throw new Error("pack(jsgame): source has no entry (package.json 'main', index.html, or main.js). rungame won't be able to run it.");
  }
  const zipped = zipSync(files, { level: 6, mtime: FIXED_ZIP_TIME });
  writeFileSync(outputPath, zipped);
  return { outputPath, entries: Object.keys(files).length, bytes: zipped.length };
}

/**
 * Register the `pack` tool - the "build" verb for the native-runtime kinds. Packs a
 * source directory into a distributable .wasc / .jsgame archive (a zip). NOT a compiler
 * (wasmcart is any-language-to-WASM; jsgame is plain JS) - it just assembles the archive.
 */
export function registerNativePackTools(server, z) {
  server.tool(
    "pack",
    "Package a native-runtime game's source into its distributable archive (the 'build' step " +
    "for wasmcart/jsgame - a ZIP, NOT a compiler). `target`:\n" +
    "• 'wasc' (wasmcart) - pass `source` (a dev dir: manifest.json + cart.wasm + assets/) OR " +
    "`wasm` (a single cart .wasm; a minimal manifest is generated, with optional `assets` dir). " +
    "Writes a .wasc whose manifest `version` is `version`, else the source's git version (clean v<semver> tag = that release, else <tag>-dev.g<commit>). NOTE: romdev does NOT compile WASM - bring your own (any language → wasm).\n" +
    "• 'jsgame' (jsgame) - pass `source` (the game dir; must have package.json 'main', index.html, " +
    "or main.js). Writes a .jsgame. Pure JS, no build needed beyond the zip.",
    {
      target: z.enum(["wasc", "jsgame"]).describe("wasc = wasmcart .wasc; jsgame = jsgame .jsgame."),
      source: z.string().optional().describe("Source directory to pack. (wasc: a dev-layout dir; jsgame: the game dir.)"),
      wasm: z.string().optional().describe("target=wasc: a single cart .wasm to wrap (a manifest is generated). Use instead of `source`."),
      assets: z.string().optional().describe("target=wasc with `wasm`: an assets directory to include under assets/."),
      outputPath: z.string().describe("Absolute path to write the archive (.wasc / .jsgame)."),
      name: z.string().optional().describe("target=wasc: manifest game name (default derived from outputPath)."),
      players: z.number().int().min(1).max(4).optional().describe("target=wasc: manifest players count."),
      title: z.string().optional().describe("target=wasc: the game's display name as people read it (manifest `title`, e.g. \"Tux Racer\"; `name` stays the short id). For a launcher list, a frontend game name and a window title; a host without it falls back to `name`. Over 64 characters packs with a warning. Replaces a source manifest's own title when given."),
      version: z.string().optional().describe("target=wasc: the cart's manifest version (semver, e.g. 1.2.0). Default: from the git checkout holding the source: the tag at a clean v<semver> tag, else <last tag>-dev.g<commit>; outside git a source manifest's version, else 0.1.0. Not semver = error."),
    },
    safeTool(async (args) => {
      if (args.target === "wasc") {
        return jsonContent(packWasc(args));
      }
      if (args.target === "jsgame") {
        return jsonContent(packJsgame(args));
      }
      throw new Error(`pack: unknown target '${args.target}'.`);
    }),
  );
}
