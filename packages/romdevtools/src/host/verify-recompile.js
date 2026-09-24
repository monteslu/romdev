// Recompiled-cart verification: a wasmcart built from a ROM, run against the
// reference core that ROM was built for, on ONE input schedule and ONE frame
// axis. Backs frame({op:'verifyRecompile'}) and the recompile mode of
// frame({op:'findDiverge'}).
//
// Replaces the per-platform Python verifiers that sms-wat carried (see
// internal-romdev/PLAN_wat_recompiler_in_romdev.md for the list). Everything
// they learned is kept here once:
//
//  * FRAME AXIS. loadMedia runs settle frames on a core (5) and ONE wc_render
//    on the wasmcart host, and a cart may run warm-up frames inside that first
//    wc_render. So "reference frame F" is cart frame F + offset, with
//    offset = refSettle - cartSettle - cartWarmup. The op computes it and
//    reports it; callers never do the arithmetic.
//  * INPUT. The same libretro button names go to both sides and the wasmcart
//    host translates them by POSITION, so the same physical button is pressed.
//    A press at reference frame f reaches the cart at f + offset.
//  * CROP. A core may present a crop of the raster the cart renders (fceumm
//    drops 8 lines top and bottom, the Game Gear shows 160x144 of 256x192).
//    The reference picture is located inside the cart framebuffer at an
//    explicit origin (default: centred) and only that window is scored.
//  * SCORES. exact = all pixels; content = pixels that are not the
//    reference's most common colour (a cart painting the right backdrop and
//    nothing else cannot score); moving = pixels that CHANGED in the
//    reference over the previous N frames (a static background matches in any
//    frame, so only this can fail a wrong-frame control on a still screen).
//  * CONTROLS that must fail, or the scores are not measuring the cart:
//    VRAM-zero (wipe the cart's video memory, render one frame), wrong-frame
//    (score against a reference N frames away), wrong-input (a second cart
//    run on a different schedule).

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { getCPUState } from "romdev-core-host/cpu-state.js";
import { normalizeFieldRef } from "../analysis/recompile/recompile-section.js";

// ─── input schedule ──────────────────────────────────────────────────────────

const BUTTON_RE = /^[a-z0-9]+$/;

/**
 * Normalise an input schedule. Accepts the compact string the sms-wat
 * verifiers used ("300:start:10,900:a+right:6" = frame:buttons:hold) or an
 * array of {frame, buttons, hold} where buttons is "a+right", ["a","right"]
 * or {a:true, right:true}. Frames are REFERENCE frames (frames stepped after
 * loadMedia on the reference core).
 * @param {string|Array<object>|undefined} input
 * @returns {{frame:number, buttons:string[], hold:number}[]}
 */
export function parseInputSchedule(input) {
  if (input == null || input === "") return [];
  const items = typeof input === "string"
    ? input.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
      const [f, b, h] = s.split(":");
      if (f == null || b == null || h == null) throw new Error(`input schedule item '${s}' must be frame:buttons:hold`);
      return { frame: Number(f), buttons: b, hold: Number(h) };
    })
    : input;
  if (!Array.isArray(items)) throw new Error("input schedule must be a 'frame:buttons:hold,...' string or an array of {frame, buttons, hold}");
  return items.map((it, i) => {
    const frame = Number(it.frame), hold = Number(it.hold ?? 1);
    if (!Number.isInteger(frame) || frame < 0) throw new Error(`input[${i}].frame must be a non-negative integer`);
    if (!Number.isInteger(hold) || hold < 1) throw new Error(`input[${i}].hold must be a positive integer`);
    let names = it.buttons;
    if (typeof names === "string") names = names.split("+");
    else if (names && !Array.isArray(names) && typeof names === "object") names = Object.keys(names).filter((k) => names[k]);
    if (!Array.isArray(names) || !names.length) throw new Error(`input[${i}].buttons is empty`);
    names = names.map((n) => String(n).trim().toLowerCase());
    for (const n of names) if (!BUTTON_RE.test(n)) throw new Error(`input[${i}] has an invalid button name '${n}'`);
    return { frame, buttons: names, hold };
  }).sort((a, b) => a.frame - b.frame);
}

/** Shift a schedule by `delta` frames (presses that would start before 0 are clipped). */
export function shiftSchedule(schedule, delta) {
  const out = [];
  for (const p of schedule) {
    let f = p.frame + delta, h = p.hold;
    if (f < 0) { h += f; f = 0; }
    if (h > 0) out.push({ ...p, frame: f, hold: h });
  }
  return out;
}

/** The legacy-cart remap: names swapped so a "byName" cart reads the button the core got. */
export const BY_NAME_CART_MAP = Object.freeze({ a: "b", b: "a", x: "y", y: "x" });

/**
 * Drives one host along a schedule, one step() burst per input edge. The
 * press active for frame f is applied BEFORE frame f runs, the contract both
 * host kinds share (they latch input at the start of a frame).
 */
