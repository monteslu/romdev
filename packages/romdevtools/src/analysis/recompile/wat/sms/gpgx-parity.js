// Test support for the SMS/GG and Genesis backends: build a synthetic ROM
// into a cart with the real build path (recompileToWasmcart), load it and
// genesis_plus_gx into fresh hosts exactly as frame({op:'findDiverge'})
// does, and compare every region and field the cart's romdev.recompile
// section declares, every frame. A test that uses it fails when the cart
// and the reference core disagree, so each hardware behaviour is checked
// against the core itself rather than against a value typed into a test.
//
// Plain JS ESM + JSDoc. Not used at recompile time.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * @param {object} a
 * @param {'sms'|'gg'|'genesis'} a.platform
 * @param {Uint8Array} a.rom
 * @param {string} [a.input]        schedule in reference frames ("f:button[+button]:hold,...")
 * @param {number} [a.maxFrames]    frames compared from reference frame 0
 * @param {object} [a.options]      backend options
 * @param {Record<string, object>} [a.regions]  extra caller regions
 * @param {boolean} [a.picture]     also score the two pictures at the last frame (result.picture)
 * @param {boolean} [a.audio]       also compare every frame's audio samples (result.audio on a difference)
 * @param {Uint8Array} [a.refRom]   run the reference on this ROM instead (a must-fail control)
 * Buttons named "p2<name>" in `input` press <name> on the SECOND pad (same schedule alignment).
 * @returns {Promise<object>} findDiverge's result (diverged, atRefFrame, regions, fields, ...)
 */
export async function gpgxParity(a) {
  const { recompileToWasmcart } = await import("../build.js");
  const { readRecompileLayout, validateRecompileLayout } = await import("../../recompile-section.js");
  const { findRecompileDivergence, scorePictures, resolveOrigin } = await import("../../../../host/verify-recompile.js");
  const { WasmcartHost } = await import("../../../../host/WasmcartHost.js");
  const { LibretroHost } = await import("romdev-core-host/index.js");
  const { resolveCore } = await import("../../../../cores/registry.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-gpgx-parity-"));
  const hosts = [];
  try {
    const ext = a.platform === "genesis" ? "md" : a.platform;
    const romPath = path.join(dir, `t.${ext}`);
    writeFileSync(romPath, a.rom);
    // a.refRom (must-fail controls): the reference runs a different ROM
    const refRomPath = a.refRom ? path.join(dir, `ref.${ext}`) : romPath;
    if (a.refRom) writeFileSync(refRomPath, a.refRom);
    const cartPath = path.join(dir, "t.wasc");
    await recompileToWasmcart({ platform: a.platform, romPath, outputPath: cartPath, options: a.options ?? {}, log: () => {} });
    const cartBytes = new Uint8Array(readFileSync(cartPath));
    const section = readRecompileLayout(cartBytes);
    const layout = validateRecompileLayout({ ...section, regions: { ...section.regions, ...(a.regions ?? {}) } });
    const resolved = resolveCore(a.platform);
    const openCart = async () => {
      const h = new WasmcartHost();
      hosts.push(h);
      await h.loadMedia({ platform: "wasmcart", bytes: cartBytes });
      return h;
    };
    const openRef = async () => {
      const h = new LibretroHost();
      hosts.push(h);
      await h.loadCore(resolved.jsPath, resolved.wasmPath, { hwRender: resolved.hwRender, noderawfs: resolved.noderawfs });
      await h.loadMedia({ platform: a.platform, path: refRomPath });
      return h;
    };
    const refHost = await openRef();
    const cartHost = await openCart();
    for (const h of [refHost, cartHost]) {
      const set = h.setInput.bind(h);
      h.setInput = (inp) => {
        const p0 = {}, p1 = {};
        for (const [k, v] of Object.entries(inp?.ports?.[0] ?? {})) (k.startsWith("p2") ? p1 : p0)[k.replace(/^p2/, "")] = v;
        return set({ ...inp, ports: [p0, p1] });
      };
    }
    const r = await findRecompileDivergence({
      cartHost, refHost, refPlatform: a.platform, layout, input: a.input ?? "",
      maxFrames: a.maxFrames ?? 60, startFrame: 0, openCart, openRef, audio: a.audio,
    });
    if (a.picture) {
      const cart = cartHost.screenshotRgba(), ref = refHost.screenshotRgba();
      r.picture = scorePictures(cart, ref, resolveOrigin(cart, ref, layout.screen?.origin));
    }
    return r;
  } finally {
    for (const h of hosts) { try { h.dispose?.(); h.destroy?.(); } catch { /* best effort */ } }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A short text for assert messages: where the two sides first differ. */
export function divergenceText(r) {
  if (!r.diverged) return "no divergence";
  return `ref frame ${r.atRefFrame}: ` + [...(r.audio?.refFrame != null ? [`audio: ${r.audio.note}`] : []), ...(r.regions ?? []).map((x) => `${x.region}@${x.firstDiff?.offset} cart=${x.firstDiff?.cart} ref=${x.firstDiff?.ref} (${x.differ} bytes)`),
    ...(r.fields ?? []).map((x) => `${x.field} cart=${x.cart} ref=${x.ref}`)].join("; ");
}

/**
 * Patch 4 bytes of `rom` at `at` so its CRC32 becomes `target`: genesis_plus_gx
 * picks an SMS/GG cart's mapper, model and region from its database by CRC,
 * so a synthetic cart forged to a listed CRC exercises that database entry.
 * (CRC32 is affine in the patched bits: solve the 32x32 system over GF(2).)
 * @param {Uint8Array} rom
 * @param {number} at
 * @param {number} target
 */
export async function forgeCrc32(rom, at, target) {
  const { crc32 } = await import("node:zlib");
  const out = new Uint8Array(rom);
  out.set([0, 0, 0, 0], at);
  const base = crc32(out) >>> 0;
  const cols = [];
  for (let i = 0; i < 32; i++) {
    const t = new Uint8Array(out);
    t[at + (i >> 3)] ^= 1 << (i & 7);
    cols.push((crc32(t) >>> 0) ^ base);
  }
  // rows of the augmented system: for each output bit r, sum_i p_i * col_i[r] = want[r]
  const want = (target ^ base) >>> 0;
  const rows = [];
  for (let r = 0; r < 32; r++) {
    let m = 0;
    for (let i = 0; i < 32; i++) if ((cols[i] >>> r) & 1) m |= 1 << i;
    rows.push([m >>> 0, (want >>> r) & 1]);
  }
  const pivotOf = [];
  let row = 0;
  for (let c = 0; c < 32 && row < 32; c++) {
    const k = rows.findIndex((x, j) => j >= row && ((x[0] >>> c) & 1));
    if (k < 0) continue;
    [rows[row], rows[k]] = [rows[k], rows[row]];
    for (let j = 0; j < 32; j++) {
      if (j !== row && ((rows[j][0] >>> c) & 1)) rows[j] = [(rows[j][0] ^ rows[row][0]) >>> 0, rows[j][1] ^ rows[row][1]];
    }
    pivotOf[c] = row++;
  }
  let p = 0;
  for (let c = 0; c < 32; c++) if (pivotOf[c] !== undefined && rows[pivotOf[c]][1]) p |= 1 << c;
  for (let i = 0; i < 4; i++) out[at + i] = (p >>> (8 * i)) & 0xFF;
  if ((crc32(out) >>> 0) !== (target >>> 0)) throw new Error("forgeCrc32: no solution");
  return out;
}
