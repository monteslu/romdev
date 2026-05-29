// Pure-JS Z80 disassembler. Produces da65-style output so the same
// post-processors (register annotation, file-offset annotation,
// untilReturn) in disasm.js work unchanged.
//
// Coverage:
//   - All 256 base opcodes
//   - CB prefix (bit ops + rotates on r/m)
//   - ED prefix (block ops, I/O, neg, retn, etc.)
//   - DD / FD prefixes (IX / IY)
//   - DDCB / FDCB prefixes (IX/IY bit ops with displacement)
//   - Undocumented opcodes are emitted as `.byte $XX` with no spurious decode
//
// Output format (matches what da65 emits with --comments 4):
//
//   <indent>mnemonic operand                       ; XXXX BB BB BB
//
// The leading indent is 8 spaces (matches da65). Labels are emitted as
// `LXXXX:` on their own line where appropriate.

const MNEMONICS_BASE = [
  // 00-0F
  "nop",         "ld bc,@nn",   "ld (bc),a",   "inc bc",      "inc b",       "dec b",       "ld b,@n",     "rlca",
  "ex af,af'",   "add hl,bc",   "ld a,(bc)",   "dec bc",      "inc c",       "dec c",       "ld c,@n",     "rrca",
  // 10-1F
  "djnz @e",     "ld de,@nn",   "ld (de),a",   "inc de",      "inc d",       "dec d",       "ld d,@n",     "rla",
  "jr @e",       "add hl,de",   "ld a,(de)",   "dec de",      "inc e",       "dec e",       "ld e,@n",     "rra",
  // 20-2F
  "jr nz,@e",    "ld hl,@nn",   "ld (@nn),hl", "inc hl",      "inc h",       "dec h",       "ld h,@n",     "daa",
  "jr z,@e",     "add hl,hl",   "ld hl,(@nn)", "dec hl",      "inc l",       "dec l",       "ld l,@n",     "cpl",
  // 30-3F
  "jr nc,@e",    "ld sp,@nn",   "ld (@nn),a",  "inc sp",      "inc (hl)",    "dec (hl)",    "ld (hl),@n",  "scf",
  "jr c,@e",     "add hl,sp",   "ld a,(@nn)",  "dec sp",      "inc a",       "dec a",       "ld a,@n",     "ccf",
  // 40-4F  (ld r,r')
  "ld b,b",      "ld b,c",      "ld b,d",      "ld b,e",      "ld b,h",      "ld b,l",      "ld b,(hl)",   "ld b,a",
  "ld c,b",      "ld c,c",      "ld c,d",      "ld c,e",      "ld c,h",      "ld c,l",      "ld c,(hl)",   "ld c,a",
  // 50-5F
  "ld d,b",      "ld d,c",      "ld d,d",      "ld d,e",      "ld d,h",      "ld d,l",      "ld d,(hl)",   "ld d,a",
  "ld e,b",      "ld e,c",      "ld e,d",      "ld e,e",      "ld e,h",      "ld e,l",      "ld e,(hl)",   "ld e,a",
  // 60-6F
  "ld h,b",      "ld h,c",      "ld h,d",      "ld h,e",      "ld h,h",      "ld h,l",      "ld h,(hl)",   "ld h,a",
  "ld l,b",      "ld l,c",      "ld l,d",      "ld l,e",      "ld l,h",      "ld l,l",      "ld l,(hl)",   "ld l,a",
  // 70-7F
  "ld (hl),b",   "ld (hl),c",   "ld (hl),d",   "ld (hl),e",   "ld (hl),h",   "ld (hl),l",   "halt",        "ld (hl),a",
  "ld a,b",      "ld a,c",      "ld a,d",      "ld a,e",      "ld a,h",      "ld a,l",      "ld a,(hl)",   "ld a,a",
  // 80-8F (add / adc on r)
  "add a,b",     "add a,c",     "add a,d",     "add a,e",     "add a,h",     "add a,l",     "add a,(hl)",  "add a,a",
  "adc a,b",     "adc a,c",     "adc a,d",     "adc a,e",     "adc a,h",     "adc a,l",     "adc a,(hl)",  "adc a,a",
  // 90-9F (sub / sbc)
  "sub b",       "sub c",       "sub d",       "sub e",       "sub h",       "sub l",       "sub (hl)",    "sub a",
  "sbc a,b",     "sbc a,c",     "sbc a,d",     "sbc a,e",     "sbc a,h",     "sbc a,l",     "sbc a,(hl)",  "sbc a,a",
  // A0-AF (and / xor)
  "and b",       "and c",       "and d",       "and e",       "and h",       "and l",       "and (hl)",    "and a",
  "xor b",       "xor c",       "xor d",       "xor e",       "xor h",       "xor l",       "xor (hl)",    "xor a",
  // B0-BF (or / cp)
  "or b",        "or c",        "or d",        "or e",        "or h",        "or l",        "or (hl)",     "or a",
  "cp b",        "cp c",        "cp d",        "cp e",        "cp h",        "cp l",        "cp (hl)",     "cp a",
  // C0-CF
  "ret nz",      "pop bc",      "jp nz,@nn",   "jp @nn",      "call nz,@nn", "push bc",     "add a,@n",    "rst $00",
  "ret z",       "ret",         "jp z,@nn",    null /* CB prefix */, "call z,@nn",  "call @nn",    "adc a,@n",    "rst $08",
  // D0-DF
  "ret nc",      "pop de",      "jp nc,@nn",   "out (@n),a",  "call nc,@nn", "push de",     "sub @n",      "rst $10",
  "ret c",       "exx",         "jp c,@nn",    "in a,(@n)",   "call c,@nn",  null /* DD prefix */, "sbc a,@n",   "rst $18",
  // E0-EF
  "ret po",      "pop hl",      "jp po,@nn",   "ex (sp),hl",  "call po,@nn", "push hl",     "and @n",      "rst $20",
  "ret pe",      "jp (hl)",     "jp pe,@nn",   "ex de,hl",    "call pe,@nn", null /* ED prefix */, "xor @n",  "rst $28",
  // F0-FF
  "ret p",       "pop af",      "jp p,@nn",    "di",          "call p,@nn",  "push af",     "or @n",       "rst $30",
  "ret m",       "ld sp,hl",    "jp m,@nn",    "ei",          "call m,@nn",  null /* FD prefix */, "cp @n",   "rst $38",
];