export class ScheduleDriver {
  /**
   * @param {object} host a LibretroHost / WasmcartHost (setInput, stepFrames)
   * @param {{frame:number, buttons:string[], hold:number}[]} schedule in THIS host's frames
   * @param {Record<string,string>} [nameMap] rename buttons before they reach the host
   */
  constructor(host, schedule, nameMap = null) {
    this.host = host;
    this.schedule = schedule;
    this.nameMap = nameMap;
    this.at = 0;
    this._held = null;
  }

  _want(f) {
    const set = new Set();
    for (const p of this.schedule) if (p.frame <= f && f < p.frame + p.hold) for (const b of p.buttons) set.add(this.nameMap?.[b] ?? b);
    return [...set].sort();
  }

  _apply(names) {
    const key = names.join("+");
    if (key === this._held) return;
    const port = {};
    for (const n of names) port[n] = true;
    this.host.setInput({ ports: [port] });
    this._held = key;
  }

  /** Advance to `target` frames stepped since load. */
  async to(target) {
    while (this.at < target) {
      this._apply(this._want(this.at));
      let next = target;
      for (const p of this.schedule) for (const e of [p.frame, p.frame + p.hold]) if (this.at < e && e < next) next = e;
      const before = this.host.status?.frameCount;
      await this.host.stepFrames(next - this.at);
      const after = this.host.status?.frameCount;
      if (Number.isFinite(before) && Number.isFinite(after) && after <= before) {
        throw new Error("a comparison host did not advance (paused or stalled); the lockstep result would be invalid");
      }
      this.at = next;
    }
    this._apply(this._want(this.at));
  }
}

/**
 * The wrong-input control's schedule: keep every press that carries start or
 * select (so the game leaves its title the same way), replace the rest with a
 * deterministic pseudo-random play script over the same span. Returns [] when
 * the schedule has no input to perturb.
 * @param {{frame:number, buttons:string[], hold:number}[]} schedule
 * @param {number} endFrame
 */
export function wrongInputSchedule(schedule, endFrame, seed = 99) {
  if (!schedule.length) return [];
  const keep = schedule.filter((p) => p.buttons.some((b) => b === "start" || b === "select"));
  const play = schedule.filter((p) => !keep.includes(p));
  const from = play.length ? play[0].frame : Math.max(...keep.map((p) => p.frame + p.hold)) + 60;
  const pool = ["right", "left", "up", "down", "a", "b", "a+right", "b+left", "a+left", "b+right"];
  const out = [...keep];
  let x = seed & 0x7fffffff, f = from;
  while (f < endFrame) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    const b = pool[(x >> 8) % pool.length];
    const h = 4 + ((x >> 4) % 40);
    out.push({ frame: f, buttons: b.split("+"), hold: h });
    f += h + ((x >> 12) % 12);
  }
  return out.sort((a, b) => a.frame - b.frame);
}

// ─── pictures ────────────────────────────────────────────────────────────────

/** @param {{width:number,height:number,rgba:Uint8Array}} s */
function snap(s) { return { width: s.width, height: s.height, rgba: Uint8Array.from(s.rgba) }; }

function key(rgba, i) { return (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]; }

/**
 * Where the reference picture sits inside the cart framebuffer.
 * @returns {{x:number,y:number,source:string}}
 */
export function resolveOrigin(cart, ref, origin) {
  let o, source;
  if (origin) { o = { x: origin[0] ?? origin.x, y: origin[1] ?? origin.y }; source = "explicit"; }
  else { o = { x: Math.floor((cart.width - ref.width) / 2), y: Math.floor((cart.height - ref.height) / 2) }; source = "centred"; }
  if (o.x < 0 || o.y < 0 || o.x + ref.width > cart.width || o.y + ref.height > cart.height) {
    throw new Error(`the ${ref.width}x${ref.height} reference picture does not fit inside the ${cart.width}x${cart.height} cart framebuffer at origin (${o.x},${o.y}). `
      + "Pass cartOrigin:[x,y] (or set screen.origin in the cart's romdev.recompile section) to say where the reference raster sits; do not guess.");
  }
  return { ...o, source };
}

/**
 * Score a cart picture against a reference picture.
 * @param {{width,height,rgba}} cart
 * @param {{width,height,rgba}} ref
 * @param {{x:number,y:number}} origin reference (0,0) inside the cart
 * @param {{width,height,rgba}|null} refPrev reference N frames earlier (moving mask)
 */
