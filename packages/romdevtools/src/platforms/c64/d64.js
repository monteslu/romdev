// C64 1541 disk image (.d64) codec — pure JS, no external tools.
//
// Why this exists: romdev builds C64 homebrew as a bare `.prg` (cc65's output),
// but the real C64 world — the new Commodore 64 Ultimate / C64C Ultimate FPGA
// hardware and the entire homebrew/demo scene — loads games as `.d64` disk
// images (and saves by writing files back INTO the disk). A `.prg` with no
// drive can't save and isn't how anything ships. This module is the bridge:
//
//   prgToD64(prg, {name})        — pack a .prg into a fresh, autostart-able .d64
//   readDirectory(d64)           — list the files on a disk image
//   extractFile(d64, name)       — pull a file's bytes back out (post-save read)
//
// Format reference: the standard 35-track 1541 image (174848 bytes). 256-byte
// sectors, variable sectors per track. Track 18 holds the BAM (sector 0) and
// the directory (sectors 1+). Files are PETSCII-named, stored as linked sector
// chains where each sector's first two bytes are (nextTrack, nextSector) — or
// (0x00, lastByteIndex) on the final sector. This is the well-documented "D64"
// layout used by VICE's c1541 and every C64 emulator.

const SECTOR_SIZE = 256;
const NUM_TRACKS = 35;
const DIR_TRACK = 18;
const BAM_SECTOR = 0;
const DIR_START_SECTOR = 1;

// Sectors per track for a 35-track 1541 disk (zones 1-4).
// Tracks 1-17: 21, 18-24: 19, 25-30: 18, 31-35: 17.
const SECTORS_PER_TRACK = (() => {
  const a = new Array(NUM_TRACKS + 1).fill(0); // 1-indexed
  for (let t = 1; t <= NUM_TRACKS; t++) {
    if (t <= 17) a[t] = 21;
    else if (t <= 24) a[t] = 19;
    else if (t <= 30) a[t] = 18;
    else a[t] = 17;
  }
  return a;
})();

const TOTAL_SECTORS = (() => {
  let n = 0;
  for (let t = 1; t <= NUM_TRACKS; t++) n += SECTORS_PER_TRACK[t];
  return n; // 683
})();

const IMAGE_SIZE = TOTAL_SECTORS * SECTOR_SIZE; // 174848

/** Byte offset of (track, sector) within the flat image. track is 1-indexed. */
function offsetOf(track, sector) {
  let off = 0;
  for (let t = 1; t < track; t++) off += SECTORS_PER_TRACK[t] * SECTOR_SIZE;
  return off + sector * SECTOR_SIZE;
}

/** Convert an ASCII string to PETSCII-ish bytes, padded/truncated to `len` with 0xA0 (shifted space). */
function petsciiName(name, len = 16) {
  const out = new Uint8Array(len).fill(0xa0);
  const s = String(name || "").toUpperCase();
  for (let i = 0; i < len && i < s.length; i++) {
    const c = s.charCodeAt(i);
    // ASCII A-Z, 0-9, space, and common punctuation map ~1:1 to PETSCII for
    // these ranges; anything exotic falls back to a space.
    out[i] = c >= 0x20 && c <= 0x5f ? c : 0x20;
  }
  return out;
}

/**
 * Convert a PETSCII directory name (as stored on disk) back to a trimmed ASCII
 * string. Filenames written by the C64 KERNAL SAVE use the DEFAULT uppercase
 * charset, where letters A–Z are 0xC1–0xDA (high bit set), not 0x41–0x5A — so we
 * must translate that range, otherwise an emulator-written "SCORE" reads as
 * empty. (Our own prgToD64 writes plain 0x41–0x5A; both must decode.)
 */
function asciiFromPetscii(bytes) {
  let s = "";
  for (const b of bytes) {
    if (b === 0xa0 || b === 0x00) break; // shifted-space pad / terminator
    if (b >= 0xc1 && b <= 0xda) {
      s += String.fromCharCode(b - 0x80);          // PETSCII upper A–Z (0xC1..) → ASCII
    } else if (b >= 0x20 && b <= 0x5f) {
      s += String.fromCharCode(b);                 // plain ASCII / digits / punctuation
    } else if (b >= 0x61 && b <= 0x7a) {
      s += String.fromCharCode(b - 0x20);          // PETSCII lower-as-upper → ASCII upper
    }
    // anything else (graphics chars etc.) is dropped from the readable name
  }
  return s.trim();
}

