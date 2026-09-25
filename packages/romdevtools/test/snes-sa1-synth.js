// Test support for the SNES recompiler's SA-1 tests: a small 65816
// assembler over romdev's own decoder table and a synthetic SA-1 LoROM
// image builder. Synthetic programs only (never commercial code).
//
// Syntax, one statement per string:
//   "label:"                      a label (at the current address)
//   "lda #$12"  "lda #$1234"      immediates: width follows the tracked M/X
//                                 (rep/sep #imm update it; `.m16`/`.m8`/
//                                 `.x16`/`.x8` pseudo-ops set it by hand)
//   "sta $12" / "$1234" / "$123456"  direct page / absolute / long by digits
//   ",x" ",y" "(..)" "(..),y" "(..,x)" "[..]" "[..],y" "$12,s" "($12,s),y"
//   "bne label"  "brl label"  "jsr label"  "jml label" (label = 24-bit)
//   "mvn $7e,$7f"                 (destination bank, source bank as written)
//   ".org $8100"                  move to a 16-bit address in the same bank
//   ".db 1,2,3" ".dw $1234"       data
//   "lda #<label" "lda #>label" "lda #^label"  label byte 0/1/2
//
// Plain JS ESM.

import { opcodeInfo } from "../src/analysis/recompile/decode-65816.js";

const TABLE = new Map();
for (let op = 0; op < 256; op++) {
  const e = opcodeInfo(op);
  if (e) TABLE.set(`${e.mnem} ${e.mode}`, op);
}

const num = (s) => {
  s = s.trim();
  if (s.startsWith("$")) return parseInt(s.slice(1), 16);
  if (s.startsWith("0x")) return parseInt(s.slice(2), 16);
  return parseInt(s, 10);
};

/**
 * Assemble `lines` placed at 24-bit address `origin`.
 * @param {string[]} lines
 * @param {number} origin
 * @param {Record<string, number>} [extern] labels defined elsewhere
 * @returns {{bytes: number[], labels: Record<string, number>}}
 */
