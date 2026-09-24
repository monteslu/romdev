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
 * @returns {Promise<object>} findDiverge's result (diverged, atRefFrame, regions, fields, ...)
 */
export async function gpgxParity(a) {
  const { recompileToWasmcart } = await import("../build.js");
  const { readRecompileLayout, validateRecompileLayout } = await import("../../recompile-section.js");
  const { findRecompileDivergence } = await import("../../../../host/verify-recompile.js");
  const { WasmcartHost } = await import("../../../../host/WasmcartHost.js");
  const { LibretroHost } = await import("romdev-core-host/index.js");
  const { resolveCore } = await import("../../../../cores/registry.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-gpgx-parity-"));
  const hosts = [];
  try {
    const ext = a.platform === "genesis" ? "md" : a.platform;
    const romPath = path.join(dir, `t.${ext}`);
    writeFileSync(romPath, a.rom);
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
      await h.loadMedia({ platform: a.platform, path: romPath });
      return h;
    };
    const refHost = await openRef();
    const cartHost = await openCart();
    return await findRecompileDivergence({
      cartHost, refHost, refPlatform: a.platform, layout, input: a.input ?? "",
      maxFrames: a.maxFrames ?? 60, startFrame: 0, openCart, openRef,
    });
  } finally {
    for (const h of hosts) { try { h.dispose?.(); h.destroy?.(); } catch { /* best effort */ } }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A short text for assert messages: where the two sides first differ. */
export function divergenceText(r) {
  if (!r.diverged) return "no divergence";
  return `ref frame ${r.atRefFrame}: ` + [...(r.regions ?? []).map((x) => `${x.region}@${x.firstDiff?.offset} cart=${x.firstDiff?.cart} ref=${x.firstDiff?.ref} (${x.differ} bytes)`),
    ...(r.fields ?? []).map((x) => `${x.field} cart=${x.cart} ref=${x.ref}`)].join("; ");
}
