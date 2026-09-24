// MCP glue for frame({op:'verifyRecompile'}) and frame({op:'findDiverge', cart}).
// Loads the cart and the reference into FRESH hosts (so the frame axis always
// starts at loadMedia), runs src/host/verify-recompile.js, then installs the
// main pair into the session's slots: slot A = the cart, slot B = the
// reference, both left at the last compared frame for follow-up reads.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { LibretroHost } from "romdev-core-host/index.js";
import { resolveCore } from "../../cores/registry.js";
import { WasmcartHost } from "../../host/WasmcartHost.js";
import { verifyRecompile, findRecompileDivergence, fuzzRecompile } from "../../host/verify-recompile.js";
import { findInstructionDivergence } from "../../host/instruction-diverge.js";
import { readRecompileLayout, validateRecompileLayout, cartWasmBytes, wascFromWasm } from "../../analysis/recompile/recompile-section.js";
import { installHost, installHostB, getHost, getHostBOrNull } from "../state.js";

function resolveInputs(sessionKey, args, opName) {
  let cartPath = args.cart, refPath = args.reference;
  // Omitted paths fall back to what the session's slots already hold, so a
  // caller who loaded the pair by hand can verify it in one more call. The
  // op still reloads both: the frame axis must start at loadMedia.
  if (!cartPath || !refPath) {
    let a = null, b = null;
    try { a = getHost(sessionKey); } catch { /* no slot A */ }
    b = getHostBOrNull(sessionKey);
    const wasm = [a, b].find((h) => h?.status?.platform === "wasmcart");
    const core = [a, b].find((h) => h && h !== wasm && h.status?.mediaPath);
    cartPath ??= wasm?.status?.mediaPath;
    refPath ??= core?.status?.mediaPath;
    args.platform ??= core?.status?.platform;
  }
  if (!cartPath) throw new Error(`frame({op:'${opName}'}): pass cart:'<path to .wasc or .wasm>' (or load it with loadMedia({platform:'wasmcart'}) first)`);
  if (!refPath) throw new Error(`frame({op:'${opName}'}): pass reference:'<path to the source ROM>' (or load it into slot B with loadMedia({slot:'b'}) first)`);
  for (const p of [cartPath, refPath]) if (!existsSync(p)) throw new Error(`frame({op:'${opName}'}): no file at ${p}`);

  const cartBytes = new Uint8Array(readFileSync(cartPath));
  const section = readRecompileLayout(cartBytes);
  let layout = section ? { ...section } : { regions: {}, fields: {}, probe: {} };
  const callerParts = ["regions", "fields", "probe"].filter((k) => args[k] && Object.keys(args[k]).length);
  for (const k of callerParts) layout[k] = { ...(layout[k] ?? {}), ...args[k] };
  if (args.warmupFrames != null) layout.warmupFrames = args.warmupFrames;
  if (args.vramZero) layout.vramZero = args.vramZero;
  layout = validateRecompileLayout(layout);
  const layoutSource = section ? (callerParts.length ? "section+caller" : "section") : (callerParts.length ? "caller" : "none");

  const platform = args.platform ?? section?.reference ?? section?.platform;
  if (!platform) throw new Error(`frame({op:'${opName}'}): pass platform (the reference core's loadMedia platform, e.g. 'sms'); the cart carries no romdev.recompile section to say`);
  const resolved = resolveCore(platform);
  if (!resolved) throw new Error(`frame({op:'${opName}'}): no core for platform '${platform}'`);

  const refBytes = readFileSync(refPath);
  const refSha1 = createHash("sha1").update(refBytes).digest("hex");
  if (section?.romSha1 && section.romSha1.toLowerCase() !== refSha1) {
    throw new Error(`frame({op:'${opName}'}): the cart was built from a ROM with sha1 ${section.romSha1}, but reference ${refPath} has sha1 ${refSha1}. Comparing a cart against a different ROM measures nothing.`);
  }
  // A bare .wasm is wrapped in memory: the wasmcart host loads archives.
  const wasm = cartWasmBytes(cartBytes);
  const loadBytes = wasm === cartBytes ? wascFromWasm(cartBytes, path.basename(cartPath, ".wasm")) : cartBytes;

  const openCart = async (hooks = {}) => {
    const h = new WasmcartHost();
    await h.loadMedia({ platform: "wasmcart", bytes: loadBytes, beforeSettle: hooks.beforeSettle });
    h.status.mediaPath = path.resolve(cartPath);
    return h;
  };
  const openRef = async (hooks = {}) => {
    const h = new LibretroHost();
    await h.loadCore(resolved.jsPath, resolved.wasmPath, { hwRender: resolved.hwRender, noderawfs: resolved.noderawfs });
    await h.loadMedia({ platform, path: refPath, beforeSettle: hooks.beforeSettle });
    return h;
  };
  return { cartPath, refPath, refSha1, refBytes: new Uint8Array(refBytes), layout, layoutSource, platform, core: resolved.coreName, openCart, openRef };
}