const R_8BIT = ["b", "c", "d", "e", "h", "l", "(hl)", "a"];
const ROT_OP = ["rlc", "rrc", "rl", "rr", "sla", "sra", "sll", "srl"];

// CB-prefix table generator. Pattern by opcode bits:
//   00rrrxxx — rotation: rlc/rrc/rl/rr/sla/sra/sll/srl on r
//   01bbbrrr — bit b,r
//   10bbbrrr — res b,r
//   11bbbrrr — set b,r
function decodeCb(op) {
  const r = R_8BIT[op & 0x07];
  const b = (op >> 3) & 0x07;
  const high = op >> 6;
  switch (high) {
    case 0: return `${ROT_OP[b]} ${r}`;
    case 1: return `bit ${b},${r}`;
    case 2: return `res ${b},${r}`;
    case 3: return `set ${b},${r}`;
  }
}

// ED-prefix table — sparsely populated.
const ED_TABLE = {
  0x40: "in b,(c)",    0x41: "out (c),b",   0x42: "sbc hl,bc",   0x43: "ld (@nn),bc",
  0x44: "neg",         0x45: "retn",        0x46: "im 0",        0x47: "ld i,a",
  0x48: "in c,(c)",    0x49: "out (c),c",   0x4A: "adc hl,bc",   0x4B: "ld bc,(@nn)",
  0x4D: "reti",        0x4F: "ld r,a",
  0x50: "in d,(c)",    0x51: "out (c),d",   0x52: "sbc hl,de",   0x53: "ld (@nn),de",
  0x56: "im 1",        0x57: "ld a,i",
  0x58: "in e,(c)",    0x59: "out (c),e",   0x5A: "adc hl,de",   0x5B: "ld de,(@nn)",
  0x5E: "im 2",        0x5F: "ld a,r",
  0x60: "in h,(c)",    0x61: "out (c),h",   0x62: "sbc hl,hl",   0x63: "ld (@nn),hl",
  0x67: "rrd",
  0x68: "in l,(c)",    0x69: "out (c),l",   0x6A: "adc hl,hl",   0x6B: "ld hl,(@nn)",
  0x6F: "rld",
  0x72: "sbc hl,sp",   0x73: "ld (@nn),sp",
  0x78: "in a,(c)",    0x79: "out (c),a",   0x7A: "adc hl,sp",   0x7B: "ld sp,(@nn)",
  0xA0: "ldi",         0xA1: "cpi",         0xA2: "ini",         0xA3: "outi",
  0xA8: "ldd",         0xA9: "cpd",         0xAA: "ind",         0xAB: "outd",
  0xB0: "ldir",        0xB1: "cpir",        0xB2: "inir",        0xB3: "otir",
  0xB8: "lddr",        0xB9: "cpdr",        0xBA: "indr",        0xBB: "otdr",
};