export function asm(lines, origin, extern = {}) {
  let labels = { ...extern };
  let out = [];
  for (let pass = 0; pass < 2; pass++) {
    out = [];
    let pc = origin, m = 1, x = 1;
    const val = (tok) => {
      tok = tok.trim();
      let sel = null;
      if ("<>^".includes(tok[0])) { sel = tok[0]; tok = tok.slice(1); }
      let v;
      if (/^[A-Za-z_]\w*$/.test(tok)) {
        v = labels[tok];
        if (v === undefined) { if (pass === 1) throw new Error(`asm: undefined label ${tok}`); v = pc; }
      } else v = num(tok);
      if (sel === "<") return v & 0xff;
      if (sel === ">") return (v >> 8) & 0xff;
      if (sel === "^") return (v >> 16) & 0xff;
      return v;
    };
    const digits = (tok) => (/^\$[0-9a-fA-F]+$/.test(tok.trim()) ? tok.trim().length - 1 : 0);
    const emit = (...b) => { for (const v of b) out.push(v & 0xff); pc += b.length; };
    for (let raw of lines) {
      const line = raw.replace(/;.*$/, "").trim();
      if (!line) continue;
      if (line.endsWith(":")) { labels[line.slice(0, -1)] = pc; continue; }
      const sp = line.indexOf(" ");
      const mnem = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
      const opnd = sp < 0 ? "" : line.slice(sp + 1).trim();
      if (mnem === ".m16") { m = 0; continue; }
      if (mnem === ".m8") { m = 1; continue; }
      if (mnem === ".x16") { x = 0; continue; }
      if (mnem === ".x8") { x = 1; continue; }
      if (mnem === ".org") {
        const a = (pc & 0xff0000) | num(opnd);
        if (a < pc) throw new Error(`asm: .org $${a.toString(16)} is behind $${pc.toString(16)}`);
        while (pc < a) emit(0xea);
        continue;
      }
      if (mnem === ".db") { emit(...opnd.split(",").map(val)); continue; }
      if (mnem === ".dw") { for (const t of opnd.split(",")) { const v = val(t); emit(v, v >> 8); } continue; }
      const op = (mode) => {
        const o = TABLE.get(`${mnem} ${mode}`);
        if (o === undefined) throw new Error(`asm: no ${mnem} ${mode} (${line})`);
        return o;
      };
      if (!opnd || opnd.toLowerCase() === "a") {
        const mode = TABLE.has(`${mnem} imp`) ? "imp" : "acc";
        emit(op(mode));
        continue;
      }
      if (mnem === "mvn" || mnem === "mvp") {
        const [d, s] = opnd.split(",").map(val);
        emit(op("bm"), d, s);
        continue;
      }
      if (opnd.startsWith("#")) {
        const v = val(opnd.slice(1));
        const info = [...TABLE.entries()].find(([k]) => k.startsWith(mnem + " imm"));
        if (!info) throw new Error(`asm: ${mnem} has no immediate`);
        const mode = info[0].split(" ")[1];
        const wide = mode === "immM" ? !m : mode === "immX" ? !x : mode === "imm16";
        emit(info[1], v);
        if (wide) emit(v >> 8);
        if (mnem === "rep" || mnem === "sep") {
          const set = mnem === "sep" ? 1 : 0;
          if (v & 0x20) m = set;
          if (v & 0x10) x = set;
        }
        continue;
      }
      if (["bpl", "bmi", "bvc", "bvs", "bcc", "bcs", "bne", "beq", "bra"].includes(mnem)) {
        const t = val(opnd), d = t - (pc + 2);
        if (pass === 1 && (d < -128 || d > 127)) throw new Error(`asm: branch out of range (${line})`);
        emit(op("rel"), d);
        continue;
      }
      if (mnem === "brl" || mnem === "per") {
        const d = val(opnd) - (pc + 3);
        emit(op("rell"), d, d >> 8);
        continue;
      }
      let mt;
      if ((mt = /^\((.+),s\),y$/i.exec(opnd))) { emit(op("sry"), val(mt[1])); continue; }
      if ((mt = /^(.+),s$/i.exec(opnd))) { emit(op("sr"), val(mt[1])); continue; }
      if ((mt = /^\[(.+)\],y$/i.exec(opnd))) { emit(op("ildpy"), val(mt[1])); continue; }
      if ((mt = /^\[(.+)\]$/i.exec(opnd))) {
        const v = val(mt[1]);
        if (digits(mt[1]) > 2 || mnem === "jml" || mnem === "jmp") { emit(op("indl"), v, v >> 8); continue; }
        emit(op("ildp"), v);
        continue;
      }
      if ((mt = /^\((.+),x\)$/i.exec(opnd))) {
        const v = val(mt[1]);
        if (digits(mt[1]) > 2 || mnem === "jmp" || mnem === "jsr") { emit(op("indx"), v, v >> 8); continue; }
        emit(op("idpx"), v);
        continue;
      }
      if ((mt = /^\((.+)\),y$/i.exec(opnd))) { emit(op("idpy"), val(mt[1])); continue; }
      if ((mt = /^\((.+)\)$/i.exec(opnd))) {
        const v = val(mt[1]);
        if (digits(mt[1]) > 2 || mnem === "jmp") { emit(op("ind"), v, v >> 8); continue; }
        emit(op("idp"), v);
        continue;
      }
      let idx = "";
      let base = opnd;
      if ((mt = /^(.+),([xy])$/i.exec(opnd))) { base = mt[1]; idx = mt[2].toLowerCase(); }
      const v = val(base);
      let w = digits(base);
      if (!w) w = (mnem === "jml" || mnem === "jsl") ? 6 : 4;   // labels: absolute (long for jml/jsl)
      if (w <= 2 && !TABLE.has(`${mnem} dp${idx}`)) w = 4;
      if (w <= 2) { emit(op(`dp${idx}`), v); continue; }
      if (w <= 4 && TABLE.has(`${mnem} abs${idx}`)) { emit(op(`abs${idx}`), v, v >> 8); continue; }
      emit(op(`absl${idx}`), v, v >> 8, v >> 16);
    }
  }
  return { bytes: out, labels };
}

/**
 * A synthetic SA-1 LoROM image (snes9x Map_SA1LoROMMap): header map mode $23,
 * ROM type $34/$35, reset/NMI/IRQ vectors, and `pieces` placed by 24-bit
 * address in banks $00-$3F ($8000-$FFFF halves) or $C0-$FF (whole banks).
 * @param {object} o
 * @param {Array<{at: number, bytes: number[]}>} o.pieces
 * @param {number} [o.banks]   32KB banks in the image
 * @param {number} [o.chipset] header ROM type ($34 no battery, $35 battery)
 * @param {number} [o.sram]    header SRAM size byte
 * @param {{reset?: number, nmi?: number, irq?: number}} [o.vectors]  16-bit bank-0 vectors
 */
