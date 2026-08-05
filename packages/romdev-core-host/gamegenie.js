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
    /*
     * Bit 3 of the THIRD letter is the 8-character marker. fceumm (the core
     * romdev ships) reads it at cheat.c:349 and the check is COMMENTED OUT --
     *     t = GGtobin(*str++);
     *     A |= (t & 0x07) << 4;
     *     // if(t&0x08) return(0);   // 8-character code?!
     * -- so the core accepts a code with the bit either way, and `& 0x07`
     * means the bit never contributes to the address.
     *
     * We deliberately do NOT set it. Published 8-letter codes disagree about
     * it (GATKGATX, verified working in test/feedback-0138-fixes.test.js, has
     * it CLEAR; many others have it SET), so there is no single correct value
     * to emit, and forcing it changes the text of codes that already work.
     * Leaving it clear keeps every emitted code decodable by fceumm and by
     * our own decoder, which branches on length rather than this bit.
     */
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
// "ABC-DEF-GHI" (9 hex digits) or "ABC-DEF" (6 hex digits).
//
// Transcribed VERBATIM from `Cartridge::applyGameGenie` in gambatte
// (src/mem/cartridge.cpp) — the exact core romdev ships for gb/gbc — so this
// is bit-identical to how the emulator itself applies the code. Letting the
// two disagree is worse than useless: romdev would report an address the
// emulator never patches.
//
// gambatte indexes the HYPHENATED string, so its code[4],[5],[6] are digits
// 3,4,5 and its code[8],[10] are digits 6,8. In digit terms:
//   value   = d0,d1
//   address = d2<<8 | d3<<4 | d4 | (d5 ^ 0xF)<<12, masked to 0x7FFF
//   compare = (9-digit) ((d6<<4 | d8) ^ 0xFF), rotate-right 2, then ^ 0x45
//   d7 ("H") is genuinely unread by the core.
//
// This replaces an earlier version written from a third-party reference doc,
// which used a different nibble order (D E F C) and omitted the ^ 0x45
// entirely. It decoded EVERY published 9-digit code to the wrong address and
// the wrong compare; only `value` (the leading two digits) agreed.
export function decodeGbGameGenie(code) {
  const clean = code.replace(/-/g, "").toUpperCase();
  if (clean.length !== 6 && clean.length !== 9) return null;
  const d = [];
  for (const ch of clean) {
    const v = parseInt(ch, 16);
    if (Number.isNaN(v)) return null;
    d.push(v);
  }
  const value = ((d[0] << 4) | d[1]) & 0xFF;
  const address = ((d[2] << 8) | (d[3] << 4) | d[4] | ((d[5] ^ 0xF) << 12)) & 0x7FFF;
  const out = { address, value };
  if (clean.length === 9) {
    let cmp = (((d[6] << 4) | d[8]) ^ 0xFF) & 0xFF;
    cmp = (((cmp >> 2) | (cmp << 6)) ^ 0x45) & 0xFF;
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
  // Exact inverse of decodeGbGameGenie above (which mirrors gambatte).
  // value = digits 0,1
  d[0] = (v >> 4) & 0xF;
  d[1] = v & 0xF;
  // address = d2<<8 | d3<<4 | d4 | (d5 ^ 0xF)<<12  (15-bit)
  d[2] = (addr >> 8) & 0xF;
  d[3] = (addr >> 4) & 0xF;
  d[4] = addr & 0xF;
  d[5] = ((addr >> 12) & 0xF) ^ 0xF;   // high nibble, complemented
  if (compare != null) {
    // decode: cmp = ROR2((d6<<4|d8) ^ 0xFF) ^ 0x45
    // encode: undo the 0x45, rotate LEFT 2, invert, then split to d6/d8.
    let b = (compare ^ 0x45) & 0xFF;
    b = ((b << 2) | (b >> 6)) & 0xFF;    // rotate left 2 (inverse of ROR2)
    b ^= 0xFF;
    d[6] = (b >> 4) & 0xF;
    d[8] = b & 0xF;
    // d7 ("H") is not read by the core. Published codes carry a nonzero digit
    // there, so it cannot be reconstructed from address/value/compare -- a
    // re-encode is semantically identical but need not be textually equal.
  }
  const hex = d.map((x) => x.toString(16).toUpperCase()).join("");
  return compare == null
    ? hex.slice(0, 3) + "-" + hex.slice(3)
    : hex.slice(0, 3) + "-" + hex.slice(3, 6) + "-" + hex.slice(6);
}

// ── SNES Game Genie ─────────────────────────────────────────────────────
// 8 chars "XXXX-XXXX". The chars use a scrambled hex alphabet, then the 24-bit
// address is bit-permuted. Transcribed VERBATIM from snes9x S9xGameGenieToRaw
// (the exact core romdev ships for SNES) so it's bit-identical to the emulator.
const SNES_GG_GENIE_HEX = "DF4709156BC8A23E";

export function decodeSnesGameGenie(code) {
  const clean = code.replace(/-/g, "").toUpperCase();
  if (clean.length !== 8) return null;
  // Map each genie char → its real 4-bit nibble, building the 32-bit value.
  let data = 0;
  for (const ch of clean) {
    const nib = SNES_GG_GENIE_HEX.indexOf(ch);
    if (nib < 0) return null;
    data = (data * 16 + nib) >>> 0;
  }
  const value = (data >>> 24) & 0xFF;
  const a = data & 0xFFFFFF;
  const address =
    (((a & 0x003c00) << 10) +
     ((a & 0x00003c) << 14) +
     ((a & 0xf00000) >>> 8) +
     ((a & 0x000003) << 10) +
     ((a & 0x00c000) >>> 6) +
     ((a & 0x0f0000) >>> 12) +
     ((a & 0x0003c0) >>> 6)) >>> 0;
  return { address, value };
}

// ── GameTank Game Genie ─────────────────────────────────────────────────
// A NEW format for Clyde Shaffer's open GameTank console — no prior art exists
// (nobody has made GameTank cheat codes before). The GameTank CPU (W65C02S) sees a
// flat 16-bit address space, so a code encodes a 16-bit READ address + an 8-bit
// substitute value, plus an optional 8-bit compare byte (the compare form survives
// the cart's flash bank switching, exactly like NES/GB compare codes). The device
// intercepts the CPU's bus read and substitutes the value — identical behaviour to
// a hardware Game Genie you could build for the console's open cart bus.
//
// Encoding: a distinct 16-letter wheel (so codes read as GameTank, not NES). The
// payload nibbles are laid out and lightly scrambled so a small address change moves
// several letters (the GG "feel"), then a 1-nibble checksum guards typos.
//   plain:   6 payload nibbles (addr16 + val8) + 1 checksum = 7 letters, shown "XXX-XXXX"
//   compare: 8 payload nibbles (addr16 + val8 + cmp8) + 1 checksum = 9 letters, "XXXX-XXXXX"
const GT_GG_LETTERS = "KLMNPQRSTVWXYZ23"; // 16 distinct glyphs, no vowels/0-1-O-I ambiguity

function gtNibblesToLetters(nibs) {
  return nibs.map((x) => GT_GG_LETTERS[x & 0xF]).join("");
}
function gtLettersToNibbles(code) {
  const clean = code.replace(/-/g, "").toUpperCase();
  const n = [];
  for (const ch of clean) {
    const v = GT_GG_LETTERS.indexOf(ch);
    if (v < 0) return null;
    n.push(v);
  }
  return n;
}
// Simple nibble checksum: XOR of all payload nibbles, folded to 4 bits.
function gtChecksum(payloadNibs) {
  let c = 0;
  for (const x of payloadNibs) c ^= x & 0xF;
  return c & 0xF;
}
// Scramble/unscramble the payload-nibble ORDER (a fixed permutation) so a code
// doesn't read as plain hex. Self-inverse pairs keep decode trivial.
const GT_PERM6 = [3, 0, 5, 1, 4, 2];      // plain: 6 nibbles
const GT_PERM8 = [5, 2, 7, 0, 4, 1, 6, 3]; // compare: 8 nibbles
function applyPerm(arr, perm) { return perm.map((i) => arr[i]); }
function invertPerm(perm) {
  const inv = new Array(perm.length);
  perm.forEach((p, i) => { inv[p] = i; });
  return inv;
}

/** ENCODE → GameTank Game Genie. `address` 0..0xFFFF, `value` 0..0xFF, optional
 *  `compare` 0..0xFF. Returns the dashed letter code, or null if out of range. */
export function encodeGameTankGameGenie({ address, value, compare }) {
  if (address == null || value == null) return null;
  const a = address & 0xFFFF, v = value & 0xFF;
  if (address < 0 || address > 0xFFFF || value < 0 || value > 0xFF) return null;

  // payload nibbles, MSB-first: addr[15:12],addr[11:8],addr[7:4],addr[3:0],val[7:4],val[3:0]
  let payload = [(a >> 12) & 0xF, (a >> 8) & 0xF, (a >> 4) & 0xF, a & 0xF, (v >> 4) & 0xF, v & 0xF];
  let perm = GT_PERM6;
  if (compare != null) {
    if (compare < 0 || compare > 0xFF) return null;
    const c = compare & 0xFF;
    payload = payload.concat([(c >> 4) & 0xF, c & 0xF]);
    perm = GT_PERM8;
  }
  const scrambled = applyPerm(payload, perm);
  const sum = gtChecksum(payload);
  const nibs = scrambled.concat([sum]);
  const letters = gtNibblesToLetters(nibs);
  // dash after the first 3 (plain) / 4 (compare) letters for readability
  const cut = compare != null ? 4 : 3;
  return letters.slice(0, cut) + "-" + letters.slice(cut);
}

/** Decode a GameTank Game Genie code → { address, value, compare? } or null. */
export function decodeGameTankGameGenie(code) {
  const n = gtLettersToNibbles(code);
  if (!n) return null;
  let perm, payloadLen;
  if (n.length === 7) { perm = GT_PERM6; payloadLen = 6; }
  else if (n.length === 9) { perm = GT_PERM8; payloadLen = 8; }
  else return null;

  const scrambled = n.slice(0, payloadLen);
  const sum = n[payloadLen];
  const payload = applyPerm(scrambled, invertPerm(perm));
  if (gtChecksum(payload) !== sum) return null; // typo / not a valid GameTank code

  const address = ((payload[0] << 12) | (payload[1] << 8) | (payload[2] << 4) | payload[3]) & 0xFFFF;
  const value = ((payload[4] << 4) | payload[5]) & 0xFF;
  if (payloadLen === 6) return { address, value };
  const compare = ((payload[6] << 4) | payload[7]) & 0xFF;
  return { address, value, compare };
}

// ── Game Boy GameShark ──────────────────────────────────────────────────
// 8 hex digits "TTVVAAAA": TT = type/RAM-bank byte, VV = replacement value,
// AAAA = the RAM address in LITTLE-ENDIAN order. (Distinct from GB Game Genie,
// which is the 3-3-3 ROM-patch format.) These are RAM cheats.
export function decodeGbGameShark(code) {
  const clean = code.replace(/[-\s]/g, "").toUpperCase();
  if (!/^[0-9A-F]{8}$/.test(clean)) return null;
  const b = [0, 2, 4, 6].map((i) => parseInt(clean.slice(i, i + 2), 16));
  const value = b[1];
  const address = (b[3] << 8) | b[2]; // little-endian
  return { address, value };
}

// ── Pro Action Replay / GameShark (raw hex address+value) ───────────────
// SNES PAR: AAAAAAVV (6-hex 24-bit address + 2-hex value). SNES/SMS/GG ROM
// cheats also appear as XXXX-XXXX hex (a 16-bit address-ish + 16-bit value).
// These devices DON'T scramble — the hex IS the address and value — so "decode"
// is just slicing. We label the device so the agent knows what it's looking at.
export function decodeProActionReplay(code, platform) {
  const clean = code.replace(/[-\s]/g, "").toUpperCase();
  if (!/^[0-9A-F]+$/.test(clean)) return null;
  if (platform === "snes" && clean.length === 8) {
    // AAAAAA VV — 24-bit address, 8-bit value (most SNES PAR codes; 7E/7Fxxxx = WRAM).
    return { address: parseInt(clean.slice(0, 6), 16), value: parseInt(clean.slice(6), 16) };
  }
  if (clean.length === 8) {
    // XXXX VVVV — 16-bit address, 16-bit value (SMS/GG/Genesis AR-style).
    return { address: parseInt(clean.slice(0, 4), 16), value: parseInt(clean.slice(4), 16) };
  }
  return null;
}

/** Identify which cheat DEVICE a code string is for, on a given platform.
 *  Returns one of: "game-genie", "pro-action-replay", "gameshark",
 *  "action-replay", "raw", or "unknown". Per-platform, because the SAME shape
 *  means different devices on different systems (8 hex = SNES PAR, but on GB =
 *  GameShark). This is what lets us be HONEST about device type. */
export function detectDevice(code, platform) {
  const c = code.trim();
  if (c.includes(":")) return "raw";
  const lettersOnly = /^[A-Z]+$/i.test(c.replace(/-/g, ""));
  const hyphenHex = /^[0-9A-F]{4}-[0-9A-F]{4}$/i.test(c);
  const hex8 = /^[0-9A-F]{8}$/i.test(c);
  switch (platform) {
    case "nes":
      if (/^[APZLGITYEOXUKSVN]{6}$|^[APZLGITYEOXUKSVN]{8}$/i.test(c)) return "game-genie";
      return "unknown";
    case "genesis": case "megadrive": case "md":
      if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(c) && lettersOnly === false && !hyphenHex) return "game-genie";
      if (/^[ABCDEFGHJKLMNPRSTVWXYZ0-9]{4}-[ABCDEFGHJKLMNPRSTVWXYZ0-9]{4}$/i.test(c)) return "game-genie";
      return "unknown";
    case "gb": case "gbc":
      if (/^[0-9A-F]{3}-[0-9A-F]{3}(-[0-9A-F]{3})?$/i.test(c)) return "game-genie";
      if (hex8) return "gameshark"; // GB GameShark is 8 hex digits
      return "unknown";
    case "snes":
      if (hyphenHex) return "game-genie";          // SNES Game Genie XXXX-XXXX
      if (hex8) return "pro-action-replay";         // SNES PAR AAAAAAVV
      return "unknown";
    case "sms": case "gg":
      if (hex8 || hyphenHex) return "action-replay"; // SMS/GG Action Replay
      if (/^[0-9A-F]{3}-[0-9A-F]{3}/i.test(c)) return "game-genie";
      return "unknown";
    case "gametank":
      // 7-letter (XXX-XXXX) or 9-letter (XXXX-XXXXX) GameTank wheel code.
      if (/^[KLMNPQRSTVWXYZ23]{3}-[KLMNPQRSTVWXYZ23]{4}$/i.test(c) ||
          /^[KLMNPQRSTVWXYZ23]{4}-[KLMNPQRSTVWXYZ23]{5}$/i.test(c)) return "game-genie";
      return "unknown";
    default:
      return "unknown";
  }
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
      return decodeGenesisGameGenie(c) || decodeProActionReplay(c, platform);
    case "gb":
    case "gbc":
      // GB: 3-3-3 = Game Genie; 8 hex = GameShark (addr/val, no scramble).
      return decodeGbGameGenie(c) || decodeGbGameShark(c);
    case "snes":
      // XXXX-XXXX = scrambled Game Genie; 8 plain hex = Pro Action Replay.
      if (/-/.test(c)) return decodeSnesGameGenie(c);
      return decodeProActionReplay(c, platform);
    case "sms":
    case "gg":
      // SMS/GG Action Replay raw-hex (addr/val, no scramble).
      return decodeProActionReplay(c, platform);
    case "gametank":
      return decodeGameTankGameGenie(c);
    default:
      return null;
  }
}

