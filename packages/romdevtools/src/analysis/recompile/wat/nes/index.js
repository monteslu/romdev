// NES WAT backend: statically recompile an iNES ROM into a wasmcart whose
// machine model is fceumm's, because fceumm is what the cart is verified
// against through romdev.
//
//   CPU   cpu.js   - decoded from PRG bytes, fceumm x6502.c cycle rules.
//   PPU   ppu.js   - a port of fceumm ppu.c (lazy RefreshLine, sprite fetch
//                    at end of line, CheckSpriteHit).
//   FRAME wc_render - FCEUPPU_Loop: a frame STARTS at line 240, then vblank
//                    (flag set, 12 dots, NMI), then the pre-render line, then
//                    lines 0-239. Two "ppudead" frames at power run the CPU
//                    with no vblank at all, as fceumm does after PowerNES.
//   X6502_Run(dots) adds dots*16 to a signed budget and runs whole
//   instructions while it is positive; each cycle costs 48. Instructions that
//   overrun carry the debt into the next Run, exactly as fceumm's _count does.
//   APU   only the parts that move the CPU clock or RAM: DMC DMA cycle
//         steals (4 per sample byte) and the $4016/$4017 pads.
//
// Every PRG offset gets an arm (data bytes included) so any entry point the
// game reaches is covered; an offset whose byte is not an official opcode
// becomes a trap that records pc and opcode in the probe block.
//
// Ported from sms-wat src/emit_nes.py (commits 1dd6c1a + 219d233, 8 mapper-0
// carts cycle-exact against fceumm through frame 2905 with input). The WAT
// text is kept identical to the Python emitter's so the two can be diffed;
// the one intended difference is that emit_nes.py's wr8 carried the
// $4010/$4012/$4013/$4015 block twice (idempotent), and it is emitted once
// here.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { lower, cyc, PACK_P, Unsupported } from "./cpu.js";
import {
  FB_W, FB_H, NESFB, PRG, WRAM, CHR, APUREG, RGBTAB, CYCTAB, DMCTAB,
  NTRAM, PAL, OAM, luts, globalsWat, ppuWat,
} from "./ppu.js";
import { MAPPERS, ntSelFixed } from "./mappers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FCEUMM = JSON.parse(readFileSync(path.join(__dirname, "fceumm-tables.json"), "utf8"));
const CYCLES = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "m6502-cycles.json"), "utf8"));

export const platforms = ["nes"];

/** Reference core the cart is verified against. */
export const REFERENCE_CORE = "fceumm";

// ---- linear-memory probe block (host-readable via wasm({op:'read'})) -------
// Cart GLOBALS are invisible to the host, so everything worth reading from
// outside is mirrored here.
export const PROBE = 0x08000;   // PROBE_FIELDS, u32 each
export const PCRING = 0x09000;  // 1024 x (pc u16 | opcode<<16, ts): last instructions
export const INPUT = 0x08400;   // 64 bytes host pad state (inputPtr) - MUST NOT be 0
export const TIME = 0x08440;    // 24 bytes host clock (timePtr) - MUST NOT be 0, 8-aligned
export const FB = 0x70000;
export const ABI = FB + FB_W * FB_H * 4 + 0x1000;

export const PROBE_FIELDS = ["steps", "trapped", "trappc", "pc", "frame", "nnmi", "ts",
  "a", "x", "y", "s", "p", "ppu0", "ppu1", "ppustatus",
  "refaddr", "tmpaddr", "xoff", "joy", "trapop", "nvram",
  "ringi", "nbrk", "nemph", "cnt", "apu4017", "dmcsize", "dmcirq"];

/**
 * Linear-memory regions the verify op compares against the reference core's
 * memory regions, plus the probe block. Static for every NES cart.
 */