export function sa1Rom({ pieces, banks = 8, chipset = 0x35, sram = 3, vectors = {} }) {
  const img = new Uint8Array(banks * 0x8000).fill(0xea);
  // distinct filler per bank so a wrong bank maps show up as wrong bytes
  for (let b = 0; b < banks; b++) img.fill(0x10 + b, b * 0x8000 + 0x7000, b * 0x8000 + 0x7f00);
  for (const { at, bytes } of pieces) {
    const bank = at >>> 16, a = at & 0xffff;
    let off;
    if (bank >= 0xc0) off = ((bank - 0xc0) << 16) | a;
    else { if (a < 0x8000) throw new Error("sa1Rom: LoROM pieces go at $8000+"); off = ((bank & 0x3f) << 15) | (a - 0x8000); }
    img.set(bytes, off);
  }
  const h = 0x7fc0;
  const title = "SA1 SYNTHETIC TEST   ";
  for (let i = 0; i < 21; i++) img[h + i] = title.charCodeAt(i);
  img[h + 0x15] = 0x23;
  img[h + 0x16] = chipset;
  img[h + 0x17] = Math.max(8, Math.ceil(Math.log2(img.length / 1024)));
  img[h + 0x18] = sram;
  img[h + 0x19] = 0x01;
  img[h + 0x1a] = 0x33;
  const vec = (off, a) => { img[off] = a & 0xff; img[off + 1] = a >> 8; };
  vec(0x7ffc, vectors.reset ?? 0x8000);
  vec(0x7fea, vectors.nmi ?? 0x8000);
  vec(0x7fee, vectors.irq ?? 0x8000);
  let sum = 0;
  img[h + 0x1c] = 0; img[h + 0x1d] = 0; img[h + 0x1e] = 0; img[h + 0x1f] = 0;
  for (const b of img) sum = (sum + b) & 0xffff;
  sum = (sum + 0x1fe) & 0xffff;
  img[h + 0x1c] = (sum ^ 0xffff) & 0xff; img[h + 0x1d] = (sum ^ 0xffff) >> 8;
  img[h + 0x1e] = sum & 0xff; img[h + 0x1f] = sum >> 8;
  return img;
}

/** Common S-CPU prologue: native mode, 8-bit A, 16-bit X/Y, stack $01FF. */
const SCPU_INIT = ["sei", "clc", "xce", "rep #$10", "sep #$20", "ldx #$01ff", "txs"];
/** Common SA-1 prologue: native mode, 8-bit A, 16-bit X/Y, stack at I-RAM $07FF. */
const SA1_INIT = ["clc", "xce", "rep #$10", "sep #$20", "ldx #$07ff", "txs", "lda #$80", "sta $2227", "lda #$ff", "sta $222a"];

/**
 * The synthetic SA-1 programs the tests run on the recompiled cart and on
 * snes9x. Each returns a ROM image.
 */
