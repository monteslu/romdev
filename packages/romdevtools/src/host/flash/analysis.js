// Flash analysis: does a run of frames strobe? The photosensitive-seizure
// thresholds of WCAG 2.2 success criterion 2.3.1 (three flashes or below) and
// the Harding test they come from, applied to every frame of a run at its frame
// rate. The same rules and measures as cartwheel's tools/lib/flash.mjs (so a
// verdict from romdev and one from a native frame dump of the same frames
// agree), streamed: frames are pushed one at a time and never kept.
//
//   relative luminance  Y = 0.2126 R + 0.7152 G + 0.0722 B on linear (decoded sRGB) channels, 0..1
//   transition          a change of Y of 0.1 or more from the last extreme the other way, where the
//                       darker side is below 0.8 (changes the same way only stretch the extreme)
//   flash               a pair of opposing transitions
//   red flash           the same on saturated red: per pixel (R - G - B) x 320 (linear, floored at 0)
//                       where R / (R + G + B) >= 0.8, else 0; a transition is a change of 20 or more
//   area                a flash counts over a sixth by a sixth of the screen (a quarter of WCAG's
//                       10-degree field estimate, a third by a third)
//   bound               at most 3 flashes, and 3 red flashes, in any one-second window
//
// Measures: regions (every 2x2-cell block of a 12x12 grid, its mean Y and red), fields (10-degree
// fields: a quarter of a field's pixels making the same transition within 3 frames, net of those
// going the other way, so small lights switching together count and a moving picture does not),
// flicker (a spectral peak 3.5-30 Hz of each cell's in-place change holding most of a 2 s window's
// power, at the same rate two windows running), rise (the hardest two-frame rise of a block's mean
// Y; bounded only when maxRise is set), motion (a run whose frames never change proves nothing).
//
// Plain JS ESM + JSDoc.

export const FLASH_DEFAULTS = Object.freeze({
  fps: 60,
  grid: 12,
  block: 2,
  field: 4,
  step: 0.1, dark: 0.8,
  redStep: 20,
  maxFlashes: 3,
  fieldShare: 0.25,
  syncFrames: 3,
  flickerAmp: 0.02,
  flickerShare: 0.6,
  flickerLo: 3.5, flickerHi: 30,
  flickerWindow: 2,
  maxRise: null,
  minMotion: 0.0005,
});

/** sRGB byte -> linear 0..1 */
export const LIN = Float32Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });

function tracker(n, step, dark) {
  const dir = new Int8Array(n), ext = new Float32Array(n), lo = new Float32Array(n), hi = new Float32Array(n);
  let first = true;
  return (vals, onT) => {
    if (first) { ext.set(vals); lo.set(vals); hi.set(vals); first = false; return; }
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      if (dir[i] === 0) {
        if (v < lo[i]) lo[i] = v;
        if (v > hi[i]) hi[i] = v;
        if (v - lo[i] >= step && lo[i] < dark) { dir[i] = 1; ext[i] = v; onT(i, 1); }
        else if (hi[i] - v >= step && v < dark) { dir[i] = -1; ext[i] = v; onT(i, -1); }
      } else if (dir[i] > 0) {
        if (v > ext[i]) ext[i] = v;
        else if (ext[i] - v >= step && v < dark) { dir[i] = -1; ext[i] = v; onT(i, -1); }
      } else {
        if (v < ext[i]) ext[i] = v;
        else if (v - ext[i] >= step && ext[i] < dark) { dir[i] = 1; ext[i] = v; onT(i, 1); }
      }
    }
  };
}

/** most flashes (floor(transitions / 2)) of one transition time list in any window of `win` frames: [count, start] */
function mostInWindow(times, win) {
  let best = 0, at = -1;
  for (let a = 0, b = 0; b < times.length; b++) {
    while (times[b] - times[a] >= win) a++;
    const f = (b - a + 1) >> 1;
    if (f > best) { best = f; at = times[a]; }
  }
  return [best, at];
}

/** flashes of one list inside [a, a + win) */
function inWindow(times, a, win) {
  let n = 0;
  for (const t of times) if (t >= a && t < a + win) n++;
  return n >> 1;
}

/**
 * A streaming analyser for w x h frames of sRGB bytes, top row first (RGB, or RGBA with channels 4).
 * @param {number} w @param {number} h @param {object} [opts] FLASH_DEFAULTS overrides, plus channels
 */
