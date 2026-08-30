// The sync32 GAME FOLDER and ARCHIVE forms (ABI 3.2-3.4).
//
// A cart ships in one of three shapes, all built from the same executable:
//
//   game.s32          the bare executable, launchable on its own
//   game/             a folder: main.s32e + info.txt + icon.bmp + resources
//   game.s32 (tar)    that folder packed into one file
//
// A game that reads resources through the disk API needs the folder or the
// archive, because its namespace has to travel with it. The archive is an
// UNCOMPRESSED, SORTED, plain-ustar tar and nothing more — the firmware walks
// it with a 512-byte header scan and no index, which is exactly why tar was
// chosen (ABI 3.4). `tar cf game.s32 -C gamedir .` produces the same bytes.
//
// This is a JS port of the SDK's tools/s32pack.py. romdev builds carts with no
// Python on PATH, so the packaging step cannot shell out to it.

const BLOCK = 512;
const RESERVED = new Set(["main.s32e", "info.txt", "icon.bmp", ".s32id"]);

/** Octal field, NUL-terminated, exactly as GNU tar/python tarfile write it. */
function octal(value, width) {
  const s = value.toString(8).padStart(width - 1, "0").slice(-(width - 1));
  return s + "\0";
}

function writeAscii(buf, offset, text, width) {
  const bytes = new TextEncoder().encode(text);
  buf.set(bytes.subarray(0, width), offset);
}

/**
 * One 512-byte ustar header.
 *
 * uid/gid/uname/gname default to 0/"root" rather than the building user's:
 * a cart image should not carry whoever happened to compile it, and the
 * firmware ignores these fields entirely.
 */
function ustarHeader({ name, size, mtime = 0, mode = 0o644, uname = "root", gname = "root", uid = 0, gid = 0 }) {
  if (new TextEncoder().encode(name).length > 100) {
    throw new Error(`'${name}' is too long for a ustar header (100 bytes max) — rename the resource`);
  }
  const h = new Uint8Array(BLOCK);
  writeAscii(h, 0, name, 100);
  writeAscii(h, 100, octal(mode, 8), 8);
  writeAscii(h, 108, octal(uid, 8), 8);
  writeAscii(h, 116, octal(gid, 8), 8);
  writeAscii(h, 124, octal(size, 12), 12);
  writeAscii(h, 136, octal(mtime, 12), 12);
  h.fill(0x20, 148, 156);            // checksum field is spaces while summing
  h[156] = 0x30;                     // typeflag '0' = regular file
  writeAscii(h, 257, "ustar\0", 6);
  writeAscii(h, 263, "00", 2);
  writeAscii(h, 265, uname, 32);
  writeAscii(h, 297, gname, 32);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  // Checksum: 6 octal digits, NUL, space — the historical layout.
  writeAscii(h, 148, octal(sum, 7), 7);
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

/**
 * Pack a game's files into a .s32 archive.
 *
 * @param {Record<string, Uint8Array>} files name → bytes. `main.s32e` is
 *   required: a folder without it is not a game (ABI 3.2).
 * @param {{mtime?: number}} [opts] mtime is fixed at 0 by default so the same
 *   inputs always produce the same archive — a build that changes its bytes
 *   every run cannot be diffed or checksummed.
 * @returns {Uint8Array}
 */
export function packS32Archive(files, opts = {}) {
  if (!files || !files["main.s32e"]) {
    throw new Error("a sync32 archive needs `main.s32e` (the packed executable) — without it, it is not a game (ABI 3.2)");
  }
  const mtime = opts.mtime ?? 0;
  // Sorted, matching s32pack.py's `sorted(os.listdir(...))`.
  const names = Object.keys(files).sort();
  const chunks = [];
  let total = 0;
  for (const name of names) {
    const data = files[name];
    const header = ustarHeader({ name, size: data.length, mtime });
    chunks.push(header);
    chunks.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(new Uint8Array(pad));
    total += BLOCK + data.length + pad;
  }
  // Two zero blocks terminate the archive.
  const trailer = new Uint8Array(BLOCK * 2);
  chunks.push(trailer);
  total += trailer.length;

  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * The `info.txt` the launcher reads for a folder/archive game (ABI 3.3).
 * Byte-for-byte what s32pack.py writes, so a folder staged here and one staged
 * by the SDK are interchangeable.
 */
export function buildInfoTxt(title) {
  return "# sync32 game info. key = value, '#' comments, blank lines ok.\n" +
    `title = ${title}\n`;
}

/**
 * Validate a launcher icon. Warns rather than throws, mirroring s32pack.py:
 * the launcher ignores a bad icon and draws its own, so a wrong icon must
 * never fail a build.
 * @returns {string|null} why it will be ignored, or null if fine
 */
export function checkIconBmp(bytes) {
  if (!bytes || bytes.length < 54) return "not a BMP";
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) return "not a BMP";
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hdr = dv.getUint32(14, true);
  const w = dv.getInt32(18, true);
  const h = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true);
  const comp = dv.getUint32(30, true);
  if (hdr < 40) return "not a BITMAPINFOHEADER";
  if (w !== 16 || Math.abs(h) !== 16) return `${w}x${Math.abs(h)}, must be 16x16`;
  if (bpp !== 24 && bpp !== 32) return `${bpp} bpp, must be 24 or 32`;
  if (comp !== 0) return "compressed";
  return null;
}

/** Names the console owns inside a game namespace. */
export { RESERVED };