export const sa1Programs = {
  /**
   * Arithmetic unit (signed multiply, divide, cumulative sum with overflow),
   * the variable-length bit reader, BW-RAM / I-RAM / MMC views from both
   * CPUs, and two free-running counters (one per CPU) whose values at a frame
   * boundary pin the SA-1's clock against the S-CPU's.
   */
  basic() {
    const s = asm([
      ...SCPU_INIT,
      "lda #<sa1main", "sta $2203", "lda #>sa1main", "sta $2204",
      "lda #$80", "sta $2226", "lda #$ff", "sta $2229", "stz $2224",
      "lda #$01", "sta $2221", "lda #$02", "sta $2222", "lda #$03", "sta $2223",
      "stz $2200",
      "wait:", "lda $3000", "cmp #$5a", "bne wait",
      "lda $2300", "sta $7e0100", "lda $2301", "sta $7e0101", "lda $230e", "sta $7e0102",
      "lda $6000", "sta $7e0103", "lda $400010", "sta $7e0104", "lda $3010", "sta $7e0105",
      "lda $2250", "sta $7e0106", "lda $4f0000", "sta $7e0107", "lda $3800", "sta $7e0108",
      "lda $c00005", "sta $7e0109", "lda $d00005", "sta $7e010a", "lda $208005", "sta $7e010b",
      "rep #$20",
      "loop:", "inc $0200", "bra loop",
      ".org $8200",
      "sa1main:",
      ...SA1_INIT,
      "stz $2250",
      "lda #$34", "sta $2251", "lda #$12", "sta $2252", "lda #$00", "sta $2253", "lda #$ff", "sta $2254",
      "lda $2306", "sta $10", "lda $2307", "sta $11", "lda $2308", "sta $12", "lda $2309", "sta $13", "lda $230a", "sta $14",
      "lda #$01", "sta $2250",
      "lda #$fb", "sta $2251", "lda #$ff", "sta $2252", "lda #$07", "sta $2253", "lda #$00", "sta $2254",
      "lda $2306", "sta $18", "lda $2307", "sta $19", "lda $2308", "sta $1a", "lda $2309", "sta $1b", "lda $230a", "sta $1c",
      "lda #$02", "sta $2250",
      "ldy #$0003",
      "acc:", "lda #$ff", "sta $2251", "lda #$7f", "sta $2252", "lda #$ff", "sta $2253", "lda #$7f", "sta $2254", "dey", "bne acc",
      "lda $2306", "sta $20", "lda $2307", "sta $21", "lda $2308", "sta $22", "lda $2309", "sta $23", "lda $230a", "sta $24", "lda $230b", "sta $25",
      "lda #$20", "sta $2254", "lda $230a", "sta $26", "lda $230b", "sta $27",
      "stz $2259", "lda #$84", "sta $225a", "stz $225b",
      "lda #$85", "sta $2258",
      "ldx #$0000",
      "vl:", "lda $230c", "sta $30,x", "lda $230d", "sta $31,x", "inx", "inx", "cpx #$0010", "bne vl",
      "lda #$0b", "sta $2258", "lda $230c", "sta $40", "lda $230d", "sta $41",
      "lda #$a5", "sta $6000", "lda #$c3", "sta $400010", "lda #$3c", "sta $410010",
      "lda $c00005", "sta $48", "lda $f00005", "sta $49", "lda $a08005", "sta $4a", "lda $7e0000", "sta $4b",
      "lda $1000", "sta $4c", "lda $4000", "sta $4d",
      "lda #$5a", "sta $00",
      "rep #$20",
      "cnt:", "inc $0100", "bra cnt",
      ".org $8400",
      ".db $3c,$a5,$96,$0f,$f0,$81,$42,$24,$18,$e7,$db,$bd,$7e,$c3,$99,$66,$11,$22,$33,$44",
    ], 0x008000);
    return sa1Rom({ pieces: [{ at: 0x008000, bytes: s.bytes }] });
  },
};

/**
 * Messaging and interrupts: the S-CPU's IRQ from the SA-1 ($2209 bit 7,
 * waking its WAI) through the $220E vector override, its NMI through $220C,
 * the SA-1's IRQ ($2200 bit 7) and NMI ($2200 bit 4) from the S-CPU's NMI
 * handler, the SA-1's H timer IRQ ($2210) with the H/V counter latch
 * ($2302-$2305), and the SA-1 waiting in WAI between them.
 */
sa1Programs.irq = function irq() {
  const s = asm([
    ...SCPU_INIT,
    "lda #<sa1main", "sta $2203", "lda #>sa1main", "sta $2204",
    "lda #<sa1nmi", "sta $2205", "lda #>sa1nmi", "sta $2206",
    "lda #<sa1irq", "sta $2207", "lda #>sa1irq", "sta $2208",
    "lda #<cpuirq", "sta $220e", "lda #>cpuirq", "sta $220f",
    "lda #<cpunmi", "sta $220c", "lda #>cpunmi", "sta $220d",
    "lda #$50", "sta $2209", "lda #$a0", "sta $2201", "lda #$ff", "sta $2229",
    "stz $2200",
    "lda #$81", "sta $4200",
    "cli",
    "wai",
    "lda #$01", "sta $7e0300",
    "main:", "rep #$20", "inc $0310", "sep #$20", "bra main",
    "cpuirq:", "rep #$20", "pha", "sep #$20",
    "lda $2300", "sta $7e0320", "lda #$80", "sta $2202",
    "rep #$20", "inc $0312", "pla", "rti",
    ".m8",
    "cpunmi:", "rep #$20", "pha", "sep #$20",
    "lda $4210", "rep #$20", "inc $0314", "sep #$20",
    "lda #$80", "sta $2200",
    "lda $0314", "and #$03", "bne nonmi", "lda #$90", "sta $2200",
    "nonmi:", "rep #$20", "pla", "rti",
    ".m8",
    ".org $8400",
    "sa1main:",
    ...SA1_INIT,
    "lda #$f0", "sta $220a", "lda #$01", "sta $2210", "lda #$40", "sta $2212", "stz $2213",
    "cli",
    "lda #$d0", "sta $2209",
    "loop:", "wai", "rep #$20", "inc $0020", "sep #$20", "bra loop",
    "sa1irq:", "rep #$20", "pha", "sep #$20",
    "lda $2301", "sta $30",
    "and #$40", "beq notimer",
    "rep #$20", "inc $0024", "sep #$20",
    "lda $2302", "sta $40", "lda $2303", "sta $41", "lda $2304", "sta $42", "lda $2305", "sta $43",
    "lda #$40", "sta $2212", "stz $2213",
    "notimer:",
    "lda $2301", "and #$80", "beq noirq",
    "rep #$20", "inc $0022", "sep #$20",
    "lda #$d0", "sta $2209",
    "noirq:",
    "lda #$c0", "sta $220b",
    "rep #$20", "pla", "rti",
    ".m8",
    "sa1nmi:", "rep #$20", "pha", "inc $0026", "sep #$20", "lda #$10", "sta $220b", "rep #$20", "pla", "rti",
  ], 0x008000);
  return sa1Rom({ pieces: [{ at: 0x008000, bytes: s.bytes }] });
};