export const layout = {
  regions: {
    ram: { offset: 0x0000, length: 0x800, ref: "system_ram" },
    nametables: { offset: NTRAM, length: 0x800, ref: "nes_nametables" },
    palette: { offset: PAL, length: 32, ref: "nes_palette" },
    oam: { offset: OAM, length: 256, ref: "nes_oam" },
  },
  probe: {
    offset: PROBE,
    fields: Object.fromEntries(PROBE_FIELDS.map((f, i) => [f, {
      offset: PROBE + 4 * i, type: f === "cnt" ? "i32" : "u32",
    }])),
  },
  // CPU state compared against cpu({op:'read'}) on the reference. P is
  // compared with bits 4-5 forced (B and the unused bit are not flags);
  // `count` is fceumm's internal X.count, which equal only when both sides
  // are on the same cycle.
  cpu: {
    pc: "pc", A: "a", X: "x", Y: "y", S: "s",
    P: { field: "p", orMask: 0x30 },
    count: { field: "cnt", ref: "coreInternal.count" },
  },
  trap: { flag: "trapped", pc: "trappc", op: "trapop" },
  pcRing: { offset: PCRING, entries: 1024, stride: 8, format: "u32 pc|opcode<<16, u32 ts" },
  framebuffer: { offset: FB, width: FB_W, height: FB_H, format: "rgba8888" },
};

/**
 * Frame / input conventions the verify op needs. Both sides are tracked by
 * TOTAL frames executed (romdev's wasmcart host settles 1 frame at load,
 * fceumm 5); with fceumm's frame loop modelled exactly, the same total is the
 * same picture, so the aligned offset in total frames is 0. The cart reads
 * the pad POSITIONALLY (the east face button, WC_BTN_B, is NES A), so to
 * press NES `a` on the cart send wasmcart `b`, and vice versa.
 */
export const conventions = {
  frameAxis: "total",
  settleFrames: { cart: 1, reference: 5 },
  totalFrameOffset: 0,
  warmupFrames: 0,
  cartInputNames: { a: "b", b: "a" },
};

/**
 * Parse the iNES header and derive everything the emitter needs.
 * @param {Uint8Array} rom  the whole .nes file
 * @param {object} [_opts]
 */
export function describe(rom, _opts = {}) {
  rom = toBytes(rom);
  if (rom.length < 16 || rom[0] !== 0x4E || rom[1] !== 0x45 || rom[2] !== 0x53 || rom[3] !== 0x1A) {
    throw new Error("nes recompile: not an iNES image (missing 'NES\\x1A' header)");
  }
  rom = cleanHeader(rom);
  const nes2 = (rom[7] & 0x0C) === 0x08;
  const prgBanks = rom[4], chrBanks = rom[5];
  const mapper = (rom[6] >> 4) | (rom[7] & 0xF0);
  const trainer = (rom[6] & 4) ? 512 : 0;
  const prgStart = 16 + trainer;
  const prgSize = prgBanks * 0x4000;
  const chrSize = chrBanks * 0x2000;
  if (prgSize === 0) throw new Error("nes recompile: header declares 0 PRG banks");
  if (rom.length < prgStart + prgSize + chrSize) {
    throw new Error(`nes recompile: file is ${rom.length} bytes, header needs ${prgStart + prgSize + chrSize}`);
  }
  const m = MAPPERS[mapper];
  const fourScreen = !!(rom[6] & 8);
  let unsupportedReason = null;
  if (!m) unsupportedReason = `mapper ${mapper} has no WAT backend yet (supported: ${Object.keys(MAPPERS).join(", ")})`;
  else if (prgSize > 0x8000) unsupportedReason = `mapper ${mapper} with ${prgSize} bytes of PRG`;
  else if (fourScreen) unsupportedReason = "four-screen nametables (4KB of cart VRAM) are not modelled";
  return {
    platform: "nes",
    referenceCore: REFERENCE_CORE,
    mapper,
    mapperName: m ? m.name : null,
    supported: unsupportedReason === null,
    unsupportedReason,
    nes2,
    prgBanks, chrBanks, prgSize, chrSize,
    prgOffset: prgStart,
    chrOffset: prgStart + prgSize,
    trainer: trainer > 0,
    chrRam: chrBanks === 0,
    // iNES flags6 bit 0: 0 = HORIZONTAL mirroring, 1 = VERTICAL.
    mirroring: fourScreen ? "four-screen" : ((rom[6] & 1) ? "vertical" : "horizontal"),
    battery: !!(rom[6] & 2),
    arms: prgSize,
    layout,
    conventions,
  };
}

/**
 * fceumm ines.c's header clean-up: old dumpers wrote a signature over bytes
 * 7-15 ("DiskDude!", "demiforce", "Ni03"), which would otherwise read as a
 * mapper high nibble. Returns a copy with those bytes zeroed, as fceumm does.
 * @param {Uint8Array} rom
 */
