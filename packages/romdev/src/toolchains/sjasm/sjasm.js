// sjasm.js — SGDK's Z80 toolchain, as WASM: `sjasm` (Z80 assembler) + `bintos`
// (Z80 binary → m68k .s/.h embedder). Used to build SGDK's sound drivers FROM
// SOURCE: a .s80 Z80 driver → sjasm → raw Z80 binary → bintos → an m68k .s that
// embeds the blob as a byte array + a .h that declares it. SGDK's C sources
// #include that generated .h. Built by scripts/build-sjasm.sh.

import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveGlue(name) {
  // Local first (dev / pre-package). A future genesis platform package can host
  // these wasm; mirror tcc816's import.meta.resolve fallback when that lands.
  const local = path.join(__dirname, "wasm", name);
  if (existsSync(local)) return local;
  throw new Error(`sjasm WASM not found: ${name} — run scripts/build-sjasm.sh`);
}

let _sjasmFactory, _bintosFactory;
async function loadSjasm() {
  if (!_sjasmFactory) _sjasmFactory = (await import(resolveGlue("sjasm.js"))).default;
  return _sjasmFactory;
}
async function loadBintos() {
  if (!_bintosFactory) _bintosFactory = (await import(resolveGlue("bintos.js"))).default;
  return _bintosFactory;
}

/**
 * Assemble a Z80 .s80 source into a raw Z80 binary.
 * @param {Object} a
 * @param {string} a.source the .s80 text
 * @param {Record<string,string>} [a.includes] .i80/.inc includes (by basename), mounted under /inc
 * @returns {Promise<{ok:boolean, binary?:Uint8Array, log:string}>}
 */
export async function runSjasm({ source, includes = {} }) {
  const factory = await loadSjasm();
  const mod = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
  let log = "";
  mod.print = (s) => { log += s + "\n"; };
  mod.printErr = (s) => { log += s + "\n"; };
  mod.FS.writeFile("/main.s80", source);
  try { mod.FS.mkdir("/inc"); } catch { /* exists */ }
  for (const [name, content] of Object.entries(includes)) {
    mod.FS.writeFile("/inc/" + name, content);
  }
  // sjasm CLI: [flags] source dest listing
  try { mod.callMain(["-i/inc", "/main.s80", "/main.o80", "/main.lst"]); }
  catch (e) { /* emcc EXIT_RUNTIME=1 throws on exit; status is in the throw */ }
  let binary = null;
  try { binary = mod.FS.readFile("/main.o80"); } catch { /* no output */ }
  return { ok: !!binary, binary: binary || undefined, log };
}

/**
 * Convert a raw Z80 binary into an m68k `.s` (embedding the blob) + a `.h`
 * (declaring it), via bintos. `symbol` names the emitted array (bintos derives
 * it from the output base name).
 * @param {Object} a
 * @param {Uint8Array} a.binary the Z80 blob
 * @param {string} a.name output base name (e.g. "drv_pcm") → drv_pcm.s + drv_pcm.h
 * @returns {Promise<{ok:boolean, s?:string, h?:string, log:string}>}
 */
export async function runBintos({ binary, name }) {
  const factory = await loadBintos();
  const mod = await factory({ noInitialRun: true, print: () => {}, printErr: () => {} });
  let log = "";
  mod.print = (s) => { log += s + "\n"; };
  mod.printErr = (s) => { log += s + "\n"; };
  mod.FS.writeFile("/in.o80", binary);
  try { mod.callMain(["/in.o80", "/" + name]); } catch (e) { /* exit throw */ }
  let s = null, h = null;
  try { s = mod.FS.readFile("/" + name + ".s", { encoding: "utf8" }); } catch {}
  try { h = mod.FS.readFile("/" + name + ".h", { encoding: "utf8" }); } catch {}
  return { ok: !!(s && h), s: s || undefined, h: h || undefined, log };
}
