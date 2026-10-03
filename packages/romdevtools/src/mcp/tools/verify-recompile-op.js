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
import { resolveCore, coresFor, ALT_CORES } from "../../cores/registry.js";
import { WasmcartHost } from "../../host/WasmcartHost.js";
import { verifyRecompile, findRecompileDivergence, fuzzRecompile, parseInputSchedule } from "../../host/verify-recompile.js";
import { autoPlan, AUTO_DEFAULTS } from "../../host/auto-verify.js";
import { findInstructionDivergence } from "../../host/instruction-diverge.js";
import { readRecompileLayout, validateRecompileLayout, cartWasmBytes, wascFromWasm } from "../../analysis/recompile/recompile-section.js";
import { isS32, readS32RecompileLayout } from "../../analysis/recompile/native/s32-cart.js";
import { S32CartHost } from "../../host/S32CartHost.js";
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
  // A natively recompiled sync32 cart carries its layout in the image
  // (s32-cart.js) and runs on the sync32 core; everything below is shared.
  const native = isS32(cartBytes);
  const section = native ? readS32RecompileLayout(cartBytes) : readRecompileLayout(cartBytes);
  if (native && !section) throw new Error(`frame({op:'${opName}'}): ${cartPath} is a sync32 cart without a recompile descriptor (build it with disasm({target:'recompile', emit:'sync32'}))`);
  let layout = section ? { ...section } : { regions: {}, fields: {}, probe: {} };
  const callerParts = ["regions", "fields", "probe"].filter((k) => args[k] && Object.keys(args[k]).length);
  for (const k of callerParts) layout[k] = { ...(layout[k] ?? {}), ...args[k] };
  if (args.warmupFrames != null) layout.warmupFrames = args.warmupFrames;
  if (args.vramZero) layout.vramZero = args.vramZero;
  layout = validateRecompileLayout(layout);
  const layoutSource = section ? (callerParts.length ? "section+caller" : "section") : (callerParts.length ? "caller" : "none");

  const platform = args.platform ?? section?.reference ?? section?.platform;
  if (!platform) throw new Error(`frame({op:'${opName}'}): pass platform (the reference core's loadMedia platform, e.g. 'sms'); the cart carries no romdev.recompile section to say`);
  // referenceCore: a second core of the platform as the reference (ALT_CORES,
  // e.g. bsnes for an SNES cart); the platform's own core by default
  const named = section?.referenceCore && ALT_CORES[platform]?.[section.referenceCore] ? section.referenceCore : null;
  const referenceCore = args.referenceCore ?? named;
  if (referenceCore && !coresFor(platform).includes(referenceCore)) {
    throw new Error(`frame({op:'${opName}'}): referenceCore '${referenceCore}' is not a ${platform} core (${coresFor(platform).join(", ") || "none"})`);
  }
  const resolved = resolveCore(platform, referenceCore ?? undefined);
  if (!resolved) throw new Error(`frame({op:'${opName}'}): no ${referenceCore ? referenceCore + " " : ""}core for platform '${platform}'`);

  // A coprocessor firmware the cart was built with (section firmware): the
  // reference core finds the same file in its system directory.
  let firmware = null;
  if (layout.firmware) {
    const want = layout.firmware;
    const tries = args.firmware ? [args.firmware] : [path.join(path.dirname(refPath), want.name), path.join(path.dirname(refPath), "firmware", want.name)];
    const src = tries.find((p) => existsSync(p));
    if (!src) throw new Error(`frame({op:'${opName}'}): the cart was built with the ${want.chip ?? "coprocessor"} firmware ${want.name}, and the reference needs it too: no file at ${tries.join(" or ")} (pass firmware:'<path>')`);
    const bytes = new Uint8Array(readFileSync(src));
    const sha = createHash("sha1").update(bytes).digest("hex");
    if (sha !== want.sha1) throw new Error(`frame({op:'${opName}'}): ${src} has sha1 ${sha}, but the cart was built with firmware of sha1 ${want.sha1}`);
    firmware = { name: want.name, bytes, path: src };
  }
  const refBytes = readFileSync(refPath);
  const refSha1 = createHash("sha1").update(refBytes).digest("hex");
  if (section?.romSha1 && section.romSha1.toLowerCase() !== refSha1) {
    throw new Error(`frame({op:'${opName}'}): the cart was built from a ROM with sha1 ${section.romSha1}, but reference ${refPath} has sha1 ${refSha1}. Comparing a cart against a different ROM measures nothing.`);
  }
  // A bare .wasm is wrapped in memory: the wasmcart host loads archives.
  const wasm = native ? null : cartWasmBytes(cartBytes);
  const loadBytes = native ? null : wasm === cartBytes ? wascFromWasm(cartBytes, path.basename(cartPath, ".wasm")) : cartBytes;

  const openCart = async (hooks = {}) => {
    if (native) {
      const h = new S32CartHost();
      await h.loadMedia({ path: path.resolve(cartPath), beforeSettle: hooks.beforeSettle });
      h.inner.status.mediaPath = path.resolve(cartPath);
      return h;
    }
    const h = new WasmcartHost();
    await h.loadMedia({ platform: "wasmcart", bytes: loadBytes, beforeSettle: hooks.beforeSettle });
    h.status.mediaPath = path.resolve(cartPath);
    return h;
  };
  const openRef = async (hooks = {}) => {
    const h = new LibretroHost();
    await h.loadCore(resolved.jsPath, resolved.wasmPath, { hwRender: resolved.hwRender, noderawfs: resolved.noderawfs });
    if (firmware) {
      const fs = h.mod?.FS;
      if (!fs) throw new Error(`frame({op:'${opName}'}): the cart needs firmware (${firmware.name}) but the ${resolved.coreName} core has no file system to put it in`);
      const dir = h.state.systemDir;
      fs.mkdirTree(dir);
      fs.writeFile(path.join(dir, firmware.name), firmware.bytes);
    }
    // A cart with a real-time clock reads the wasmcart host's frame clock
    // (frame N of the cart at (N - 1) * stepMs); the reference's wall clock
    // is pinned to the same frames: its settle runs see baseMs, and run
    // settle + k sees baseMs + k * stepMs.
    if (layout.clock) h.setPinnedClock({ baseMs: layout.clock.baseMs, stepMs: layout.clock.stepMs, startRun: () => h.status.settleFramesUsed ?? Infinity });
    // Files the core opens beside its ROM (an SNES MSU-1 pack, a Sufami
    // Turbo or BS-X BIOS): loadMedia puts the ROM at /rom<ext> in the core's
    // file system, so <stem><suffix> next to the reference ROM goes to
    // /rom<suffix>, and a "/<name>" entry is <name> from the ROM's directory.
    if (layout.companionFiles?.length) {
      const fs = h.mod?.FS;
      if (!fs) throw new Error(`frame({op:'${opName}'}): the cart needs companion files (${layout.companionFiles.join(", ")}) but the ${resolved.coreName} core has no file system to put them in`);
      const stem = refPath.replace(/\.[^./\\]*$/, "");
      for (const f of layout.companionFiles) {
        const [src, dst] = f.startsWith("/") ? [path.join(path.dirname(refPath), f.slice(1)), f] : [stem + f, "/rom" + f];
        if (!existsSync(src)) throw new Error(`frame({op:'${opName}'}): the cart was built with ${path.basename(src)} beside its ROM, and the reference needs it too: no file at ${src}`);
        fs.writeFile(dst, new Uint8Array(readFileSync(src)));
      }
    }
    // A cart built with a battery save (section saveRam) or a battery clock's
    // registers (saveRtc) powers on with them; the reference gets the same
    // bytes in save_ram / rtc before its first frame, as a frontend restores
    // the .srm / .rtc after retro_load_game.
    let beforeSettle = hooks.beforeSettle;
    for (const [key, region, what] of [["saveRam", "save_ram", "battery save"], ["saveRtc", "rtc", "clock registers"]]) {
      const want = layout[key];
      if (!want) continue;
      const src = path.join(path.dirname(refPath), want.name);
      if (!existsSync(src)) throw new Error(`frame({op:'${opName}'}): the cart was built with the ${what} ${want.name}, and the reference needs it too: no file at ${src}`);
      const bytes = new Uint8Array(readFileSync(src));
      const sha = createHash("sha1").update(bytes).digest("hex");
      if (sha !== want.sha1) throw new Error(`frame({op:'${opName}'}): ${src} has sha1 ${sha}, but the cart was built with ${what} of sha1 ${want.sha1}`);
      const inner = beforeSettle;
      beforeSettle = (host) => {
        if (host.regionSize(region) < bytes.length) throw new Error(`frame({op:'${opName}'}): the reference's ${region} is ${host.regionSize(region)} bytes, smaller than the cart's ${bytes.length}-byte ${what}`);
        host.writeMemory(region, 0, bytes);
        inner?.(host);
      };
    }
    await h.loadMedia({ platform, path: refPath, beforeSettle });
    return h;
  };
  return { cartPath, refPath, refSha1, refBytes: new Uint8Array(refBytes), layout, layoutSource, platform, core: resolved.coreName, referenceCore, firmware: firmware ? { name: firmware.name, path: firmware.path } : null, openCart, openRef };
}

