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

/** PRG window table (4 x u32 PRG offsets for $8000/$A000/$C000/$E000) and CHR slot table (8 x u32). */
const PRGMAP = 0x05700, CHRMAP = 0x05710;

/** fceumm's `ntSel` for a runtime $mirr holding MI_H 0 / MI_V 1 / MI_0 2 / MI_1 3. */
const NTSEL_MIRR = `(if (result i32) (i32.eqz (global.get $mirr)) (then (i32.shr_u (local.get $slot) (i32.const 1)))
      (else (if (result i32) (i32.eq (global.get $mirr) (i32.const 1)) (then (i32.and (local.get $slot) (i32.const 1)))
        (else (i32.sub (global.get $mirr) (i32.const 2))))))`;

/**
 * MMC3 (fceumm boards/mmc3.c: Mapper4_Init -> GenMMC3_Init(info, 512, 256,
 * 8KB WRAM), M4Power, MMC3_CMDWrite/MMC3_IRQWrite, ClockMMC3Counter run by
 * GameHBIRQHook once per rendered line, i.e. fceumm's own scanline model of
 * the A12 counter, not a dot-level one).
 */
function makeMmc3(d, prg) {
  const n = prg.length, base = BANKED_PRG, store = base + n;
  const mask8 = (pow2(n) >> 13) - 1;                                   // PRGmask8 &= (512K >> 13) - 1
  const chrBytes = d.chrSize || 0x2000;
  const mask1 = (pow2(chrBytes) >> 10) - 1;                            // CHRmask1 &= (256K >> 10) - 1
  const chrRam = !d.chrSize;
  const last = n - 0x2000;
  const isRevB = d.crc32 === 0x97b6cb19 ? 0 : 1;
  // FixMMC3PRG's Kick Master test reads $F885.. through the $E000 window,
  // which is always the last bank, so it is decided here; plus the CRCs
  const at = (a) => prg[last + (a & 0x1FFF)];
  const kick = (at(0xF885) === 0xA2 && at(0xF886) === 0x08 && at(0xF887) === 0xCA && at(0xF888) === 0xD0 &&
    at(0xF894) === 0x20 && at(0xF895) === 0xA7 && at(0xF896) === 0xFA && at(0xF897) === 0xAD) ||
    [0x5104833e, 0x5a6860f1, 0xae280e20].includes(d.crc32);
  const hbHook = kick ? "(if (i32.eq (global.get $scanline) (i32.const 238)) (then (call $m3_clock))) (call $m3_clock)"
    : d.crc32 === 0xfcd772eb ? "(if (i32.eq (global.get $scanline) (i32.const 240)) (then (call $m3_clock))) (call $m3_clock)"
      : "(call $m3_clock)";
  const win = (e) => `(i32.or (i32.load (i32.add (i32.const ${PRGMAP}) (i32.and (i32.shr_u ${e} (i32.const 11)) (i32.const 0xC))))
        (i32.and ${e} (i32.const 0x1FFF)))`;
  const hdrMirr = d.mirroring === "vertical" ? 1 : 0;
  const funcs = `
  ;; GENPWRAP: setprg8(A, V & $7F), masked by the chip size
  (func $m3_setprg (param $slot i32) (param $v i32)
    (i32.store (i32.add (i32.const ${PRGMAP}) (i32.shl (local.get $slot) (i32.const 2)))
      (i32.shl (i32.and (i32.and (local.get $v) (i32.const 0x7F)) (i32.const ${mask8})) (i32.const 13))))

  ;; FixMMC3PRG(V)
  (func $m3_prg (param $v i32)
    (if (i32.and (local.get $v) (i32.const 0x40))
      (then (call $m3_setprg (i32.const 2) (global.get $m3r6)) (call $m3_setprg (i32.const 0) (i32.const 0x7E)))
      (else (call $m3_setprg (i32.const 0) (global.get $m3r6)) (call $m3_setprg (i32.const 2) (i32.const 0x7E))))
    (call $m3_setprg (i32.const 1) (global.get $m3r7))
    (call $m3_setprg (i32.const 3) (i32.const 0x7F)))

  ;; GENCWRAP: setchr1(A, V) -> LineUpdate, then the 1KB bank into the window
  (func $m3_setchr (param $addr i32) (param $v i32)
    (local $slot i32) (local $off i32)
    (call $lineupdate)
    (local.set $slot (i32.and (i32.shr_u (local.get $addr) (i32.const 10)) (i32.const 7)))
    (local.set $off (i32.shl (i32.and (local.get $v) (i32.const ${mask1})) (i32.const 10)))
    ${chrRam ? `;; CHR RAM: write the slot back to the bank it showed first
    (memory.copy (i32.add (i32.const ${store}) (i32.load (i32.add (i32.const ${CHRMAP}) (i32.shl (local.get $slot) (i32.const 2)))))
      (i32.add (i32.const ${CHR}) (i32.shl (local.get $slot) (i32.const 10))) (i32.const 0x400))` : ""}
    (i32.store (i32.add (i32.const ${CHRMAP}) (i32.shl (local.get $slot) (i32.const 2))) (local.get $off))
    (memory.copy (i32.add (i32.const ${CHR}) (i32.shl (local.get $slot) (i32.const 10)))
      (i32.add (i32.const ${store}) (local.get $off)) (i32.const 0x400)))

  ;; GENMWRAP: A000B = V; setmirror((V & 1) ^ 1)
  (func $m3_mirror (param $v i32)
    (global.set $m3a000 (local.get $v))
    (call $lineupdate)
    ${d.mirrorHard ? "" : "(global.set $mirr (i32.xor (i32.and (local.get $v) (i32.const 1)) (i32.const 1)))"})

  ;; FixMMC3CHR(V)
  (func $m3_chr (param $v i32)
    (local $cb i32)
    (local.set $cb (i32.shl (i32.and (local.get $v) (i32.const 0x80)) (i32.const 5)))
    (call $m3_setchr (local.get $cb) (i32.and (global.get $m3r0) (i32.const 0xFE)))
    (call $m3_setchr (i32.xor (local.get $cb) (i32.const 0x400)) (i32.or (global.get $m3r0) (i32.const 1)))
    (call $m3_setchr (i32.xor (local.get $cb) (i32.const 0x800)) (i32.and (global.get $m3r1) (i32.const 0xFE)))
    (call $m3_setchr (i32.xor (local.get $cb) (i32.const 0xC00)) (i32.or (global.get $m3r1) (i32.const 1)))
    (call $m3_setchr (i32.xor (local.get $cb) (i32.const 0x1000)) (global.get $m3r2))
    (call $m3_setchr (i32.xor (local.get $cb) (i32.const 0x1400)) (global.get $m3r3))
    (call $m3_setchr (i32.xor (local.get $cb) (i32.const 0x1800)) (global.get $m3r4))
    (call $m3_setchr (i32.xor (local.get $cb) (i32.const 0x1C00)) (global.get $m3r5))
    (call $m3_mirror (global.get $m3a000)))

  ;; MMC3_CMDWrite ($8000-$BFFF) / MMC3_IRQWrite ($C000-$FFFF)
  (func $m3_write (param $a i32) (param $v i32)
    (local $cb i32) (local $r i32)
    (local.set $r (i32.and (local.get $a) (i32.const 0xE001)))
    (if (i32.eq (local.get $r) (i32.const 0x8000))
      (then
        (if (i32.and (i32.xor (local.get $v) (global.get $m3cmd)) (i32.const 0x40)) (then (call $m3_prg (local.get $v))))
        (if (i32.and (i32.xor (local.get $v) (global.get $m3cmd)) (i32.const 0x80)) (then (call $m3_chr (local.get $v))))
        (global.set $m3cmd (local.get $v))
        (return)))
    (if (i32.eq (local.get $r) (i32.const 0x8001))
      (then
        (local.set $cb (i32.shl (i32.and (global.get $m3cmd) (i32.const 0x80)) (i32.const 5)))
        (local.set $r (i32.and (global.get $m3cmd) (i32.const 7)))
        (if (i32.eqz (local.get $r)) (then (global.set $m3r0 (local.get $v))
          (call $m3_setchr (local.get $cb) (i32.and (local.get $v) (i32.const 0xFE)))
          (call $m3_setchr (i32.xor (local.get $cb) (i32.const 0x400)) (i32.or (local.get $v) (i32.const 1)))))
        (if (i32.eq (local.get $r) (i32.const 1)) (then (global.set $m3r1 (local.get $v))
          (call $m3_setchr (i32.xor (local.get $cb) (i32.const 0x800)) (i32.and (local.get $v) (i32.const 0xFE)))
          (call $m3_setchr (i32.xor (local.get $cb) (i32.const 0xC00)) (i32.or (local.get $v) (i32.const 1)))))
        (if (i32.eq (local.get $r) (i32.const 2)) (then (global.set $m3r2 (local.get $v))
          (call $m3_setchr (i32.xor (local.get $cb) (i32.const 0x1000)) (local.get $v))))
        (if (i32.eq (local.get $r) (i32.const 3)) (then (global.set $m3r3 (local.get $v))
          (call $m3_setchr (i32.xor (local.get $cb) (i32.const 0x1400)) (local.get $v))))
        (if (i32.eq (local.get $r) (i32.const 4)) (then (global.set $m3r4 (local.get $v))
          (call $m3_setchr (i32.xor (local.get $cb) (i32.const 0x1800)) (local.get $v))))
        (if (i32.eq (local.get $r) (i32.const 5)) (then (global.set $m3r5 (local.get $v))
          (call $m3_setchr (i32.xor (local.get $cb) (i32.const 0x1C00)) (local.get $v))))
        (if (i32.eq (local.get $r) (i32.const 6)) (then (global.set $m3r6 (local.get $v))
          (call $m3_setprg (if (result i32) (i32.and (global.get $m3cmd) (i32.const 0x40)) (then (i32.const 2)) (else (i32.const 0))) (local.get $v))))
        (if (i32.eq (local.get $r) (i32.const 7)) (then (global.set $m3r7 (local.get $v))
          (call $m3_setprg (i32.const 1) (local.get $v))))
        (return)))
    (if (i32.eq (local.get $r) (i32.const 0xA000)) (then (call $m3_mirror (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 0xA001)) (then (global.set $m3a001 (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 0xC000)) (then (global.set $m3latch (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 0xC001)) (then (global.set $m3reload (i32.const 1)) (return)))
    (if (i32.eq (local.get $r) (i32.const 0xE000))
      (then (global.set $irqlow (i32.and (global.get $irqlow) (i32.const -2))) (global.set $m3irqa (i32.const 0)) (return)))
    (global.set $m3irqa (i32.const 1)))

  ;; ClockMMC3Counter${isRevB ? "" : " (isRevB = 0 for this cart)"}
  (func $m3_clock
    (local $count i32)
    (local.set $count (global.get $m3count))
    (if (i32.or (i32.eqz (local.get $count)) (global.get $m3reload))
      (then (global.set $m3count (global.get $m3latch)) (global.set $m3reload (i32.const 0)))
      (else (global.set $m3count (i32.sub (global.get $m3count) (i32.const 1)))))
    (if (i32.and (i32.ne (i32.or (local.get $count) (i32.const ${isRevB})) (i32.const 0)) (i32.eqz (global.get $m3count)))
      (then (if (global.get $m3irqa) (then (global.set $irqlow (i32.or (global.get $irqlow) (i32.const 1))))))))
`;
  return {
    prgBase: base,
    prgRead: `(i32.load8_u (i32.add (i32.const ${base}) ${win("(local.get $a)")}))`,
    pcOffset: win("(global.get $pc)"),
    fixedByte: (addr) => (addr >= 0xE000 ? prg[last + (addr & 0x1FFF)] : null),
    armBase: (off) => (off >= last ? 0xE000 : 0x8000) | (off & 0x1FFF),
    window: 0x2000,
    operand: (off, k) => prg[(off + k) % n],
    romWrite: `
    (if (i32.ge_u (local.get $a) (i32.const 0x8000)) (then (call $m3_write (local.get $a) (local.get $v))))`,
    romWritesMatter: true,
    globals: ["m3cmd", "m3a000", "m3a001", "m3count", "m3latch", "m3irqa", "m3reload", "m3r6", "m3r0"]
      .map((g) => `  (global $${g} (mut i32) (i32.const 0))\n`).join("") +
      "  (global $m3r1 (mut i32) (i32.const 2))\n  (global $m3r2 (mut i32) (i32.const 4))\n  (global $m3r3 (mut i32) (i32.const 5))\n" +
      "  (global $m3r4 (mut i32) (i32.const 6))\n  (global $m3r5 (mut i32) (i32.const 7))\n  (global $m3r7 (mut i32) (i32.const 1))\n" +
      `  (global $mirr (mut i32) (i32.const ${hdrMirr}))\n`,
    funcs,
    ntSel: NTSEL_MIRR,
    wramGate: null,
    chrStore: store,
    hbHook,
    // GenMMC3Power + MMC3RegReset (FixMMC3PRG(0), FixMMC3CHR(0) with the
    // default DRegBuf), then M4Power: A000B = header^1, setmirror(header).
    // CHR RAM starts identity-mapped (setchr8(0)).
    init: `${chrRam ? Array.from({ length: 8 }, (_, i) => `(i32.store (i32.const ${CHRMAP + 4 * i}) (i32.const ${i * 0x400}))`).join(" ") : ""}
    (call $m3_prg (i32.const 0)) (call $m3_chr (i32.const 0))
    (global.set $m3a000 (i32.const ${(hdrMirr ^ 1) & 1}))
    ${d.mirrorHard ? "" : `(global.set $mirr (i32.const ${hdrMirr}))`}`,
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
  4: {
    id: 4, name: "MMC3", make: makeMmc3, layout: withWram,
    supports: (d) => banked(d) || ([0x93991433, 0xaf65aa84].includes(d.crc32) ? "an MMC3 board without WRAM (fceumm's Low-G-Man special case)" : null),
  },
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