// ── Encoders for the raw-hex devices ────────────────────────────────────
/** ENCODE → SNES Pro Action Replay: AAAAAAVV (24-bit addr + 8-bit value). */
export function encodeSnesProActionReplay({ address, value }) {
  if (address == null || value == null) return null;
  return (address & 0xFFFFFF).toString(16).toUpperCase().padStart(6, "0") +
         (value & 0xFF).toString(16).toUpperCase().padStart(2, "0");
}

/** ENCODE → GB GameShark: TTVVAAAA (type 01, value, little-endian address). */
export function encodeGbGameShark({ address, value, type = 0x01 }) {
  if (address == null || value == null) return null;
  const lo = address & 0xFF, hi = (address >> 8) & 0xFF;
  return [type, value & 0xFF, lo, hi].map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");
}

// Forward address scramble (the exact snes9x permutation, factored out so the
// inverse can be DERIVED from it rather than hand-transcribed — derivation is
// provably correct; hand-inverting this bit-soup is not).
function snesScrambleAddr(a24) {
  const a = a24 & 0xFFFFFF;
  return (((a & 0x003c00) << 10) +
          ((a & 0x00003c) << 14) +
          ((a & 0xf00000) >>> 8) +
          ((a & 0x000003) << 10) +
          ((a & 0x00c000) >>> 6) +
          ((a & 0x0f0000) >>> 12) +
          ((a & 0x0003c0) >>> 6)) >>> 0;
}
// Build the inverse permutation ONCE: scramble each single input bit to learn
// where it lands, then map output-bit → input-bit. (The scramble is a pure bit
// permutation, so this fully characterizes it.)
let _snesInvMap = null;
function snesUnscrambleAddr(scrambled) {
  if (!_snesInvMap) {
    _snesInvMap = new Array(24).fill(-1);
    for (let inBit = 0; inBit < 24; inBit++) {
      const out = snesScrambleAddr(1 << inBit);
      for (let outBit = 0; outBit < 24; outBit++) {
        if ((out >>> outBit) & 1) { _snesInvMap[outBit] = inBit; break; }
      }
    }
  }
  let a = 0;
  for (let outBit = 0; outBit < 24; outBit++) {
    if ((scrambled >>> outBit) & 1) { const ib = _snesInvMap[outBit]; if (ib >= 0) a |= (1 << ib); }
  }
  return a >>> 0;
}