function describeSides(ctx, cartHost, refHost) {
  return {
    cart: { path: ctx.cartPath, framebuffer: { width: cartHost.status.fbWidth, height: cartHost.status.fbHeight }, layoutSource: ctx.layoutSource, regions: Object.keys(ctx.layout.regions), abiWarnings: cartHost.status.abiWarnings?.length ? cartHost.status.abiWarnings : undefined },
    reference: { platform: ctx.platform, core: ctx.core, path: ctx.refPath, sha1: ctx.refSha1, framebuffer: { width: refHost.status.fbWidth, height: refHost.status.fbHeight } },
  };
}

/** frame({op:'verifyRecompile'}) */
export async function runVerifyRecompile(sessionKey, args) {
  const ctx = resolveInputs(sessionKey, args, "verifyRecompile");
  const frames = args.atFrames;
  if (!Array.isArray(frames) || !frames.length) throw new Error("frame({op:'verifyRecompile'}): pass atFrames:[...] - the REFERENCE frames (stepped after loadMedia) to score, e.g. [1000, 2000, 3000]. Score late frames with real pictures: a title screen proves little.");
  const tag = args.tag ?? `${path.basename(ctx.cartPath).replace(/\.(wasc|wasm)$/, "")}`;
  const outputDir = args.outputDir ?? path.join(os.tmpdir(), "romdev-verify", tag);
  const { result, cartHost, refHost } = await verifyRecompile({
    openCart: ctx.openCart, openRef: ctx.openRef, refPlatform: ctx.platform, layout: ctx.layout,
    frames, input: args.input, wrongInput: args.wrongInput, cartFrameOffset: args.cartFrameOffset,
    searchFrame: args.searchFrame, searchWindow: args.searchWindow, minSharpness: args.minSharpness,
    sweep: args.sweep, cartOrigin: args.cartOrigin, cartButtonMap: args.cartButtonMap,
    controls: args.controls, movingWindow: args.movingWindow, wrongFrameDelta: args.wrongFrameDelta, wrongFrameMaxDelta: args.wrongFrameMaxDelta,
    bar: { ...(args.minContentPct != null ? { minContentPct: args.minContentPct } : {}), ...(args.minContentPx != null ? { minContentPx: args.minContentPx } : {}),
      ...(args.minMovingPct != null ? { minMovingPct: args.minMovingPct } : {}), ...(args.minMovingPx != null ? { minMovingPx: args.minMovingPx } : {}),
      ...(args.minChangePx != null ? { minChangePx: args.minChangePx } : {}) },
    requireStateMatch: args.requireStateMatch, outputDir, tag,
    audio: args.audio, audioFrames: args.audioFrames, audioStream: args.audioStream, audioBar: args.audioBar,
    audioControls: args.audioControls, audioDropChannel: args.audioDropChannel, audioWav: args.audioWav, audioMaxLag: args.audioMaxLag,
  });
  installHost(sessionKey, cartHost);
  installHostB(sessionKey, refHost);
  return {
    ...result,
    ...describeSides(ctx, cartHost, refHost),
    outputDir,
    slots: "slot A now holds the cart and slot B the reference, both at the last scored frame (memory/wasm reads and frame({op:'step', slot}) work on them). The controls ran on separate cart instances.",
  };
}