function cleanHeader(rom) {
  const at = (o, str) => [...str].every((c, i) => rom[o + i] === c.charCodeAt(0));
  let from = -1, len = 0;
  if (at(7, "DiskDude") || at(7, "demiforce")) { from = 7; len = 9; }
  else if (at(0xA, "Ni03")) { if (at(7, "Dis")) { from = 7; len = 9; } else { from = 0xA; len = 6; } }
  if (from < 0) return rom;
  const h = Uint8Array.from(rom.subarray(0, 16));
  h.fill(0, from, from + len);
  const out = new Uint8Array(rom.length);
  out.set(rom);
  out.set(h, 0);
  return out;
}

/** @param {Uint8Array|ArrayBuffer|Buffer} b */
function toBytes(b) {
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  throw new TypeError("nes recompile: rom must be a Uint8Array/Buffer");
}

/** @param {Uint8Array} b */
function watBytes(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) s += "\\" + (b[i] < 16 ? "0" : "") + b[i].toString(16);
  return s;
}

/** @param {number[]} arr */
function u32le(arr) {
  const b = new Uint8Array(arr.length * 4);
  const dv = new DataView(b.buffer);
  arr.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
  return b;
}

/**
 * The `romdev.recompile` custom section: everything the verify op needs to
 * compare this cart with the reference, so no sidecar file is required.
 * @param {Uint8Array} rom
 * @param {string} [sha1]  sha1 of the ROM file (hex), if the caller has it
 */
export function recompileSection(rom, sha1) {
  const d = describe(rom);
  return {
    name: "romdev.recompile",
    json: {
      version: 1,
      platform: "nes",
      referenceCore: REFERENCE_CORE,
      romSha1: sha1 || null,
      mapper: d.mapper,
      mirroring: d.mirroring,
      regions: layout.regions,
      probe: layout.probe,
      cpu: layout.cpu,
      trap: layout.trap,
      pcRing: layout.pcRing,
      framebuffer: layout.framebuffer,
      conventions,
    },
  };
}

function cpuGlobals() {
  const g = ["a", "x", "y", "pc", "fn", "fv", "fd", "fz", "fc", "t", "t2", "t3",
    "ea", "trapped", "trappc", "trapop", "curpc", "cnt", "ts", "steps",
    "irqlow", "nframe", "nnmi", "nvram", "joy", "joybit", "joybit2", "laststrobe",
    "ringi", "nbrk", "nemph", "apu4017", "lastts", "dmcbitcount",
    "dmcaddrlatch", "dmcsizelatch", "dmcformat", "dmcaddress", "dmcsize",
    "dmcshift", "dmchavedma", "dmcdmabuf", "dmchavesample", "dmcirq"];
  let s = g.map((n) => `  (global $${n} (mut i32) (i32.const 0))\n`).join("");
  s += "  (global $s (mut i32) (i32.const 0xFD))\n";
  s += "  (global $fi (mut i32) (i32.const 1))\n";
  s += "  (global $dmcacc (mut i32) (i32.const 1))\n";
  s += "  (global $dmcperiod (mut i32) (i32.const 0x1AC))\n";
  return s;
}

/**
 * Memory map, pads, APU DMC, OAM DMA, trap.
 * @param {import("./mappers.js").NesMapper} mapper
 * @param {number} n  PRG size
 */