export function createFlashAnalyser(w, h, opts = {}) {
  const o = { ...FLASH_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const ch = opts.channels || 3, G = o.grid, n = w * h;
  if (w < G || h < G) throw new Error(`flash: a ${w}x${h} frame is smaller than the ${G}x${G} grid`);
  const cellOf = new Int32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cellOf[y * w + x] = Math.min(G - 1, Math.floor(y * G / h)) * G + Math.min(G - 1, Math.floor(x * G / w));
  const cellN = new Float64Array(G * G);
  for (let i = 0; i < n; i++) cellN[cellOf[i]]++;
  const blocks = [], fields = [];
  for (let by = 0; by + o.block <= G; by++) for (let bx = 0; bx + o.block <= G; bx++) blocks.push([bx, by]);
  for (let fy = 0; fy + o.field <= G; fy++) for (let fx = 0; fx + o.field <= G; fx++) fields.push([fx, fy]);
  const NB = blocks.length, NF = fields.length;
  const bY = new Float32Array(NB), bR = new Float32Array(NB);
  const blockTrack = tracker(NB, o.step, o.dark), blockRedTrack = tracker(NB, o.redStep, Infinity);
  const blockT = Array.from({ length: NB }, () => []), blockRT = Array.from({ length: NB }, () => []);
  const Y = new Float32Array(n), RD = new Float32Array(n), prevY = new Float32Array(n);
  const pixTrack = tracker(n, o.step, o.dark), pixRedTrack = tracker(n, o.redStep, Infinity);
  const lastUp = new Int32Array(n).fill(-1e9), lastDown = new Int32Array(n).fill(-1e9);
  const lastRUp = new Int32Array(n).fill(-1e9), lastRDown = new Int32Array(n).fill(-1e9);
  const fieldDir = new Int8Array(NF), fieldRDir = new Int8Array(NF);
  const fieldT = Array.from({ length: NF }, () => []), fieldRT = Array.from({ length: NF }, () => []);
  const cellUp = new Float64Array(G * G), cellDown = new Float64Array(G * G), cellRUp = new Float64Array(G * G), cellRDown = new Float64Array(G * G);
  const cellY = new Float64Array(G * G), cellR = new Float64Array(G * G);
  const history = [];
  const cellD = new Float64Array(G * G), cellA = new Float64Array(G * G), coh = new Float32Array(G * G);
  let t = 0, motion = 0, rise = 0, riseAt = -1, riseWhere = -1;
  const bHist = [new Float32Array(NB), new Float32Array(NB)];
  const onUp = (i, d) => { if (d > 0) lastUp[i] = t; else lastDown[i] = t; };
  const onRUp = (i, d) => { if (d > 0) lastRUp[i] = t; else lastRDown[i] = t; };

  function push(px) {
    if (px.length < n * ch) throw new Error(`flash: frame ${t} has ${px.length} bytes, want ${n * ch}`);
    cellY.fill(0); cellR.fill(0); cellD.fill(0); cellA.fill(0);
    let dsum = 0;
    for (let i = 0, j = 0; i < n; i++, j += ch) {
      const r = LIN[px[j]], g = LIN[px[j + 1]], b = LIN[px[j + 2]];
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b, s = r + g + b;
      const rd = s > 0 && r / s >= 0.8 ? Math.max(0, (r - g - b) * 320) : 0;
      const c = cellOf[i];
      if (t) { const d = y - prevY[i]; dsum += Math.abs(d); cellD[c] += d; cellA[c] += Math.abs(d); }
      prevY[i] = Y[i] = y; RD[i] = rd;
      cellY[c] += y; cellR[c] += rd;
    }
    if (t) motion += dsum / n;
    for (let c = 0; c < G * G; c++) { cellY[c] /= cellN[c]; cellR[c] /= cellN[c]; }
    for (let c = 0; c < G * G; c++) coh[c] = (t ? coh[c] : 0) + (cellA[c] > 0 ? (cellD[c] / cellN[c]) * (cellD[c] / cellA[c]) ** 2 : 0);
    history.push(Float32Array.from(coh));
    for (let k = 0; k < NB; k++) {
      const [bx, by] = blocks[k];
      let sy = 0, sr = 0, sn = 0;
      for (let y = by; y < by + o.block; y++) for (let x = bx; x < bx + o.block; x++) { const c = y * G + x; sy += cellY[c] * cellN[c]; sr += cellR[c] * cellN[c]; sn += cellN[c]; }
      bY[k] = sy / sn; bR[k] = sr / sn;
    }
    if (t >= 2) for (let k = 0; k < NB; k++) { const d = bY[k] - bHist[t % 2][k]; if (d > rise) { rise = d; riseAt = t; riseWhere = k; } }
    bHist[t % 2].set(bY);
    blockTrack(bY, (k) => blockT[k].push(t));
    blockRedTrack(bR, (k) => blockRT[k].push(t));
    pixTrack(Y, onUp);
    pixRedTrack(RD, onRUp);
    cellUp.fill(0); cellDown.fill(0); cellRUp.fill(0); cellRDown.fill(0);
    const since = t - o.syncFrames;
    for (let i = 0; i < n; i++) {
      const c = cellOf[i];
      if (lastUp[i] > since) cellUp[c]++;
      if (lastDown[i] > since) cellDown[c]++;
      if (lastRUp[i] > since) cellRUp[c]++;
      if (lastRDown[i] > since) cellRDown[c]++;
    }
    for (let k = 0; k < NF; k++) {
      const [fx, fy] = fields[k];
      let up = 0, down = 0, rup = 0, rdown = 0, sn = 0;
      for (let y = fy; y < fy + o.field; y++) for (let x = fx; x < fx + o.field; x++) { const c = y * G + x; up += cellUp[c]; down += cellDown[c]; rup += cellRUp[c]; rdown += cellRDown[c]; sn += cellN[c]; }
      const stepF = (dirs, list, u, d) => {
        if ((u - d) / sn > o.fieldShare && dirs[k] !== 1) { dirs[k] = 1; list[k].push(t); }
        else if ((d - u) / sn > o.fieldShare && dirs[k] !== -1) { dirs[k] = -1; list[k].push(t); }
      };
      stepF(fieldDir, fieldT, up, down);
      stepF(fieldRDir, fieldRT, rup, rdown);
    }
    t++;
  }

  function flicker() {
    const N = Math.round(o.fps * o.flickerWindow), hop = Math.max(1, o.fps >> 1), C = G * G;
    const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    const wsum = hann.reduce((a, b) => a + b, 0);
    const kLo = Math.max(1, Math.ceil(o.flickerLo * N / o.fps)), kHi = Math.min(N >> 1, Math.round(o.flickerHi * N / o.fps));
    const cosT = [], sinT = [];
    for (let k = 0; k <= N >> 1; k++) { cosT.push(Float64Array.from({ length: N }, (_, i) => Math.cos((2 * Math.PI * k * i) / N))); sinT.push(Float64Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * k * i) / N))); }
    let worst = { amp: 0, hz: 0, cell: -1, at: -1 };
    const prevPeak = new Int32Array(C).fill(-99);
    const sig = new Float64Array(N);
    for (let a = 0; a + N <= history.length; a += hop) {
      for (let c = 0; c < C; c++) {
        let m = 0;
        for (let i = 0; i < N; i++) m += history[a + i][c];
        m /= N;
        let range = 0;
        for (let i = 0; i < N; i++) { const v = history[a + i][c] - m; sig[i] = v * hann[i]; range = Math.max(range, Math.abs(v)); }
        if (range < o.flickerAmp) { prevPeak[c] = -99; continue; }
        const pw = new Float64Array((N >> 1) + 1);
        let total = 0;
        for (let k = 1; k <= N >> 1; k++) {
          let re = 0, im = 0;
          const ck = cosT[k], sk = sinT[k];
          for (let i = 0; i < N; i++) { re += sig[i] * ck[i]; im -= sig[i] * sk[i]; }
          pw[k] = re * re + im * im; total += pw[k];
        }
        let pk = -1, pv = 0;
        for (let k = kLo; k <= kHi; k++) if (pw[k] > pv) { pv = pw[k]; pk = k; }
        if (pk < 0 || total <= 0 || pw[pk - 1] > pw[pk] || (pk < N >> 1 && pw[pk + 1] > pw[pk])) { prevPeak[c] = -99; continue; }
        const near = pw[pk] + (pw[pk - 1] || 0) + (pk + 1 <= N >> 1 ? pw[pk + 1] : 0);
        const amp = (2 * Math.sqrt(near)) / wsum;
        const regular = near / total >= o.flickerShare && amp >= o.flickerAmp;
        if (regular) {
          const held = Math.abs(prevPeak[c] - pk) <= 2;
          if (held && amp > worst.amp) worst = { amp, hz: (pk * o.fps) / N, cell: c, at: a };
          prevPeak[c] = pk;
        } else prevPeak[c] = -99;
      }
    }
    return worst;
  }

  function result() {
    const most = (lists, items) => {
      let best = 0, at = -1, where = -1;
      lists.forEach((l, k) => { const [f, a] = mostInWindow(l, o.fps); if (f > best) { best = f; at = a; where = k; } });
      const it = where >= 0 ? items[where] : null;
      return { flashes: best, at, where: it ? { x: it[0] / G, y: it[1] / G } : null };
    };
    const within = (lists, a) => lists.reduce((m, l) => Math.max(m, inWindow(l, a, o.fps)), 0);
    const blockXY = blocks[riseWhere];
    const fl = flicker();
    const r = {
      frames: t, width: w, height: h, opts: o,
      regions: most(blockT, blocks), regionsRed: most(blockRT, blocks),
      fields: most(fieldT, fields), fieldsRed: most(fieldRT, fields),
      flicker: { amp: fl.amp, hz: fl.hz, at: fl.at, where: fl.cell >= 0 ? { x: (fl.cell % G) / G, y: Math.floor(fl.cell / G) / G } : null },
      rise: { amount: rise, at: riseAt, where: blockXY ? { x: blockXY[0] / G, y: blockXY[1] / G } : null },
      motion: t > 1 ? motion / (t - 1) : 0,
    };
    // the worst second: the window of the measure with the most flashes, and every measure inside it
    const pick = ["regions", "regionsRed", "fields", "fieldsRed"].reduce((b, k) => (r[k].flashes > (b ? r[b].flashes : 0) ? k : b), null);
    if (pick) {
      const a = r[pick].at;
      r.worstSecond = { measure: pick, from: a, to: a + o.fps - 1, seconds: a / o.fps,
        regions: within(blockT, a), regionsRed: within(blockRT, a), fields: within(fieldT, a), fieldsRed: within(fieldRT, a) };
    } else r.worstSecond = null;
    return r;
  }
  return { push, result, get frames() { return t; } };
}

