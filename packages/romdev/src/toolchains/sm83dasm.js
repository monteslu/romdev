// Pure-JS SM83 (Game Boy / GBC CPU) disassembler. Produces da65-style
// output so the same post-processors in disasm.js (register annotation,
// file-offset annotation, untilReturn) work unchanged.
//
// SM83 differs from Z80 in important ways:
//   - No shadow registers (no AF'/BC'/DE'/HL', no EXX, no EX AF,AF')
//   - No IX/IY registers (no DD/FD prefixes)
//   - No ED prefix (no block ops like LDIR; SM83 has LDI/LDD as base ops)
//   - LDH (n),A = LD ($FF00+n),A  — high-RAM short form
//   - LD (HL+),A / LD (HL-),A — auto-increment/decrement variants
//   - JR cc,e supports NZ/Z/NC/C only (no PO/PE/P/M — no parity flag)
//   - Some opcodes are illegal/undefined (0xD3, 0xDB, 0xDD, 0xE3, 0xE4,
//     0xEB, 0xEC, 0xED, 0xF4, 0xFC, 0xFD)
//   - LD HL,SP+e — add signed displacement to SP
//   - RETI = return + enable interrupts (single op, no separate EI)
//
// Output format (matches da65 --comments 4 / z80dasm):
//   <indent>mnemonic operand                       ; XXXX BB BB BB

const MNEMONICS_BASE = [
  // 00-0F
  "nop",         "ld bc,@nn",   "ld (bc),a",   "inc bc",      "inc b",       "dec b",       "ld b,@n",     "rlca",
  "ld (@nn),sp", "add hl,bc",   "ld a,(bc)",   "dec bc",      "inc c",       "dec c",       "ld c,@n",     "rrca",
  // 10-1F
  "stop",        "ld de,@nn",   "ld (de),a",   "inc de",      "inc d",       "dec d",       "ld d,@n",     "rla",
  "jr @e",       "add hl,de",   "ld a,(de)",   "dec de",      "inc e",       "dec e",       "ld e,@n",     "rra",
  // 20-2F
  "jr nz,@e",    "ld hl,@nn",   "ld (hl+),a",  "inc hl",      "inc h",       "dec h",       "ld h,@n",     "daa",
  "jr z,@e",     "add hl,hl",   "ld a,(hl+)",  "dec hl",      "inc l",       "dec l",       "ld l,@n",     "cpl",
  // 30-3F
  "jr nc,@e",    "ld sp,@nn",   "ld (hl-),a",  "inc sp",      "inc (hl)",    "dec (hl)",    "ld (hl),@n",  "scf",
  "jr c,@e",     "add hl,sp",   "ld a,(hl-)",  "dec sp",      "inc a",       "dec a",       "ld a,@n",     "ccf",
  // 40-4F (ld r,r')
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
  // 80-8F (add / adc)
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
  "ret nc",      "pop de",      "jp nc,@nn",   "$illegal_d3", "call nc,@nn", "push de",     "sub @n",      "rst $10",
  "ret c",       "reti",        "jp c,@nn",    "$illegal_db", "call c,@nn",  "$illegal_dd", "sbc a,@n",    "rst $18",
  // E0-EF
  "ldh (@n),a",  "pop hl",      "ldh (c),a",   "$illegal_e3", "$illegal_e4", "push hl",     "and @n",      "rst $20",
  "add sp,@e8",  "jp hl",       "ld (@nn),a",  "$illegal_eb", "$illegal_ec", "$illegal_ed", "xor @n",      "rst $28",
  // F0-FF
  "ldh a,(@n)",  "pop af",      "ldh a,(c)",   "di",          "$illegal_f4", "push af",     "or @n",       "rst $30",
  "ld hl,sp+@e8","ld sp,hl",    "ld a,(@nn)",  "ei",          "$illegal_fc", "$illegal_fd", "cp @n",       "rst $38",
];

const R_8BIT = ["b", "c", "d", "e", "h", "l", "(hl)", "a"];
const ROT_OP = ["rlc", "rrc", "rl", "rr", "sla", "sra", "swap", "srl"];

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

function formatHex2(n) { return "$" + (n & 0xFF).toString(16).toUpperCase().padStart(2, "0"); }
function formatHex4(n) { return "$" + (n & 0xFFFF).toString(16).toUpperCase().padStart(4, "0"); }
function signedDisp(b) { return b >= 0x80 ? b - 0x100 : b; }