function memWat(mapper, n) {
  return `
  (func $addcyc1
    (global.set $cnt (i32.sub (global.get $cnt) (i32.const 48)))
    (global.set $ts (i32.add (global.get $ts) (i32.const 1))))

  ;; Dummy read (uncarried address of an indexed access). Only I/O has
  ;; read side effects, so anything else is skipped.
  (func $dummyrd (param $a i32)
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x2000))
                 (i32.lt_u (local.get $a) (i32.const 0x4018)))
      (then (drop (call $rd8 (local.get $a))))))

  ;; ReadGP with FSDisable=1 (fceumm libretro default): bits past 8 read 1.
  (func $joyread (param $w i32) (result i32)
    (local $ret i32)
    (if (local.get $w)
      (then
        ;; port 2: a gamepad with nothing pressed
        (local.set $ret (i32.ge_u (global.get $joybit2) (i32.const 8)))
        (global.set $joybit2 (i32.and (i32.add (global.get $joybit2) (i32.const 1)) (i32.const 0xFF)))
        (return (i32.or (local.get $ret) (i32.const 0x40)))))
    (if (i32.ge_u (global.get $joybit) (i32.const 8))
      (then (local.set $ret (i32.const 1)))
      (else (local.set $ret (i32.and (i32.shr_u (global.get $joy) (global.get $joybit)) (i32.const 1)))))
    (global.set $joybit (i32.and (i32.add (global.get $joybit) (i32.const 1)) (i32.const 0xFF)))
    ;; JPRead: ret |= X.DB & 0xC0; DB is the operand's high byte, $40.
    (i32.or (local.get $ret) (i32.const 0x40)))

  (func $rd8 (param $a i32) (result i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFF)))
    (if (i32.lt_u (local.get $a) (i32.const 0x2000))
      (then (return (i32.load8_u (i32.and (local.get $a) (i32.const 0x7FF))))))
    (if (i32.lt_u (local.get $a) (i32.const 0x4000))
      (then (return (call $ppu_read (i32.and (local.get $a) (i32.const 7))))))
    (if (i32.ge_u (local.get $a) (i32.const 0x8000))
      (then (return ${mapper.prgRead(n)})))
    (if (i32.ge_u (local.get $a) (i32.const 0x6000))
      (then (return (i32.load8_u (i32.add (i32.const ${WRAM - 0x6000}) (local.get $a))))))
    (if (i32.eq (local.get $a) (i32.const 0x4016)) (then (return (call $joyread (i32.const 0)))))
    (if (i32.eq (local.get $a) (i32.const 0x4017)) (then (return (call $joyread (i32.const 1)))))
    (if (i32.eq (local.get $a) (i32.const 0x4015)) (then (return (i32.const 0))))
    ;; open bus: the last byte on the bus was the operand's high byte
    (i32.shr_u (local.get $a) (i32.const 8)))

  (func $wr8 (param $a i32) (param $v i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFF)))
    (local.set $v (i32.and (local.get $v) (i32.const 0xFF)))
    (if (i32.lt_u (local.get $a) (i32.const 0x2000))
      (then (i32.store8 (i32.and (local.get $a) (i32.const 0x7FF)) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $a) (i32.const 0x4000))
      (then (call $ppu_write (i32.and (local.get $a) (i32.const 7)) (local.get $v)) (return)))
    (if (i32.eq (local.get $a) (i32.const 0x4014))
      (then (call $oamdma (local.get $v)) (return)))
    (if (i32.eq (local.get $a) (i32.const 0x4016))
      (then
        (if (i32.and (i32.ne (global.get $laststrobe) (i32.const 0))
                     (i32.eqz (i32.and (local.get $v) (i32.const 1))))
          (then (global.set $joybit (i32.const 0)) (global.set $joybit2 (i32.const 0))))
        (global.set $laststrobe (i32.and (local.get $v) (i32.const 1)))
        (return)))
    (if (i32.eq (local.get $a) (i32.const 0x4010))
      (then
        (global.set $dmcperiod (i32.load (i32.add (i32.const ${DMCTAB})
          (i32.shl (i32.and (local.get $v) (i32.const 0xF)) (i32.const 2)))))
        (global.set $dmcformat (local.get $v))))
    (if (i32.eq (local.get $a) (i32.const 0x4012)) (then (global.set $dmcaddrlatch (local.get $v))))
    (if (i32.eq (local.get $a) (i32.const 0x4013)) (then (global.set $dmcsizelatch (local.get $v))))
    (if (i32.eq (local.get $a) (i32.const 0x4015))
      (then
        (if (i32.and (local.get $v) (i32.const 0x10))
          (then (if (i32.eqz (global.get $dmcsize)) (then (call $prep_dpcm))))
          (else (global.set $dmcsize (i32.const 0))))))
    (if (i32.eq (local.get $a) (i32.const 0x4017))
      (then (global.set $apu4017 (i32.or (local.get $v) (i32.const 0x100)))))
    (if (i32.lt_u (local.get $a) (i32.const 0x4018))
      (then (i32.store8 (i32.add (i32.const ${APUREG}) (i32.sub (local.get $a) (i32.const 0x4000)))
                        (local.get $v)) (return)))
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x6000)) (i32.lt_u (local.get $a) (i32.const 0x8000)))
      (then (i32.store8 (i32.add (i32.const ${WRAM - 0x6000}) (local.get $a)) (local.get $v))))${mapper.romWrite})

  (func $prep_dpcm
    (global.set $dmcaddress (i32.add (i32.const 0x4000) (i32.shl (global.get $dmcaddrlatch) (i32.const 6))))
    (global.set $dmcsize (i32.add (i32.shl (global.get $dmcsizelatch) (i32.const 4)) (i32.const 1))))

  ;; FCEU_SoundCPUHook, the DMC half (the frame counter only feeds length
  ;; counters and an IRQ that fceumm powers up DISABLED; no cart here reads
  ;; $4015 or writes $4017 with the IRQ enabled).
  (func $apu_hook (param $cycles i32)
    ;; DMCDMA: four X6502_DMR, i.e. 4 stolen cycles per sample byte
    (if (i32.and (i32.ne (global.get $dmcsize) (i32.const 0)) (i32.eqz (global.get $dmchavedma)))
      (then
        (call $addcyc1) (call $addcyc1) (call $addcyc1) (call $addcyc1)
        (global.set $dmcdmabuf (call $rd8 (i32.add (i32.const 0x8000) (global.get $dmcaddress))))
        (global.set $dmchavedma (i32.const 1))
        (global.set $dmcaddress (i32.and (i32.add (global.get $dmcaddress) (i32.const 1)) (i32.const 0x7FFF)))
        (global.set $dmcsize (i32.sub (global.get $dmcsize) (i32.const 1)))
        (if (i32.eqz (global.get $dmcsize))
          (then
            (if (i32.and (global.get $dmcformat) (i32.const 0x40))
              (then (call $prep_dpcm))
              (else (if (i32.and (global.get $dmcformat) (i32.const 0x80))
                ;; DMC IRQ: not modelled; counted so a cart that needs it shows
                (then (global.set $dmcirq (i32.add (global.get $dmcirq) (i32.const 1)))))))))))
    (global.set $dmcacc (i32.sub (global.get $dmcacc) (local.get $cycles)))
    (block $d (loop $l
      (br_if $d (i32.gt_s (global.get $dmcacc) (i32.const 0)))
      (global.set $dmcacc (i32.add (global.get $dmcacc) (global.get $dmcperiod)))
      (global.set $dmcbitcount (i32.and (i32.add (global.get $dmcbitcount) (i32.const 1)) (i32.const 7)))
      (global.set $dmcshift (i32.shr_u (global.get $dmcshift) (i32.const 1)))
      ;; tester()
      (if (i32.eqz (global.get $dmcbitcount))
        (then
          (if (i32.eqz (global.get $dmchavedma))
            (then (global.set $dmchavesample (i32.const 0)))
            (else
              (global.set $dmchavesample (i32.const 1))
              (global.set $dmcshift (global.get $dmcdmabuf))
              (global.set $dmchavedma (i32.const 0))))))
      (br $l))))

  ;; B4014: 256 x (X6502_DMR + X6502_DMW), each ADDCYC(1): 512 cycles.
  (func $oamdma (param $page i32)
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 256)))
      (call $addcyc1)
      (global.set $t3 (call $rd8 (i32.or (i32.shl (local.get $page) (i32.const 8)) (local.get $i))))
      (call $addcyc1)
      (call $w2004 (global.get $t3))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func $trap (param $op i32)
    (if (i32.eqz (global.get $trapped))
      (then
        (global.set $trapped (i32.const 1))
        (global.set $trappc (global.get $curpc))
        (global.set $trapop (local.get $op))
        (call $probe))))
`;
}

