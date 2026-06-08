// sjasm.js — SGDK's Z80 toolchain, as WASM: `sjasm` (Z80 assembler) + `bintos`
// (Z80 binary → m68k .s/.h embedder). Used to build SGDK's sound drivers FROM
// SOURCE: a .s80 Z80 driver → sjasm → raw Z80 binary → bintos → an m68k .s that
// embeds the blob as a byte array + a .h that declares it. SGDK's C sources
// #include that generated .h. Built by scripts/build-sjasm.sh.

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveGlue(name) {
  // sjasm + bintos ship in romdev-toolchain-m68k-gcc (the Genesis toolchain
  // package — same place as the m68k compiler they pair with). Resolve from
  // there; fall back to a local copy under src/ for dev.
  try {
    const u = import.meta.resolve("romdev-toolchain-m68k-gcc");
    const p = path.join(path.dirname(fileURLToPath(u)), "wasm", name);
    if (existsSync(p)) return p;
  } catch { /* package not resolvable — fall through to local */ }
  const local = path.join(__dirname, "wasm", name);
  if (existsSync(local)) return local;
  throw new Error(`sjasm WASM not found: ${name} — install romdev-toolchain-m68k-gcc (or run scripts/build-sjasm.sh)`);
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
