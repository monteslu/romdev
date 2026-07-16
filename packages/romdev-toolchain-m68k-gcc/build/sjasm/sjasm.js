// sjasm.js — SGDK's Z80 toolchain, as WASM: `sjasm` (Z80 assembler) + `bintos`
// (Z80 binary → m68k .s/.h embedder). Used to build SGDK's sound drivers FROM
// SOURCE: a .s80 Z80 driver → sjasm → raw Z80 binary → bintos → an m68k .s that
// embeds the blob as a byte array + a .h that declares it. SGDK's C sources
// #include that generated .h. Built by scripts/build-sjasm.sh.
//
// 0.95.0 env injection: `makeZ80Tools(env)` lets a host supply
// `env.loadGlue(file)` → the emscripten module FACTORY for that glue file
// (a browser Web Worker imports the staged glue asset itself). The default
// resolves from this npm package lazily — NO top-level node imports, so a
// browser bundle can load this module untouched.

/** Default: resolve sjasm/bintos glue from the npm package (node). Lazy. */
function defaultLoadGlue() {
  let resolveGlue = null;
  return async (file) => {
    if (!resolveGlue) {
      const { makeGlueResolver } = await import("../common/wasm-tool.js");
      resolveGlue = makeGlueResolver({
        pkg: "romdev-toolchain-m68k-gcc",
        localDir: new URL(".", import.meta.url).href,
        label: "sjasm",
      });
    }
    return (await import(resolveGlue(file))).default;
  };
}

/**
 * Build the two Z80 tool runners, optionally over an injected environment.
 * @param {{loadGlue?: (file:string) => Promise<Function>}} [env]
 */
export function makeZ80Tools(env) {
  const loadGlue = env?.loadGlue ?? defaultLoadGlue();
  let _sjasmFactory, _bintosFactory;

  /**
   * Assemble a Z80 .s80 source into a raw Z80 binary.
   * @param {Object} a
   * @param {string} a.source the .s80 text
   * @param {Record<string,string>} [a.includes] .i80/.inc includes (by basename), mounted under /inc
   * @returns {Promise<{ok:boolean, binary?:Uint8Array, log:string}>}
   */
  async function runSjasm({ source, includes = {} }) {
    if (!_sjasmFactory) _sjasmFactory = await loadGlue("sjasm.js");
    const mod = await _sjasmFactory({ noInitialRun: true, print: () => {}, printErr: () => {} });
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
  async function runBintos({ binary, name }) {
    if (!_bintosFactory) _bintosFactory = await loadGlue("bintos.js");
    const mod = await _bintosFactory({ noInitialRun: true, print: () => {}, printErr: () => {} });
    let log = "";
    mod.print = (s) => { log += s + "\n"; };
    mod.printErr = (s) => { log += s + "\n"; };
    mod.FS.writeFile("/in.o80", binary);
    try { mod.callMain(["/in.o80", "/" + name]); } catch (e) { /* exit throw */ }
    let s = null, h = null;
    try { s = mod.FS.readFile("/" + name + ".s", { encoding: "utf8" }); } catch { /* no .s */ }
    try { h = mod.FS.readFile("/" + name + ".h", { encoding: "utf8" }); } catch { /* no .h */ }
    return { ok: !!(s && h), s: s || undefined, h: h || undefined, log };
  }

  return { runSjasm, runBintos };
}

const defaultTools = makeZ80Tools();
export const runSjasm = defaultTools.runSjasm;
export const runBintos = defaultTools.runBintos;