export function scorePictures(cart, ref, origin, refPrev = null) {
  const counts = new Map();
  for (let i = 0; i < ref.rgba.length; i += 4) { const k = key(ref.rgba, i); counts.set(k, (counts.get(k) || 0) + 1); }
  let backdrop = 0, top = -1;
  for (const [k, n] of counts) if (n > top) { top = n; backdrop = k; }
  const usePrev = refPrev && refPrev.width === ref.width && refPrev.height === ref.height;
  let exact = 0, content = 0, contentTotal = 0, moving = 0, movingTotal = 0;
  const cartColours = new Set();
  for (let y = 0; y < ref.height; y++) {
    for (let x = 0; x < ref.width; x++) {
      const ri = (y * ref.width + x) * 4;
      const ci = ((y + origin.y) * cart.width + (x + origin.x)) * 4;
      const r = key(ref.rgba, ri), c = key(cart.rgba, ci);
      if (cartColours.size < 3) cartColours.add(c);
      const same = r === c;
      if (same) exact++;
      if (r !== backdrop) { contentTotal++; if (same) content++; }
      if (usePrev && r !== key(refPrev.rgba, ri)) { movingTotal++; if (same) moving++; }
    }
  }
  const total = ref.width * ref.height;
  const pct = (a, b) => (b ? Math.round((10000 * a) / b) / 100 : null);
  let status = "OK";
  if (counts.size < 2) status = "INCONCLUSIVE";
  else if (cartColours.size < 2) status = "BLANK";
  return {
    status,
    exactPct: pct(exact, total), exactPx: exact, totalPx: total,
    contentPct: pct(content, contentTotal), contentPx: content, contentTotal,
    movingPct: usePrev ? pct(moving, movingTotal) : null, movingPx: moving, movingTotal: usePrev ? movingTotal : null,
    mismatchedPx: total - exact,
    backdrop: "#" + backdrop.toString(16).padStart(6, "0"),
  };
}

/**
 * [cart | reference | diff] PNG. The cart pane is the scored window of the
 * cart framebuffer; the diff pane is the reference dimmed to 30% with every
 * mismatching pixel in magenta. A score says how much differs; this says where.
 */
export function writeDiffPng(file, cart, ref, origin) {
  const w = ref.width, h = ref.height, gap = 4;
  const png = new PNG({ width: w * 3 + gap * 2, height: h });
  png.data.fill(0x28);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 0xff;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ri = (y * w + x) * 4, ci = ((y + origin.y) * cart.width + (x + origin.x)) * 4;
      const put = (px, r, g, b) => { const o = (y * png.width + px) * 4; png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 0xff; };
      put(x, cart.rgba[ci], cart.rgba[ci + 1], cart.rgba[ci + 2]);
      put(w + gap + x, ref.rgba[ri], ref.rgba[ri + 1], ref.rgba[ri + 2]);
      const same = key(cart.rgba, ci) === key(ref.rgba, ri);
      if (same) put(2 * (w + gap) + x, (ref.rgba[ri] * 3 / 10) | 0, (ref.rgba[ri + 1] * 3 / 10) | 0, (ref.rgba[ri + 2] * 3 / 10) | 0);
      else put(2 * (w + gap) + x, 0xff, 0x00, 0xff);
    }
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, PNG.sync.write(png));
  return file;
}

// ─── state (regions / fields / probe) ────────────────────────────────────────

function applyTransform(bytes, transform) {
  if (!transform) return bytes;
  if (transform === "swap16") {
    const o = new Uint8Array(bytes.length);
    for (let i = 0; i + 1 < bytes.length; i += 2) { o[i] = bytes[i + 1]; o[i + 1] = bytes[i]; }
    return o;
  }
  const n = bytes.length >> 1, o = new Uint8Array(n), hi = transform === "highbyte16" ? 1 : 0;
  for (let i = 0; i < n; i++) o[i] = bytes[2 * i + hi];
  return o;
}

/** Read one region's cart bytes and reference bytes, comparable byte for byte. */
export function readRegionPair(cartHost, refHost, spec) {
  const mult = spec.transform === "lowbyte16" || spec.transform === "highbyte16" ? 2 : 1;
  const refSize = refHost.regionSize?.(spec.ref) ?? 0;
  const refOffset = spec.refOffset ?? 0;
  if (!refSize) throw new Error(`reference has no memory region '${spec.ref}' (memory({op:'regions'}) lists what this core exposes)`);
  if (refOffset + spec.length * mult > refSize) throw new Error(`reference region '${spec.ref}' is ${refSize} bytes; ${refOffset}+${spec.length * mult} is past its end`);
  if (spec.offset + spec.length > cartHost.wasmMemorySize()) throw new Error(`cart span ${spec.offset}+${spec.length} is past the end of its ${cartHost.wasmMemorySize()}-byte linear memory`);
  let cart = Uint8Array.from(cartHost.readMemory(spec.offset, spec.length));
  let ref = applyTransform(Uint8Array.from(refHost.readMemory(spec.ref, refOffset, spec.length * mult)), spec.transform);
  if (spec.mask != null) {
    cart = cart.map((b) => b & spec.mask);
    ref = ref.map((b) => b & spec.mask);
  }
  return { cart, ref };
}