/**
 * A second core of the platform (referenceCore) may not have every region
 * the cart's section names for its own core (bsnes has no save_ram on a
 * board without one, where snes9x always allocates SRAM). Those regions are
 * left out of the comparison and listed in the result, never silently: a
 * region the reference does have is compared exactly as always.
 */
async function dropRegionsNotOnReference(ctx) {
  if (!ctx.referenceCore) return [];
  const probe = await ctx.openRef();
  const missing = [];
  try {
    for (const key of ["regions", "diagnosticRegions"]) {
      const regs = ctx.layout[key];
      if (!regs) continue;
      for (const [name, spec] of Object.entries(regs)) {
        if (!(probe.regionSize?.(spec.ref) > 0)) { missing.push({ region: name, ref: spec.ref, compared: key === "regions" }); delete regs[name]; }
      }
    }
  } finally { probe.dispose?.(); }
  return missing;
}

function describeSides(ctx, cartHost, refHost) {
  return {
    cart: { path: ctx.cartPath, framebuffer: { width: cartHost.status.fbWidth, height: cartHost.status.fbHeight }, layoutSource: ctx.layoutSource, regions: Object.keys(ctx.layout.regions), abiWarnings: cartHost.status.abiWarnings?.length ? cartHost.status.abiWarnings : undefined },
    reference: { platform: ctx.platform, core: ctx.core, path: ctx.refPath, sha1: ctx.refSha1, ...(ctx.firmware ? { firmware: ctx.firmware } : {}), framebuffer: { width: refHost.status.fbWidth, height: refHost.status.fbHeight } },
  };
}

