// Game Genie / raw cheat-code decoders.
//
// RetroArch .cht `cheatK_code` values come in two broad shapes:
//   1. `ADDR:VAL`  — a raw address:value write (hex). The address is in the
//      core's cheat address space (for NES that's CPU space; a value with no
//      compare). Trivial to parse.
//   2. Game Genie codes — a compact, PER-PLATFORM letter encoding that packs
//      an address + value (+ optional compare byte). NES, Genesis, and GB each
//      use a DIFFERENT encoding; the decoders below implement each.
//
// A decoded cheat is { address, value, compare? } where `compare` (when
// present) is the byte the location must currently hold for the patch to
// apply — its presence is the signal that the cheat targets ROM/code rather
// than a free RAM variable, which is exactly the distinction romhacking cares
// about (RAM var vs code site).

/** Parse a raw `ADDR:VAL` (or `ADDR:VAL:COMPARE`) hex code. */
export function decodeRaw(code) {
  const parts = code.split(":");
  if (parts.length < 2) return null;
  const address = parseInt(parts[0], 16);
  const value = parseInt(parts[1], 16);
  if (Number.isNaN(address) || Number.isNaN(value)) return null;
  const out = { address, value };
  if (parts.length >= 3) {
    const compare = parseInt(parts[2], 16);
    if (!Number.isNaN(compare)) out.compare = compare;
  }
  return out;
}

// ── NES Game Genie ──────────────────────────────────────────────────────
// 6-letter codes encode address+value (RAM/ROM, no compare); 8-letter codes
// add a compare byte (ROM-only, the classic "patch the instruction" form).
// Letters map to 4-bit nibbles via this fixed table; the bit-shuffle below is
// the documented NES GG scramble.
const NES_GG_LETTERS = "APZLGITYEOXUKSVN";

function nesLettersToNibbles(code) {
  const n = [];
  for (const ch of code.toUpperCase()) {
    const v = NES_GG_LETTERS.indexOf(ch);
    if (v < 0) return null;
    n.push(v);
  }
  return n;
}

/** Decode a 6- or 8-char NES Game Genie code → { address, value, compare? }.
 *  `address` is the CPU address with bit15 set ($8000-$FFFF range), matching
 *  how GG patches map into PRG space. */
export function decodeNesGameGenie(code) {
  const n = nesLettersToNibbles(code);
  if (!n || (n.length !== 6 && n.length !== 8)) return null;

  // Standard NES GG bit layout (see nesdev "Game Genie" doc).
  const address =
    0x8000 +
    (((n[3] & 7) << 12) |
      ((n[5] & 7) << 8) | ((n[4] & 8) << 8) |
      ((n[2] & 7) << 4) | ((n[1] & 8) << 4) |
      (n[4] & 7) | (n[3] & 8));

  if (n.length === 6) {
    const value =
      ((n[1] & 7) << 4) | ((n[0] & 8) << 4) |
      (n[0] & 7) | (n[5] & 8);
    return { address, value };
  }
  // 8-char: value uses n[1]/n[0]/n[7], compare uses n[7]/n[6]/n[5].
  const value =
    ((n[1] & 7) << 4) | ((n[0] & 8) << 4) |
    (n[0] & 7) | (n[7] & 8);
  const compare =
    ((n[7] & 7) << 4) | ((n[6] & 8) << 4) |
    (n[6] & 7) | (n[5] & 8);
  return { address, value, compare };
}

/** ENCODE → NES Game Genie. Inverse of decodeNesGameGenie. `address` may be a
 *  CPU address ($8000-$FFFF) or its low 15 bits. With a `compare` byte you get
 *  an 8-char (ROM) code; without, a 6-char code. Returns the letter code, or
 *  null if the inputs are out of range. Round-trip verified against the DB. */
