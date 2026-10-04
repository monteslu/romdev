// Whole-ROM recompile pipeline: backend.emitWat -> assemble -> pack .wasc.
//
//   recompileToWasmcart({platform, romPath, outputPath, emit, options})
//
// emit:'wasmcart' (default) streams the backend's WAT chunks straight into
// the streaming assembler (the module text never exists as one string, and
// is never written to disk), embeds the `romdev.recompile` custom section,
// validates the binary and packs it with pack({target:'wasc'})'s own
// implementation. emit:'wasm' stops before packing. emit:'wat' writes the
// text instead (small carts / debugging; a SNES or GBA module is GBs).
//
// Backend contract (see index.js): `platforms`, `describe(rom, opts)`,
// `async function* emitWat(rom, opts)` that fills `opts.stats`
// ({arms, lowered, trapped, ...}), and optionally
// `recompileSection(rom, sha1, opts)` -> {name, json}.
//
// Plain JS ESM + JSDoc.

import { readFileSync, openSync, writeSync, closeSync, statSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { backendFor, PLATFORM_BACKEND } from "./index.js";
import { assembleWat } from "./assemble.js";
import { toCustomSection, recompileSectionBytes } from "./cart-abi.js";
import { packWasc } from "../../../mcp/tools/native-pack.js";
import { cartLicence } from "../licence.js";

/**
 * @typedef {object} RecompileResult
 * @property {string} platform
 * @property {string} emit
 * @property {string} outputPath
 * @property {string} romSha1
 * @property {number} romBytes
 * @property {object} stats        backend stats (arms, lowered, trapped, ...)
 * @property {object} [describe]   backend's header-derived config
 * @property {object} [layout]     the romdev.recompile section JSON
 * @property {object} sizes        {watChars, wasmBytes, codeBytes, dataBytes, wascBytes}
 * @property {object} timings      ms per phase
 */

/**
 * @param {object} a
 * @param {string} a.platform       sms, gg, nes, gb, gbc, genesis/md, snes, gba
 * @param {string} [a.romPath]      the ROM file (or pass `rom`)
 * @param {Uint8Array} [a.rom]
 * @param {string} a.outputPath     .wasc (emit wasmcart), .wasm (emit wasm) or .wat (emit wat)
 * @param {'wasmcart'|'wasm'|'wat'} [a.emit='wasmcart']
 * @param {object} [a.options]      backend options (documented per backend)
 * @param {boolean} [a.validate=true]  WebAssembly.validate the binary before packing
 * @param {boolean} [a.keepWasm=false] emit wasmcart: also keep the bare .wasm next to the .wasc
 * @param {string} [a.name]         manifest name (default: the output file's base name)
 * @param {(msg: string) => void} [a.log]
 * @param {object} [a.backend]      a backend module to use instead of the registry's (tests)
 * @returns {Promise<RecompileResult>}
 */
export async function recompileToWasmcart(a) {
  const emit = a.emit || "wasmcart";
  if (!["wasmcart", "wasm", "wat"].includes(emit)) throw new Error(`recompile: emit must be 'wasmcart', 'wasm' or 'wat', got '${emit}'`);
  if (!a.outputPath) throw new Error("recompile: outputPath is required");
  if (!a.platform) throw new Error(`recompile: platform is required (one of ${Object.keys(PLATFORM_BACKEND).join(", ")})`);
  const outputPath = path.resolve(a.outputPath);
  const rom = a.rom ? new Uint8Array(a.rom) : new Uint8Array(readFileSync(a.romPath));
  const romSha1 = createHash("sha1").update(rom).digest("hex");
  const log = a.log || (() => {});
  const t0 = Date.now();
  const timings = {};

  const backend = a.backend || await backendFor(a.platform);
  if (Array.isArray(backend.platforms) && !backend.platforms.includes(a.platform)) {
    // Aliases (md/megadrive -> genesis) resolve to the backend's own id.
    const own = backend.platforms[0];
    if (PLATFORM_BACKEND[a.platform] !== PLATFORM_BACKEND[own]) throw new Error(`recompile: backend does not accept platform '${a.platform}'`);
  }
  const stats = {};
  const opts = { ...(a.options || {}), platform: a.platform, stats, romPath: a.romPath };
  const desc = typeof backend.describe === "function" ? await backend.describe(rom, opts) : undefined;
  if (desc && desc.supported === false) {
    throw new Error(`recompile: ${a.platform} ROM refused: ${desc.unsupportedReason || desc.refusal || "unsupported"}`);
  }
  timings.describe = Date.now() - t0;

  const chunks = backend.emitWat(rom, opts);

  if (emit === "wat") {
    const t1 = Date.now();
    const tmp = outputPath + ".tmp";
    const fd = openSync(tmp, "w");
    let chars = 0;
    try {
      for await (const c of chunks) {
        chars += c.length;
        const b = Buffer.from(c, "utf8");
        let w = 0; while (w < b.length) w += writeSync(fd, b, w, b.length - w);
      }
    } catch (e) {
      closeSync(fd); try { unlinkSync(tmp); } catch { /* gone */ }
      throw e;
    }
    closeSync(fd);
    renameSync(tmp, outputPath);
    timings.emit = Date.now() - t1;
    timings.total = Date.now() - t0;
    return summarize({ a, emit, outputPath, romSha1, rom, stats, desc, layout: undefined, sizes: { watChars: chars, watBytes: statSync(outputPath).size }, timings });
  }

  // Custom section: the backend's own, else a minimal one from describe().
  let sec;
  if (typeof backend.recompileSection === "function") sec = await backend.recompileSection(rom, romSha1, opts);
  else if (desc && desc.layout) sec = { json: { platform: a.platform, referenceCore: desc.referenceCore || backend.REFERENCE_CORE, romSha1, ...desc.layout } };
  // Every cart names the emulator code it carries and that code's licence
  // (licence.js): a recompiled cart is under the reference core's terms.
  if (sec?.json && PLATFORM_BACKEND[a.platform]) sec = { ...sec, json: { ...sec.json, licence: cartLicence(a.platform, desc, opts) } };
  const section = sec ? toCustomSection(sec) : undefined;
  const layout = section ? JSON.parse(Buffer.from(section.data).toString("utf8")) : undefined;

  // The bare module: the output itself for emit:'wasm'; for emit:'wasmcart' a
  // temp file beside the .wasc (never an existing <name>.wasm, which is only
  // written when keepWasm asks for it).
  const keptWasm = outputPath.replace(/\.wasc$/i, "") + ".wasm";
  const wasmPath = emit === "wasm" ? outputPath : a.keepWasm ? keptWasm : outputPath + ".cart.wasm";
  const tmpWasm = wasmPath + ".tmp";
  const t1 = Date.now();
  let asm;
  try {
    asm = await assembleWat(chunks, {
      outputPath: tmpWasm,
      customSections: section ? [section] : [],
      onProgress: ({ fields }) => log(`assemble: ${fields} fields`),
    });
  } catch (e) {
    try { unlinkSync(tmpWasm); } catch { /* not written */ }
    throw e;
  }
  timings.emitAndAssemble = Date.now() - t1;

  if (a.validate !== false) {
    const t2 = Date.now();
    const bin = readFileSync(tmpWasm);
    if (!WebAssembly.validate(bin)) {
      // Name the failure: compiling gives the validator's message.
      let msg = "invalid module";
      try { new WebAssembly.Module(bin); } catch (e) { msg = e.message; }
      try { unlinkSync(tmpWasm); } catch { /* gone */ }
      throw new Error(`recompile: assembled ${a.platform} module does not validate: ${msg}`);
    }
    timings.validate = Date.now() - t2;
  }
  renameSync(tmpWasm, wasmPath);
  const sizes = { watChars: asm.textChars, wasmBytes: asm.size, codeBytes: asm.codeBytes, dataBytes: asm.dataBytes, functions: asm.functions };

  if (emit === "wasmcart") {
    const t3 = Date.now();
    const name = a.name || path.basename(outputPath).replace(/\.wasc$/i, "");
    const r = packWasc({ wasm: wasmPath, outputPath, name });
    sizes.wascBytes = r.bytes;
    timings.pack = Date.now() - t3;
    if (!a.keepWasm) { try { unlinkSync(wasmPath); } catch { /* gone */ } }
    else sizes.wasmPath = wasmPath;
  }
  timings.total = Date.now() - t0;
  return summarize({ a, emit, outputPath, romSha1, rom, stats, desc, layout, sizes, timings });
}

function summarize({ a, emit, outputPath, romSha1, rom, stats, desc, layout, sizes, timings }) {
  const res = { platform: a.platform, emit, outputPath, romSha1, romBytes: rom.length, stats, sizes, timings };
  if (desc) res.describe = compactDescribe(desc);
  if (layout) res.layout = layout;
  if (stats && Number.isFinite(stats.arms) && Number.isFinite(stats.lowered)) {
    res.lowered = `${stats.lowered}/${stats.arms} arms lowered${Number.isFinite(stats.trapped) ? `, ${stats.trapped} trap` : ""}`;
  }
  return res;
}

/** Drop bulky fields (tables, byte arrays) from a describe() result for the tool response. */
function compactDescribe(d) {
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (v instanceof Uint8Array || ArrayBuffer.isView(v)) continue;
    if (Array.isArray(v) && v.length > 64) { out[k] = `[${v.length} entries]`; continue; }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const s = JSON.stringify(v);
      if (s && s.length > 4096) { out[k] = `{${Object.keys(v).length} keys}`; continue; }
    }
    out[k] = v;
  }
  return out;
}

/** Re-exported so callers building a section by hand get the same checks. */
export { recompileSectionBytes };

