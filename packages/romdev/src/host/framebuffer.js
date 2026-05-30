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
  if (format === RETRO_PIXEL_FORMAT_XRGB8888) {
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
