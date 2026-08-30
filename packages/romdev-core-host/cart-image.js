// The cartridge ROM image, as bytes plus how those bytes relate to CPU space.
//
// LibretroHost.getCartRom() calls this on a loaded core, and the MCP layer
// calls it on a plain file for memory({op:'readCart', path}). ONE derivation,
// two entry points. Nothing in it needs an
// emulator: it is per-platform header stripping plus the note explaining
// whether a file offset is a flat CPU address. Keeping ONE implementation is
// the point -- a second copy would drift, and the header sizes are exactly the
// detail that must not.
//
// Why it matters that this works without a host: reading bytes out of a ROM
// file is a static question. `disasm({target:'rom', path})` and
// `cheats({op:'make', platform})` already answer their static questions with no
// core loaded, and an agent doing romhacking spends most of its time in exactly
// that mode. `memory({op:'readCart'})` was the odd one out -- the tool whose
// whole job is reading bytes was the one that demanded a live emulator -- so a
// session whose host went away lost byte verification entirely and had to
// re-read the ROM from disk in Python.

/**
 * Derive the cart image view for `platform` from a full on-disk ROM image.
 *
 * @param {Uint8Array} raw full file image, header included
 * @param {string} platform
 * @returns {{bytes: Uint8Array, raw: Uint8Array, base: number, headerSkipped: number, mapped: boolean, platform: string, note: string}}
 */
export function cartImageFromBytes(raw, platform) {
  let headerSkipped = 0;
  let mapped = false;
  let base = 0;
  let note = "File image == CPU ROM space (un-banked): offset N is the byte the CPU fetches at ROM address N.";

  if (platform === "nes") {
    if (raw.length >= 4 && raw[0] === 0x4e && raw[1] === 0x45 && raw[2] === 0x53 && raw[3] === 0x1a) headerSkipped = 16;
    mapped = true;
    note = "NES PRG-ROM (iNES header skipped). Bytes are correct but the CPU sees them through the mapper at $8000-$FFFF — a file offset is not a flat CPU address. Use findWriter's prgOffset/bank to map a CPU PC to a PRG offset.";
  } else if (platform === "snes") {
    if ((raw.length % 1024) === 512) headerSkipped = 512;
    mapped = true;
    note = "SNES ROM (copier header skipped if present). Bytes are correct but LoROM/HiROM banking maps them into $xx:8000+ — a file offset is not a flat CPU address.";
  } else if (platform === "gba") {
    mapped = true;
    base = 0x08000000;
    note = "GBA ROM is mapped flat at 0x08000000 — CPU address = 0x08000000 + file offset.";
  }

  const bytes = headerSkipped ? raw.subarray(headerSkipped) : raw;
  return { bytes, raw, base, headerSkipped, mapped, platform, note };
}