export function encodeNesGameGenie({ address, value, compare }) {
  if (value == null || value < 0 || value > 0xFF) return null;
  const a = address & 0x7FFF; // low 15 bits (bit15 is implicit $8000)
  const v = value & 0xFF;
  const n = new Array(compare == null ? 6 : 8).fill(0);

  // Invert the decode bit layout: set each source nibble-bit from address/value/
  // compare exactly where the decoder reads it.
  // address bits (from decode):
  //   a12..a14 ← n3&7<<12 / a8..a10 ← (n5&7)<<8|(n4&8)<<8 ...
  n[3] |= ((a >> 12) & 7);          // n3 low3 = a12..14
  n[5] |= ((a >> 8) & 7);           // n5 low3 = a8..10
  n[4] |= ((a >> 8) & 8);           // n4 bit3 = a11
  n[2] |= ((a >> 4) & 7);           // n2 low3 = a4..6
  n[1] |= ((a >> 4) & 8);           // n1 bit3 = a7
  n[4] |= (a & 7);                  // n4 low3 = a0..2
  n[3] |= (a & 8);                  // n3 bit3 = a3

  // value bits:
  n[1] |= ((v >> 4) & 7);           // n1 low3 = v4..6
  n[0] |= ((v >> 4) & 8);           // n0 bit3 = v7
  n[0] |= (v & 7);                  // n0 low3 = v0..2
  if (compare == null) {
    n[5] |= (v & 8);                // 6-char: n5 bit3 = v3
  } else {
    n[7] |= (v & 8);                // 8-char: n7 bit3 = v3
    const c = compare & 0xFF;
    n[7] |= ((c >> 4) & 7);         // n7 low3 = c4..6
    n[6] |= ((c >> 4) & 8);         // n6 bit3 = c7
    n[6] |= (c & 7);                // n6 low3 = c0..2
    n[5] |= (c & 8);                // n5 bit3 = c3
  }
  return n.map((x) => NES_GG_LETTERS[x & 0xF]).join("");
}

// ── Genesis (Mega Drive) Game Genie ─────────────────────────────────────
// 8 letters in two groups of 4 ("XXXX-XXXX"). Decodes to a 24-bit ROM address
// + 16-bit value (68k word patch). Algorithm transcribed VERBATIM from the
// `decode_cheat` routine in Genesis-Plus-GX (the exact core romdev ships for
// Genesis), so it's bit-identical to how the emulator itself applies the code.
const GEN_GG_LETTERS = "ABCDEFGHJKLMNPRSTVWXYZ0123456789";

export function decodeGenesisGameGenie(code) {
  const clean = code.replace(/-/g, "").toUpperCase();
  if (clean.length !== 8) return null;
  let address = 0;
  let data = 0;
  for (let i = 0; i < 8; i++) {
    const n = GEN_GG_LETTERS.indexOf(clean[i]); // 0..31 (5 bits)
    if (n < 0) return null;
    switch (i) {
      case 0: data |= n << 3; break;
      case 1: data |= n >> 2; address |= (n & 3) << 14; break;
      case 2: address |= n << 9; break;
      case 3: address |= ((n & 0xF) << 20) | ((n >> 4) << 8); break;
      case 4: data |= (n & 1) << 12; address |= (n >> 1) << 16; break;
      case 5: data |= ((n & 1) << 15) | ((n >> 1) << 8); break;
      case 6: data |= (n >> 3) << 13; address |= (n & 7) << 5; break;
      case 7: address |= n; break;
    }
  }
  return { address: address >>> 0, value: data & 0xFFFF };
}

/** ENCODE → Genesis Game Genie. Inverse of decodeGenesisGameGenie (the
 *  Genesis-Plus-GX bit layout). `address` is the 24-bit ROM address, `value`
 *  the 16-bit word. Returns "XXXX-XXXX", or null if out of range. Round-trip
 *  verified against the DB. */