/** The caller's bar overrides, as verifyRecompile takes them. */
function barOf(args) {
  return { ...(args.minContentPct != null ? { minContentPct: args.minContentPct } : {}), ...(args.minContentPx != null ? { minContentPx: args.minContentPx } : {}),
    ...(args.minMovingPct != null ? { minMovingPct: args.minMovingPct } : {}), ...(args.minMovingPx != null ? { minMovingPx: args.minMovingPx } : {}),
    ...(args.minChangePx != null ? { minChangePx: args.minChangePx } : {}) };
}

/** Auto mode: auto:true / auto:{...}, or atFrames omitted (and auto not false). */
function autoOptions(args) {
  if (args.auto === false) return null;
  if (args.auto === true) return {};
  if (args.auto && typeof args.auto === "object") return { ...args.auto };
  return Array.isArray(args.atFrames) && args.atFrames.length ? null : {};
}

/** frame({op:'verifyRecompile'}) */
export async function runVerifyRecompile(sessionKey, args) {
  const ctx = resolveInputs(sessionKey, args, "verifyRecompile");
  const auto = autoOptions(args);
  let frames = args.atFrames, input = args.input, audio = args.audio, audioFrames = args.audioFrames, plan = null;
  if (!auto && (!Array.isArray(frames) || !frames.length)) throw new Error("frame({op:'verifyRecompile'}): pass atFrames:[...] - the REFERENCE frames (stepped after loadMedia) to score, e.g. [1000, 2000, 3000] - or auto:true to let romdev choose the input and frames from the reference. Score late frames with real pictures: a title screen proves little.");
  if (auto) {
    if (Array.isArray(frames) && frames.length) throw new Error("frame({op:'verifyRecompile', auto}): auto mode chooses atFrames itself; drop atFrames (pass input to fix the schedule and let auto choose only the frames), or drop auto to score your own frames");
    for (const k of Object.keys(auto)) if (!(k in AUTO_DEFAULTS)) throw new Error(`frame({op:'verifyRecompile', auto}): unknown auto option '${k}' (known: ${Object.keys(AUTO_DEFAULTS).join(", ")})`);
    plan = await autoPlan({ openRef: ctx.openRef, bar: barOf(args), movingWindow: args.movingWindow, fixedSchedule: input != null ? parseInputSchedule(input) : null, ...auto });
    if (!plan.ok) {
      return {
        op: "verifyRecompile", verdict: "INCONCLUSIVE", verified: false, reasons: [plan.reason], auto: plan.report,
        cart: { path: ctx.cartPath, layoutSource: ctx.layoutSource }, reference: { platform: ctx.platform, core: ctx.core, path: ctx.refPath, sha1: ctx.refSha1 },
        note: "auto mode found nothing the verifier could score as evidence, so the cart was not run: INCONCLUSIVE is not a failure of the cart and never a pass.",
      };
    }
    frames = plan.atFrames;
    input = plan.input;
    // Sound where the reference makes it is part of the verdict; a silent
    // reference is reported and leaves audio out (audio:false opts out, an
    // explicit audio / audioFrames is kept).
    if (audio === undefined) audio = plan.audioFrames ? "required" : undefined;
    if (audio && !audioFrames && plan.audioFrames) audioFrames = plan.audioFrames;
  }
  const notOnReference = await dropRegionsNotOnReference(ctx);
  const tag = args.tag ?? `${path.basename(ctx.cartPath).replace(/\.(wasc|wasm)$/, "")}`;
  const outputDir = args.outputDir ?? path.join(os.tmpdir(), "romdev-verify", tag);
  const { result, cartHost, refHost } = await verifyRecompile({
    openCart: ctx.openCart, openRef: ctx.openRef, refPlatform: ctx.platform, layout: ctx.layout,
    frames, input, wrongInput: args.wrongInput, cartFrameOffset: args.cartFrameOffset,
    searchFrame: args.searchFrame, searchWindow: args.searchWindow, minSharpness: args.minSharpness,
    sweep: args.sweep, cartOrigin: args.cartOrigin, cartButtonMap: args.cartButtonMap,
    controls: args.controls, movingWindow: args.movingWindow, wrongFrameDelta: args.wrongFrameDelta, wrongFrameMaxDelta: args.wrongFrameMaxDelta,
    bar: barOf(args),
    requireStateMatch: args.requireStateMatch, outputDir, tag,
    audio, audioFrames, audioStream: args.audioStream, audioBar: args.audioBar,
    audioControls: args.audioControls, audioDropChannel: args.audioDropChannel, audioWav: args.audioWav, audioMaxLag: args.audioMaxLag,
  });
  installHost(sessionKey, cartHost);
  installHostB(sessionKey, refHost);
  if (plan) {
    const reproduce = { op: "verifyRecompile", cart: ctx.cartPath, reference: ctx.refPath, input: input || undefined, atFrames: frames,
      ...(audio ? { audio, audioFrames } : {}) };
    result.auto = { ...plan.report, input: input || "", atFrames: frames, ...(audio ? { audio, audioFrames } : {}), reproduce,
      note: "romdev chose the input and frames from the REFERENCE core alone (the cart could not influence them); reproduce re-runs exactly this verification by hand." };
  }
  return {
    ...result,
    ...describeSides(ctx, cartHost, refHost),
    ...(notOnReference.length ? { notOnReference, notOnReferenceNote: `the ${ctx.core} reference has no such memory region, so these were not compared` } : {}),
    outputDir,
    slots: "slot A now holds the cart and slot B the reference, both at the last scored frame (memory/wasm reads and frame({op:'step', slot}) work on them). The controls ran on separate cart instances.",
  };
}

/** frame({op:'findDiverge', cart, reference}) - the recompile mode. */
export async function runRecompileDiverge(sessionKey, args) {
  const ctx = resolveInputs(sessionKey, args, "findDiverge");
  const notOnReference = await dropRegionsNotOnReference(ctx);
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
  return { ...res, ...describeSides(ctx, cartHost, refHost), ...(notOnReference.length ? { notOnReference } : {}), slots: "slot A = the cart, slot B = the reference, both stopped at the reported frame." };
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