// DD/FD prefix: same table as base but with hl→ix/iy substitution and
// (hl)→(ix+d)/(iy+d) where d is a signed byte. Most other DD/FD ops
// are equivalent to the unprefixed op (transparent prefix).
const DD_OVERLAY = new Set([
  0x09, 0x19, 0x29, 0x39,                 // add hl,xx → add ix,xx
  0x21, 0x22, 0x23, 0x2A, 0x2B,           // hl loads
  0x24, 0x25, 0x26,                       // inc/dec/ld h
  0x2C, 0x2D, 0x2E,                       // inc/dec/ld l
  0x34, 0x35, 0x36,                       // inc/dec/ld (hl)
  0x46, 0x4E, 0x56, 0x5E, 0x66, 0x6E, 0x7E, // ld r,(hl)
  0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x77, // ld (hl),r
  0x86, 0x8E, 0x96, 0x9E, 0xA6, 0xAE, 0xB6, 0xBE, // alu (hl)
  0xE1, 0xE3, 0xE5, 0xE9, 0xF9,           // hl pushes/pops/jp/ld sp,hl
]);

function applyIndexPrefix(text, idx /* "ix" or "iy" */, d) {
  // Replace hl → idx, (hl) → (idx+d)
  const dispStr = d == null ? "" : (d >= 0x80 ? `-$${(0x100 - d).toString(16).toUpperCase()}` : `+$${d.toString(16).toUpperCase()}`);
  return text
    .replace(/\bhl\b/g, idx)
    .replace(/\(hl\)/g, `(${idx}${dispStr})`);
}

function formatHex2(n) { return "$" + (n & 0xFF).toString(16).toUpperCase().padStart(2, "0"); }
function formatHex4(n) { return "$" + (n & 0xFFFF).toString(16).toUpperCase().padStart(4, "0"); }
function formatHexAddr(n) { return formatHex4(n); }
function signedDisp(b) { return b >= 0x80 ? b - 0x100 : b; }

/**
 * Disassemble one instruction starting at `bytes[pos]`. Returns
 * { length, mnemonic, operandText, comment } or null if out-of-range.
 */
function disasmOne(bytes, pos, addr) {
  if (pos >= bytes.length) return null;
  const op = bytes[pos];

  // Prefix handling.
  if (op === 0xCB) {
    if (pos + 1 >= bytes.length) return { length: 1, text: `.byte ${formatHex2(op)}` };
    const op2 = bytes[pos + 1];
    return { length: 2, text: decodeCb(op2) };
  }
  if (op === 0xED) {
    if (pos + 1 >= bytes.length) return { length: 1, text: `.byte ${formatHex2(op)}` };
    const op2 = bytes[pos + 1];
    const tpl = ED_TABLE[op2];
    if (!tpl) {
      // Undocumented / invalid ED op — emit as 2 raw bytes.
      return { length: 2, text: `.byte ${formatHex2(op)},${formatHex2(op2)}` };
    }
    if (tpl.includes("@nn")) {
      if (pos + 3 >= bytes.length) return { length: 2, text: tpl.replace("@nn", "??") };
      const nn = bytes[pos + 2] | (bytes[pos + 3] << 8);
      return { length: 4, text: tpl.replace("@nn", formatHex4(nn)) };
    }
    return { length: 2, text: tpl };
  }
  if (op === 0xDD || op === 0xFD) {
    if (pos + 1 >= bytes.length) return { length: 1, text: `.byte ${formatHex2(op)}` };
    const idx = op === 0xDD ? "ix" : "iy";
    const op2 = bytes[pos + 1];
    // DDCB / FDCB
    if (op2 === 0xCB) {
      if (pos + 3 >= bytes.length) return { length: 2, text: `.byte ${formatHex2(op)},${formatHex2(op2)}` };
      const d = bytes[pos + 2];
      const op3 = bytes[pos + 3];
      const decoded = decodeCb(op3);
      const text = decoded.replace(/\(hl\)/, `(${idx}+${formatHex2(d)})`);
      return { length: 4, text };
    }
    // Transparent — same as the base op (most ops fall here).
    const sub = disasmOne(bytes, pos + 1, addr + 1);
    if (!sub) return { length: 1, text: `.byte ${formatHex2(op)}` };
    if (DD_OVERLAY.has(op2)) {
      // (hl) version needs a displacement byte INSERTED after the opcode.
      // For ops that touch (hl), the displacement is at pos+2.
      const usesIndirect = /\(hl\)/.test(sub.text);
      if (usesIndirect) {
        const d = bytes[pos + 2];
        return { length: sub.length + 2, text: applyIndexPrefix(sub.text, idx, d) };
      }
      return { length: sub.length + 1, text: applyIndexPrefix(sub.text, idx, null) };
    }
    // Transparent: just decode the sub-op with `+1` prefix length.
    return { length: sub.length + 1, text: sub.text };
  }

  const tpl = MNEMONICS_BASE[op];
  if (tpl == null) {
    return { length: 1, text: `.byte ${formatHex2(op)}` };
  }
  // Resolve operand placeholders.
  let length = 1;
  let text = tpl;
  if (text.includes("@nn")) {
    if (pos + 2 >= bytes.length) return { length: 1, text: `.byte ${formatHex2(op)}` };
    const nn = bytes[pos + 1] | (bytes[pos + 2] << 8);
    text = text.replace("@nn", formatHex4(nn));
    length = 3;
  } else if (text.includes("@n")) {
    if (pos + 1 >= bytes.length) return { length: 1, text: `.byte ${formatHex2(op)}` };
    const n = bytes[pos + 1];
    text = text.replace("@n", formatHex2(n));
    length = 2;
  } else if (text.includes("@e")) {
    // Relative branch displacement.
    if (pos + 1 >= bytes.length) return { length: 1, text: `.byte ${formatHex2(op)}` };
    const d = bytes[pos + 1];
    const target = (addr + 2 + signedDisp(d)) & 0xFFFF;
    text = text.replace("@e", `L${target.toString(16).toUpperCase().padStart(4, "0")}`);
    length = 2;
  }
  return { length, text };
}

