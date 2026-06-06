// Load an Emscripten-built libretro core from disk and return the Module.
//
// Cores ship as two files: `<name>_libretro.js` (Emscripten glue) and
// `<name>_libretro.wasm` (the binary). The .js is a factory.
//
// In Node we import the .js dynamically. Emscripten's Node glue locates the
// .wasm next to the .js automatically unless we pass `wasmBinary`.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { RETRO_API_VERSION } from "./retroConstants.js";

/**
 * @typedef {Object} LoadCoreArgs
 * @property {string} jsPath absolute path to the `_libretro.js` glue
 * @property {string} [wasmPath] absolute path to the `.wasm`; if omitted, Emscripten resolves next to the .js
 */

/**
 * Loads a libretro core's Emscripten module. Does NOT call _retro_init() —
 * the caller must register callbacks first, then init.
 * @param {LoadCoreArgs} args
 */
export async function loadLibretroCore(args) {
  const { jsPath, wasmPath } = args;

  const url = pathToFileURL(jsPath).href + "?t=" + Date.now();
  const ns = await import(url);
  const factory = ns.default;
  if (typeof factory !== "function") {
    throw new Error(`Core glue at ${jsPath} did not default-export an Emscripten factory`);
  }

  /** @type {Record<string, unknown>} */
  const opts = {
    noInitialRun: true,
    print: () => {},
    printErr: () => {},
  };
  if (wasmPath) {
    opts.wasmBinary = await readFile(wasmPath);
  }

  const mod = await factory(opts);

  if (typeof mod._retro_api_version !== "function") {
    throw new Error(`Core ${jsPath} missing _retro_api_version export`);
  }
  const version = mod._retro_api_version();
  if (version !== RETRO_API_VERSION) {
    throw new Error(
      `Core ${jsPath} reports retro_api_version=${version}, expected ${RETRO_API_VERSION}`,
    );
  }

  return mod;
}