/** Byte-compare every region; never throws (a region that cannot be read is reported). */
export function compareRegions(cartHost, refHost, regions) {
  const out = {};
  for (const [name, spec] of Object.entries(regions ?? {})) {
    try {
      const { cart, ref } = readRegionPair(cartHost, refHost, spec);
      let differ = 0, first = -1;
      for (let i = 0; i < cart.length; i++) if (cart[i] !== ref[i]) { differ++; if (first < 0) first = i; }
      out[name] = { bytes: cart.length, differ, ...(first >= 0 ? { firstDiff: { offset: first, cart: cart[first], ref: ref[first] } } : {}) };
    } catch (e) {
      out[name] = { error: e.message };
    }
  }
  return out;
}

function readLe(bytes, size, signed) {
  let v = 0;
  for (let i = 0; i < size; i++) v += bytes[i] * 2 ** (8 * i);
  if (signed && v >= 2 ** (8 * size - 1)) v -= 2 ** (8 * size);
  return v;
}

function readCartScalar(cartHost, f) {
  return readLe(cartHost.readMemory(f.offset, f.size ?? 4), f.size ?? 4, !!f.signed);
}

function dig(obj, dotted) {
  let v = obj;
  for (const k of dotted.split(".")) {
    if (v == null) return undefined;
    if (k in v) { v = v[k]; continue; }
    const hit = Object.keys(v).find((kk) => kk.toLowerCase() === k.toLowerCase());
    v = hit ? v[hit] : undefined;
  }
  return v;
}

/** Compare scalar fields (cart linear memory vs reference cpu state / region). */
export function compareFields(cartHost, refHost, refPlatform, fields) {
  const out = {};
  let cpu;
  for (const [name, f] of Object.entries(fields ?? {})) {
    const size = f.size ?? 4;
    const all = size === 4 ? 0xffffffff : (1 << (8 * size)) - 1;
    const mask = (f.mask ?? all) >>> 0;
    try {
      const cartV = readCartScalar(cartHost, f);
      const ref = normalizeFieldRef(name, f.ref, size);
      if (!ref) { out[name] = { cart: cartV, note: "no ref: cart-only field" }; continue; }
      let refV;
      if (ref.cpu) {
        cpu ??= getCPUState(refHost, refPlatform);
        refV = dig(cpu, ref.cpu);
        if (typeof refV !== "number") throw new Error(`cpu({op:'read'}) on ${refPlatform} has no numeric '${ref.cpu}'`);
      } else {
        refV = readLe(refHost.readMemory(ref.region, ref.offset, ref.size), ref.size, ref.signed);
      }
      const same = ((cartV & mask) >>> 0) === ((refV & mask) >>> 0);
      out[name] = { cart: cartV, ref: refV, same };
    } catch (e) {
      out[name] = { error: e.message };
    }
  }
  return out;
}

/** Cart-only probe fields (e.g. `trapped`). */
export function readProbe(cartHost, probe) {
  const out = {};
  for (const [name, f] of Object.entries(probe ?? {})) {
    try { out[name] = readCartScalar(cartHost, f); } catch (e) { out[name] = { error: e.message }; }
  }
  return out;
}

/** Regions the VRAM-zero control wipes. */
export function vramZeroRegions(layout) {
  if (layout?.vramZero?.length) return layout.vramZero;
  return Object.keys(layout?.regions ?? {}).filter((n) => /vram|chr|nametable/i.test(n));
}

// ─── alignment ───────────────────────────────────────────────────────────────

/**
 * The frame offset between the two sides: cart frame = reference frame + offset.
 */
export function resolveAlignment(cartHost, refHost, layout, explicitOffset) {
  const refSettle = refHost.status?.settleFramesUsed ?? 0;
  const cartSettle = cartHost.status?.frameCount ?? 1;
  const warmup = layout?.warmupFrames ?? 0;
  const computed = refSettle - cartSettle - warmup;
  const offset = explicitOffset ?? computed;
  return {
    offset,
    source: explicitOffset != null ? "caller" : "computed",
    computedOffset: computed,
    refSettleFrames: refSettle,
    cartSettleFrames: cartSettle,
    cartWarmupFrames: warmup,
    meaning: `reference frame F (frames stepped after loadMedia) is compared with cart frame F${offset >= 0 ? "+" : ""}${offset}; a press scheduled at reference frame f reaches the cart at f${offset >= 0 ? "+" : ""}${offset}. computed = refSettle(${refSettle}) - cartSettle(${cartSettle}) - cartWarmup(${warmup}).`,
  };
}

// ─── the verification ────────────────────────────────────────────────────────

const DEFAULT_CONTROLS = ["vramZero", "wrongFrame", "wrongInput"];

function passesBar(s, bar) {
  if (s.status !== "OK") return false;
  const contentOk = s.contentTotal >= bar.minContentPx && s.contentPct >= bar.minContentPct;
  const movingOk = s.movingTotal == null || s.movingTotal < bar.minMovingPx || s.movingPct >= bar.minMovingPct;
  return contentOk && movingOk;
}

