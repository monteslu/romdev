// Framebuffer utilities. XRGB8888 / RGB565 / 0RGB1555 → PNG (base64).
//
// libretro pixel layouts (little-endian, byte order on a little-endian host):
//   XRGB8888 → [B, G, R, X] per pixel, 4 bytes
//   RGB565   → low byte then high byte; bits {15..11=R, 10..5=G, 4..0=B}
//   0RGB1555 → low byte then high byte; bits {14..10=R, 9..5=G, 4..0=B}
//
// pngjs expects [R, G, B, A] per pixel.

import { PNG } from "pngjs";
import {
  RETRO_PIXEL_FORMAT_0RGB1555,
  RETRO_PIXEL_FORMAT_RGB565,
  RETRO_PIXEL_FORMAT_XRGB8888,
  ROMDEV_PIXEL_FORMAT_RGBA8888,
} from "./retroConstants.js";

/**
 * Convert a libretro framebuffer to a flat RGBA8888 Uint8Array (one
 * row at a time, no padding). Same pixel-format decode as
 * framebufferToPng but skips the PNG encode step — useful when the
 * caller wants raw pixels (e.g. piping into chafa-wasm for ASCII
 * rendering).
 *
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} src raw framebuffer bytes
 * @param {number} pitch bytes per row
 * @param {number} format one of RETRO_PIXEL_FORMAT_*
 * @returns {Uint8Array} `width * height * 4` bytes, RGBA order
 */
export function framebufferToRgba(width, height, src, pitch, format) {
  const dst = new Uint8Array(width * height * 4);
  decodePixelsInto(dst, width, height, src, pitch, format);
  return dst;
}

function decodePixelsInto(dst, width, height, src, pitch, format) {
  if (format === ROMDEV_PIXEL_FORMAT_RGBA8888) {
    // HW-render readback: already RGBA. Copy RGB row-by-row but FORCE alpha=255 —
    // the N64/PS1 GL framebuffer leaves alpha at 0 (it's the render target's unused
    // channel), which would make every pixel transparent → composites to white.
    for (let y = 0; y < height; y++) {
      const sRow = y * pitch, dRow = y * width * 4;
      for (let x = 0; x < width; x++) {
        const s = sRow + x * 4, d = dRow + x * 4;
        dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2];
        dst[d + 3] = 0xff;
      }
    }
  } else if (format === RETRO_PIXEL_FORMAT_XRGB8888) {
    for (let y = 0; y < height; y++) {
      const srcRow = y * pitch;
      const dstRow = y * width * 4;
      for (let x = 0; x < width; x++) {
        const s = srcRow + x * 4;
        const d = dstRow + x * 4;
        dst[d + 0] = src[s + 2]; // R
        dst[d + 1] = src[s + 1]; // G
        dst[d + 2] = src[s + 0]; // B
        dst[d + 3] = 0xff;
      }
    }
  } else if (format === RETRO_PIXEL_FORMAT_RGB565) {
    for (let y = 0; y < height; y++) {
      const srcRow = y * pitch;
      const dstRow = y * width * 4;
      for (let x = 0; x < width; x++) {
        const s = srcRow + x * 2;
        const pix = src[s] | (src[s + 1] << 8);
        const r = (pix >> 11) & 0x1f;
        const g = (pix >> 5) & 0x3f;
        const b = pix & 0x1f;
        const d = dstRow + x * 4;
        dst[d + 0] = (r << 3) | (r >> 2);
        dst[d + 1] = (g << 2) | (g >> 4);
        dst[d + 2] = (b << 3) | (b >> 2);
        dst[d + 3] = 0xff;
      }
    }
  } else if (format === RETRO_PIXEL_FORMAT_0RGB1555) {
    for (let y = 0; y < height; y++) {
      const srcRow = y * pitch;
      const dstRow = y * width * 4;
      for (let x = 0; x < width; x++) {
        const s = srcRow + x * 2;
        const pix = src[s] | (src[s + 1] << 8);
        const r = (pix >> 10) & 0x1f;
        const g = (pix >> 5) & 0x1f;
        const b = pix & 0x1f;
        const d = dstRow + x * 4;
        dst[d + 0] = (r << 3) | (r >> 2);
        dst[d + 1] = (g << 3) | (g >> 2);
        dst[d + 2] = (b << 3) | (b >> 2);
        dst[d + 3] = 0xff;
      }
    }
  } else {
    throw new Error(`Unsupported pixel format ${format}`);
  }
}

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