/**
 * The SA-1's data units and memory views: character conversion 1 (an S-CPU
 * DMA from BW-RAM to VRAM), normal DMA (ROM -> I-RAM, BW-RAM -> I-RAM,
 * I-RAM -> BW-RAM) with its DMA-end flag, character conversion 2 (the
 * bitmap registers), the BW-RAM bitmap views ($60 banks, $2225 bit 7, both
 * $223F formats), $2224 / $2225 BW-RAM banking, MMC bank registers with
 * bit 7, MVN into I-RAM and BW-RAM, and code run from I-RAM (both CPUs),
 * BW-RAM and bank $41 (the SA-1's PCBase quirk). A 2MB image: the tests
 * emit arms for bank 0 only (the rest runs in the interpreter).
 */
sa1Programs.units = function units() {
  const s = asm([
    ...SCPU_INIT,
    "lda #<sa1main", "sta $2203", "lda #>sa1main", "sta $2204",
    "lda #$80", "sta $2226", "lda #$ff", "sta $2229",
    "stz $2200",
    "w1:", "lda $3000", "cmp #$11", "bne w1",
    "lda #$80", "sta $2115", "stz $2116", "stz $2117",
    "lda #$01", "sta $4300", "lda #$18", "sta $4301", "stz $4302", "stz $4303", "lda #$40", "sta $4304",
    "stz $4305", "lda #$02", "sta $4306", "lda #$01", "sta $420b",
    "lda $2300", "sta $7e0100",
    // a second conversion: 2bpp, 4 characters wide, starting mid-line
    "lda #$0a", "sta $2231", "lda #$b0", "sta $2230", "stz $2235", "stz $2236",
    "lda #$00", "sta $2116", "lda #$10", "sta $2117",
    "lda #$18", "sta $4302", "lda #$40", "sta $4304", "lda #$80", "sta $4305", "stz $4306", "lda #$01", "sta $420b",
    "lda #$80", "sta $2231",
    "lda #$22", "sta $3000",
    "w2:", "lda $3000", "cmp #$33", "bne w2",
    "lda #$01", "sta $2224", "lda $6000", "sta $7e0101", "lda $7fff", "sta $7e0102", "stz $2224",
    "jsr $3400",
    "lda $208000", "sta $7e0104", "lda $d00000", "sta $7e0105", "lda $e00000", "sta $7e0106", "lda $a08000", "sta $7e0107",
    "rep #$20", "loop:", "inc $0200", "bra loop",
    ".m8",
    ".org $8400",
    "sa1main:",
    ...SA1_INIT,
    "ldx #$0000", "fill:", "txa", "eor #$5a", "sta $400000,x", "inx", "cpx #$0400", "bne fill",
    "lda #$05", "sta $2231", "lda #$b0", "sta $2230", "stz $2235", "stz $2236",
    "lda #$11", "sta $00",
    "w3:", "lda $00", "cmp #$22", "bne w3",
    // normal DMA: ROM -> I-RAM $0200
    "lda #$80", "sta $2230", "stz $2232", "lda #$88", "sta $2233", "stz $2234", "lda #$40", "sta $2238", "stz $2239",
    "stz $2235", "lda #$02", "sta $2236",
    "lda $2301", "sta $70",
    // BW-RAM $10 -> I-RAM $0280
    "lda #$81", "sta $2230", "lda #$10", "sta $2232", "stz $2233", "stz $2234", "lda #$20", "sta $2238",
    "lda #$80", "sta $2235", "lda #$02", "sta $2236",
    // I-RAM $0200 -> BW-RAM $1000 (the $2237 write starts it)
    "lda #$86", "sta $2230", "stz $2232", "lda #$02", "sta $2233", "lda #$40", "sta $2238",
    "stz $2235", "lda #$10", "sta $2236", "stz $2237",
    // character conversion 2: 4bpp, two characters into I-RAM $0300
    "lda #$a0", "sta $2230", "lda #$01", "sta $2231", "stz $2235", "lda #$03", "sta $2236",
    "ldy #$0000",
    "cc2:", "ldx #$0000",
    "cc2b:", "tya", "asl a", "asl a", "asl a", "asl a", "sta $71", "txa", "clc", "adc $71", "sta $2240,x", "inx", "cpx #$0010", "bne cc2b",
    "iny", "cpy #$0008", "bne cc2",
    // bitmap views
    "stz $223f",
    "ldx #$0000", "bm4:", "txa", "sta $600000,x", "inx", "cpx #$0010", "bne bm4",
    "lda $600003", "sta $72", "lda $400001", "sta $73",
    "lda #$80", "sta $223f",
    "lda #$03", "sta $600020", "lda #$02", "sta $600021", "lda #$01", "sta $600022",
    "lda $600021", "sta $74", "lda $400008", "sta $75",
    "lda #$81", "sta $2225", "lda #$0f", "sta $6001", "lda $6001", "sta $76", "lda $400200", "sta $77",
    "stz $223f", "lda #$0e", "sta $6003", "lda $6003", "sta $78",
    "lda #$02", "sta $2225", "lda #$77", "sta $6000", "lda $404000", "sta $79",
    "stz $2225", "lda #$99", "sta $7fff", "lda #$98", "sta $6000",
    "lda #$55", "sta $402000", "lda #$66", "sta $403fff",
    // MMC
    "lda #$81", "sta $2221", "lda #$02", "sta $2222", "lda #$83", "sta $2223",
    "lda $208000", "sta $7a", "lda $d00000", "sta $7b", "lda $e00000", "sta $7c", "lda $a08000", "sta $7d", "lda $f00000", "sta $7e",
    // code: MVN a routine into I-RAM ($0400 for the S-CPU, $0500 for the SA-1), BW-RAM $6200 and SRAM $0100
    "rep #$30", "lda #$000f", "ldx #$8900", "ldy #$0400", "mvn $00,$00",
    "lda #$000f", "ldx #$8910", "ldy #$0500", "mvn $00,$00",
    "lda #$000f", "ldx #$8920", "ldy #$6200", "mvn $00,$00",
    "lda #$000f", "ldx #$8930", "ldy #$0100", "mvn $40,$00",
    "sep #$20", ".m8",
    "jsr $0500", "jsr $6200", "jsl $410100",
    "lda #$33", "sta $00",
    "rep #$20", "cnt:", "inc $0100", "bra cnt",
    ".m8",
    ".org $8800",
    ".db $01,$23,$45,$67,$89,$ab,$cd,$ef,$fe,$dc,$ba,$98,$76,$54,$32,$10,$11,$22,$33,$44,$55,$66,$77,$88,$99,$aa,$bb,$cc,$dd,$ee,$ff,$00",
    ".org $8900",
    ".db $a9,$42,$8f,$03,$01,$7e,$60,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea",   // lda #$42 / sta $7e0103 / rts
    ".db $a9,$5a,$85,$60,$60,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea",   // lda #$5a / sta $60 / rts
    ".db $a9,$6b,$85,$61,$60,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea",   // lda #$6b / sta $61 / rts
    ".db $a9,$7c,$85,$62,$6b,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea,$ea",   // lda #$7c / sta $62 / rtl
  ], 0x008000);
  const mark = (at, b) => ({ at, bytes: [b, b ^ 0xff, b + 1] });
  return sa1Rom({
    banks: 128,
    pieces: [{ at: 0x008000, bytes: s.bytes },
      mark(0x208000, 0xa1), mark(0xd00000, 0xb2), mark(0xd80000, 0xd4), mark(0xf00000, 0xe5)],
  });
};