/** ENCODE → SNES Game Genie (inverse of the snes9x scramble, derived). */
export function encodeSnesGameGenie({ address, value }) {
  if (address == null || value == null) return null;
  const s = snesUnscrambleAddr(address & 0xFFFFFF);
  const data = (((value & 0xFF) * 0x1000000) + (s & 0xFFFFFF)) >>> 0;
  let out = "";
  for (let i = 7; i >= 0; i--) out += SNES_GG_GENIE_HEX[(Math.floor(data / Math.pow(16, i))) & 0xF];
  return out.slice(0, 4) + "-" + out.slice(4);
}

/** Decode + label the device in one call. Returns { address, value, compare?,
 *  device } or null. THE preferred entry point for the index/tools — it makes
 *  the device type explicit (your "be clear what device" requirement). */
export function decodeWithDevice(code, platform) {
  const device = detectDevice(code, platform);
  const decoded = decodeCode(code, platform);
  if (!decoded) return device === "unknown" ? null : { device, address: null, value: null };
  return { ...decoded, device };
}

/** Format a raw ADDR:VAL[:COMPARE] code from decoded parts (hex, no 0x).
 *  The ADDRESS is padded to a minimum of 4 hex digits. This is NOT cosmetic:
 *  libretro cheat parsers (verified on fceumm) treat a short `AA:VV` RAM code as
 *  inert — it parses but never binds (`apply` then falsely reports success). A
 *  zero-page address like $32 must be emitted as `0032:09` to actually poke; the
 *  2-digit `32:09` is silently dropped. ROM addresses ($8000+) are already 4+
 *  digits, so padding only fixes the low-RAM case and never changes a working
 *  code. The VALUE stays 2 digits (`0009` 4-digit values also break the parser).
 *  Addresses wider than 16 bits (e.g. Genesis $FFxxxx work RAM) keep their full
 *  width, rounded up to an even number of digits. */