const pct = (v) => `${Math.round(v * 100)}%`;
const atText = (m, fps) => (m.at >= 0 ? ` from frame ${m.at} (${(m.at / fps).toFixed(2)} s)` : "") + (m.where ? ` at ${pct(m.where.x)},${pct(m.where.y)} of the screen` : "");

/** the reasons a result fails its bounds ([] = it passes) */
export function judgeFlash(m) {
  const o = m.opts, why = [];
  const f = (name, r) => { if (r.flashes > o.maxFlashes) why.push(`${name}: ${r.flashes} flashes in one second (at most ${o.maxFlashes})${atText(r, o.fps)}`); };
  f("a sixth of the screen", m.regions);
  f("a sixth of the screen, red", m.regionsRed);
  f("a quarter of a 10-degree field together", m.fields);
  f("a quarter of a 10-degree field together, red", m.fieldsRed);
  if (m.flicker.amp >= o.flickerAmp) why.push(`regular flicker at ${m.flicker.hz.toFixed(1)} Hz, amplitude ${m.flicker.amp.toFixed(3)} (under ${o.flickerAmp})${atText(m.flicker, o.fps)}`);
  if (o.maxRise != null && m.rise.amount > o.maxRise) why.push(`a hard onset: a sixth of the screen rose by ${m.rise.amount.toFixed(3)} in two frames (at most ${o.maxRise})${atText(m.rise, o.fps)}`);
  if (m.motion < o.minMotion) why.push(`the frames hardly change (mean change ${m.motion.toFixed(5)} a frame, at least ${o.minMotion}): this run proves nothing`);
  return why;
}

