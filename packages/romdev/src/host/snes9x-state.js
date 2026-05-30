// Shared helpers for parsing snes9x's libretro savestate blob.
//
// Block header format (from snes9x src/snapshot.cpp FreezeBlock):
//   "<3-char name>:<6-digit ASCII length>:<binary payload>"
// 11 bytes of header, then `length` bytes of payload.

/**
 * Locate a named block in a snes9x savestate. Returns the offset of the
 * first payload byte (after the 11-byte header), or -1 if not found.
 *
 * Validates the 6 length bytes are ASCII digits AND followed by ':' so
 * we don't false-positive on payload bytes that happen to spell "SND:".
 *
 * @param {Uint8Array} state
 * @param {string} name 3-character block name (e.g. "REG", "SND", "PPU")
 * @returns {number}
 */
export function findSnes9xBlock(state, name) {
  if (name.length !== 3) throw new Error("snes9x block names are 3 chars");
  const c0 = name.charCodeAt(0);
  const c1 = name.charCodeAt(1);
  const c2 = name.charCodeAt(2);
  for (let i = 0; i < state.length - 11; i++) {
    if (state[i] !== c0 || state[i + 1] !== c1 || state[i + 2] !== c2) continue;
    if (state[i + 3] !== 0x3A) continue; // ':'
    let allDigits = true;
    for (let j = 0; j < 6; j++) {
      const c = state[i + 4 + j];
      if (c < 0x30 || c > 0x39) { allDigits = false; break; }
    }
    if (!allDigits || state[i + 10] !== 0x3A) continue;
    return i + 11;
  }
  return -1;
}