export function encodeRaw({ address, value, compare }) {
  const rawHex = (address >>> 0).toString(16).toUpperCase();
  // pad to >=4 digits, and to an even digit count so it's a whole number of bytes
  const width = Math.max(4, rawHex.length + (rawHex.length & 1));
  const addrHex = rawHex.padStart(width, "0");
  const valHex = (value & 0xFF).toString(16).toUpperCase().padStart(2, "0");
  return compare != null
    ? `${addrHex}:${valHex}:${(compare & 0xFF).toString(16).toUpperCase().padStart(2, "0")}`
    : `${addrHex}:${valHex}`;
}

// Which physical cheat DEVICE each platform's "native" code is for. This is the
// honesty layer: we don't call everything "Game Genie" — SNES native is Pro
// Action Replay, SMS/GG is Action Replay, GB has both GG (ROM) and GameShark
// (RAM). `nativeDevicesFor` lists them best-first.
export function nativeDevicesFor(platform) {
  switch (platform) {
    case "nes": return ["game-genie"];
    case "genesis": case "megadrive": case "md": return ["game-genie"];
    case "snes": return ["pro-action-replay", "game-genie"];
    case "gb": case "gbc": return ["game-genie", "gameshark"];
    case "sms": case "gg": return ["action-replay"];
    case "gametank": return ["game-genie"];
    default: return ["raw"];
  }
}

