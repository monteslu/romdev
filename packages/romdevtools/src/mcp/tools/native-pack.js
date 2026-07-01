// native-pack — the "compile" step for the native-runtime kinds (wasmcart / jsgame).
//
// These game artifacts are ZIP archives, so packing a source directory into one is the
// build verb for them (there is NO compiler here — wasmcart is language-agnostic, bring
// your own WASM; jsgame is plain JS). romdev just assembles the archive.
//
//   .wasc  (wasmcart): zip of { manifest.json, cart.wasm, assets/… }. If the source dir
//           lacks a manifest but has a single .wasm, a minimal manifest is generated.
//   .jsgame (jsgame):  zip of the game directory as-is (must contain package.json with a
//           "main", or an index.html / main.js entry — same as rungame expects).

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import { jsonContent, safeTool } from "../util.js";

/** Recursively collect files under `dir` into a { relPath: Uint8Array } map for zipSync. */
function collectDir(dir, baseDir = dir, out = {}) {
  for (const name of readdirSync(dir)) {
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
 */
export function packWasc({ source, wasm, assets, outputPath, name, players } = {}) {
  if (!outputPath) throw new Error("pack(wasmcart): `outputPath` is required.");
  let files;

  if (source) {
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      throw new Error(`pack(wasmcart): source '${source}' is not a directory.`);
    }
    files = collectDir(source);
    if (!files["manifest.json"]) {
      // No manifest in the dir — synthesize one pointing at the single .wasm present.
      const wasmEntry = Object.keys(files).find((f) => f.endsWith(".wasm"));
      if (!wasmEntry) throw new Error("pack(wasmcart): source dir has no manifest.json and no .wasm to derive one.");
      const manifest = { name: name || path.basename(outputPath, ".wasc"), version: "1.0.0", entry: wasmEntry };
      if (players) manifest.players = players;
      files["manifest.json"] = new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2)));
    }
  } else if (wasm) {
    if (!existsSync(wasm)) throw new Error(`pack(wasmcart): wasm '${wasm}' not found.`);
    files = { "cart.wasm": new Uint8Array(readFileSync(wasm)) };
    const manifest = { name: name || path.basename(outputPath, ".wasc"), version: "1.0.0", entry: "cart.wasm" };
    if (players) manifest.players = players;
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

  const zipped = zipSync(files, { level: 6 });
  writeFileSync(outputPath, zipped);
  return { outputPath, entries: Object.keys(files).length, bytes: zipped.length };
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
  const zipped = zipSync(files, { level: 6 });
  writeFileSync(outputPath, zipped);
  return { outputPath, entries: Object.keys(files).length, bytes: zipped.length };
}

/**
 * Register the `pack` tool — the "build" verb for the native-runtime kinds. Packs a
 * source directory into a distributable .wasc / .jsgame archive (a zip). NOT a compiler
 * (wasmcart is any-language-to-WASM; jsgame is plain JS) — it just assembles the archive.
 */
export function registerNativePackTools(server, z) {
  server.tool(
    "pack",
    "Package a native-runtime game's source into its distributable archive (the 'build' step " +
    "for wasmcart/jsgame — a ZIP, NOT a compiler). `target`:\n" +
    "• 'wasc' (wasmcart) — pass `source` (a dev dir: manifest.json + cart.wasm + assets/) OR " +
    "`wasm` (a single cart .wasm; a minimal manifest is generated, with optional `assets` dir). " +
    "Writes a .wasc. NOTE: romdev does NOT compile WASM — bring your own (any language → wasm).\n" +
    "• 'jsgame' (jsgame) — pass `source` (the game dir; must have package.json 'main', index.html, " +
    "or main.js). Writes a .jsgame. Pure JS, no build needed beyond the zip.",
    {
      target: z.enum(["wasc", "jsgame"]).describe("wasc = wasmcart .wasc; jsgame = jsgame .jsgame."),
      source: z.string().optional().describe("Source directory to pack. (wasc: a dev-layout dir; jsgame: the game dir.)"),
      wasm: z.string().optional().describe("target=wasc: a single cart .wasm to wrap (a manifest is generated). Use instead of `source`."),
      assets: z.string().optional().describe("target=wasc with `wasm`: an assets directory to include under assets/."),
      outputPath: z.string().describe("Absolute path to write the archive (.wasc / .jsgame)."),
      name: z.string().optional().describe("target=wasc: manifest game name (default derived from outputPath)."),
      players: z.number().int().min(1).max(4).optional().describe("target=wasc: manifest players count."),
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