/** frame({op:'findDiverge', cart, reference}) - the recompile mode. */
export async function runRecompileDiverge(sessionKey, args) {
  const ctx = resolveInputs(sessionKey, args, "findDiverge");
  const refHost = await ctx.openRef();
  let cartHost;
  try { cartHost = await ctx.openCart(); } catch (e) { refHost.dispose?.(); throw e; }
  let res;
  try {
    res = await findRecompileDivergence({
      cartHost, refHost, refPlatform: ctx.platform, layout: ctx.layout, input: args.input,
      cartFrameOffset: args.cartFrameOffset, startFrame: args.startFrame, maxFrames: args.maxFrames,
      openCart: ctx.openCart, openRef: ctx.openRef, searchFrame: args.searchFrame, searchWindow: args.searchWindow, minSharpness: args.minSharpness,
      stride: args.stride, cartButtonMap: args.cartButtonMap, audio: !!args.audio, audioStream: args.audioStream,
    });
  } catch (e) {
    refHost.dispose?.(); cartHost.destroy?.();
    throw e;
  }
  installHost(sessionKey, cartHost);
  installHostB(sessionKey, refHost);
  return { ...res, ...describeSides(ctx, cartHost, refHost), slots: "slot A = the cart, slot B = the reference, both stopped at the reported frame." };
}

/** frame({op:'findDiverge', cart, reference, level:'instruction'}) - the instruction-level differ. */
export async function runInstructionDiverge(sessionKey, args) {
  const ctx = resolveInputs(sessionKey, args, "findDiverge");
  const { result, cartHost, refHost } = await findInstructionDivergence({
    openCart: ctx.openCart, openRef: ctx.openRef, refPlatform: ctx.platform, layout: ctx.layout, rom: ctx.refBytes,
    input: args.input, cartFrameOffset: args.cartFrameOffset, atFrame: args.atFrame, startFrame: args.startFrame, maxFrames: args.maxFrames,
    context: args.context, refState: args.refState, cartButtonMap: args.cartButtonMap,
    searchFrame: args.searchFrame, searchWindow: args.searchWindow, minSharpness: args.minSharpness,
  });
  if (cartHost && refHost) {
    installHost(sessionKey, cartHost);
    installHostB(sessionKey, refHost);
    return { ...result, ...describeSides(ctx, cartHost, refHost), slots: "slot A = the cart, slot B = the reference, both at the end of the traced frame." };
  }
  return { ...result, cart: { path: ctx.cartPath, layoutSource: ctx.layoutSource }, reference: { platform: ctx.platform, core: ctx.core, path: ctx.refPath, sha1: ctx.refSha1 } };
}

/** frame({op:'fuzzRecompile', cart}) - seeded random play on the cart alone, first trap per seed. */
export async function runFuzzRecompile(sessionKey, args) {
  const cartPath = args.cart ?? (() => { try { const h = getHost(sessionKey); return h?.status?.platform === "wasmcart" ? h.status.mediaPath : null; } catch { return null; } })();
  if (!cartPath) throw new Error("frame({op:'fuzzRecompile'}): pass cart:'<path to .wasc or .wasm>'");
  if (!existsSync(cartPath)) throw new Error(`frame({op:'fuzzRecompile'}): no file at ${cartPath}`);
  const cartBytes = new Uint8Array(readFileSync(cartPath));
  const section = readRecompileLayout(cartBytes);
  let layout = section ? { ...section } : { regions: {}, fields: {}, probe: {} };
  if (args.probe && Object.keys(args.probe).length) layout.probe = { ...(layout.probe ?? {}), ...args.probe };
  layout = validateRecompileLayout(layout);
  const wasm = cartWasmBytes(cartBytes);
  const loadBytes = wasm === cartBytes ? wascFromWasm(cartBytes, path.basename(cartPath, ".wasm")) : cartBytes;
  const openCart = async () => { const h = new WasmcartHost(); await h.loadMedia({ platform: "wasmcart", bytes: loadBytes }); return h; };
  const r = await fuzzRecompile({ openCart, layout, frames: args.frames === 1 ? undefined : args.frames, seeds: args.seeds, input: args.input, cartButtonMap: args.cartButtonMap });
  return { ...r, cart: cartPath };
}