/** Encode { address, value, compare? } → { code, device } for `platform`.
 *  Pass `device` to force a specific device; otherwise the platform's native
 *  device is used. `device:"raw"` always works (ADDR:VAL). Returns null if the
 *  inputs can't produce that device. ALWAYS round-trips. */
export function encodeForDevice({ address, value, compare }, platform, device) {
  const dev = device || nativeDevicesFor(platform)[0];
  switch (dev) {
    case "raw": return { code: encodeRaw({ address, value, compare }), device: "raw" };
    case "game-genie": {
      let code = null;
      if (platform === "nes") code = encodeNesGameGenie({ address, value, compare });
      else if (["genesis", "megadrive", "md"].includes(platform)) code = encodeGenesisGameGenie({ address, value });
      else if (["gb", "gbc"].includes(platform)) code = encodeGbGameGenie({ address, value, compare });
      else if (platform === "snes") code = encodeSnesGameGenie({ address, value });
      else if (platform === "gametank") code = encodeGameTankGameGenie({ address, value, compare });
      return code ? { code, device: "game-genie" } : null;
    }
    case "pro-action-replay": {
      const code = platform === "snes" ? encodeSnesProActionReplay({ address, value }) : null;
      return code ? { code, device: "pro-action-replay" } : null;
    }
    case "gameshark": {
      const code = ["gb", "gbc"].includes(platform) ? encodeGbGameShark({ address, value }) : null;
      return code ? { code, device: "gameshark" } : null;
    }
    default: return null;
  }
}

/** Back-compat thin wrapper: returns just the code string (style "raw" or the
 *  platform's native device). Prefer encodeForDevice for the device label. */
export function encodeCode({ address, value, compare }, platform, style = "gamegenie") {
  if (style === "raw") return encodeRaw({ address, value, compare });
  const r = encodeForDevice({ address, value, compare }, platform);
  return r ? r.code : encodeRaw({ address, value, compare });
}