/** Disassemble one instruction starting at bytes[pos] (CPU addr = addr). */
function disasmOne(bytes, pos, addr) {
  if (pos >= bytes.length) return null;
  const op = bytes[pos];

  if (op === 0xCB) {
    if (pos + 1 >= bytes.length) return { length: 1, text: `.byte ${formatHex2(op)}` };
    return { length: 2, text: decodeCb(bytes[pos + 1]) };
  }

  const tpl = MNEMONICS_BASE[op];
  if (tpl == null || tpl.startsWith("$illegal_")) {
    return { length: 1, text: `.byte ${formatHex2(op)}` };
  }

  // GB `stop` ($10) is a TWO-byte instruction (`10 00`) — the CPU swallows the
  // following byte. rgbds (and the hardware) treat it as 2 bytes; decoding it
  // as 1 byte desyncs the whole stream. A real `stop` is `10 00`; if the second
  // byte is anything else it's almost certainly DATA misread as code, so emit a
  // 1-byte `.byte $10` (faithful + reassembles) rather than a bogus `stop`.
  if (op === 0x10) {
    if (pos + 1 < bytes.length && bytes[pos + 1] === 0x00) return { length: 2, text: "stop" };
    return { length: 1, text: `.byte ${formatHex2(op)}` };
  }

  let length = 1;
  let text = tpl;
  if (text.includes("@nn")) {
    if (pos + 2 >= bytes.length) return { length: 1, text: `.byte ${formatHex2(op)}` };
    const nn = bytes[pos + 1] | (bytes[pos + 2] << 8);
    text = text.replace("@nn", formatHex4(nn));
    length = 3;
  } else if (text.includes("@n")) {
    if (pos + 1 >= bytes.length) return { length: 1, text: `.byte ${formatHex2(op)}` };
    text = text.replace("@n", formatHex2(bytes[pos + 1]));
    length = 2;
  } else if (text.includes("@e8")) {
    // Signed 8-bit displacement used by `add sp,@e8` and `ld hl,sp+@e8`.
    if (pos + 1 >= bytes.length) return { length: 1, text: `.byte ${formatHex2(op)}` };
    const d = signedDisp(bytes[pos + 1]);
    text = text.replace("@e8", (d < 0 ? `-$${(-d).toString(16).toUpperCase()}` : `+$${d.toString(16).toUpperCase()}`));
    length = 2;
  } else if (text.includes("@e")) {
    // Relative branch.
    if (pos + 1 >= bytes.length) return { length: 1, text: `.byte ${formatHex2(op)}` };
    const target = (addr + 2 + signedDisp(bytes[pos + 1])) & 0xFFFF;
    text = text.replace("@e", `L${target.toString(16).toUpperCase().padStart(4, "0")}`);
    length = 2;
  }
  return { length, text };
}

/**
 * Disassemble a range of bytes into da65-style output.
 *
 * @param {{ bytes: Uint8Array, startAddress: number, addComments?: boolean }} args
 * @returns {{ asm: string, exitCode: number }}
 */
export function runSm83dasm({ bytes, startAddress, addComments = true }) {
  // Pass 1: collect branch targets so we can emit labels.
  const labels = new Set();
  let pos = 0, addr = startAddress;
  while (pos < bytes.length) {
    const r = disasmOne(bytes, pos, addr);
    if (!r) break;
    const labMatches = r.text.matchAll(/\bL([0-9A-F]{4})\b/g);
    for (const m of labMatches) labels.add(parseInt(m[1], 16));
    const jpMatches = r.text.matchAll(/\b(jp|call|jr)\b[^;]*?\$([0-9A-F]{4})\b/g);
    for (const m of jpMatches) labels.add(parseInt(m[2], 16));
    pos += r.length;
    addr = (addr + r.length) & 0xFFFF;
  }

  const lines = [
    "; sm83dasm (romdev built-in)",
    "; Input bytes: " + bytes.length,
    "",
    "        .setcpu \"sm83\"",
    "",
  ];
  pos = 0;
  addr = startAddress;
  while (pos < bytes.length) {
    const r = disasmOne(bytes, pos, addr);
    if (!r) break;
    const indent = "        ";
    if (labels.has(addr)) {
      const labelName = `L${addr.toString(16).toUpperCase().padStart(4, "0")}`;
      lines.push(`${labelName}:`);
    }
    let mnemonicLine = r.text;
    // Substitute jp/call/jr $XXXX → LXXXX label when target is one we tagged.
    mnemonicLine = mnemonicLine.replace(/\b(jp|call|jr)\b(\s+(?:nz|z|nc|c),)?\s+\$([0-9A-F]{4})\b/g, (full, mnem, cond, hexAddr) => {
      const tgt = parseInt(hexAddr, 16);
      if (labels.has(tgt)) {
        return `${mnem}${cond ?? " "}L${hexAddr.toUpperCase()}`;
      }
      return full;
    });
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
