// The sync32 executable container: a 64-byte header, the flat image, and an
// optional 16x16 icon. A port of the SDK's tools/mks32.py, byte-for-byte.
//
// Two things the Python does with external processes, this does in-process:
// it reads `_start` out of the ELF symbol table directly (mks32 shells out to
// `arm-none-eabi-nm`), and the caller hands us the flat image objcopy already
// produced. That keeps the whole cart build inside WASM + JS with no native
// binaries and no Python on PATH.

const MAGIC = 0x32335953; // "SY32" little-endian
const HEADER_BYTES = 64;

// Where the loader maps the image, per mode. The entry offset stored in the
// header is `_start - base`, so these MUST match the SDK's linker scripts
// (crt0/ram.ld and crt0/xip.ld).
const BASE_RAM = 0x20030000;
const BASE_XIP = 0x10100000;

/**
 * Read a symbol's address out of a little-endian ELF32 symbol table.
 * @param {Uint8Array} elf
 * @param {string} want
 * @returns {number}
 */
export function elfSymbolAddress(elf, want) {
  const dv = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (!(elf[0] === 0x7f && elf[1] === 0x45 && elf[2] === 0x4c && elf[3] === 0x46)) {
    throw new Error("not an ELF file");
  }
  const shoff = dv.getUint32(0x20, true);
  const shentsize = dv.getUint16(0x2e, true);
  const shnum = dv.getUint16(0x30, true);
  const SH = (i) => {
    const o = shoff + i * shentsize;
    return {
      type: dv.getUint32(o + 4, true),
      offset: dv.getUint32(o + 16, true),
      size: dv.getUint32(o + 20, true),
      link: dv.getUint32(o + 24, true),
      entsize: dv.getUint32(o + 36, true),
    };
  };
  const readStr = (base, off) => {
    let end = base + off;
    while (end < elf.length && elf[end] !== 0) end++;
    return new TextDecoder().decode(elf.subarray(base + off, end));
  };
  for (let i = 0; i < shnum; i++) {
    const s = SH(i);
    if (s.type !== 2) continue; // SHT_SYMTAB
    const strtab = SH(s.link).offset;
    const step = s.entsize || 16;
    for (let o = s.offset; o < s.offset + s.size; o += step) {
      const nameOff = dv.getUint32(o, true);
      if (!nameOff) continue;
      if (readStr(strtab, nameOff) === want) return dv.getUint32(o + 4, true);
    }
  }
  throw new Error(`symbol '${want}' not found in the linked ELF`);
}

/** CRC-32 (IEEE), matching Python's zlib.crc32. */
export function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

/**
 * Wrap a flat image in the sync32 header.
 *
 * @param {Object} a
 * @param {Uint8Array} a.image flat binary (objcopy -O binary)
 * @param {Uint8Array} a.elf the linked ELF, for `_start`
 * @param {"ram"|"xip"} [a.mode]
 * @param {string} [a.title] 16 bytes, truncated
 * @param {string} [a.id] 8 bytes, truncated
 * @param {"240"|"180"} [a.video]
 * @param {number} [a.api]
 * @param {Uint8Array} [a.icon] 512-byte RGB565 16x16, optional
 * @returns {{bytes: Uint8Array, entryOffset: number}}
 */
export function packS32({ image, elf, mode = "ram", title = "untitled", id = "00000000", video = "240", api = 1, icon }) {
  const base = mode === "ram" ? BASE_RAM : BASE_XIP;
  // The thumb bit is cleared here; the loader sets it when it branches.
  const entry = elfSymbolAddress(elf, "_start") & ~1;
  const entryOffset = entry - base;
  if (entryOffset < 0 || entryOffset >= image.length) {
    throw new Error(
      `entry _start=0x${entry.toString(16)} is outside the ${mode} image ` +
      `(base 0x${base.toString(16)}, ${image.length} bytes) — wrong linker script for this mode?`
    );
  }
  if (icon && icon.length !== 512) throw new Error(`icon must be 512 bytes (16x16 RGB565), got ${icon.length}`);

  const iconBytes = icon ?? new Uint8Array(0);
  const iconOff = iconBytes.length ? HEADER_BYTES + image.length : 0;
  const total = HEADER_BYTES + image.length + iconBytes.length;

  const payload = new Uint8Array(image.length + iconBytes.length);
  payload.set(image, 0);
  if (iconBytes.length) payload.set(iconBytes, image.length);

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint32(o, MAGIC, true); o += 4;
  dv.setUint16(o, 1, true); o += 2;                    // container version
  dv.setUint16(o, api, true); o += 2;                  // minimum api_version
  dv.setUint32(o, total, true); o += 4;
  dv.setUint32(o, crc32(payload), true); o += 4;
  dv.setUint32(o, HEADER_BYTES, true); o += 4;         // image offset
  dv.setUint32(o, image.length, true); o += 4;
  dv.setUint32(o, entryOffset, true); o += 4;
  out[o++] = mode === "ram" ? 0 : 1;
  out[o++] = video === "240" ? 0 : 1;
  out[o++] = 0;
  out[o++] = 0;
  const put = (s, n) => {
    const b = new TextEncoder().encode(String(s)).subarray(0, n);
    out.set(b, o); o += n;
  };
  put(title, 16);
  put(id, 8);
  dv.setUint32(o, iconOff, true); o += 4;
  dv.setUint32(o, 0, true); o += 4;                    // reserved
  if (o !== HEADER_BYTES) throw new Error(`header is ${o} bytes, expected ${HEADER_BYTES}`);

  out.set(payload, HEADER_BYTES);
  return { bytes: out, entryOffset };
}

export { HEADER_BYTES, BASE_RAM, BASE_XIP };