/**
 * Two-level dispatch: br_table on the 1KB shard, then the shard's own
 * br_table on the low bits.
 * @param {number} nsh
 * @param {number} SH
 */
function dispatch(nsh, SH) {
  let out = "    ";
  for (let si = nsh - 1; si >= 0; si--) out += `(block $b${si} `;
  const labels = [];
  for (let si = 0; si < nsh; si++) labels.push(`$b${si}`);
  out += "(br_table " + labels.join(" ") + " $b0 (i32.shr_u (local.get $o) (i32.const 10)))";
  for (let si = 0; si < nsh; si++) {
    out += `)\n    (call $shard${si} (i32.and (local.get $o) (i32.const ${SH - 1}))) (return)`;
  }
  return out;
}

/**
 * $probe and $step (fetch, cycle charge, sound hook, dispatch).
 * @param {import("./mappers.js").NesMapper} mapper
 * @param {number} n
 * @param {string} probeStores
 * @param {string} disp
 */
function stepWat(mapper, n, probeStores, disp) {
  return `
  (func $probe
${probeStores})

  (func $step
    (local $o i32) (local $r i32)
    (global.set $curpc (global.get $pc))
    (if (i32.lt_u (global.get $pc) (i32.const 0x8000))
      (then (call $trap (i32.const 0x100)) (return)))
    (local.set $o ${mapper.pcOffset(n)})
    (local.set $r (i32.add (i32.const ${PCRING})
      (i32.shl (i32.and (global.get $ringi) (i32.const 1023)) (i32.const 3))))
    (i32.store (local.get $r) (i32.or (global.get $pc)
      (i32.shl (i32.load8_u (i32.add (i32.const ${PRG}) (local.get $o))) (i32.const 16))))
    (i32.store (i32.add (local.get $r) (i32.const 4)) (global.get $ts))
    (global.set $ringi (i32.add (global.get $ringi) (i32.const 1)))
    (global.set $steps (i32.add (global.get $steps) (i32.const 1)))
    ;; X6502_Run: ADDCYC(CycTable[op]) at fetch, then the sound hook with
    ;; every cycle since the previous hook (this one's base, the previous
    ;; instruction's extras, DMA, NMI, and the hook's own DMC steals).
    (local.set $r (i32.load8_u (i32.add (i32.const ${CYCTAB})
      (i32.load8_u (i32.add (i32.const ${PRG}) (local.get $o))))))
    (global.set $cnt (i32.sub (global.get $cnt) (i32.mul (local.get $r) (i32.const 48))))
    (global.set $ts (i32.add (global.get $ts) (local.get $r)))
    (local.set $r (i32.sub (global.get $ts) (global.get $lastts)))
    (global.set $lastts (global.get $ts))
    (call $apu_hook (local.get $r))
` + disp + ")";
}

