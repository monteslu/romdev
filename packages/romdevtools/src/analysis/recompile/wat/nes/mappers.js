// NES mappers for the WAT backend.
//
// The cart has ONE dispatch arm per PRG byte offset (see index.js), so a
// mapper only has to say how the CPU address space reaches PRG and CHR. The
// hooks below are the ONLY place the emitted WAT differs by mapper; the CPU,
// PPU and frame loop never change. A new mapper is one entry in MAPPERS.
//
// MAPPERS[id] = { id, name, supports(d) -> reason|null, make(d, prg) -> M }
// where d is describe()'s result and M carries:
//   prgBase           linear address of the PRG image
//   prgRead           expression: the byte at CPU $8000-$FFFF, given
//                     `(local.get $a)` in $rd8
//   pcOffset          expression: the PRG offset of the arm for the RUNTIME
//                     $pc (>= $8000), used by $step's dispatch and cycle fetch
//   fixedByte(addr)   a ROM operand that cannot change at run time is folded
//                     to a constant; a banked window returns null (read
//                     through $rd8)
//   armBase(off)      the canonical CPU address of PRG offset `off` (only its
//                     low byte and page parity matter: they decide a branch's
//                     static page-cross cost)
//   operand(off, k)   the k-th byte after the opcode at `off` as the CPU sees
//                     it (an instruction can straddle a bank window)
//   romWrite          statements run for EVERY CPU write that reaches the end
//                     of $wr8 (a >= $6000), `(local.get $a)`/`(local.get $v)`
//   romWritesMatter   the cart has registers at $8000+, so a RMW instruction's
//                     double write (old value, then new) must reach them
//   globals, funcs    extra (global ...) / (func ...) text
//   ntSel             nametable page expression (local $slot), or null for the
//                     header's fixed mirroring
//   wramGate          expression: is $6000-$7FFF enabled (null = always)
//   chrStore          linear address of the whole CHR ROM (banked CHR), or 0
//   init              statements for wc_init (the power-on mapping)
//   pages             64KB wasm pages the layout needs
//   layout(l)         the romdev.recompile layout for this mapper
//
// CHR banking copies the selected bank(s) into the 8KB window at ppu.CHR, so
// the PPU never changes per mapper; romdev's reference region nes_chr is that
// same mapped 8KB (VPage[0..7]). Every fceumm setchr*/setmirror call does
// FCEUPPU_LineUpdate() first (cart.c), i.e. the background is drawn up to
// the current dot with the OLD banks, so the copies here do too.
//
// Ported from fceumm: boards/datalatch.c (UNROM, CNROM: Latch_Init, bus
// conflicts only when an NES 2.0 header asks, submapper 2; 8KB WRAM at
// $6000), boards/mmc1.c (GenMMC1Init/MMC1_write/MMC1PRG/MMC1CHR/MMC1MIRROR,
// the busy window after a reset write), cart.c (setprg16/setchr4/setchr8
// masks against the power-of-two chip size).
//
// Plain JS ESM + JSDoc.

import { PRG, CHR, WRAM } from "./ppu.js";

/** Banked carts put PRG above the 1MB fixed layout, CHR ROM after it. */
const BANKED_PRG = 0x100000;

const pow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

/** Common layout additions for carts with 8KB WRAM at $6000. */
const withWram = (l) => ({ ...l, regions: { ...l.regions, wram: { offset: WRAM, length: 0x2000, ref: "nes_cart_ram" } } });

/** Refuse what fceumm would mask in a way these ports do not reproduce. */
function banked({ prgSize, chrSize }) {
  if (prgSize & (prgSize - 1)) return `PRG size ${prgSize} is not a power of two`;
  if (chrSize & (chrSize - 1)) return `CHR size ${chrSize} is not a power of two`;
  return null;
}

/** memory.copy of `len` bytes from CHR ROM offset `src` (expression) into the window at `dst`. */
const chrCopy = (store, dst, src, len) =>
  `(memory.copy (i32.const ${CHR + dst}) (i32.add (i32.const ${store}) ${src}) (i32.const ${len}))`;