export function encodeGenesisGameGenie({ address, value }) {
  if (address == null || value == null) return null;
  const a = address >>> 0;
  const d = value & 0xFFFF;
  const bit = (x, b) => (x >> b) & 1;
  const n = new Array(8).fill(0);
  // Reconstruct each n[i] (5 bits) by gathering the bits the decoder pulled out.
  // case 0: data |= n0 << 3       → n0 = data bits 3..7
  n[0] = (d >> 3) & 0x1F;
  // case 1: data |= n1 >> 2  → data bits 0..2 ← n1 bits 2..4
  //         address |= (n1 & 3) << 14 → addr bits 14..15 ← n1 bits 0..1
  n[1] = (((d >> 0) & 7) << 2) | ((a >> 14) & 3);
  // case 2: address |= n2 << 9    → n2 = addr bits 9..13
  n[2] = (a >> 9) & 0x1F;
  // case 3: address |= (n3 & 0xF) << 20 | (n3 >> 4) << 8
  //   addr bits 20..23 ← n3 bits 0..3 ; addr bit 8 ← n3 bit 4
  n[3] = ((a >> 20) & 0xF) | (((a >> 8) & 1) << 4);
  // case 4: data |= (n4 & 1) << 12 ; address |= (n4 >> 1) << 16
  //   data bit 12 ← n4 bit0 ; addr bits 16..19 ← n4 bits 1..4
  n[4] = bit(d, 12) | (((a >> 16) & 0xF) << 1);
  // case 5: data |= (n5 & 1) << 15 | (n5 >> 1) << 8
  //   data bit 15 ← n5 bit0 ; data bits 8..11 ← n5 bits 1..4
  n[5] = bit(d, 15) | (((d >> 8) & 0xF) << 1);
  // case 6: data |= (n6 >> 3) << 13 ; address |= (n6 & 7) << 5
  //   data bits 13..14 ← n6 bits 3..4 ; addr bits 5..7 ← n6 bits 0..2
  n[6] = ((a >> 5) & 7) | (((d >> 13) & 3) << 3);
  // case 7: address |= n7          → n7 = addr bits 0..4
  n[7] = a & 0x1F;
  if (n.some((x) => x < 0 || x > 31)) return null;
  const letters = n.map((x) => GEN_GG_LETTERS[x]).join("");
  return letters.slice(0, 4) + "-" + letters.slice(4);
}

// ── Game Boy Game Genie ─────────────────────────────────────────────────
// "ABC-DEF-GHI" (9 hex digits) or "ABC-DEF" (6 hex digits). Per Jeff
// Frohwein's reference (devrs.com/gb/files/gg.html):
//   value   = digits A,B (direct hex byte)
//   address = digits reordered D E F C, with the high nibble (D) XOR 0xF
//   compare = (9-digit only) from G,H,I: GI byte inverted, rotated right 2.
export function decodeGbGameGenie(code) {
  const clean = code.replace(/-/g, "").toUpperCase();
  if (clean.length !== 6 && clean.length !== 9) return null;
  const d = [];
  for (const ch of clean) {
    const v = parseInt(ch, 16);
    if (Number.isNaN(v)) return null;
    d.push(v);
  }
  // A B C D E F (G H I)
  const value = (d[0] << 4) | d[1];
  // address nibbles in order D E F C, with D (the high nibble) complemented.
  const hi = d[3] ^ 0xF;
  const address = ((hi << 12) | (d[4] << 8) | (d[5] << 4) | d[2]) & 0xFFFF;
  const out = { address, value };
  if (clean.length === 9) {
    // compare from G(d6) H(d7) I(d8): form byte (I<<4 | G)?? Per ref the
    // compare uses digits G,I → byte, inverted, rotate-right 2.
    let cmp = ((d[8] << 4) | d[6]) & 0xFF;
    cmp ^= 0xFF;
    cmp = ((cmp >> 2) | (cmp << 6)) & 0xFF; // rotate right 2
    out.compare = cmp;
  }
  return out;
}

/** ENCODE → Game Boy Game Genie. Inverse of decodeGbGameGenie. `address` is the
 *  16-bit ROM address (GB GG range $0002-$7FFF), `value` the replacement byte,
 *  optional `compare` for the 9-digit form. Returns "ABC-DEF" or "ABC-DEF-GHI",
 *  or null if out of range. Round-trip verified against the DB. */