/** $run, $do_irq, pads, the wasmcart ABI exports and FCEUPPU_Loop. */
function frameWat() {
  return `
  ;; X6502_Run(dots)
  (func $run (param $dots i32)
    (global.set $cnt (i32.add (global.get $cnt) (i32.shl (local.get $dots) (i32.const 4))))
    (if (global.get $trapped) (then (global.set $cnt (i32.const 0)) (return)))
    (block $out (loop $l
      (br_if $out (i32.le_s (global.get $cnt) (i32.const 0)))
      (if (global.get $irqlow)
        (then
          (call $do_irq)
          (br_if $out (i32.le_s (global.get $cnt) (i32.const 0)))))
      (call $step)
      (if (global.get $trapped) (then (global.set $cnt (i32.const 0)) (br $out)))
      (br $l))))

  ;; irqlow bit 1 = NMI, bit 2 = NMI2 (B2000 enabling NMI inside vblank:
  ;; becomes a real NMI one instruction later, as in fceumm).
  (func $do_irq
    (if (i32.and (global.get $irqlow) (i32.const 2))
      (then
        (global.set $irqlow (i32.or (i32.and (global.get $irqlow) (i32.const -3)) (i32.const 1)))
        (return)))
    (if (i32.and (global.get $irqlow) (i32.const 1))
      (then
        ${cyc(7)}
        (i32.store8 (i32.or (i32.const 0x100) (global.get $s)) (i32.shr_u (global.get $pc) (i32.const 8)))
        (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFF)))
        (i32.store8 (i32.or (i32.const 0x100) (global.get $s)) (i32.and (global.get $pc) (i32.const 0xFF)))
        (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFF)))
        (i32.store8 (i32.or (i32.const 0x100) (global.get $s)) ${PACK_P})
        (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFF)))
        (global.set $fi (i32.const 1))
        (global.set $pc (i32.or (call $rd8 (i32.const 0xFFFA))
                                (i32.shl (call $rd8 (i32.const 0xFFFB)) (i32.const 8))))
        (global.set $nnmi (i32.add (global.get $nnmi) (i32.const 1)))
        (global.set $irqlow (i32.and (global.get $irqlow) (i32.const -2))))))

  (func $read_pad
    (local $b i32) (local $j i32)
    (local.set $b (i32.load16_u (i32.const ${INPUT})))
    ;; wasmcart buttons are POSITIONAL (W3C): the east face button is
    ;; WC_BTN_B, which is where the NES A button sits; south (WC_BTN_A) is
    ;; NES B. NES bit order: A B Select Start Up Down Left Right.
    (if (i32.and (local.get $b) (i32.const 2))    (then (local.set $j (i32.or (local.get $j) (i32.const 0x01)))))
    (if (i32.and (local.get $b) (i32.const 1))    (then (local.set $j (i32.or (local.get $j) (i32.const 0x02)))))
    (if (i32.and (local.get $b) (i32.const 128))  (then (local.set $j (i32.or (local.get $j) (i32.const 0x04)))))
    (if (i32.and (local.get $b) (i32.const 64))   (then (local.set $j (i32.or (local.get $j) (i32.const 0x08)))))
    (if (i32.and (local.get $b) (i32.const 256))  (then (local.set $j (i32.or (local.get $j) (i32.const 0x10)))))
    (if (i32.and (local.get $b) (i32.const 512))  (then (local.set $j (i32.or (local.get $j) (i32.const 0x20)))))
    (if (i32.and (local.get $b) (i32.const 1024)) (then (local.set $j (i32.or (local.get $j) (i32.const 0x40)))))
    (if (i32.and (local.get $b) (i32.const 2048)) (then (local.set $j (i32.or (local.get $j) (i32.const 0x80)))))
    (global.set $joy (local.get $j)))

  (func (export "wc_get_info") (result i32)
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 0))  (i32.const 3))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 4))  (i32.const ${FB_W}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 8))  (i32.const ${FB_H}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 12)) (i32.const ${FB}))
    ;; inputPtr (field 7) and timePtr (field 10) are written by the host
    ;; every frame with NO zero check: both must point somewhere harmless.
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 28)) (i32.const ${INPUT}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 40)) (i32.const ${TIME}))
    (i32.const ${ABI}))

  (func (export "wc_init")
    ;; fceumm_ramstate default "fill $ff"
    (memory.fill (i32.const 0) (i32.const 0xFF) (i32.const 0x800))
    (global.set $s (i32.const 0xFD))
    (global.set $fi (i32.const 1))
    (global.set $pc (i32.or (call $rd8 (i32.const 0xFFFC))
                            (i32.shl (call $rd8 (i32.const 0xFFFD)) (i32.const 8)))))

  ;; FCEUPPU_Loop
  (func (export "wc_render")
    (local $i i32)
    (call $read_pad)
    (if (global.get $ppudead)
      (then
        (memory.fill (i32.const ${NESFB}) (i32.const 0) (i32.const ${256 * 240}))
        (call $run (i32.const ${262 * 341}))
        (global.set $ppudead (i32.sub (global.get $ppudead) (i32.const 1))))
      (else
        (call $run (i32.const 341))
        (global.set $ppustatus (i32.or (global.get $ppustatus) (i32.const 0x80)))
        (global.set $ppu3 (i32.const 0))
        (global.set $ppuspl (i32.const 0))
        (call $run (i32.const 12))
        (if (i32.and (global.get $ppu0) (i32.const 0x80))
          (then (global.set $irqlow (i32.or (global.get $irqlow) (i32.const 1)))))
        (call $run (i32.const ${20 * 341 - 12}))
        (global.set $ppustatus (i32.and (global.get $ppustatus) (i32.const 0x1F)))
        (call $run (i32.const 256))
        (call $run (i32.const ${85 - 16}))
        (if (i32.and (global.get $ppu1) (i32.const 0x18))
          (then (global.set $refaddr (global.get $tmpaddr))))
        (global.set $spork (i32.const 0))
        (global.set $numsprites (i32.const 0))
        (call $reset_rl (i32.const ${NESFB}))
        (call $run (i32.sub (i32.const 16) (global.get $kook)))
        (global.set $kook (i32.xor (global.get $kook) (i32.const 1)))
        (global.set $scanline (i32.const 0))
        (block $d (loop $l
          (br_if $d (i32.ge_s (global.get $scanline) (i32.const 240)))
          (call $do_line)
          (br $l)))))
    (local.set $i (i32.const 0))
    (block $pd (loop $pl
      (br_if $pd (i32.ge_u (local.get $i) (i32.const ${256 * 240})))
      (i32.store (i32.add (i32.const ${FB}) (i32.shl (local.get $i) (i32.const 2)))
        (i32.load (i32.add (i32.const ${RGBTAB}) (i32.shl (i32.and
          (i32.load8_u (i32.add (i32.const ${NESFB}) (local.get $i))) (i32.const 0x3F))
          (i32.const 2)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $pl)))
    (global.set $nframe (i32.add (global.get $nframe) (i32.const 1)))
    (call $probe))
`;
}