/** UxROM: $8000 = 16KB latch bank, $C000 = the last bank. */
function makeUxrom(d, prg) {
  const n = prg.length, last = n - 0x4000, base = BANKED_PRG;
  const mask16 = (pow2(n) >> 14) - 1;
  const conflict = d.nes2 && d.submapper === 2;
  const win = (e) => `(if (result i32) (i32.lt_u ${e} (i32.const 0xC000))
        (then (i32.or (global.get $prgA) (i32.and ${e} (i32.const 0x3FFF))))
        (else (i32.or (i32.const ${last}) (i32.and ${e} (i32.const 0x3FFF)))))`;
  return {
    prgBase: base,
    prgRead: `(i32.load8_u (i32.add (i32.const ${base}) ${win("(local.get $a)")}))`,
    pcOffset: win("(global.get $pc)"),
    fixedByte: (addr) => (addr >= 0xC000 ? prg[last + (addr & 0x3FFF)] : null),
    armBase: (off) => (off >= last ? 0xC000 : 0x8000) | (off & 0x3FFF),
    // an instruction at the end of a switchable bank runs on into $C000
    operand: (off, k) => ((off < last && (off & 0x3FFF) + k > 0x3FFF) ? prg[last + (((off & 0x3FFF) + k) & 0x3FFF)] : prg[(off + k) % n]),
    romWrite: `
    (if (i32.ge_u (local.get $a) (i32.const 0x8000))
      (then
        ;; LatchWrite${conflict ? " (bus conflict: V & CartBR(A))" : ""}, UNROMSync: setprg16($8000, latch); setchr8(0) -> LineUpdate
        ${conflict ? `(local.set $v (i32.and (local.get $v) (i32.load8_u (i32.add (i32.const ${base}) ${win("(local.get $a)")}))))` : ""}
        (global.set $prgA (i32.shl (i32.and (local.get $v) (i32.const ${mask16})) (i32.const 14)))
        (call $lineupdate)))`,
    romWritesMatter: true,
    globals: "  (global $prgA (mut i32) (i32.const 0))\n",
    funcs: "",
    ntSel: null,
    wramGate: null,
    chrStore: 0,
    init: "",
    pages: Math.ceil((base + n) / 0x10000),
  };
}

/** CNROM: PRG as NROM, $8000-$FFFF write = 8KB CHR bank. */
function makeCnrom(d, prg) {
  const n = prg.length, base = BANKED_PRG, store = base + n;
  const mask8 = d.chrSize ? (pow2(d.chrSize) >> 13) - 1 : 0;
  const conflict = d.nes2 && d.submapper === 2;
  const off = `(i32.and (local.get $a) (i32.const ${n - 1}))`;
  return {
    prgBase: base,
    prgRead: `(i32.load8_u (i32.add (i32.const ${base}) ${off}))`,
    pcOffset: `(i32.and (global.get $pc) (i32.const ${n - 1}))`,
    fixedByte: (addr) => prg[(addr - 0x8000) % n],
    armBase: (o) => 0x10000 - n + o,
    operand: (o, k) => prg[(o + k) % n],
    romWrite: `
    (if (i32.ge_u (local.get $a) (i32.const 0x8000))
      (then
        ;; LatchWrite${conflict ? " (bus conflict)" : ""}, CNROMSync: setchr8(latch) -> LineUpdate, then the bank
        ${conflict ? `(local.set $v (i32.and (local.get $v) (i32.load8_u (i32.add (i32.const ${base}) ${off}))))` : ""}
        (call $lineupdate)
        ${d.chrSize ? chrCopy(store, 0, `(i32.shl (i32.and (local.get $v) (i32.const ${mask8})) (i32.const 13))`, 0x2000) : ""}))`,
    romWritesMatter: true,
    globals: "",
    funcs: "",
    ntSel: null,
    wramGate: null,
    chrStore: d.chrSize ? store : 0,
    init: "",
    pages: Math.ceil((store + d.chrSize) / 0x10000),
  };
}

/**
 * MMC1 (fceumm Mapper1_Init = GenMMC1Init(info, 512, 256, 8KB WRAM)): serial
 * port, PRG modes, 4/8KB CHR, runtime mirroring, WRAM enable.
 */