/** A control must FAIL: any of blank, below the content bar, or below the moving bar. */
function controlFailed(s, bar) {
  if (s.status === "BLANK") return true;
  if (s.status === "INCONCLUSIVE") return false;
  if (s.movingTotal != null && s.movingTotal >= bar.minMovingPx) return s.movingPct < bar.minMovingPct;
  return !(s.contentTotal >= bar.minContentPx && s.contentPct >= bar.minContentPct);
}

function disposeHost(h) {
  try { if (typeof h?.dispose === "function") h.dispose(); else if (typeof h?.destroy === "function") h.destroy(); } catch { /* best effort */ }
}

/**
 * Run the verification.
 *
 * @param {object} a
 * @param {() => Promise<object>} a.openCart   loads a FRESH cart host (called once per run: main + controls)
 * @param {() => Promise<object>} a.openRef    loads the reference host (called once)
 * @param {string} a.refPlatform               reference platform id (for cpu-state decoding)
 * @param {object|null} a.layout               validated romdev.recompile layout (regions etc.)
 * @param {number[]} a.frames                  REFERENCE frames to score
 * @param {Array|string} [a.input]             input schedule in reference frames
 * @param {Array|string} [a.wrongInput]        explicit schedule for the wrong-input control
 * @param {number} [a.cartFrameOffset]         override the computed alignment
 * @param {number} [a.sweep]                   also score cart frames +-sweep around the aligned one
 * @param {number[]} [a.cartOrigin]            [x,y] of the reference picture inside the cart framebuffer
 * @param {Record<string,string>} [a.cartButtonMap] rename buttons for the cart side only
 * @param {string[]} [a.controls]              subset of vramZero | wrongFrame | wrongInput
 * @param {number} [a.movingWindow]            frames back for the moving-pixel mask (default 10)
 * @param {number} [a.wrongFrameDelta]         distance of the wrong-frame reference (default 30)
 * @param {object} [a.bar]                     {minContentPct, minContentPx, minMovingPct, minMovingPx}
 * @param {boolean} [a.requireStateMatch]      a region/field difference fails the verdict
 * @param {string} [a.outputDir]               where [cart|ref|diff] PNGs go (omit: none written)
 * @param {string} [a.tag]                     PNG filename prefix
 * @returns {Promise<{result: object, cartHost: object, refHost: object}>}
 */