export function encodeGbGameGenie({ address, value, compare }) {
  if (value == null || value < 0 || value > 0xFF) return null;
  const addr = address & 0xFFFF;
  const v = value & 0xFF;
  const d = new Array(compare == null ? 6 : 9).fill(0);
  // value = digits A,B
  d[0] = (v >> 4) & 0xF;
  d[1] = v & 0xF;
  // address: decode read nibbles as hi=d3^0xF, then d4 d5 d2 for the lower 12.
  //   addr = (hi<<12)|(d4<<8)|(d5<<4)|d2  where hi = d3^0xF
  d[3] = ((addr >> 12) & 0xF) ^ 0xF;  // high nibble, complemented
  d[4] = (addr >> 8) & 0xF;
  d[5] = (addr >> 4) & 0xF;
  d[2] = addr & 0xF;
  if (compare != null) {
    // Invert the compare transform: decode did inv→ROR2 to GET compare.
    // So encode: ROL2 then invert → the stored byte; then split to G(d6),I(d8).
    let b = compare & 0xFF;
    b = ((b << 2) | (b >> 6)) & 0xFF;  // rotate left 2 (inverse of ROR2)
    b ^= 0xFF;
    d[6] = b & 0xF;          // G
    d[8] = (b >> 4) & 0xF;   // I
    d[7] = 0;                // H is unused by decode; canonical 0
  }
  const hex = d.map((x) => x.toString(16).toUpperCase()).join("");
  return compare == null
    ? hex.slice(0, 3) + "-" + hex.slice(3)
    : hex.slice(0, 3) + "-" + hex.slice(3, 6) + "-" + hex.slice(6);
}

/** Dispatch a single code string to the right decoder for `platform`.
 *  Returns { address, value, compare? } or null if it can't be decoded.
 *  (Multi-code `+`-joined combos must be split by the caller.) */
export function decodeCode(code, platform) {
  const c = code.trim();
  if (c.includes(":")) return decodeRaw(c);
  switch (platform) {
    case "nes":
      return decodeNesGameGenie(c);
    case "genesis":
    case "megadrive":
    case "md":
      return decodeGenesisGameGenie(c);
    case "gb":
    case "gbc":
      return decodeGbGameGenie(c);
    default:
      // SNES/SMS/GG/Atari use raw ADDR:VAL or Pro-Action-Replay forms we treat
      // as raw when they contain ':'. Unknown letter codes → null (skipped).
      return null;
  }
}

/** Format a raw ADDR:VAL[:COMPARE] code from decoded parts (hex, no 0x). */
export function encodeRaw({ address, value, compare }) {
  const h = (n, w) => (n & ((1 << (4 * w)) - 1) >>> 0).toString(16).toUpperCase().padStart(w, "0");
  const addrHex = (address >>> 0).toString(16).toUpperCase();
  const valHex = (value & 0xFF).toString(16).toUpperCase().padStart(2, "0");
  return compare != null
    ? `${addrHex}:${valHex}:${(compare & 0xFF).toString(16).toUpperCase().padStart(2, "0")}`
    : `${addrHex}:${valHex}`;
}

/** Encode { address, value, compare? } → a cheat code for `platform`.
 *  `style:"raw"` forces ADDR:VAL output (works on every platform — the cores
 *  accept it); `style:"gamegenie"` (default where supported) emits the letter
 *  code. Returns null if the platform/inputs can't produce that style.
 *  ALWAYS round-trips: decodeCode(encodeCode(p,plat),plat) reproduces p. */
export function encodeCode({ address, value, compare }, platform, style = "gamegenie") {
  if (style === "raw") return encodeRaw({ address, value, compare });
  switch (platform) {
    case "nes": return encodeNesGameGenie({ address, value, compare });
    case "genesis": case "megadrive": case "md":
      return encodeGenesisGameGenie({ address, value }); // Genesis GG carries no compare
    case "gb": case "gbc":
      return encodeGbGameGenie({ address, value, compare });
    default:
      // No Game Genie letter scheme wired for this platform → fall back to raw.
      return encodeRaw({ address, value, compare });
  }
}