function makeMmc1(d, prg) {
  const n = prg.length, base = BANKED_PRG, store = base + n;
  // GenMMC1Init's `PRGmask16[0] &= (prg >> 14) - 1` is passed prg = 512 (KB),
  // so it ANDs with -1: only the chip-size mask applies (same for CHR)
  const mask16 = (pow2(n) >> 14) - 1;
  const chrBytes = d.chrSize || 0x2000;                               // ines.c gives CHR-less carts 8KB CHR RAM
  const mask4 = (pow2(chrBytes) >> 12) - 1;
  const chrRam = !d.chrSize;
  // mirr holds fceumm's MI_* value: 0 H, 1 V, 2 one-screen A, 3 one-screen B
  const hdrMirr = d.mirroring === "vertical" ? 1 : d.mirroring === "one-screen-a" ? 2 : d.mirroring === "one-screen-b" ? 3 : 0;
  const win = (e) => `(i32.or (if (result i32) (i32.lt_u ${e} (i32.const 0xC000)) (then (global.get $prgA)) (else (global.get $prgB)))
        (i32.and ${e} (i32.const 0x3FFF)))`;
  const funcs = `
  ;; MMC1PRG: the two 16KB windows (setprg16 masks by the chip size)
  (func $mmc1_prg
    (local $offs i32) (local $a i32) (local $b i32)
    (local.set $offs (i32.and (global.get $dr1) (i32.const 0x10)))
    (if (i32.eq (i32.and (global.get $dr0) (i32.const 0xC)) (i32.const 0xC))
      (then (local.set $a (i32.add (global.get $dr3) (local.get $offs)))
            (local.set $b (i32.add (i32.const 0xF) (local.get $offs))))
      (else (if (i32.eq (i32.and (global.get $dr0) (i32.const 0xC)) (i32.const 0x8))
        (then (local.set $b (i32.add (global.get $dr3) (local.get $offs)))
              (local.set $a (local.get $offs)))
        (else (local.set $a (i32.add (i32.and (global.get $dr3) (i32.const 0x1E)) (local.get $offs)))
              (local.set $b (i32.add (local.get $a) (i32.const 1)))))))
    (global.set $prgA (i32.shl (i32.and (local.get $a) (i32.const ${mask16})) (i32.const 14)))
    (global.set $prgB (i32.shl (i32.and (local.get $b) (i32.const ${mask16})) (i32.const 14))))

  ;; MMC1CHR: setchr4 x2 (4KB mode) or setchr8; each is a LineUpdate first
  (func $mmc1_chr
    (local $lo i32) (local $hi i32)
    (call $lineupdate)
    (if (i32.and (global.get $dr0) (i32.const 0x10))
      (then (local.set $lo (i32.and (global.get $dr1) (i32.const ${mask4})))
            (local.set $hi (i32.and (global.get $dr2) (i32.const ${mask4}))))
      (else (local.set $lo (i32.and (i32.and (global.get $dr1) (i32.const 0x1E)) (i32.const ${mask4})))
            (local.set $hi (i32.and (i32.or (global.get $dr1) (i32.const 1)) (i32.const ${mask4})))))
    (local.set $lo (i32.shl (local.get $lo) (i32.const 12)))
    (local.set $hi (i32.shl (local.get $hi) (i32.const 12)))
    ${chrRam ? `;; CHR RAM: the window IS the RAM for the banks it shows; write both
    ;; halves back before remapping. Two halves showing ONE bank cannot be
    ;; kept coherent this way: counted in the probe (mapwarn).
    (if (i32.and (i32.eq (local.get $lo) (global.get $chrlo)) (i32.eq (local.get $hi) (global.get $chrhi))) (then (return)))
    (memory.copy (i32.add (i32.const ${store}) (global.get $chrlo)) (i32.const ${CHR}) (i32.const 0x1000))
    (memory.copy (i32.add (i32.const ${store}) (global.get $chrhi)) (i32.const ${CHR + 0x1000}) (i32.const 0x1000))
    (if (i32.eq (local.get $lo) (local.get $hi)) (then (global.set $mapwarn (i32.add (global.get $mapwarn) (i32.const 1)))))` : ""}
    (global.set $chrlo (local.get $lo))
    (global.set $chrhi (local.get $hi))
    ${chrCopy(store, 0, "(local.get $lo)", 0x1000)}
    ${chrCopy(store, 0x1000, "(local.get $hi)", 0x1000)})

  ;; MMC1MIRROR -> setmirror (LineUpdate; ignored when the header hard-wires it)
  (func $mmc1_mirror
    (local $m i32)
    ${d.submapper === 7 ? "(return)" : ""}
    (call $lineupdate)
    ${d.mirrorHard ? "(return)" : ""}
    (local.set $m (i32.and (global.get $dr0) (i32.const 3)))
    ;; 2 -> MI_V, 3 -> MI_H, 0 -> MI_0, 1 -> MI_1
    (global.set $mirr (if (result i32) (i32.lt_u (local.get $m) (i32.const 2))
      (then (i32.add (local.get $m) (i32.const 2)))
      (else (i32.sub (i32.const 3) (local.get $m))))))

  ;; MMC1_write
  (func $mmc1_write (param $a i32) (param $v i32)
    (local $n i32)
    ;; "The MMC1 is busy so ignore the write": within 2 cycles of a reset
    ;; write, i.e. the second write of a RMW instruction
    (if (i32.lt_u (global.get $ts) (i32.add (global.get $lreset) (i32.const 2))) (then (return)))
    (if (i32.and (local.get $v) (i32.const 0x80))
      (then
        (global.set $dr0 (i32.or (global.get $dr0) (i32.const 0xC)))
        (global.set $mbuf (i32.const 0))
        (global.set $mshift (i32.const 0))
        (call $mmc1_prg)
        (global.set $lreset (global.get $ts))
        (return)))
    (global.set $mbuf (i32.or (global.get $mbuf) (i32.shl (i32.and (local.get $v) (i32.const 1)) (global.get $mshift))))
    (global.set $mshift (i32.add (global.get $mshift) (i32.const 1)))
    (if (i32.ne (global.get $mshift) (i32.const 5)) (then (return)))
    (local.set $n (i32.sub (i32.shr_u (local.get $a) (i32.const 13)) (i32.const 4)))
    (if (i32.eqz (local.get $n)) (then (global.set $dr0 (global.get $mbuf))))
    (if (i32.eq (local.get $n) (i32.const 1)) (then (global.set $dr1 (global.get $mbuf))))
    (if (i32.eq (local.get $n) (i32.const 2)) (then (global.set $dr2 (global.get $mbuf))))
    (if (i32.eq (local.get $n) (i32.const 3)) (then (global.set $dr3 (global.get $mbuf))))
    (global.set $mbuf (i32.const 0))
    (global.set $mshift (i32.const 0))
    (if (i32.eqz (local.get $n)) (then (call $mmc1_mirror) (call $mmc1_chr) (call $mmc1_prg) (return)))
    (if (i32.eq (local.get $n) (i32.const 1)) (then (call $mmc1_chr) (call $mmc1_prg) (return)))
    (if (i32.eq (local.get $n) (i32.const 2)) (then (call $mmc1_chr) (return)))
    (call $mmc1_prg))
`;
  return {
    prgBase: base,
    prgRead: `(i32.load8_u (i32.add (i32.const ${base}) ${win("(local.get $a)")}))`,
    pcOffset: win("(global.get $pc)"),
    fixedByte: () => null,
    armBase: (off) => 0x8000 | (off & 0x3FFF),
    window: 0x4000,
    operand: (off, k) => prg[(off + k) % n],
    romWrite: `
    (if (i32.ge_u (local.get $a) (i32.const 0x8000)) (then (call $mmc1_write (local.get $a) (local.get $v))))`,
    romWritesMatter: true,
    globals: ["dr1", "dr2", "dr3", "mbuf", "mshift", "lreset", "prgA", "prgB", "chrlo"]
      .map((g) => `  (global $${g} (mut i32) (i32.const 0))\n`).join("") +
      "  (global $chrhi (mut i32) (i32.const 0x1000))\n" +
      "  (global $dr0 (mut i32) (i32.const 0x0C))\n" +
      `  (global $mirr (mut i32) (i32.const ${hdrMirr}))\n`,
    funcs,
    ntSel: `(if (result i32) (i32.eqz (global.get $mirr)) (then (i32.shr_u (local.get $slot) (i32.const 1)))
      (else (if (result i32) (i32.eq (global.get $mirr) (i32.const 1)) (then (i32.and (local.get $slot) (i32.const 1)))
        (else (i32.sub (global.get $mirr) (i32.const 2))))))`,
    // MAWRAM/MBWRAM: DRegs[3] bit 4 disables it (reads then return X.DB)
    wramGate: "(i32.eqz (i32.and (global.get $dr3) (i32.const 0x10)))",
    chrStore: store,
    // GenMMC1Power -> MMC1CMReset: DRegs = {$0C,0,0,0}; MIRROR, CHR, PRG
    init: "(call $mmc1_mirror) (call $mmc1_chr) (call $mmc1_prg)",
    pages: Math.ceil((store + chrBytes) / 0x10000),
  };
}

