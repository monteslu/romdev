// Recompiled-cart verification: a wasmcart built from a ROM, run against the
// reference core that ROM was built for, on ONE input schedule and ONE frame
// axis. Backs frame({op:'verifyRecompile'}) and the recompile mode of
// frame({op:'findDiverge'}).
//
// Replaces the per-platform Python verifiers of the earlier Python
// recompiler. Everything they learned is kept here once:
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
import { AudioCapture, scoreAudio, syntheticAudioControls, writeAudioWavs, audioChunkHash } from "./audio-verify.js";
import { AUDIO_REFERENCE } from "../analysis/recompile/wat/cart-abi.js";

// ─── input schedule ──────────────────────────────────────────────────────────

// A button name, optionally addressed to another controller: "p2.a" is
// player 2's a (host port 1), "p1.a" is the same as "a". Ports 1-4.
const BUTTON_RE = /^(?:p[1-4]\.)?[a-z0-9]+$/;

/** Split "p2.up" into [1, "up"] (port index, button); a bare name is port 0. */
export function splitPortButton(name) {
  const m = /^p([1-4])\.(.+)$/.exec(name);
  return m ? [Number(m[1]) - 1, m[2]] : [0, name];
}

/**
 * Normalise an input schedule. Accepts the compact string the earlier
 * verifiers used ("300:start:10,900:a+right:6" = frame:buttons:hold) or an
 * array of {frame, buttons, hold} where buttons is "a+right", ["a","right"]
 * or {a:true, right:true}. Frames are REFERENCE frames (frames stepped after
 * loadMedia on the reference core). A name prefixed "p2." (p1-p4) presses
 * that controller's button ("0:p2.start:10" is player 2's start).
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
    /** @type {Array<(frame:number) => void>|null} called after each frame with the frames stepped since load */
    this.onFrame = null;
  }

  /** Observe every frame from now on (the driver then steps one frame at a time). */
  observe(fn) {
    (this.onFrame ??= []).push(fn);
    return this;
  }

  _want(f) {
    const set = new Set();
    for (const p of this.schedule) {
      if (!(p.frame <= f && f < p.frame + p.hold)) continue;
      for (const n of p.buttons) {
        const [port, b] = splitPortButton(n);
        const m = this.nameMap?.[b] ?? b;
        set.add(port ? `p${port + 1}.${m}` : m);
      }
    }
    return [...set].sort();
  }

  _apply(names) {
    const key = names.join("+");
    if (key === this._held) return;
    const ports = [{}];
    for (const n of names) {
      const [p, b] = splitPortButton(n);
      while (ports.length <= p) ports.push({});
      ports[p][b] = true;
    }
    this.host.setInput({ ports });
    this._held = key;
  }

  /** Advance to `target` frames stepped since load. */
  async to(target) {
    while (this.at < target) {
      this._apply(this._want(this.at));
      let next = target;
      for (const p of this.schedule) for (const e of [p.frame, p.frame + p.hold]) if (this.at < e && e < next) next = e;
      const before = this.host.status?.frameCount;
      if (this.onFrame) {
        // Per-frame observers (audio capture) need every frame's output on
        // its own, so the burst is stepped one frame at a time.
        for (let f = this.at; f < next; f++) {
          await this.host.stepFrames(1);
          for (const fn of this.onFrame) fn(f + 1);
        }
      } else {
        await this.host.stepFrames(next - this.at);
      }
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
  return [...keep, ...seededPlay(from, endFrame, seed)].sort((a, b) => a.frame - b.frame);
}

/** The play pool of the seeded scripts (wrong-input control, fuzzRecompile, auto mode). */
export const PLAY_POOL = Object.freeze(["right", "left", "up", "down", "a", "b", "a+right", "b+left", "a+left", "b+right"]);

/**
 * A deterministic pseudo-random play script over [from, endFrame): presses
 * drawn from `pool`, held 4..43 frames, 0..11 released frames between them
 * (the LCG the earlier play scripts used, so the same seed gives the same
 * script everywhere it is used).
 * @returns {{frame:number, buttons:string[], hold:number}[]}
 */
export function seededPlay(from, endFrame, seed, pool = PLAY_POOL) {
  const out = [];
  let x = seed & 0x7fffffff, f = from;
  while (f < endFrame) {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    const b = pool[(x >> 8) % pool.length];
    const h = 4 + ((x >> 4) % 40);
    out.push({ frame: f, buttons: b.split("+"), hold: h });
    f += h + ((x >> 12) % 12);
  }
  return out;
}

// ─── pictures ────────────────────────────────────────────────────────────────

/** @param {{width:number,height:number,rgba:Uint8Array}} s */
export function snap(s) { return { width: s.width, height: s.height, rgba: Uint8Array.from(s.rgba) }; }

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
 * The wrong-frame control's pixel signal: only the pixels where the RIGHT
 * reference frame and the WRONG one differ can tell the two apart, so the
 * cart is scored there alone. A cart that tracks the right frame matches the
 * wrong one on few of them; a still screen has none (changedPx 0) and cannot
 * fail this way, which is reported, not passed.
 */
export function scoreChangeRegion(cart, refRight, refWrong, origin) {
  let changed = 0, matchWrong = 0, matchRight = 0;
  for (let y = 0; y < refRight.height; y++) {
    for (let x = 0; x < refRight.width; x++) {
      const ri = (y * refRight.width + x) * 4;
      const a = key(refRight.rgba, ri), b = key(refWrong.rgba, ri);
      if (a === b) continue;
      changed++;
      const c = key(cart.rgba, ((y + origin.y) * cart.width + (x + origin.x)) * 4);
      if (c === b) matchWrong++;
      if (c === a) matchRight++;
    }
  }
  const pct = (v) => (changed ? Math.round((10000 * v) / changed) / 100 : null);
  return { changedPx: changed, wrongMatchPct: pct(matchWrong), rightMatchPct: pct(matchRight) };
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

/** A region's reference bytes, transformed and masked, as compared. */
function refRegionBytes(refHost, spec) {
  const mult = spec.transform === "lowbyte16" || spec.transform === "highbyte16" ? 2 : 1;
  let ref = applyTransform(Uint8Array.from(refHost.readMemory(spec.ref, spec.refOffset ?? 0, spec.length * mult)), spec.transform);
  if (spec.mask != null) ref = ref.map((b) => b & spec.mask);
  return ref;
}

/** A region's cart bytes, masked, as compared. */
function cartRegionBytes(cartHost, spec) {
  let cart = Uint8Array.from(cartHost.readMemory(spec.offset, spec.length));
  if (spec.mask != null) cart = cart.map((b) => b & spec.mask);
  return cart;
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
      out[name] = { bytes: cart.length, differ, ...(first >= 0 ? { firstDiff: { offset: first, cart: cart[first], ref: ref[first] } } : {}), ...(spec.compare === false ? { diagnostic: true } : {}) };
    } catch (e) {
      out[name] = { error: e.message, ...(spec.compare === false ? { diagnostic: true } : {}) };
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

// ─── offset search ───────────────────────────────────────────────────────────

/** True when the frame offset must be FOUND: caller 'auto', or the section's frameAlignment:'search'. */
export function wantsSearch(layout, explicitOffset) {
  if (explicitOffset === "auto") return true;
  if (explicitOffset != null) return false;
  return layout?.frameAlignment === "search";
}

/**
 * Find the cart frame offset by picture, for carts whose frame axis does not
 * follow the settle-frame arithmetic (a boot that takes a game-dependent
 * number of frames longer or shorter than the reference's).
 *
 * Runs a FRESH cart and a FRESH reference (so the main run's hosts keep their
 * whole history), steps the reference to `frame`, then steps the cart through
 * frame+base-window .. frame+base+window scoring each picture against that one
 * reference picture (moving pixels when enough moved, else content). The
 * winner must reach the content bar and stand clear of every candidate more
 * than one frame away from it by `minSharpness` points, or the search refuses:
 * an attract loop, a still title or a fade matches many offsets equally and a
 * guess there would verify the wrong frame.
 *
 * Cost bound: one cart run to frame+base+window and one reference run to
 * `frame`, plus 2*window+1 screenshot scores (window <= 600).
 *
 * Input scheduled before `frame` reaches the search cart at the BASE offset,
 * not at each candidate's; search at a frame before the first press (a title
 * or attract frame) when the game's timeline depends on when input arrives.
 */
export async function searchFrameOffset({ openCart, openRef, schedule = [], nameMap = null, base = 0, frame,
  window = 120, movingWindow = 10, bar = {}, origin = null, minSharpness = 2 }) {
  if (!Number.isInteger(frame) || frame < 1) throw new Error("offset search needs a reference frame >= 1 to search at (searchFrame, default the first scored frame)");
  window = Math.max(1, Math.min(600, window ?? 120));
  minSharpness ??= 2;
  const minMovingPx = bar.minMovingPx ?? 200, minContentPct = bar.minContentPct ?? 95;
  const refHost = await openRef();
  let cartHost;
  try {
    cartHost = await openCart();
    const rd = new ScheduleDriver(refHost, schedule);
    let prev = null;
    if (frame - movingWindow >= 0) { await rd.to(frame - movingWindow); prev = snap(refHost.screenshotRgba()); }
    await rd.to(frame);
    const refPic = snap(refHost.screenshotRgba());
    const cd = new ScheduleDriver(cartHost, shiftSchedule(schedule, base), nameMap);
    const scores = [];
    let o = null;
    for (let d = base - window; d <= base + window; d++) {
      const cf = frame + d;
      if (cf < 0) continue;
      await cd.to(cf);
      const pic = snap(cartHost.screenshotRgba());
      o ??= resolveOrigin(pic, refPic, origin);
      const sc = scorePictures(pic, refPic, o, prev);
      const useMoving = sc.movingTotal != null && sc.movingTotal >= minMovingPx;
      scores.push({ offset: d, pct: sc.status === "OK" ? (useMoving ? sc.movingPct : sc.contentPct) : -1, metric: useMoving ? "moving" : "content", contentPct: sc.contentPct });
    }
    const top = [...scores].sort((x, y) => y.pct - x.pct).slice(0, 6).map((x) => ({ offset: x.offset, pct: x.pct, metric: x.metric }));
    const best = top[0];
    const refuse = (why) => {
      throw new Error(`frame offset search refused: ${why}. Searched cart offsets ${base - window}..${base + window} at reference frame ${frame}; best candidates ${JSON.stringify(top)}. `
        + "Search at a frame whose picture MOVES (searchFrame), widen searchWindow (max 600), or pass cartFrameOffset explicitly.");
    };
    if (!best || best.pct < 0) refuse("no candidate produced a scorable picture (blank cart or a one-colour reference frame)");
    const plateau = scores.filter((x) => x.pct >= best.pct - 0.005).map((x) => x.offset).sort((x, y) => x - y);
    const contiguous = plateau[plateau.length - 1] - plateau[0] === plateau.length - 1;
    if (!contiguous || plateau.length > 4) refuse(`${plateau.length} offsets tie at ${best.pct}% (${plateau.slice(0, 8).join(", ")}${plateau.length > 8 ? ", ..." : ""}): the picture does not pin a frame`);
    const outside = scores.filter((x) => x.offset < plateau[0] - 1 || x.offset > plateau[plateau.length - 1] + 1).map((x) => x.pct);
    const sharpness = Math.round((best.pct - (outside.length ? Math.max(...outside) : 0)) * 100) / 100;
    const chosen = scores.find((x) => x.offset === plateau[0]);
    if ((chosen.contentPct ?? 0) < minContentPct) refuse(`the best offset scores only ${chosen.contentPct}% content, below the ${minContentPct}% bar`);
    if (sharpness < minSharpness) refuse(`the peak is not sharp (${sharpness} points above the best candidate two or more frames away; need ${minSharpness})`);
    return { offset: chosen.offset, frame, window: [base - window, base + window], metric: chosen.metric, peakPct: chosen.pct,
      sharpness, plateau: plateau.length > 1 ? plateau : undefined, candidates: scores.length, top };
  } finally {
    disposeHost(cartHost);
    disposeHost(refHost);
  }
}

// ─── audio ───────────────────────────────────────────────────────────────────

const AUDIO_CONTROLS = ["silence", "shift", "stereoDrop", "channelDrop"];

/** The reference stream a run compares against: "output" or a stream region. */
function audioStreamOf(a, layout) {
  return a.audioStream ?? layout?.audio?.reference ?? "output";
}

function captureSource(stream) {
  return stream === "output" ? "output" : { region: stream };
}

/**
 * Arm per-frame audio capture on both drivers (before they step): the main
 * stream plus every cart debug stream the section declares.
 */
function startAudioCapture({ a, layout, refHost, cartHost, ref, cart, off, last }) {
  const stream = audioStreamOf(a, layout);
  const from = Math.max(1, a.audioFrames?.[0] ?? 1), to = a.audioFrames?.[1] ?? last;
  if (!(to >= from)) throw new Error(`audioFrames [${from}, ${to}] is empty`);
  const win = [from, to];
  const refCap = new AudioCapture(refHost, { source: captureSource(stream), from, to });
  const cartCap = new AudioCapture(cartHost, { source: "output", from: from + off, to: to + off });
  ref.observe((f) => refCap.onFrame(f));
  cart.observe((f) => cartCap.onFrame(f));
  const streams = {};
  for (const [name, spec] of Object.entries(layout?.audio?.streams ?? {})) {
    const c = new AudioCapture(cartHost, { source: { cartStream: spec }, from: from + off, to: to + off });
    cart.observe((f) => c.onFrame(f));
    let r = null;
    if (spec.ref) { r = new AudioCapture(refHost, { source: { region: spec.ref }, from, to }); ref.observe((f) => r.onFrame(f)); }
    streams[name] = { spec, cart: c, ref: r };
  }
  return { stream, win, refCap, cartCap, streams };
}

function cartAudioInfo(cartHost) {
  // a console cart (sync32) has no ring of its own in wc_info: it pushes into
  // the console's ring, which the host describes
  if (typeof cartHost.audioInfo === "function") return cartHost.audioInfo();
  const info = cartHost.cart?.info ?? {};
  return { ring: !!(info.audioPtr && info.audioCap), rate: info.audioSampleRate || cartHost.status?.audioSampleRate || 0, f32: !!info.audioIsF32, cap: info.audioCap || 0 };
}

/** Score the captured audio, run the audio controls, write WAVs. */
async function finishAudio({ a, run, layout, refHost, cartHost, schedule, nameMap, off, tag }) {
  const ci = cartAudioInfo(cartHost);
  const refRate = run.stream === "output" ? (refHost.status?.audioSampleRate || 0) : run.refCap.rate;
  const cartRate = ci.rate || layout?.audio?.sampleRate || 0;
  const base = { ref: run.refCap.frames, cart: run.cartCap.frames, offset: off, from: run.win[0], to: run.win[1],
    refRate, cartRate, refChannels: run.refCap.channels, cartChannels: 2, maxLag: a.audioMaxLag, bar: a.audioBar };
  const score = scoreAudio(base);
  const notes = [];
  const verdictReasons = [];
  if (!ci.ring) verdictReasons.push("the cart declares no audio ring (wc_info audio_ptr/audio_cap are 0)");
  if (ci.f32) notes.push("the cart's ring is f32: the wasmcart host converts it to s16 (x32768 / x32767), so a sample-exact match needs an s16 ring (cart-abi AUDIO_CONTRACT)");
  if (layout?.audio?.sampleRate && ci.rate && Math.abs(layout.audio.sampleRate - ci.rate) >= 1) notes.push(`the section says audio.sampleRate ${layout.audio.sampleRate} but wc_info says ${ci.rate}`);
  if (run.refCap.errors.length) verdictReasons.push(`reference stream '${run.stream}' could not be read: ${run.refCap.errors[0]}`);
  if (run.refCap.dropped) notes.push(`the reference stream dropped ${run.refCap.dropped} sample frames (its buffer is too small for a frame)`);
  if (ci.ring && ci.cap && score.cartSampleFrames / Math.max(1, score.framesCompared) * 2 > ci.cap) notes.push(`the cart ring holds ${ci.cap} sample frames, less than twice a frame's worth: a long frame can overrun it`);
  for (const r of score.reasons ?? []) verdictReasons.push(r);
  if (score.status === "NO-DATA") verdictReasons.push(score.note);

  // controls
  const want = a.audioControls ?? AUDIO_CONTROLS;
  const controls = score.status === "NO-DATA" ? {} : syntheticAudioControls(base, want.filter((w) => w !== "channelDrop"));
  if (want.includes("channelDrop")) controls.channelDrop = await channelDropControl({ a, layout, run, base, schedule, nameMap, off });
  for (const [n, c] of Object.entries(controls)) {
    if (c.skipped) continue;
    if (!c.failed) verdictReasons.push(`audio control ${n} did NOT fail${c.couldNotFail ? `: ${c.couldNotFail}` : ""}`);
  }

  // debug streams
  const streams = {};
  for (const [name, st] of Object.entries(run.streams)) {
    const frames = [...st.cart.frames.values()];
    const all = frames.reduce((n, c) => n + c.length, 0);
    const entry = { sampleFrames: all / (st.spec.channels ?? 1), frames: frames.length, ...(st.cart.errors.length ? { error: st.cart.errors[0] } : {}), ...(st.cart.dropped ? { dropped: st.cart.dropped } : {}) };
    if (st.ref) {
      const s = scoreAudio({ ref: st.ref.frames, cart: st.cart.frames, offset: off, from: run.win[0], to: run.win[1],
        refRate: st.ref.rate || 1, cartRate: st.ref.rate || 1, refChannels: st.ref.channels, cartChannels: st.spec.channels ?? 1 });
      Object.assign(entry, { ref: st.spec.ref, exactPct: s.exactPct, framesExactPct: s.framesExactPct, maxAbsError: s.maxAbsError, countMismatchFrames: s.countMismatchFrames,
        ...(s.firstMismatch ? { firstMismatch: s.firstMismatch } : {}), pass: s.pass, ...(st.ref.errors.length ? { refError: st.ref.errors[0] } : {}) });
      if (a.audio === "required" && st.spec.compare !== false && !s.pass) verdictReasons.push(`stream ${name}: ${s.reasons.join("; ")}`);
    }
    streams[name] = entry;
  }

  let wavs = null;
  if (a.audioWav && a.outputDir && score.status !== "NO-DATA") wavs = writeAudioWavs(a.outputDir, tag, base);
  const report = {
    stream: run.stream, ...score, controls,
    ...(Object.keys(streams).length ? { streams } : {}),
    ...(wavs ? { wavs } : {}),
    ...(notes.length ? { notes } : {}),
    verdict: verdictReasons.length ? "AUDIO DIFFERS" : "AUDIO VERIFIED",
    required: a.audio === "required",
  };
  const plat = AUDIO_REFERENCE[a.refPlatform]?.alias ?? a.refPlatform;
  const refDoc = AUDIO_REFERENCE[plat];
  if (refDoc) report.referenceDoc = { core: refDoc.core, rate: refDoc.rate, match: refDoc.match, perFrame: refDoc.perFrame, streams: refDoc.streams };
  delete report.reasons;
  report.reasons = verdictReasons;
  return { report, verdictReasons };
}

/**
 * The real must-fail control: a fresh cart with one mixer channel silenced
 * through the section's audio.muteMask, re-run on the same schedule. The
 * scorer must see the difference, or the audio compare is not measuring the
 * cart's mix.
 */
async function channelDropControl({ a, layout, run, base, schedule, nameMap, off }) {
  const m = layout?.audio?.muteMask;
  if (!m) return { skipped: "the cart's section declares no audio.muteMask, so no mixer channel can be silenced (the synthetic silence/shift/stereoDrop controls still ran)" };
  if (!a.openCart) return { skipped: "no fresh-cart opener" };
  const names = a.audioDropChannel ? [a.audioDropChannel] : m.channels;
  const tried = [];
  for (const name of names) {
    const bit = m.channels.indexOf(name);
    if (bit < 0) return { skipped: `audioDropChannel '${name}' is not in muteMask.channels (${m.channels.join(", ")})` };
    const h = await a.openCart();
    try {
      const size = m.size ?? 1, v = 1 << bit, bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (v >>> (8 * i)) & 0xff;
      h.writeMemory(m.offset, bytes);
      const cap = new AudioCapture(h, { source: "output", from: run.win[0] + off, to: run.win[1] + off });
      const d = new ScheduleDriver(h, shiftSchedule(schedule, off), nameMap).observe((f) => cap.onFrame(f));
      await d.to(run.win[1] + off);
      const s = scoreAudio({ ...base, cart: cap.frames });
      const failed = !s.pass;
      tried.push({ channel: name, failed, exactPct: s.exactPct ?? null, spectral: s.spectral?.similarity ?? null });
      if (failed) return { channel: name, failed: true, exactPct: s.exactPct ?? null, ...(tried.length > 1 ? { tried } : {}) };
    } finally { disposeHost(h); }
  }
  return { failed: false, tried, couldNotFail: `silencing ${tried.map((t) => t.channel).join(", ")} through muteMask did not change the scored audio: those channels are silent in the window, or the cart ignores muteMask` };
}

// ─── the verification ────────────────────────────────────────────────────────

const DEFAULT_CONTROLS = ["vramZero", "wrongFrame", "wrongInput"];

/** The evidence bar every verification scores against (callers may only override it explicitly). */
export const DEFAULT_BAR = Object.freeze({ minContentPct: 95, minContentPx: 2000, minMovingPct: 95, minMovingPx: 200, minChangePx: 50 });

function passesBar(s, bar) {
  if (s.status !== "OK") return false;
  const contentOk = s.contentTotal >= bar.minContentPx && s.contentPct >= bar.minContentPct;
  const movingOk = s.movingTotal == null || s.movingTotal < bar.minMovingPx || s.movingPct >= bar.minMovingPct;
  return contentOk && movingOk;
}

/** A control must FAIL: any of blank, below the content bar, or below the moving bar. */
export function controlFailed(s, bar) {
  if (s.status === "BLANK") return true;
  if (s.status === "INCONCLUSIVE") return false;
  if (s.movingTotal != null && s.movingTotal >= bar.minMovingPx) return s.movingPct < bar.minMovingPct;
  return !(s.contentTotal >= bar.minContentPx && s.contentPct >= bar.minContentPct);
}

export function disposeHost(h) {
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
 * @param {number|"auto"} [a.cartFrameOffset] override the computed alignment; "auto" searches for it
 * @param {number} [a.searchFrame]             reference frame the offset search runs at (default frames[0])
 * @param {number} [a.searchWindow]            offsets searched either side of the computed one (default 120, max 600)
 * @param {number} [a.minSharpness]            points the searched peak must stand above its non-neighbours (default 2)
 * @param {number} [a.sweep]                   also score cart frames +-sweep around the aligned one
 * @param {number[]} [a.cartOrigin]            [x,y] of the reference picture inside the cart framebuffer
 * @param {Record<string,string>} [a.cartButtonMap] rename buttons for the cart side only
 * @param {string[]} [a.controls]              subset of vramZero | wrongFrame | wrongInput
 * @param {number} [a.movingWindow]            frames back for the moving-pixel mask (default 10)
 * @param {number} [a.wrongFrameDelta]         distance of the wrong-frame reference (default: tried at 5/10/20/30/60/120
 *                                             and the one where the reference changed most is used)
 * @param {number} [a.wrongFrameMaxDelta]      bound on those candidates (default 120)
 * @param {object} [a.bar]                     {minContentPct, minContentPx, minMovingPct, minMovingPx, minChangePx}
 * @param {boolean} [a.requireStateMatch]      a region/field difference fails the verdict (default true;
 *   false only reports differences in stateDiffs and lets the pixels decide)
 * @param {string} [a.outputDir]               where [cart|ref|diff] PNGs go (omit: none written)
 * @param {string} [a.tag]                     PNG filename prefix
 * @param {boolean|"required"} [a.audio]       capture and score both sides' audio (true: reported;
 *                                             "required": part of the verdict)
 * @param {number[]} [a.audioFrames]           [from, to] reference frames whose audio is compared
 *                                             (default [1, last scored frame])
 * @param {string} [a.audioStream]             reference stream: "output" or a stream region
 *                                             (default the section's audio.reference, else "output")
 * @param {object} [a.audioBar]                {minSpectral, minEnvelope} for rate-mismatched streams
 * @param {string[]} [a.audioControls]         subset of silence | shift | stereoDrop | channelDrop
 * @param {string} [a.audioDropChannel]        the muteMask channel the channelDrop control silences
 *                                             (default: each in turn until one fails)
 * @param {boolean} [a.audioWav]               write [cart|ref|diff] WAVs to outputDir
 * @param {number} [a.audioMaxLag]             cross-correlation lag search, in samples
 * @returns {Promise<{result: object, cartHost: object, refHost: object}>}
 */
export async function verifyRecompile(a) {
  const layout = a.layout ?? { regions: {}, fields: {}, probe: {} };
  const frames = [...new Set(a.frames)].sort((x, y) => x - y);
  if (!frames.length) throw new Error("verifyRecompile: `frames` must list at least one reference frame to score");
  if (frames[0] < 1) throw new Error("verifyRecompile: frames are reference frames stepped after loadMedia and must be >= 1");
  const schedule = parseInputSchedule(a.input);
  let sweep = a.sweep ?? 0;
  const mw = a.movingWindow ?? 10;
  const wfd = a.wrongFrameDelta ?? 30;
  // Wrong-frame candidates: the caller's delta, or a spread (the control
  // takes the one where the reference picture changed most, within the bound).
  const wfMax = a.wrongFrameMaxDelta ?? 120;
  const wfCands = a.wrongFrameDelta != null ? [a.wrongFrameDelta]
    : [...new Set([wfd, 5, 10, 20, 60, 120])].filter((d) => d >= 1 && d <= Math.max(wfMax, 1)).sort((x, y) => x - y);
  const controls = a.controls ?? DEFAULT_CONTROLS;
  const bar = { ...DEFAULT_BAR, ...(a.bar ?? {}) };
  const nameMap = a.cartButtonMap ?? (layout.buttons === "byName" ? BY_NAME_CART_MAP : null);
  const tag = (a.tag ?? "verify").replace(/[^A-Za-z0-9_.-]/g, "_");

  const refHost = await a.openRef();
  let cartHost;
  try { cartHost = await a.openCart(); }
  catch (e) { disposeHost(refHost); throw e; }
  // Any failure past this point must not leak two live emulator heaps.
  try {

  const searched = wantsSearch(layout, a.cartFrameOffset);
  const alignment = resolveAlignment(cartHost, refHost, layout, searched ? undefined : a.cartFrameOffset);
  if (searched) {
    const found = await searchFrameOffset({
      openCart: a.openCart, openRef: a.openRef, schedule, nameMap, base: alignment.computedOffset,
      frame: a.searchFrame ?? frames[0], window: a.searchWindow, movingWindow: mw, bar,
      origin: a.cartOrigin ?? layout.screen?.origin, minSharpness: a.minSharpness,
    });
    Object.assign(alignment, { offset: found.offset, source: "search", search: found });
    alignment.meaning = `reference frame F is compared with cart frame F${found.offset >= 0 ? "+" : ""}${found.offset}, FOUND by searching cart offsets ${found.window[0]}..${found.window[1]} at reference frame ${found.frame} (peak ${found.peakPct}%, sharpness ${found.sharpness}); each scored frame may refine it by up to +-${Math.max(sweep, 2)} when its own sweep has a sharp peak (row.refinedBy).`;
  }
  const off = alignment.offset;
  if (searched && sweep < 2) sweep = 2;
  const ref = new ScheduleDriver(refHost, schedule);
  const cart = new ScheduleDriver(cartHost, shiftSchedule(schedule, off), nameMap);

  const last = frames[frames.length - 1];
  const audioRun = a.audio ? startAudioCapture({ a, layout, refHost, cartHost, ref, cart, off, last }) : null;
  const refShots = new Map();
  const want = new Set();
  const wfFrames = new Set();
  for (const F of frames) {
    want.add(F);
    if (F - mw >= 0) want.add(F - mw);
    // The wrong-frame control's candidate references for this sample (chosen after the run).
    if (controls.includes("wrongFrame")) for (const d of wfCands) if (F - d >= 1) { want.add(F - d); wfFrames.add(F - d); if (F - d - mw >= 0) want.add(F - d - mw); }
  }
  const refFrames = [...want].sort((x, y) => x - y);
  const sampleSet = new Set(frames);
  // Compared regions (not diagnostic ones) at each wrong-frame candidate, for
  // the control's state signal.
  const cmpRegions = Object.entries(layout.regions ?? {}).filter(([, r]) => r.compare !== false);
  const wfState = new Map();

  const rows = [];
  let origin = null, trapped = null;
  const alignedCartPics = new Map();
  for (const r of refFrames) {
    await ref.to(r);
    refShots.set(r, snap(refHost.screenshotRgba()));
    if (wfFrames.has(r) && cmpRegions.length) {
      const m = {};
      for (const [n, spec] of cmpRegions) { try { m[n] = refRegionBytes(refHost, spec); } catch { /* unreadable: no state signal */ } }
      wfState.set(r, m);
    }
    if (!sampleSet.has(r)) continue;
    const F = r, refPic = refShots.get(F), prev = refShots.get(F - mw) ?? null;
    const curve = [], cands = [];
    for (let d = -sweep; d <= sweep; d++) {
      const cf = F + off + d;
      if (cf < cart.at || cf < 0) { curve.push({ d, skipped: "cart already past this frame (samples closer together than the sweep)" }); continue; }
      await cart.to(cf);
      const pic = snap(cartHost.screenshotRgba());
      origin ??= resolveOrigin(pic, refPic, a.cartOrigin ?? layout.screen?.origin);
      const s = scorePictures(pic, refPic, origin, prev);
      curve.push({ d, contentPct: s.contentPct, movingPct: s.movingPct, exactPct: s.exactPct, status: s.status });
      // State is read at every candidate the row might settle on: the aligned
      // pair always, and in search mode every sweep point (the refine below
      // may pick one of them).
      if (d === 0 || searched) {
        const c = { d, cf, pic, s, regions: compareRegions(cartHost, refHost, layout.regions) };
        // bytes differing between this cart state and each wrong-frame reference
        if (controls.includes("wrongFrame") && cmpRegions.length) {
          c.wrongState = {};
          const cartBytes = {};
          for (const [n, spec] of cmpRegions) { try { cartBytes[n] = cartRegionBytes(cartHost, spec); } catch { /* skip */ } }
          for (const dd of wfCands) {
            const snapW = wfState.get(F - dd);
            if (!snapW) continue;
            let differ = 0, compared = 0;
            for (const n of Object.keys(snapW)) {
              const x = cartBytes[n], y = snapW[n];
              if (!x || x.length !== y.length) continue;
              compared += x.length;
              for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) differ++;
            }
            if (compared) c.wrongState[dd] = differ;
          }
        }
        if (Object.keys(layout.fields ?? {}).length) c.fields = compareFields(cartHost, refHost, a.refPlatform, layout.fields);
        if (Object.keys(layout.probe ?? {}).length) c.probe = readProbe(cartHost, layout.probe);
        cands.push(c);
      }
    }
    const scored = curve.filter((c) => c.contentPct != null || c.movingPct != null);
    const metric = (c) => (c.movingPct ?? c.contentPct ?? -1);
    const peak = scored.reduce((b, c) => (b == null || metric(c) > metric(b) || (metric(c) === metric(b) && c.d === 0) ? c : b), null);
    const others = scored.filter((c) => c !== peak).map(metric);
    const sharpness = others.length && peak ? Math.round((metric(peak) - Math.max(...others)) * 100) / 100 : null;
    // Search mode refines per frame: when the searched offset is off by a
    // frame or two here (a lag frame, a 30 fps game) and the sweep has a sharp
    // peak elsewhere, score that pair. Fixed offsets never move.
    let pick = cands.find((c) => c.d === 0);
    if (searched && peak && peak.d !== 0 && sharpness > 0) pick = cands.find((c) => c.d === peak.d) ?? pick;
    if (!pick) continue;
    alignedCartPics.set(F, pick.pic);
    const row = { refFrame: F, cartFrame: pick.cf, ...(pick.d !== 0 ? { refinedBy: pick.d } : {}), ...pick.s, pass: passesBar(pick.s, bar), regions: pick.regions };
    if (pick.wrongState) Object.defineProperty(row, "_wrongState", { value: pick.wrongState, enumerable: false });
    if (pick.fields) row.fields = pick.fields;
    if (pick.probe) {
      row.probe = pick.probe;
      if (typeof row.probe.trapped === "number" && row.probe.trapped) trapped ??= { refFrame: F, cartFrame: pick.cf, probe: row.probe };
    }
    if (a.outputDir) row.png = writeDiffPng(path.join(a.outputDir, `${tag}_ref${F}_cart${pick.cf}.png`), pick.pic, refPic, origin);
    if (sweep) {
      row.sweep = curve;
      if (peak) { row.peak = { d: peak.d, metric: peak.movingPct != null ? "moving" : "content", pct: metric(peak) }; row.sharpness = sharpness; }
    }
    rows.push(row);
  }

  // ── controls ──
  const lastRef = refShots.get(last), lastPrev = refShots.get(last - mw) ?? null;
  const ctl = {};
  if (controls.includes("wrongFrame")) {
    // The cart's aligned picture at one sample scored against the reference
    // `d` frames EARLIER. Three signals, strongest first:
    //  1. PIXELS WHERE THE TWO REFERENCE FRAMES DIFFER: the only pixels that
    //     can tell right from wrong. (sample, d) is chosen to maximise that
    //     change, so a near-static game (40 moving pixels in 10 frames) is still
    //     tested on everything that did change. Needs >= bar.minChangePx.
    //  2. STATE: the compared regions equal the reference at the aligned frame
    //     but differ from it at the wrong frame (a frame counter in RAM moves
    //     even when the picture does not).
    //  3. The whole-picture score (content / moving), as before.
    // A control none of these can fail is reported as couldNotFail, never
    // passed: a still screen with no compared state cannot tell frames apart.
    const alignedStateSame = (r) => Object.values(r.regions ?? {}).every((v) => v.diagnostic || (!v.error && !v.differ));
    let best = null, stateHit = null;
    const tried = [];
    for (const r of rows) {
      if (!alignedCartPics.has(r.refFrame)) continue;
      for (const d of wfCands) {
        const wf = r.refFrame - d;
        if (!refShots.has(wf)) continue;
        const cr = scoreChangeRegion(alignedCartPics.get(r.refFrame), refShots.get(r.refFrame), refShots.get(wf), origin);
        const st = r._wrongState?.[d];
        tried.push({ sampleRefFrame: r.refFrame, delta: d, changedPx: cr.changedPx, ...(st != null ? { stateDiffer: st } : {}) });
        if (!best || cr.changedPx > best.cr.changedPx) best = { r, d, wf, cr };
        if (!stateHit && st > 0 && alignedStateSame(r)) stateHit = { r, d, wf, differ: st };
      }
    }
    if (!best || !origin) ctl.wrongFrame = { skipped: `no scored frame lies more than ${Math.min(...wfCands)} frame(s) after frame 0` };
    else {
      const { r, d, wf, cr } = best;
      const whole = scorePictures(alignedCartPics.get(r.refFrame), refShots.get(wf), origin, refShots.get(wf - mw) ?? null);
      const pixelFail = cr.changedPx >= bar.minChangePx && cr.wrongMatchPct < bar.minMovingPct;
      const wholeFail = controlFailed(whole, bar);
      ctl.wrongFrame = { refFrame: wf, cartFrame: r.cartFrame, sampleRefFrame: r.refFrame, delta: d, ...whole,
        changeRegion: { ...cr, note: `pixels where reference frames ${r.refFrame} and ${wf} differ; the cart matches the WRONG frame on wrongMatchPct of them (and the right one on rightMatchPct)` },
        ...(stateHit ? { state: { sampleRefFrame: stateHit.r.refFrame, delta: stateHit.d, wrongFrameBytesDiffer: stateHit.differ, alignedBytesDiffer: 0 } } : {}),
        tried };
      ctl.wrongFrame.signal = pixelFail ? "pixels-changed-region" : wholeFail ? "pixels-whole-picture" : stateHit ? "state" : "none";
      ctl.wrongFrame.failed = pixelFail || wholeFail || !!stateHit;
      if (!ctl.wrongFrame.failed) {
        ctl.wrongFrame.couldNotFail = `the reference picture changes in only ${cr.changedPx} px between frames ${r.refFrame} and ${wf} (the most over deltas ${wfCands.join("/")}; the change-region signal needs ${bar.minChangePx})`
          + (cmpRegions.length ? ", and no sample has compared state that equals the reference at the aligned frame yet differs at the wrong one" : ", and the cart declares no compared regions for a state signal")
          + ". Score frames where the picture moves, or add a region the game writes every frame.";
      }
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
    // Variants tried in order until one fails: the caller's schedule if given;
    // otherwise WITHHOLD ALL INPUT (the strongest perturbation: a game that
    // waits on its title for Start cannot reach the same picture), then a
    // perturbed schedule (Start/Select kept, play presses replaced). If none
    // fails, that is reported, never passed silently.
    const variants = a.wrongInput != null
      ? [{ kind: "caller", schedule: parseInputSchedule(a.wrongInput) }]
      : schedule.length ? [{ kind: "no-input", schedule: [] }, { kind: "perturbed", schedule: wrongInputSchedule(schedule, last) }] : [];
    if (!variants.length) ctl.wrongInput = { skipped: "no input schedule: this run does not exercise input, so there is nothing to perturb (pass `input`, or `wrongInput` explicitly)" };
    const tried = [];
    for (const v of variants) {
      const h = await a.openCart();
      try {
        const d = new ScheduleDriver(h, shiftSchedule(v.schedule, off), nameMap);
        await d.to(last + off);
        const pic = snap(h.screenshotRgba());
        const c = { variant: v.kind, refFrame: last, cartFrame: last + off, presses: v.schedule.length, ...scorePictures(pic, lastRef, origin, lastPrev) };
        c.failed = controlFailed(c, bar);
        tried.push({ variant: v.kind, failed: c.failed, contentPct: c.contentPct, movingPct: c.movingPct });
        if (c.failed || v === variants[variants.length - 1]) {
          if (a.outputDir) c.png = writeDiffPng(path.join(a.outputDir, `${tag}_control_wronginput_ref${last}.png`), pic, lastRef, origin);
          ctl.wrongInput = { ...c, ...(tried.length > 1 ? { tried } : {}) };
          if (!c.failed) ctl.wrongInput.couldNotFail = `no input variant changed the picture at reference frame ${last} (tried: ${tried.map((t) => t.variant).join(", ")}). Input may not matter at this frame (an attract loop, a cutscene): score a frame where the pressed input shows, pass wrongInput explicitly, or drop the control with controls:[...] if you can defend it.`;
          break;
        }
      } finally { disposeHost(h); }
    }
  }

  // ── audio ──
  let audioResult = null;
  if (audioRun) {
    await ref.to(Math.max(ref.at, audioRun.win[1]));
    await cart.to(Math.max(cart.at, audioRun.win[1] + off));
    audioResult = await finishAudio({ a, run: audioRun, layout, refHost, cartHost, schedule, nameMap, off, tag });
  }

  // ── verdict ──
  const reasons = [];
  // Most specific failure first: a trapped cart explains everything after it.
  if (trapped) reasons.push(`the cart TRAPPED (probe.trapped=${trapped.probe.trapped}${trapped.probe.trappc != null ? `, trappc=0x${Number(trapped.probe.trappc).toString(16)}` : ""}) by ref frame ${trapped.refFrame}`);
  for (const r of rows) {
    // A frame is evidence when the REFERENCE shows enough content; what the
    // cart drew there (even a blank screen) is then a pass or a failure. A
    // reference with too little content is reported (evidence:false) and
    // never counted either way.
    r.evidence = r.status !== "INCONCLUSIVE" && r.contentTotal >= bar.minContentPx;
    if (!r.evidence) continue;
    if (!r.pass) {
      const regionMiss = Object.entries(r.regions ?? {}).filter(([, v]) => !v.diagnostic && v.differ).map(([n, v]) => `${n} ${v.differ}/${v.bytes}`);
      reasons.push(`ref frame ${r.refFrame}: pixels do not match - ${r.status === "BLANK" ? "the cart drew a BLANK (one-colour) picture" : `content ${r.contentPct}% (${r.contentPx}/${r.contentTotal})${r.movingTotal != null ? `, moving ${r.movingPct}% (${r.movingPx}/${r.movingTotal})` : ""}`}, below the bar${regionMiss.length ? `; state also differs: ${regionMiss.join(", ")} bytes` : ""}`);
    }
  }
  if (!rows.some((r) => r.evidence)) reasons.push(`no scored frame is evidence: every requested reference frame has fewer than ${bar.minContentPx} content pixels (or is one colour). Pick later frames with real pictures.`);
  for (const [n, c] of Object.entries(ctl)) {
    if (c.skipped) continue;
    if (!c.failed) reasons.push(`control ${n} did NOT fail (content ${c.contentPct}%${c.movingTotal != null ? `, moving ${c.movingPct}%` : ""}): ${c.couldNotFail ?? "the score cannot tell this wrong picture from the right one"}`);
  }
  const stateDiffs = [];
  for (const r of rows) {
    for (const [n, v] of Object.entries(r.regions ?? {})) if (!v.diagnostic && (v.error || v.differ)) stateDiffs.push(`ref frame ${r.refFrame}: region ${n} ${v.error ? `unreadable (${v.error})` : `${v.differ}/${v.bytes} bytes differ`}`);
    for (const [n, v] of Object.entries(r.fields ?? {})) if (v.error || v.same === false) stateDiffs.push(`ref frame ${r.refFrame}: field ${n} ${v.error ? `unreadable (${v.error})` : `cart ${v.cart} ref ${v.ref}`}`);
  }
  if (a.audio === "required" && audioResult) for (const r of audioResult.verdictReasons) reasons.push(`audio: ${r}`);
  // Matching pixels over differing memory is not a verified recompile: state
  // decides by default, and only an explicit requireStateMatch:false opts out.
  if (a.requireStateMatch !== false && stateDiffs.length) reasons.push(`state differs: ${stateDiffs.slice(0, 6).join("; ")}${stateDiffs.length > 6 ? ` (+${stateDiffs.length - 6} more)` : ""}`);
  const verified = reasons.length === 0;
  const regionNames = Object.keys(layout.regions ?? {});
  const table = [
    `| ref frame | cart frame | exact | content (px) | moving (px) |${regionNames.map((n) => ` ${n} |`).join("")} pass |`,
    `|---|---|---|---|---|${regionNames.map(() => "---|").join("")}---|`,
    ...rows.map((r) => `| ${r.refFrame} | ${r.cartFrame} | ${r.exactPct}% | ${r.contentPct ?? "-"}% (${r.contentPx}/${r.contentTotal}) | ${r.movingTotal == null ? "-" : `${r.movingPct ?? "-"}% (${r.movingPx}/${r.movingTotal})`} |${regionNames.map((n) => ` ${r.regions?.[n]?.error ? "ERR" : `${r.regions?.[n]?.differ}/${r.regions?.[n]?.bytes}`}${r.regions?.[n]?.diagnostic ? " (diag)" : ""} |`).join("")} ${!r.evidence ? "n/a" : r.pass ? "yes" : "NO"} |`),
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
    ...(audioResult ? { audio: audioResult.report } : {}),
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
 * @param {boolean} [a.audio]      also compare each frame's audio (per-frame hash of the samples)
 * @param {string} [a.audioStream] reference stream: "output" or a stream region (default the section's audio.reference)
 */
export async function findRecompileDivergence(a) {
  const layout = a.layout ?? {};
  // compare:false regions are diagnostic (e.g. a register page whose
  // read-side values are computed on access): never a divergence.
  const regions = Object.fromEntries(Object.entries(layout.regions ?? {}).filter(([, r]) => r.compare !== false)), fields = layout.fields ?? {};
  if (!Object.keys(regions).length && !Object.keys(fields).length && !a.audio) {
    throw new Error("findDiverge (recompile): nothing to compare - the cart has no romdev.recompile section and no `regions`/`fields` were passed");
  }
  const schedule = parseInputSchedule(a.input);
  const nameMap = a.cartButtonMap ?? (layout.buttons === "byName" ? BY_NAME_CART_MAP : null);
  const alignment = resolveAlignment(a.cartHost, a.refHost, layout, wantsSearch(layout, a.cartFrameOffset) ? undefined : a.cartFrameOffset);
  if (wantsSearch(layout, a.cartFrameOffset)) {
    if (!a.openCart || !a.openRef) throw new Error("findDiverge: an offset search needs fresh hosts (openCart/openRef)");
    const found = await searchFrameOffset({ openCart: a.openCart, openRef: a.openRef, schedule, nameMap, base: alignment.computedOffset,
      frame: a.searchFrame ?? Math.max(a.startFrame ?? 0, 600), window: a.searchWindow, minSharpness: a.minSharpness, origin: layout.screen?.origin });
    Object.assign(alignment, { offset: found.offset, source: "search", search: found });
  }
  const off = alignment.offset;
  const ref = new ScheduleDriver(a.refHost, schedule);
  const cart = new ScheduleDriver(a.cartHost, shiftSchedule(schedule, off), nameMap);
  const start = Math.max(a.startFrame ?? 0, off < 0 ? -off : 0);
  const stride = a.stride ?? 1, maxFrames = a.maxFrames ?? 600;
  // Audio: every frame's chunk on both sides, compared at each compare point
  // over the frames since the previous one (a stride compares the span).
  let aud = null;
  if (a.audio) {
    const stream = audioStreamOf(a, layout);
    aud = { stream, ref: new AudioCapture(a.refHost, { source: captureSource(stream), keep: false }), cart: new AudioCapture(a.cartHost, { source: "output", keep: false }),
      refPend: new Map(), cartPend: new Map(), silent: true };
    ref.observe((f) => { const c = aud.ref.onFrame(f); if (f > start - stride) aud.refPend.set(f, c); });
    cart.observe((f) => { const c = aud.cart.onFrame(f); if (f > start - stride + off) aud.cartPend.set(f, c); });
  }
  let lastSame = null, compared = 0, changed = 0, prevSig = null;
  for (let F = start, n = 0; n < maxFrames; F += stride, n++) {
    await ref.to(F);
    await cart.to(F + off);
    let audioDiff = null;
    if (aud) {
      for (let f = F - stride + 1; f <= F; f++) {
        if (f < 1 || f + off < 1) continue;
        const r = aud.refPend.get(f), c = aud.cartPend.get(f + off);
        if (!r || !c) continue;
        if (aud.silent) for (let i = 0; i < r.length; i++) if (r[i]) { aud.silent = false; break; }
        const hr = audioChunkHash(r), hc = audioChunkHash(c);
        if (hr !== hc && !audioDiff) {
          let k = 0;
          while (k < Math.min(r.length, c.length) && r[k] === c[k]) k++;
          const ch = aud.ref.channels;
          audioDiff = { refFrame: f, cartFrame: f + off, refSamples: r.length / ch, cartSamples: c.length / 2, refHash: hr, cartHash: hc,
            firstSample: { index: Math.floor(k / ch), channel: ch === 2 ? (k % 2 ? "R" : "L") : "mono", ref: r[k] ?? null, cart: c[k] ?? null } };
        }
      }
      aud.refPend.clear(); aud.cartPend.clear();
      if (aud.ref.errors.length) throw new Error(`findDiverge audio: reference stream '${aud.stream}' could not be read: ${aud.ref.errors[0]}`);
    }
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
    if (badRegions.length || badFields.length || audioDiff) {
      return {
        op: "findDiverge", mode: "recompile", diverged: true,
        atRefFrame: F, atCartFrame: F + off, lastIdenticalRefFrame: lastSame,
        regions: badRegions, fields: badFields,
        ...(audioDiff ? { audio: { ...audioDiff, stream: aud.stream, note: `the samples produced during reference frame ${audioDiff.refFrame} differ from the cart's frame ${audioDiff.cartFrame}${audioDiff.refSamples !== audioDiff.cartSamples ? ` (and the sample COUNTS differ: ${audioDiff.refSamples} vs ${audioDiff.cartSamples})` : ""}; frame({op:'verifyRecompile', audio:true, audioFrames:[${audioDiff.refFrame}, ${audioDiff.refFrame}], audioWav:true}) dumps that frame` } } : {}),
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
    ...(aud ? { audio: { stream: aud.stream, compared: true, referenceSilent: aud.silent, ...(aud.ref.errors.length ? { error: aud.ref.errors[0] } : {}),
      note: aud.silent ? "every compared audio frame was identical, but the reference was SILENT throughout: this says nothing about sound" : "every compared frame's audio was sample-identical (same count, same samples)" } } : {}),
    conclusion: changed > 0 || (aud && !aud.silent) ? "no-observed-divergence" : "inconclusive-no-observed-state-change",
    note: changed > 0
      ? "Every compared region and field matched at every compared frame, and the state changed along the way. This is evidence for these regions at these frames, not proof of whole-program equivalence."
      : "The compared state never changed, so matching says nothing about execution (an idle or spin loop matches trivially). Compare later frames, or add regions that the game writes every frame.",
  };
}

// ─── trap fuzzing ────────────────────────────────────────────────────────────

/**
 * Run a recompiled cart ALONE under several seeded random play scripts and
 * report the first frame each one TRAPS at (the section's probe.trapped),
 * with the probe block there. A trap is invisible from outside (the host
 * keeps presenting the last picture at full frame rate), and a run on the
 * verified schedule only covers the code that schedule reaches; random play
 * reaches the rest (RAM routines a discovery pass never saw, rarely used
 * paths). Replaces the earlier per-cart fuzz scripts.
 *
 * @param {object} a
 * @param {() => Promise<object>} a.openCart
 * @param {object} a.layout                  the cart's romdev.recompile layout (needs probe.trapped)
 * @param {number} [a.frames=3600]           frames per seed
 * @param {number[]} [a.seeds=[1,2,3]]
 * @param {Array|string} [a.input]           presses kept in every script (e.g. the Start that leaves the title)
 * @param {Record<string,string>} [a.cartButtonMap]
 */
export async function fuzzRecompile(a) {
  const layout = a.layout ?? {};
  if (!layout.probe?.trapped) throw new Error("fuzz: the cart's romdev.recompile section declares no probe.trapped, so a trap cannot be seen; pass probe:{trapped:{offset}} for a cart that has one");
  const frames = a.frames ?? 3600, seeds = a.seeds?.length ? a.seeds : [1, 2, 3];
  if (!Number.isInteger(frames) || frames < 1 || frames > 100000) throw new Error("fuzz: frames must be 1..100000");
  const base = parseInputSchedule(a.input);
  const nameMap = a.cartButtonMap ?? (layout.buttons === "byName" ? BY_NAME_CART_MAP : null);
  const from = base.length ? Math.max(...base.map((p) => p.frame + p.hold)) + 30 : 60;
  const runs = [];
  for (const seed of seeds) {
    // keep the caller's presses, add seeded play from `from` on
    const play = wrongInputSchedule([{ frame: from, buttons: ["a"], hold: 1 }], frames, seed).filter((p) => p.frame >= from);
    const schedule = [...base, ...play].sort((x, y) => x.frame - y.frame);
    const h = await a.openCart();
    try {
      const d = new ScheduleDriver(h, schedule, nameMap);
      let trapAt = null, probe = null;
      for (let f = 1; f <= frames; f++) {
        await d.to(f);
        const t = readCartScalar(h, layout.probe.trapped);
        if (t) { trapAt = f; probe = readProbe(h, layout.probe); break; }
      }
      runs.push({ seed, presses: schedule.length, framesRun: trapAt ?? frames, trapped: trapAt != null,
        ...(trapAt != null ? { atCartFrame: trapAt, probe, schedule: schedule.filter((p) => p.frame <= trapAt).slice(-8) } : {}) });
    } finally { disposeHost(h); }
  }
  const trapped = runs.filter((r) => r.trapped);
  return {
    op: "fuzzRecompile", frames, seeds, runs,
    verdict: trapped.length ? "TRAPPED" : "NO TRAP",
    note: trapped.length
      ? `${trapped.length} of ${runs.length} seeded scripts trapped; the first at cart frame ${Math.min(...trapped.map((r) => r.atCartFrame))}. The probe names where (trappc); the last presses before it are in schedule. Rebuild with the backend's RAM-code options if trappc is a RAM address, or trace the frame with findDiverge level:'instruction' (atFrame = the cart frame minus the section's alignment).`
      : `No trap in ${runs.length} x ${frames} frames of random play. Evidence of coverage for the paths those scripts reached, not proof that none exists.`,
  };
}
