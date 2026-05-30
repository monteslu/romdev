// extractSpriteFromScreenshot — crop a region of a PNG and isolate a sprite
// from its background by flood-filling the background away. The LOSSY
// fallback for when meta-sprite capture isn't possible (no clean SAT
// composition, or the source is just a screenshot). Pure pixel work.
//
// Algorithm:
//   1. Crop to {x,y,w,h}.
//   2. Background detection:
//      - "edge-flood" (default): flood-fill inward from every border pixel,
//        marking pixels whose color is within `tolerance` of the border
//        color they're reached from as background. This removes a connected
//        background that touches the crop edges (the common case: sprite
//        floating in a field of sky/floor color).
//      - "color": treat all pixels within `tolerance` of an explicit
//        `bgColor` as background, anywhere in the crop.
//   3. If a `seed` is given, keep ONLY the connected non-background
//      component containing the seed (drops other objects/platform bits).
//   4. Emit a transparent PNG (background → alpha 0) + a debug PNG showing
//      kept (original) vs rejected (magenta) pixels.

import { PNG } from "pngjs";

function colorDist(a, ai, b, bi) {
  const dr = a[ai] - b[bi], dg = a[ai + 1] - b[bi + 1], db = a[ai + 2] - b[bi + 2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * @param {object} args
 * @param {Buffer|Uint8Array} args.pngBytes source PNG
 * @param {{x,y,w,h}} args.crop
 * @param {{x,y}} [args.seed] keep only the component containing this point
 *   (in CROP-relative coords)
 * @param {"edge-flood"|"color"} [args.backgroundMode="edge-flood"]
 * @param {[number,number,number]} [args.bgColor] for "color" mode
 * @param {number} [args.tolerance=24] color match tolerance (0-441)
 * @param {number} [args.previewScale=1]
 * @returns {{ png:Buffer, debugPng:Buffer, width:number, height:number,
 *   keptPixels:number, totalPixels:number }}
 */
export function extractSpriteFromScreenshot(args) {
  const src = PNG.sync.read(Buffer.from(args.pngBytes));
  const { x, y, w, h } = args.crop;
  if (x < 0 || y < 0 || x + w > src.width || y + h > src.height) {
    throw new Error(`crop (${x},${y} ${w}×${h}) is outside the ${src.width}×${src.height} image.`);
  }
  const tol = args.tolerance ?? 24;
  const mode = args.backgroundMode ?? "edge-flood";
  const scale = Math.max(1, args.previewScale ?? 1);

  // Crop into a w×h RGBA buffer.
  const crop = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const s = ((y + row) * src.width + (x + col)) * 4;
      const d = (row * w + col) * 4;
      crop[d] = src.data[s]; crop[d + 1] = src.data[s + 1]; crop[d + 2] = src.data[s + 2]; crop[d + 3] = src.data[s + 3];
    }
  }

  // bg[i] = true if pixel i is background.
  const bg = new Uint8Array(w * h);

  if (mode === "color") {
    const c = args.bgColor ?? [crop[0], crop[1], crop[2]];
    const ref = [c[0], c[1], c[2]];
    for (let i = 0; i < w * h; i++) if (colorDist(crop, i * 4, ref, 0) <= tol) bg[i] = 1;
  } else {
    // edge-flood: BFS from all border pixels; a pixel is background if it's
    // reachable from the edge through pixels all within tol of the seed
    // border color. We use each border pixel's own color as the local ref so
    // gradients along the border still flood.
    const q = [];
    const push = (cx, cy, ref) => {
      const i = cy * w + cx;
      if (bg[i]) return;
      if (colorDist(crop, i * 4, ref, 0) <= tol) { bg[i] = 1; q.push(i); }
    };
    for (let cx = 0; cx < w; cx++) {
      push(cx, 0, [crop[(cx) * 4], crop[(cx) * 4 + 1], crop[(cx) * 4 + 2]]);
      const bi = ((h - 1) * w + cx) * 4;
      push(cx, h - 1, [crop[bi], crop[bi + 1], crop[bi + 2]]);
    }
    for (let cy = 0; cy < h; cy++) {
      const li = (cy * w) * 4;
      push(0, cy, [crop[li], crop[li + 1], crop[li + 2]]);
      const ri = (cy * w + w - 1) * 4;
      push(w - 1, cy, [crop[ri], crop[ri + 1], crop[ri + 2]]);
    }
    while (q.length) {
      const i = q.pop();
      const cx = i % w, cy = (i / w) | 0;
      const ref = [crop[i * 4], crop[i * 4 + 1], crop[i * 4 + 2]];
      if (cx > 0) push(cx - 1, cy, ref);
      if (cx < w - 1) push(cx + 1, cy, ref);
      if (cy > 0) push(cx, cy - 1, ref);
      if (cy < h - 1) push(cx, cy + 1, ref);
    }
  }

  // Optional: keep only the connected non-background component at `seed`.
  if (args.seed) {
    const sx = args.seed.x, sy = args.seed.y;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
      throw new Error(`seed (${sx},${sy}) is outside the crop (${w}×${h}); seed is crop-relative.`);
    }
    const seedI = sy * w + sx;
    if (bg[seedI]) {
      throw new Error(`seed pixel is classified as background — pick a seed on the sprite, or raise tolerance/switch backgroundMode.`);
    }
    const keep = new Uint8Array(w * h);
    const q = [seedI]; keep[seedI] = 1;
    while (q.length) {
      const i = q.pop(); const cx = i % w, cy = (i / w) | 0;
      const tryN = (nx, ny) => { const ni = ny * w + nx; if (!bg[ni] && !keep[ni]) { keep[ni] = 1; q.push(ni); } };
      if (cx > 0) tryN(cx - 1, cy);
      if (cx < w - 1) tryN(cx + 1, cy);
      if (cy > 0) tryN(cx, cy - 1);
      if (cy < h - 1) tryN(cx, cy + 1);
    }
    // Everything not in the kept component becomes background.
    for (let i = 0; i < w * h; i++) if (!keep[i]) bg[i] = 1;
  }

  // Build the transparent output + debug image.
  let kept = 0;
  const out = new PNG({ width: w * scale, height: h * scale });
  const dbg = new PNG({ width: w * scale, height: h * scale });
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const i = row * w + col;
      const isBg = !!bg[i];
      if (!isBg) kept++;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const o = ((row * scale + sy) * (w * scale) + (col * scale + sx)) * 4;
          // transparent output
          out.data[o] = crop[i * 4]; out.data[o + 1] = crop[i * 4 + 1]; out.data[o + 2] = crop[i * 4 + 2];
          out.data[o + 3] = isBg ? 0 : 0xFF;
          // debug: kept = original, rejected = magenta
          if (isBg) { dbg.data[o] = 0xFF; dbg.data[o + 1] = 0x00; dbg.data[o + 2] = 0xFF; dbg.data[o + 3] = 0xFF; }
          else { dbg.data[o] = crop[i * 4]; dbg.data[o + 1] = crop[i * 4 + 1]; dbg.data[o + 2] = crop[i * 4 + 2]; dbg.data[o + 3] = 0xFF; }
        }
      }
    }
  }
  return {
    png: PNG.sync.write(out),
    debugPng: PNG.sync.write(dbg),
    width: w, height: h,
    keptPixels: kept, totalPixels: w * h,
  };
}