/** @type {Record<number, {id: number, name: string, supports?: Function, make?: Function}>} */
export const MAPPERS = {
  0: {
    id: 0,
    name: "NROM",
    supports: ({ prgSize }) => (prgSize > 0x8000 ? `mapper 0 with ${prgSize} bytes of PRG` : null),
    make: (d, prg) => {
      const n = prg.length;
      return {
        prgBase: PRG,
        // A 16KB NROM-128 image appears at both $8000 and $C000; masking by
        // the PRG size folds the mirror.
        prgRead: `(i32.load8_u (i32.add (i32.const ${PRG})
        (i32.and (local.get $a) (i32.const ${Math.max(1, n) - 1}))))`,
        pcOffset: `(i32.and (global.get $pc) (i32.const ${n - 1}))`,
        fixedByte: (addr) => prg[(addr - 0x8000) % n],
        // Arms use the RUNTIME pc for fall-through/branches/pushes, so the
        // base only matters for static branch page-cross costs (identical
        // in either mirror) and for the arm comments.
        armBase: (off) => 0x10000 - n + off,
        operand: (off, k) => prg[(off + k) % n],
        romWrite: "",
        romWritesMatter: false,
        globals: "",
        funcs: "",
        ntSel: null,
        wramGate: null,
        chrStore: 0,
        init: "",
        pages: 16,
      };
    },
  },
  1: {
    id: 1, name: "MMC1", make: makeMmc1, layout: withWram,
    // DetectMMC1WRAMSize: an NES 2.0 header (or an ines-correct.h row that
    // makes it one) sizes WRAM; more than 8KB is banked through CHR regs
    supports: (d) => banked(d) || ((d.nes2 || d.prgRam != null) && d.prgRam !== 8192
      ? `MMC1 with ${d.prgRam} bytes of WRAM (only the plain 8KB board is modelled)` : null),
  },
  2: { id: 2, name: "UxROM", supports: banked, make: makeUxrom, layout: withWram },
  3: {
    id: 3, name: "CNROM", make: makeCnrom, layout: withWram,
    supports: (d) => banked(d) || (d.prgSize > 0x8000 ? `CNROM with ${d.prgSize} bytes of PRG` : null),
  },
};

/**
 * Nametable page select for header (fixed) mirroring: slot (0-3, local $slot)
 * -> CIRAM page 0/1. iNES flags6 bit 0: 0 = HORIZONTAL, 1 = VERTICAL;
 * ines-correct.h can also hard-wire one-screen (MI_0 / MI_1).
 * @param {string} mirroring  describe().mirroring
 */
export function ntSelFixed(mirroring) {
  if (mirroring === "one-screen-a") return "(i32.const 0)";
  if (mirroring === "one-screen-b") return "(i32.const 1)";
  return mirroring === "vertical"
    ? "(i32.and (local.get $slot) (i32.const 1))"
    : "(i32.shr_u (local.get $slot) (i32.const 1))";
}