export async function verifyRecompile(a) {
  const layout = a.layout ?? { regions: {}, fields: {}, probe: {} };
  const frames = [...new Set(a.frames)].sort((x, y) => x - y);
  if (!frames.length) throw new Error("verifyRecompile: `frames` must list at least one reference frame to score");
  if (frames[0] < 1) throw new Error("verifyRecompile: frames are reference frames stepped after loadMedia and must be >= 1");
  const schedule = parseInputSchedule(a.input);
  const sweep = a.sweep ?? 0;
  const mw = a.movingWindow ?? 10;
  const wfd = a.wrongFrameDelta ?? 30;
  const controls = a.controls ?? DEFAULT_CONTROLS;
  const bar = { minContentPct: 95, minContentPx: 2000, minMovingPct: 95, minMovingPx: 200, ...(a.bar ?? {}) };
  const nameMap = a.cartButtonMap ?? (layout.buttons === "byName" ? BY_NAME_CART_MAP : null);
  const tag = (a.tag ?? "verify").replace(/[^A-Za-z0-9_.-]/g, "_");

  const refHost = await a.openRef();
  let cartHost;
  try { cartHost = await a.openCart(); }
  catch (e) { disposeHost(refHost); throw e; }
  // Any failure past this point must not leak two live emulator heaps.
  try {

  const alignment = resolveAlignment(cartHost, refHost, layout, a.cartFrameOffset);
  const off = alignment.offset;
  const ref = new ScheduleDriver(refHost, schedule);
  const cart = new ScheduleDriver(cartHost, shiftSchedule(schedule, off), nameMap);

  const last = frames[frames.length - 1];
  const refShots = new Map();
  const want = new Set();
  for (const F of frames) {
    want.add(F);
    if (F - mw >= 0) want.add(F - mw);
    // The wrong-frame control's reference for this sample (chosen after the run).
    if (controls.includes("wrongFrame") && F - wfd >= 1) { want.add(F - wfd); if (F - wfd - mw >= 0) want.add(F - wfd - mw); }
  }
  const refFrames = [...want].sort((x, y) => x - y);
  const sampleSet = new Set(frames);

  const rows = [];
  let origin = null, trapped = null;
  const alignedCartPics = new Map();
  for (const r of refFrames) {
    await ref.to(r);
    refShots.set(r, snap(refHost.screenshotRgba()));
    if (!sampleSet.has(r)) continue;
    const F = r, refPic = refShots.get(F), prev = refShots.get(F - mw) ?? null;
    const curve = [];
    let aligned = null, alignedPic = null;
    for (let d = -sweep; d <= sweep; d++) {
      const cf = F + off + d;
      if (cf < cart.at || cf < 0) { curve.push({ d, skipped: "cart already past this frame (samples closer together than the sweep)" }); continue; }
      await cart.to(cf);
      const pic = snap(cartHost.screenshotRgba());
      origin ??= resolveOrigin(pic, refPic, a.cartOrigin ?? layout.screen?.origin);
      const s = scorePictures(pic, refPic, origin, prev);
      curve.push({ d, contentPct: s.contentPct, movingPct: s.movingPct, exactPct: s.exactPct, status: s.status });
      if (d === 0) {
        aligned = s; alignedPic = pic;
        alignedCartPics.set(F, pic);
        const row = { refFrame: F, cartFrame: cf, ...s, pass: passesBar(s, bar) };
        row.regions = compareRegions(cartHost, refHost, layout.regions);
        if (Object.keys(layout.fields ?? {}).length) row.fields = compareFields(cartHost, refHost, a.refPlatform, layout.fields);
        if (Object.keys(layout.probe ?? {}).length) {
          row.probe = readProbe(cartHost, layout.probe);
          if (typeof row.probe.trapped === "number" && row.probe.trapped) trapped ??= { refFrame: F, cartFrame: cf, probe: row.probe };
        }
        if (a.outputDir) row.png = writeDiffPng(path.join(a.outputDir, `${tag}_ref${F}_cart${cf}.png`), pic, refPic, origin);
        rows.push(row);
      }
    }
    const row = rows[rows.length - 1];
    if (row?.refFrame === F) {
      const scored = curve.filter((c) => c.contentPct != null || c.movingPct != null);
      const metric = (c) => (c.movingPct ?? c.contentPct ?? -1);
      const peak = scored.reduce((b, c) => (b == null || metric(c) > metric(b) || (metric(c) === metric(b) && c.d === 0) ? c : b), null);
      const others = scored.filter((c) => c !== peak).map(metric);
      row.sweep = sweep ? curve : undefined;
      if (sweep && peak) {
        row.peak = { d: peak.d, metric: peak.movingPct != null ? "moving" : "content", pct: metric(peak) };
        row.sharpness = others.length ? Math.round((metric(peak) - Math.max(...others)) * 100) / 100 : null;
      }
    }
  }

  // ── controls ──
  const lastRef = refShots.get(last), lastPrev = refShots.get(last - mw) ?? null;
  const ctl = {};
  if (controls.includes("wrongFrame")) {
    // The cart's aligned picture at one sample, scored against the reference
    // `wfd` frames EARLIER (with that frame's own moving mask). The sample is
    // the one whose reference moved most: on a still screen every frame
    // matches every other, so a control taken there cannot fail and proves
    // nothing (the sms-wat GBA verifier picked its control frame the same way).
    const cands = rows.filter((r) => alignedCartPics.has(r.refFrame) && refShots.has(r.refFrame - wfd));
    const pick = cands.reduce((b, r) => (b == null || (r.movingTotal ?? -1) > (b.movingTotal ?? -1) ? r : b), null);
    if (!pick || !origin) ctl.wrongFrame = { skipped: `no scored frame lies more than wrongFrameDelta (${wfd}) frames after frame 0` };
    else {
      const wf = pick.refFrame - wfd;
      ctl.wrongFrame = { refFrame: wf, cartFrame: pick.cartFrame, sampleRefFrame: pick.refFrame, ...scorePictures(alignedCartPics.get(pick.refFrame), refShots.get(wf), origin, refShots.get(wf - mw) ?? null) };
      ctl.wrongFrame.failed = controlFailed(ctl.wrongFrame, bar);
    }
  }
  if (controls.includes("vramZero")) {
    const names = vramZeroRegions(layout);
    if (!names.length) ctl.vramZero = { skipped: "no VRAM region known: list the cart's video memory in `regions` (or the section's vramZero)" };
    else {
      const h = await a.openCart();
      try {
        const d = new ScheduleDriver(h, shiftSchedule(schedule, off), nameMap);
        await d.to(last + off - 1);
        for (const n of names) {
          const r = layout.regions[n];
          h.writeMemory(r.offset, new Uint8Array(r.length));
        }
        await d.to(last + off);
        const pic = snap(h.screenshotRgba());
        ctl.vramZero = { zeroed: names, refFrame: last, cartFrame: last + off, ...scorePictures(pic, lastRef, origin, lastPrev) };
        ctl.vramZero.failed = controlFailed(ctl.vramZero, bar);
        if (a.outputDir) ctl.vramZero.png = writeDiffPng(path.join(a.outputDir, `${tag}_control_vramzero_ref${last}.png`), pic, lastRef, origin);
      } finally { disposeHost(h); }
    }
  }
  if (controls.includes("wrongInput")) {
    const alt = a.wrongInput != null ? parseInputSchedule(a.wrongInput) : wrongInputSchedule(schedule, last);
    if (!alt.length) ctl.wrongInput = { skipped: "no input schedule: this run does not exercise input, so there is nothing to perturb (pass `input`, or `wrongInput` explicitly)" };
    else {
      const h = await a.openCart();
      try {
        const d = new ScheduleDriver(h, shiftSchedule(alt, off), nameMap);
        await d.to(last + off);
        const pic = snap(h.screenshotRgba());
        ctl.wrongInput = { refFrame: last, cartFrame: last + off, presses: alt.length, ...scorePictures(pic, lastRef, origin, lastPrev) };
        ctl.wrongInput.failed = controlFailed(ctl.wrongInput, bar);
        if (a.outputDir) ctl.wrongInput.png = writeDiffPng(path.join(a.outputDir, `${tag}_control_wronginput_ref${last}.png`), pic, lastRef, origin);
      } finally { disposeHost(h); }
    }
  }

  // ── verdict ──
  const reasons = [];
  const scoredRows = rows.filter((r) => r.status === "OK" && r.contentTotal >= bar.minContentPx);
  if (!scoredRows.length) reasons.push(`no scored frame has >= ${bar.minContentPx} content pixels in the reference: nothing here is evidence (pick later frames with real pictures)`);
  for (const r of rows) {
    if (r.status === "INCONCLUSIVE") continue;
    if (!r.pass) reasons.push(`ref frame ${r.refFrame}: ${r.status !== "OK" ? r.status : `content ${r.contentPct}% (${r.contentPx}/${r.contentTotal})${r.movingTotal != null ? `, moving ${r.movingPct}% (${r.movingPx}/${r.movingTotal})` : ""}`} is below the bar`);
  }
  for (const [n, c] of Object.entries(ctl)) {
    if (c.skipped) continue;
    if (!c.failed) reasons.push(`control ${n} did NOT fail (content ${c.contentPct}%${c.movingTotal != null ? `, moving ${c.movingPct}%` : ""}): the score cannot tell this wrong picture from the right one`);
  }
  if (trapped) reasons.push(`the cart trapped (probe.trapped=${trapped.probe.trapped}) by ref frame ${trapped.refFrame}`);
  const stateDiffs = [];
  for (const r of rows) {
    for (const [n, v] of Object.entries(r.regions ?? {})) if (v.error || v.differ) stateDiffs.push(`ref frame ${r.refFrame}: region ${n} ${v.error ? `unreadable (${v.error})` : `${v.differ}/${v.bytes} bytes differ`}`);
    for (const [n, v] of Object.entries(r.fields ?? {})) if (v.error || v.same === false) stateDiffs.push(`ref frame ${r.refFrame}: field ${n} ${v.error ? `unreadable (${v.error})` : `cart ${v.cart} ref ${v.ref}`}`);
  }
  if (a.requireStateMatch && stateDiffs.length) reasons.push(`state differs: ${stateDiffs.slice(0, 6).join("; ")}${stateDiffs.length > 6 ? ` (+${stateDiffs.length - 6} more)` : ""}`);
  const verified = reasons.length === 0;
  const regionNames = Object.keys(layout.regions ?? {});
  const table = [
    `| ref frame | cart frame | exact | content (px) | moving (px) |${regionNames.map((n) => ` ${n} |`).join("")} pass |`,
    `|---|---|---|---|---|${regionNames.map(() => "---|").join("")}---|`,
    ...rows.map((r) => `| ${r.refFrame} | ${r.cartFrame} | ${r.exactPct}% | ${r.contentPct ?? "-"}% (${r.contentPx}/${r.contentTotal}) | ${r.movingTotal == null ? "-" : `${r.movingPct ?? "-"}% (${r.movingPx}/${r.movingTotal})`} |${regionNames.map((n) => ` ${r.regions?.[n]?.error ? "ERR" : `${r.regions?.[n]?.differ}/${r.regions?.[n]?.bytes}`} |`).join("")} ${r.status === "INCONCLUSIVE" ? "n/a" : r.pass ? "yes" : "NO"} |`),
  ];
  const result = {
    op: "verifyRecompile",
    verdict: verified ? "VERIFIED" : "NOT VERIFIED",
    verified,
    reasons,
    stateIdentical: stateDiffs.length === 0,
    ...(stateDiffs.length ? { stateDiffs: stateDiffs.slice(0, 24) } : {}),
    alignment,
    origin,
    bar,
    frames: rows,
    controls: ctl,
    table: table.join("\n"),
  };
  return { result, cartHost, refHost };
  } catch (e) {
    disposeHost(cartHost);
    disposeHost(refHost);
    throw e;
  }
}