/**
 * Pack a `.prg` (2-byte little-endian load address + body) into a fresh,
 * autostart-able 1541 `.d64` image. The file is written as a single PRG-type
 * directory entry named `name` (default "GAME"). The disk is otherwise empty.
 *
 * @param {Uint8Array|Buffer} prg  the raw .prg bytes (load addr + program)
 * @param {object} [opts]
 * @param {string} [opts.name]      file name (PETSCII, ≤16 chars) — default "GAME"
 * @param {string} [opts.diskName]  disk label (≤16 chars) — default = name
 * @param {string} [opts.diskId]    2-char disk id — default "RD"
 * @returns {Uint8Array} a 174848-byte .d64 image
 */
export function prgToD64(prg, opts = {}) {
  const body = prg instanceof Uint8Array ? prg : new Uint8Array(prg);
  if (body.length < 2) throw new Error("prgToD64: .prg too small (need ≥2 bytes load address)");
  const fileName = opts.name || "GAME";
  const diskName = opts.diskName || fileName;
  const diskId = (opts.diskId || "RD").slice(0, 2).padEnd(2, " ");

  const img = new Uint8Array(IMAGE_SIZE);

  // ---- Lay the file out as a linked sector chain ----------------------------
  // Files conventionally start on track 1; we walk forward, skipping the
  // directory track (18). 254 data bytes per sector (2 bytes are the link).
  const dataPerSector = SECTOR_SIZE - 2;
  const numSectors = Math.ceil(body.length / dataPerSector) || 1;

  // Pick a sector list (track, sector) for the file, skipping the dir track.
  const chain = [];
  let track = 1;
  let sector = 0;
  for (let i = 0; i < numSectors; i++) {
    // advance to a free (track,sector), skipping the directory track
    while (track === DIR_TRACK || sector >= SECTORS_PER_TRACK[track]) {
      if (sector >= SECTORS_PER_TRACK[track]) { track++; sector = 0; }
      if (track === DIR_TRACK) { track++; sector = 0; }
      if (track > NUM_TRACKS) throw new Error("prgToD64: file too large for a 35-track disk");
    }
    chain.push([track, sector]);
    sector++;
  }

  // Write the chain.
  for (let i = 0; i < chain.length; i++) {
    const [t, s] = chain[i];
    const base = offsetOf(t, s);
    const isLast = i === chain.length - 1;
    const sliceStart = i * dataPerSector;
    const sliceEnd = Math.min(sliceStart + dataPerSector, body.length);
    const chunk = body.subarray(sliceStart, sliceEnd);
    if (isLast) {
      img[base] = 0x00;                 // next track = 0 → end of file
      img[base + 1] = chunk.length + 1; // bytes-used-in-this-sector index
    } else {
      const [nt, ns] = chain[i + 1];
      img[base] = nt;
      img[base + 1] = ns;
    }
    img.set(chunk, base + 2);
  }

  const fileBlocks = chain.length;

  // ---- BAM (track 18, sector 0) --------------------------------------------
  const bam = offsetOf(DIR_TRACK, BAM_SECTOR);
  img[bam + 0] = DIR_TRACK;        // first directory track
  img[bam + 1] = DIR_START_SECTOR; // first directory sector
  img[bam + 2] = 0x41;             // 'A' = 1541 disk format
  img[bam + 3] = 0x00;

  // Per-track free-sector bitmap: 4 bytes each for tracks 1..35 at +4.
  // byte0 = free count, bytes1-3 = bitmap (bit set = sector free).
  for (let t = 1; t <= NUM_TRACKS; t++) {
    const e = bam + 4 + (t - 1) * 4;
    const spt = SECTORS_PER_TRACK[t];
    let freeMask = 0;
    for (let s = 0; s < spt; s++) freeMask |= (1 << s);
    // mark used: any sector in our file chain, plus track 18 sectors 0 & 1
    let used = new Set();
    if (t === DIR_TRACK) { used.add(BAM_SECTOR); used.add(DIR_START_SECTOR); }
    for (const [ct, cs] of chain) if (ct === t) used.add(cs);
    for (const s of used) freeMask &= ~(1 << s);
    let freeCount = 0;
    for (let s = 0; s < spt; s++) if (freeMask & (1 << s)) freeCount++;
    img[e + 0] = freeCount;
    img[e + 1] = freeMask & 0xff;
    img[e + 2] = (freeMask >> 8) & 0xff;
    img[e + 3] = (freeMask >> 16) & 0xff;
  }

  // Disk name (+0x90, 16 bytes, 0xA0 padded), then id + dos type.
  img.set(petsciiName(diskName, 16), bam + 0x90);
  img[bam + 0xa0] = 0xa0;
  img[bam + 0xa1] = 0xa0;
  img[bam + 0xa2] = diskId.charCodeAt(0);
  img[bam + 0xa3] = diskId.charCodeAt(1);
  img[bam + 0xa4] = 0xa0;
  img[bam + 0xa5] = 0x32; // '2'  DOS version
  img[bam + 0xa6] = 0x41; // 'A'
  for (let i = 0xa7; i <= 0xaa; i++) img[bam + i] = 0xa0;

  // ---- Directory entry (track 18, sector 1, first slot) --------------------
  const dir = offsetOf(DIR_TRACK, DIR_START_SECTOR);
  img[dir + 0] = 0x00; // next dir track = 0 (only one dir sector)
  img[dir + 1] = 0xff; // next dir sector = 0xff (last in chain)
  // entry: file type (0x82 = closed PRG), then first (track,sector)
  img[dir + 2] = 0x82;
  img[dir + 3] = chain[0][0];
  img[dir + 4] = chain[0][1];
  img.set(petsciiName(fileName, 16), dir + 5);
  // bytes 0x15-0x1d: REL side info / unused for PRG → 0
  img[dir + 0x1e] = fileBlocks & 0xff;        // block count low
  img[dir + 0x1f] = (fileBlocks >> 8) & 0xff; // block count high

  return img;
}

