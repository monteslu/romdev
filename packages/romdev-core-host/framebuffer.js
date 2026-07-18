// Framebuffer utilities: XRGB8888 / RGB565 / 0RGB1555 → RGBA typed arrays.
//
// libretro pixel layouts (little-endian, byte order on a little-endian host):
//   XRGB8888 → [B, G, R, X] per pixel, 4 bytes
//   RGB565   → low byte then high byte; bits {15..11=R, 10..5=G, 4..0=B}
//   0RGB1555 → low byte then high byte; bits {14..10=R, 9..5=G, 4..0=B}
//
// This module is part of the isomorphic core surface: pure typed-array math,
// no pngjs. PNG encode/crop/resample live in framebuffer-png.js.

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
 * rendering, or blitting to a browser canvas).
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

/** Decode into a caller-provided RGBA destination (pngjs data or a canvas
 *  ImageData buffer). Exported for framebuffer-png.js and direct blitters. */
export function decodePixelsInto(dst, width, height, src, pitch, format) {
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