// ─── per-frame state divergence ──────────────────────────────────────────────

/**
 * Step the cart and the reference in lockstep on the shared frame axis and
 * report the FIRST frame at which any layout region or field differs (the
 * replacement for the native trace differs: native mGBA with a trace hook,
 * the gpgx Musashi struct differ, fceumm register + cycle-count compares).
 *
 * @param {object} a
 * @param {object} a.cartHost    freshly loaded
 * @param {object} a.refHost     freshly loaded
 * @param {string} a.refPlatform
 * @param {object} a.layout      regions + fields to compare
 * @param {Array|string} [a.input]
 * @param {number} [a.cartFrameOffset]
 * @param {number} [a.startFrame]  first reference frame compared (earlier frames are run, not compared)
 * @param {number} [a.maxFrames]   frames compared at most
 * @param {number} [a.stride]      compare every Nth frame
 * @param {Record<string,string>} [a.cartButtonMap]
 */
export async function findRecompileDivergence(a) {
  const layout = a.layout ?? {};
  const regions = layout.regions ?? {}, fields = layout.fields ?? {};
  if (!Object.keys(regions).length && !Object.keys(fields).length) {
    throw new Error("findDiverge (recompile): nothing to compare - the cart has no romdev.recompile section and no `regions`/`fields` were passed");
  }
  const schedule = parseInputSchedule(a.input);
  const nameMap = a.cartButtonMap ?? (layout.buttons === "byName" ? BY_NAME_CART_MAP : null);
  const alignment = resolveAlignment(a.cartHost, a.refHost, layout, a.cartFrameOffset);
  const off = alignment.offset;
  const ref = new ScheduleDriver(a.refHost, schedule);
  const cart = new ScheduleDriver(a.cartHost, shiftSchedule(schedule, off), nameMap);
  const start = Math.max(a.startFrame ?? 0, off < 0 ? -off : 0);
  const stride = a.stride ?? 1, maxFrames = a.maxFrames ?? 600;
  let lastSame = null, compared = 0, changed = 0, prevSig = null;
  for (let F = start, n = 0; n < maxFrames; F += stride, n++) {
    await ref.to(F);
    await cart.to(F + off);
    const reg = compareRegions(a.cartHost, a.refHost, regions);
    const fld = compareFields(a.cartHost, a.refHost, a.refPlatform, fields);
    compared++;
    const unreadable = [...Object.entries(reg), ...Object.entries(fld)].filter(([, v]) => v.error);
    if (unreadable.length) throw new Error(`cannot compare ${unreadable.map(([k, v]) => `${k} (${v.error})`).join("; ")}`);
    const badRegions = Object.entries(reg).filter(([, v]) => v.differ).map(([k, v]) => ({ region: k, ...v }));
    const badFields = Object.entries(fld).filter(([, v]) => v.same === false).map(([k, v]) => ({ field: k, ...v }));
    const sig = JSON.stringify(Object.values(fld).map((v) => v.ref)) + Object.keys(regions).map((k) => {
      const { ref: rb } = readRegionPair(a.cartHost, a.refHost, regions[k]);
      let h = 2166136261;
      for (let i = 0; i < rb.length; i++) h = Math.imul(h ^ rb[i], 16777619);
      return h;
    }).join(",");
    if (prevSig != null && sig !== prevSig) changed++;
    prevSig = sig;
    if (badRegions.length || badFields.length) {
      return {
        op: "findDiverge", mode: "recompile", diverged: true,
        atRefFrame: F, atCartFrame: F + off, lastIdenticalRefFrame: lastSame,
        regions: badRegions, fields: badFields,
        framesCompared: compared, stride, alignment,
        note: lastSame == null
          ? `The two sides already differ at the FIRST compared frame (${F}). Either the alignment is wrong (check alignment.meaning, or pass cartFrameOffset) or the cart diverges during boot: rerun with startFrame:0 and stride:1.`
          : `Identical through reference frame ${lastSame}, different at ${F}${stride > 1 ? ` (stride ${stride}: rerun with startFrame:${lastSame}, stride:1 for the exact frame)` : ""}. The first differing field/byte is where to start: breakpoint({on:'write'}) on the reference for that address, and the cart's own trace for the same frame.`,
      };
    }
    lastSame = F;
  }
  return {
    op: "findDiverge", mode: "recompile", diverged: false,
    framesCompared: compared, stride, firstRefFrame: start, lastRefFrame: lastSame, alignment,
    stateChangedOnFrames: changed,
    conclusion: changed > 0 ? "no-observed-divergence" : "inconclusive-no-observed-state-change",
    note: changed > 0
      ? "Every compared region and field matched at every compared frame, and the state changed along the way. This is evidence for these regions at these frames, not proof of whole-program equivalence."
      : "The compared state never changed, so matching says nothing about execution (an idle or spin loop matches trivially). Compare later frames, or add regions that the game writes every frame.",
  };
}