const SHARD = 1024;

/**
 * Emit the whole cart as WAT, one (module ...) in text chunks.
 * @param {Uint8Array} rom  the whole .nes file
 * @param {object} [opts]
 * @param {{arms?: number, lowered?: number, trapped?: number}} [opts.stats]  filled in
 * @returns {AsyncGenerator<string>}
 */
export async function* emitWat(rom, opts = {}) {
  rom = toBytes(rom);
  const d = describe(rom);
  if (!d.supported) throw new Error(`nes recompile: ${d.unsupportedReason}`);
  const mapper = MAPPERS[d.mapper];
  const prg = rom.subarray(d.prgOffset, d.prgOffset + d.prgSize);
  const chr = rom.subarray(d.chrOffset, d.chrOffset + d.chrSize);
  const n = prg.length;
  const view = { fixedByte: mapper.fixedByte(prg) };

  const bodies = new Array(n);
  let ok = 0, bad = 0;
  for (let off = 0; off < n; off++) {
    const op = prg[off];
    try {
      bodies[off] = lower(op, prg[(off + 1) % n], prg[(off + 2) % n], view, mapper.armBase(n, off));
      ok++;
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      bodies[off] = `(call $trap (i32.const ${op}))`;
      bad++;
    }
  }
  if (opts.stats) Object.assign(opts.stats, { arms: n, lowered: ok, trapped: bad });

  const vertical = d.mirroring === "vertical";
  yield "(module\n";
  yield '  (memory (export "memory") 16)\n';
  yield cpuGlobals() + mapper.globals + "\n";
  yield globalsWat() + "\n";
  yield memWat(mapper, n) + "\n";
  yield ppuWat({
    NTSEL: ntSelFixed(vertical),
    CHRWRITE: d.chrRam ? `(i32.store8 (i32.add (i32.const ${CHR}) (local.get $tmp)) (local.get $v))` : "",
  }) + "\n";
  yield `  (data (i32.const ${RGBTAB}) "${watBytes(u32le(FCEUMM.paletteRgb.map((c) => (0xFF000000 | c) >>> 0)))}")\n`;
  yield `  (data (i32.const ${CYCTAB}) "${watBytes(Uint8Array.from(CYCLES.base))}")\n`;
  yield `  (data (i32.const ${DMCTAB}) "${watBytes(u32le(FCEUMM.ntscDmcPeriod))}")\n`;
  for (const [addr, data] of luts()) yield `  (data (i32.const ${addr}) "${watBytes(data)}")\n`;

  const nsh = Math.ceil(n / SHARD);
  for (let si = 0; si < nsh; si++) {
    const sh = bodies.slice(si * SHARD, (si + 1) * SHARD);
    const parts = [`  (func $shard${si} (param $id i32)`];
    for (let i = sh.length - 1; i >= 0; i--) parts.push(`    (block $s${i}`);
    parts.push("    (block $sdef");
    parts.push("      (br_table " + sh.map((_, i) => `$s${i}`).join(" ") + " $sdef (local.get $id))");
    parts.push("    ) (return)");
    for (let i = 0; i < sh.length; i++) {
      const cpu = mapper.armBase(n, si * SHARD + i);
      parts.push(`    ) ;; ${cpu.toString(16).toUpperCase().padStart(4, "0")}`);
      parts.push(`    ${sh[i]} (return)`);
    }
    parts.push("  )");
    yield parts.join("\n") + "\n";
  }

  const probeStores = PROBE_FIELDS.map((f, i) => {
    const v = f === "p" ? PACK_P : f === "frame" ? "(global.get $nframe)" : `(global.get $${f})`;
    return `    (i32.store (i32.const ${PROBE + 4 * i}) ${v})`;
  }).join("\n");
  yield stepWat(mapper, n, probeStores, dispatch(nsh, SHARD)) + "\n";
  yield frameWat() + "\n";
  yield `  (data (i32.const ${PRG}) "${watBytes(prg)}")\n`;
  if (chr.length) yield `  (data (i32.const ${CHR}) "${watBytes(chr)}")\n`;
  yield ")";
}

/**
 * Convenience: the whole module as one string (small carts, tests, debugging).
 * @param {Uint8Array} rom
 * @param {object} [opts]
 */
export async function emitWatString(rom, opts) {
  let s = "";
  for await (const c of emitWat(rom, opts)) s += c;
  return s;
}