/**
 * Read the directory of a `.d64` image.
 * @param {Uint8Array|Buffer} d64
 * @returns {Array<{name:string, type:string, track:number, sector:number, blocks:number}>}
 */
export function readDirectory(d64) {
  const img = d64 instanceof Uint8Array ? d64 : new Uint8Array(d64);
  const TYPES = ["DEL", "SEQ", "PRG", "USR", "REL"];
  const out = [];
  let t = DIR_TRACK, s = DIR_START_SECTOR;
  const seen = new Set();
  while (t !== 0 && !seen.has(`${t},${s}`)) {
    seen.add(`${t},${s}`);
    const base = offsetOf(t, s);
    const nextT = img[base + 0];
    const nextS = img[base + 1];
    // 8 entries per sector, 32 bytes each, first entry at +2 then every +32.
    for (let e = 0; e < 8; e++) {
      const entryBase = base + (e === 0 ? 2 : 2 + e * 32);
      const typeByte = img[entryBase + 0];
      if ((typeByte & 0x0f) === 0 && typeByte === 0) continue; // empty slot
      const ft = img[entryBase + 0];
      const ftrack = img[entryBase + 1];
      const fsector = img[entryBase + 2];
      const nameBytes = img.subarray(entryBase + 3, entryBase + 3 + 16);
      const name = asciiFromPetscii(nameBytes);
      if (!name) continue;
      const blocks = img[entryBase + 0x1c] | (img[entryBase + 0x1d] << 8);
      out.push({ name, type: TYPES[ft & 0x07] || "DEL", track: ftrack, sector: fsector, blocks });
    }
    t = nextT; s = nextS;
  }
  return out;
}

/**
 * Extract a file's raw bytes (including its 2-byte load address for PRG) from a
 * `.d64`, by following its sector chain. If `name` is omitted, the first file
 * is returned.
 * @param {Uint8Array|Buffer} d64
 * @param {string} [name]
 * @returns {Uint8Array|null} file bytes, or null if not found
 */
export function extractFile(d64, name) {
  const img = d64 instanceof Uint8Array ? d64 : new Uint8Array(d64);
  const dir = readDirectory(img);
  const entry = name
    ? dir.find((d) => d.name.toUpperCase() === String(name).toUpperCase())
    : dir[0];
  if (!entry) return null;

  const bytes = [];
  let t = entry.track, s = entry.sector;
  const seen = new Set();
  while (t !== 0 && !seen.has(`${t},${s}`)) {
    seen.add(`${t},${s}`);
    const base = offsetOf(t, s);
    const nextT = img[base + 0];
    const nextS = img[base + 1];
    if (nextT === 0) {
      // last sector: nextS is the index of the last valid byte (+1 over data)
      const used = nextS; // bytes 2..used hold data
      for (let i = 2; i <= used && base + i < img.length; i++) bytes.push(img[base + i]);
      break;
    } else {
      for (let i = 2; i < SECTOR_SIZE; i++) bytes.push(img[base + i]);
    }
    t = nextT; s = nextS;
  }
  return new Uint8Array(bytes);
}

export const D64_IMAGE_SIZE = IMAGE_SIZE;
export const D64_DISK_EXTENSIONS = [".d64", ".d71", ".d81", ".g64", ".t64", ".tap", ".crt", ".p00"];
