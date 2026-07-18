// framebuffer-png.js — PNG encode/transform over the framebuffer decoders.
//
// Split from framebuffer.js so the isomorphic core surface stays free of
// pngjs (which drags node:zlib): framebuffer.js keeps the pure typed-array
// converters; everything that produces or consumes a PNG lives here.
// LibretroHost preloads this module lazily at loadCore — where it can't load
// (a browser bundle without a pngjs shim), screenshot() explains itself and
// the typed-array surface (getFramebuffer / screenshotRgba) still works.

import { PNG } from "pngjs";
import { decodePixelsInto } from "./framebuffer.js";

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} src raw framebuffer bytes
 * @param {number} pitch bytes per row
 * @param {number} format one of RETRO_PIXEL_FORMAT_*
 * @returns {Buffer} PNG bytes
 */
export function framebufferToPng(width, height, src, pitch, format) {
  const png = new PNG({ width, height });
  decodePixelsInto(png.data, width, height, src, pitch, format);
  return PNG.sync.write(png);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} src
 * @param {number} pitch
 * @param {number} format
 * @returns {import("./types.js").ScreenshotResult}
 */
export function framebufferToScreenshot(width, height, src, pitch, format) {
  const buf = framebufferToPng(width, height, src, pitch, format);
  return { width, height, pngBase64: buf.toString("base64") };
}

/**
 * Crop a base64 PNG to {x,y,w,h} (framebuffer pixel coords, clamped to the
 * image). The HUD-verification workflow (poke a value, read the counter/bar)
 * wants a small native-res strip: far fewer image tokens than the full frame
 * AND legible, unlike a downscale. Compose with resamplePng (crop first, then
 * scale) for an enlarged detail view.
 *
 * @param {string} pngBase64 source PNG, base64-encoded
 * @param {{x?:number, y?:number, w?:number, h?:number}} crop
 * @returns {{ base64: string, width: number, height: number }}
 */
export function cropPng(pngBase64, crop) {
  const src = PNG.sync.read(Buffer.from(pngBase64, "base64"));
  const x = Math.max(0, Math.min(src.width - 1, Math.floor(crop.x ?? 0)));
  const y = Math.max(0, Math.min(src.height - 1, Math.floor(crop.y ?? 0)));
  const w = Math.max(1, Math.min(src.width - x, Math.floor(crop.w ?? (src.width - x))));
  const h = Math.max(1, Math.min(src.height - y, Math.floor(crop.h ?? (src.height - y))));
  const dst = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    const si = ((y + row) * src.width + x) * 4;
    src.data.copy(dst.data, row * w * 4, si, si + w * 4);
  }
  return { base64: PNG.sync.write(dst).toString("base64"), width: w, height: h };
}

/**
 * Nearest-neighbor resample of a base64 PNG by `scale`. Works BOTH directions:
 *   scale<1  → downscale (e.g. 0.5 = half size; ~75% fewer image tokens for a
 *              routine "did it change?" sanity check).
 *   scale>=2 → integer up-scale (e.g. 4 = 4x size) so tiny handheld targets
 *              (GB/GG 160x144, etc.) are legible inline without ImageMagick.
 *
 * Nearest-neighbor (not averaging/smoothing) is deliberate in both directions:
 * it keeps pixel-art edges crisp and palette colors exact, so a scaled shot
 * still reads accurately. The PNG is fully decoded already (it's a tiny
 * framebuffer), so this is cheap. Platform-agnostic — same pixel scaling for
 * every core.
 *
 * @param {string} pngBase64 source PNG, base64-encoded
 * @param {number} scale resample factor (>0)
 * @returns {{ base64: string, width: number, height: number }}
 */
export function resamplePng(pngBase64, scale) {
  const src = PNG.sync.read(Buffer.from(pngBase64, "base64"));
  const dw = Math.max(1, Math.round(src.width * scale));
  const dh = Math.max(1, Math.round(src.height * scale));
  const dst = new PNG({ width: dw, height: dh });
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / scale));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / scale));
      const si = (sy * src.width + sx) * 4;
      const di = (y * dw + x) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  return { base64: PNG.sync.write(dst).toString("base64"), width: dw, height: dh };
}