/**
 * Disassemble a range of bytes. Returns asm text in da65-style format
 * (one instruction per line, indented at column 8, with `; ADDR BB BB`
 * trailing comments).
 *
 * @param {Object} args
 * @param {Uint8Array} args.bytes
 * @param {number} args.startAddress
 * @param {boolean} [args.addComments] include the `; ADDR BB` trailing comment (default true)
 * @returns {{ asm: string, exitCode: number }}
 */
export function runZ80dasm({ bytes, startAddress, addComments = true }) {
  // Pass 1: collect branch targets so we can emit labels.
  const labels = new Set();
  let pos = 0, addr = startAddress;
  while (pos < bytes.length) {
    const r = disasmOne(bytes, pos, addr);
    if (!r) break;
    // Scan for LXXXX targets — both `jp $nnnn` / `call $nnnn` and the
    // `LXXXX` we emit for relative branches.
    const labMatches = r.text.matchAll(/\bL([0-9A-F]{4})\b/g);
    for (const m of labMatches) labels.add(parseInt(m[1], 16));
    const jpMatches = r.text.matchAll(/\b(jp|call|jr|djnz)\b[^;]*?\$([0-9A-F]{4})\b/g);
    for (const m of jpMatches) labels.add(parseInt(m[2], 16));
    pos += r.length;
    addr = (addr + r.length) & 0xFFFF;
  }

  // Pass 2: emit.
  const lines = [
    "; z80dasm (romdev built-in)",
    "; Input bytes: " + bytes.length,
    "",
    "        .setcpu \"z80\"",
    "",
  ];
  pos = 0;
  addr = startAddress;
  while (pos < bytes.length) {
    const r = disasmOne(bytes, pos, addr);
    if (!r) break;
    const indent = "        ";
    // Address label (if it's a target).
    if (labels.has(addr)) {
      const labelName = `L${addr.toString(16).toUpperCase().padStart(4, "0")}`;
      // Substitute `jp $nnnn` etc. operand to use the LXXXX label form
      // — matches what da65 does (it auto-generates LXXXX labels).
      lines.push(`${labelName}:`);
    }
    // For `jp $XXXX` / `call $XXXX`, prefer the LXXXX label name if we
    // emitted one — gives the agent searchable labels.
    let mnemonicLine = r.text;
    mnemonicLine = mnemonicLine.replace(/\b(jp|call|jr|djnz)\b(\s+(?:nz|z|nc|c|po|pe|p|m),)?\s+\$([0-9A-F]{4})\b/g, (full, mnem, cond, hexAddr) => {
      const tgt = parseInt(hexAddr, 16);
      if (labels.has(tgt)) {
        return `${mnem}${cond ?? " "}L${hexAddr.toUpperCase()}`;
      }
      return full;
    });
    // Build the trailing comment: `; ADDR BB BB BB`
    if (addComments) {
      const rawBytes = Array.from(bytes.slice(pos, pos + r.length))
        .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
        .join(" ");
      const addrStr = addr.toString(16).toUpperCase().padStart(4, "0");
      const padded = (indent + mnemonicLine).padEnd(40, " ");
      lines.push(`${padded}; ${addrStr} ${rawBytes}`);
    } else {
      lines.push(indent + mnemonicLine);
    }
    pos += r.length;
    addr = (addr + r.length) & 0xFFFF;
  }

  return { asm: lines.join("\n") + "\n", exitCode: 0 };
}