/** one line of a result's numbers */
export function describeFlash(m) {
  return `${m.frames} frames ${m.width}x${m.height}: flashes in a second ${m.regions.flashes} (red ${m.regionsRed.flashes}), fields ${m.fields.flashes} (red ${m.fieldsRed.flashes}); ` +
    `flicker ${m.flicker.amp >= 0.001 ? `${m.flicker.amp.toFixed(3)} at ${m.flicker.hz.toFixed(1)} Hz` : "none"}; hardest two-frame rise ${m.rise.amount.toFixed(3)}; motion ${m.motion.toFixed(4)}`;
}

/**
 * The control's strobe for frame i of a run: white mixed in at `mix` on alternate halves of each
 * cycle (8 Hz: on 4 frames, off 3 or 4). Writes into `out` and returns it, or returns `rgb` itself
 * on an off frame. The same frames cartwheel's withStrobe() makes.
 */
export function strobeFrame(rgb, i, out, { hz = 8, mix = 0.7, fps = 60, color = [255, 255, 255], area = 1 } = {}) {
  const on = Math.floor((i * hz * 2) / fps) % 2 === 1;
  if (!on) return rgb;
  out.set(rgb);
  const len = Math.floor((out.length / 3) * area) * 3;
  for (let j = 0; j < len; j += 3) for (let c = 0; c < 3; c++) out[j + c] = Math.round(out[j + c] * (1 - mix) + color[c] * mix);
  return out;
}
