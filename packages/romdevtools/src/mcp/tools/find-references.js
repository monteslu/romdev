// findReferences — given a target CPU address, find every instruction in a
// ROM that references it.
//
// Built on top of the disassembler — we run the full PRG / ROM through
// da65 then scan the asm text for operands that match the target address.
// Also walks the vector table so reset/nmi/irq references show up even
// though they're not "instructions" per se.

import { readFile } from "node:fs/promises";
import { mapAtari2600Address, mapC64Address } from "./disasm.js";

/**
 * Classify a referring instruction by its mnemonic.
 *   jsr, jmp           → "call" / "jump"
 *   bcc/bne/bpl/...    → "branch"
 *   lda/ldx/ldy/...    → "read"
 *   sta/stx/sty/...    → "write"
 *   adc/cmp/eor/and/.. → "use"
 *   anything else      → "ref"
 */
function classify(mnemonic) {
  const m = mnemonic.toLowerCase();
  if (m === "jsr") return "call";
  if (m === "jmp") return "jump";
  if (/^b[a-z]{2}$/.test(m) && m !== "bit") return "branch";
  if (/^(lda|ldx|ldy|pla|plp|plx|ply)\b/.test(m)) return "read";
  if (/^(sta|stx|sty|stz|pha|php|phx|phy)\b/.test(m)) return "write";
  if (/^(adc|sbc|cmp|cpx|cpy|and|ora|eor|bit|asl|lsr|rol|ror|inc|dec)\b/.test(m)) return "use";
  return "ref";
}

/**
 * Walk the asm output of da65 (with `--comments 4`) and find every line
 * whose operand resolves to the target address.
 *
 * da65 lines look like:
 *   `        jsr     LC184                           ; C2F0 20 84 C1`
 * with the trailing comment giving the CPU address of THIS instruction
 * and the raw bytes. We don't have to re-decode operands — we just match
 * `$NNNN` literals in the source column AND da65's auto-generated `LXXXX`
 * labels (whose value matches the target address).
 */
function scanAsmForReferences(asm, targetAddr, sourceLabels) {
  const refs = [];
  const lines = asm.split(/\r?\n/);
  // Build a regex pool of strings that resolve to the target address:
  //   `$<hex>` (16-bit) or `$<bank>:<addr>` (24-bit).
  const targetHex16 = targetAddr.toString(16).toUpperCase();
  const targetHex24 = (targetAddr & 0xFFFFFF).toString(16).toUpperCase().padStart(6, "0");
  const target24Form = targetHex24.slice(0, 2) + ":" + targetHex24.slice(2);

  // da65 auto-generates LXXXX labels for any address it sees branching to.
  // We need to know the LXXXX form of our target. 6502/Z80/SM83 use 4 hex
  // digits; m68k uses 6. Match either width.
  const autoLabel4 = "L" + targetHex16.padStart(4, "0");
  const autoLabel6 = "L" + targetHex24;
  const autoLabelRe = new RegExp("\\b(" + autoLabel4 + "|" + autoLabel6 + ")\\b");

  for (const line of lines) {
    if (line.startsWith(";")) continue;
    // Parse: address (from trailing comment), mnemonic, operand.
    const addrM = line.match(/;\s+([0-9A-Fa-f]{4,6})\s+/);
    if (!addrM) continue;
    const refAddr = parseInt(addrM[1], 16);
    // Strip leading spaces. da65 indents at column 8. Then optional label "LXXXX:".
    const trimmed = line.replace(/^[\s\t]+/, "").replace(/^L[0-9A-Fa-f]{4,6}:\s*/, "");
    // Now we have "mnemonic operand ... ; comment".
    const sepIdx = trimmed.indexOf(";");
    const src = sepIdx >= 0 ? trimmed.slice(0, sepIdx).trim() : trimmed.trim();
    const mnemonicM = src.match(/^([a-zA-Z][a-zA-Z0-9.]*)\s+(.*)$/);
    if (!mnemonicM) continue;
    const mnemonic = mnemonicM[1];
    const operand = mnemonicM[2];

    // Match: any `$XXXX` (or `$XX:XXXX`) in operand that resolves to target,
    // OR the LXXXX auto-label for the target address, OR a named label.
    let matched = false;
    for (const m of operand.matchAll(/(#?)\$([0-9A-Fa-f]+)\b/g)) {
      if (m[1] === "#") continue;   /* immediate (`lda #$02`) — a value, not an address */
      const v = parseInt(m[2], 16);
      if (v === targetAddr || v === (targetAddr & 0xFFFF)) { matched = true; break; }
    }
    if (!matched && autoLabelRe.test(operand)) matched = true;
    if (!matched && operand.includes(target24Form)) matched = true;
    if (!matched) {
      for (const lab of sourceLabels) {
        if (lab.addr === targetAddr && new RegExp("\\b" + lab.name + "\\b").test(operand)) {
          matched = true;
          break;
        }
      }
    }
    if (matched) {
      refs.push({
        atAddress: "$" + refAddr.toString(16).toUpperCase(),
        atAddressDec: refAddr,
        instruction: `${mnemonic} ${operand}`,
        kind: classify(mnemonic),
      });
    }
  }
  return refs;
}

/**
 * Vector-table references for SMS / Game Gear. The Z80 has fixed
 * "vectors" — actually rst handler entry points — at $0000, $0008,
 * $0010, $0018, $0020, $0028, $0030, $0038, plus NMI at $0066. If the
 * target address matches any of these, report a pseudo-ref.
 */
function smsVectorRefs(data, targetAddr) {
  const vecs = {
    reset: 0x0000,
    rst08: 0x0008, rst10: 0x0010, rst18: 0x0018,
    rst20: 0x0020, rst28: 0x0028, rst30: 0x0030,
    irq:   0x0038,
    nmi:   0x0066,
  };
  const refs = [];
  for (const [name, addr] of Object.entries(vecs)) {
    if (addr === targetAddr) {
      refs.push({
        atAddress: "(vector)",
        instruction: `${name} entry point`,
        kind: name === "reset" || name === "nmi" || name === "irq" ? name : "rst",
        fileOffset: "0x" + addr.toString(16).toUpperCase(),
      });
    }
  }
  return refs;
}

/**
 * Vector-table references for Game Boy / GBC. The SM83 has fixed entry
 * points for reset, RSTs, IRQs ($0040-$0060), and the cart entry at
 * $0100. If the target matches any, report a pseudo-ref.
 */
function gbVectorRefs(data, targetAddr) {
  const vecs = {
    reset: 0x0000,
    rst08: 0x0008, rst10: 0x0010, rst18: 0x0018,
    rst20: 0x0020, rst28: 0x0028, rst30: 0x0030, rst38: 0x0038,
    vblank:   0x0040,
    lcd_stat: 0x0048,
    timer:    0x0050,
    serial:   0x0058,
    joypad:   0x0060,
    entry:    0x0100,
  };
  const refs = [];
  for (const [name, addr] of Object.entries(vecs)) {
    if (addr === targetAddr) {
      refs.push({
        atAddress: "(vector)",
        instruction: `${name} entry point`,
        kind: ({ vblank: "irq", lcd_stat: "irq", timer: "irq", serial: "irq", joypad: "irq", reset: "reset", entry: "entry" })[name] ?? "rst",
        fileOffset: "0x" + addr.toString(16).toUpperCase(),
      });
    }
  }
  return refs;
}

/**
 * Vector-table references for Atari 2600 / 7800. Both use 6502 vectors at
 * $FFFA (NMI), $FFFC (RESET), $FFFE (IRQ) — at the very end of cart ROM.
 */
function atariVectorRefs(data, targetAddr) {
  if (data.length < 6) return [];
  const off = data.length - 6;
  const vecs = {
    nmi:   data[off + 0] | (data[off + 1] << 8),
    reset: data[off + 2] | (data[off + 3] << 8),
    irq:   data[off + 4] | (data[off + 5] << 8),
  };
  const refs = [];
  for (const [name, addr] of Object.entries(vecs)) {
    if (addr === targetAddr) {
      refs.push({
        atAddress: "(vector)",
        instruction: `${name} vector`,
        kind: name,
        fileOffset: "0x" + (off + (name === "nmi" ? 0 : name === "reset" ? 2 : 4)).toString(16).toUpperCase(),
      });
    }
  }
  return refs;
}

/**
 * Vector-table references for NES. Returns reset/nmi/irq pseudo-refs if any
 * of them point at the target.
 */
function nesVectorRefs(data, targetAddr) {
  if (data[0] !== 0x4e || data[1] !== 0x45 || data[2] !== 0x53 || data[3] !== 0x1a) return [];
  const prgSize = data[4] * 16384;
  const vecOff = 16 + prgSize - 6;
  const refs = [];
  const tag = (kind, lo, hi) => {
    const v = data[lo] | (data[hi] << 8);
    if (v === targetAddr) {
      refs.push({
        atAddress: "(vector)",
        instruction: `${kind} vector`,
        kind,
        fileOffset: "0x" + lo.toString(16).toUpperCase(),
      });
    }
  };
  tag("nmi",   vecOff,     vecOff + 1);
  tag("reset", vecOff + 2, vecOff + 3);
  tag("irq",   vecOff + 4, vecOff + 5);
  return refs;
}

export async function findReferencesCore({ path, platform, address, mapper, maxRefsReturned = 256 }) {
  const data = new Uint8Array(await readFile(path));
  const resolved = platform ?? (
    /\.nes$/i.test(path) ? "nes" :
    /\.(sfc|smc)$/i.test(path) ? "snes" :
    /\.sms$/i.test(path) ? "sms" :
    /\.gg$/i.test(path) ? "gg" :
    /\.gb$/i.test(path) ? "gb" :
    /\.gbc$/i.test(path) ? "gbc" :
    /\.a26$/i.test(path) ? "atari2600" :
    /\.a78$/i.test(path) ? "atari7800" :
    /\.prg$/i.test(path) ? "c64" :
    /\.(gen|md|bin)$/i.test(path) ? "genesis" :
    null
  );
  if (!resolved) {
    throw new Error(`findReferences: could not detect platform for '${path}'. Pass platform explicitly.`);
  }

  // Disassemble the whole code area. Flat platforms produce one asm blob;
  // BANKED carts (NES mappers, SNES LoROM, GB MBC, Sega mapper, MSX megaROM,
  // 2600 F8/F6/F4, 7800 SuperGame, >32KB HuCards) produce one segment PER
  // BANK (segments[]) — a flat-blob disasm mis-addresses everything past the
  // first bank and lets instructions straddle bank edges, which corrupts the
  // decode stream (the 0.27.0 refsFound:0 bug, fixed for NES first and now
  // applied to every banked platform). Refs from a segment carry a bank tag.
  let asm;
  /** @type {{asm: string, bank: number}[] | null} */
  let segments = null;
  // Bound the per-bank da65/objdump fan-out on huge carts. 64 banks covers
  // 1MB (16KB banks) / 512KB (8KB pages) — beyond that we scan the first 64
  // and SAY SO in notes rather than silently truncating.
  const SEGMENT_CAP = 64;
  let segmentsCapped = 0;
  if (resolved === "nes") {
    const prgSize = data[4] * 16384;
    const { runDa65 } = await import("../../toolchains/cc65/da65.js");
    if (prgSize <= 32768) {
      const startAddress = prgSize === 16384 ? 0xC000 : 0x8000;
      const bytes = data.slice(16, 16 + prgSize);
      const r = await runDa65({ bytes, startAddress, cpu: "6502", options: ["--comments", "4"] });
      asm = r.asm;
    } else {
      // Banked PRG (>32KB, e.g. UxROM/MMC1/MMC3): the old code disassembled
      // the whole PRG as ONE flat blob at $8000, which mis-addresses every
      // bank past the first — a 128KB mapper-2 scan returned refsFound:0
      // for bytes referenced in dozens of places (0.27.0 feedback #3).
      // Disassemble each 16KB bank separately: switchable banks at $8000,
      // the (conventionally fixed) last bank at $C000; tag refs with the
      // bank index.
      const banks = Math.floor(prgSize / 16384);
      segments = [];
      for (let b = 0; b < banks; b++) {
        const bytes = data.slice(16 + b * 16384, 16 + (b + 1) * 16384);
        const startAddress = b === banks - 1 ? 0xC000 : 0x8000;
        const r = await runDa65({ bytes, startAddress, cpu: "6502", options: ["--comments", "4"] });
        segments.push({ asm: r.asm, bank: b });
      }
    }
  } else if (resolved === "snes") {
    // LoROM: 32KB banks each mapped at $xx:8000. The old code disassembled
    // ONLY the first 32KB bank — a 1MB cart's other 31 banks were invisible.
    // Scan every 32KB bank at $8000 (absolute 16-bit operands are bank-window
    // addresses on LoROM), tagged with the bank index.
    const hasHeader = (data.length % 1024) === 512;
    const body = hasHeader ? data.subarray(512) : data;
    const { runDa65 } = await import("../../toolchains/cc65/da65.js");
    const BANK = 0x8000;
    const nBanks = Math.ceil(body.length / BANK);
    const scanBanks = Math.min(nBanks, SEGMENT_CAP);
    segmentsCapped = nBanks - scanBanks;
    if (nBanks <= 1) {
      const r = await runDa65({
        bytes: body.slice(0, BANK), startAddress: 0x008000, cpu: "65816",
        options: ["--comments", "4"],
        info: `RANGE { START $8000; END $${(0x8000 + Math.min(body.length, BANK) - 1).toString(16).toUpperCase()}; TYPE Code; ADDRMODE "MX"; };\n`,
      });
      asm = r.asm;
    } else {
      segments = [];
      for (let b = 0; b < scanBanks; b++) {
        const bytes = body.slice(b * BANK, (b + 1) * BANK);
        const r = await runDa65({
          bytes, startAddress: 0x008000, cpu: "65816",
          options: ["--comments", "4"],
          info: `RANGE { START $8000; END $${(0x8000 + bytes.length - 1).toString(16).toUpperCase()}; TYPE Code; ADDRMODE "MX"; };\n`,
        });
        segments.push({ asm: r.asm, bank: b });
      }
    }
  } else if (resolved === "sms" || resolved === "gg") {
    // Sega mapper: slots 0+1 ($0000-$7FFF) hold banks 0-1; slot 2 ($8000-
    // $BFFF) pages in banks 2+. The old code scanned only the first 32KB —
    // every bank past 1 was invisible. Scan bank 0 @ $0000, bank 1 @ $4000,
    // banks 2+ @ $8000 (their pageable window), tagged with the bank index.
    const { runObjdump } = await import("../../toolchains/objdump.js");
    if (data.length <= 0x8000) {
      asm = (await runObjdump({ bytes: data.slice(0), arch: "z80", startAddress: 0x0000 })).asm;
    } else {
      const BANK = 0x4000;
      const nBanks = Math.ceil(data.length / BANK);
      const scanBanks = Math.min(nBanks, SEGMENT_CAP);
      segmentsCapped = nBanks - scanBanks;
      segments = [];
      for (let b = 0; b < scanBanks; b++) {
        const bytes = data.slice(b * BANK, (b + 1) * BANK);
        const startAddress = b === 0 ? 0x0000 : b === 1 ? 0x4000 : 0x8000;
        segments.push({ asm: (await runObjdump({ bytes, arch: "z80", startAddress })).asm, bank: b });
      }
    }
  } else if (resolved === "gb" || resolved === "gbc") {
    // MBC banking: bank 0 fixed at $0000, banks 1+ page into $4000-$7FFF.
    // The old code scanned only the first 32KB (banks 0-1) — a 128KB MBC1
    // cart's other 6 banks were invisible. Scan every 16KB bank (bank 0 @
    // $0000, banks 1+ @ $4000), tagged with the bank index.
    const { runObjdump } = await import("../../toolchains/objdump.js");
    if (data.length <= 0x8000) {
      asm = (await runObjdump({ bytes: data.slice(0), arch: "gbz80", startAddress: 0x0000 })).asm;
    } else {
      const BANK = 0x4000;
      const nBanks = Math.ceil(data.length / BANK);
      const scanBanks = Math.min(nBanks, SEGMENT_CAP);
      segmentsCapped = nBanks - scanBanks;
      segments = [];
      for (let b = 0; b < scanBanks; b++) {
        const bytes = data.slice(b * BANK, (b + 1) * BANK);
        const startAddress = b === 0 ? 0x0000 : 0x4000;
        segments.push({ asm: (await runObjdump({ bytes, arch: "gbz80", startAddress })).asm, bank: b });
      }
    }
  } else if (resolved === "atari2600") {
    // 2600 cart maps to $F000-$FFFF. Banked carts (F8=8KB, F6=16KB, F4=32KB,
    // …) page 4KB banks into the SAME $F000 window. The old code scanned only
    // the boot bank — fixed: scan every 4KB bank at $F000, tagged.
    const { runDa65 } = await import("../../toolchains/cc65/da65.js");
    if (data.length <= 0x1000) {
      const mapped = mapAtari2600Address(data, 0xF000, 0x1000, 0);
      const r = await runDa65({ bytes: mapped.bytes, startAddress: 0xF000, cpu: "6502", options: ["--comments", "4"] });
      asm = r.asm;
    } else {
      const BANK = 0x1000;
      const nBanks = Math.ceil(data.length / BANK);
      segments = [];
      for (let b = 0; b < nBanks; b++) {
        const bytes = data.slice(b * BANK, (b + 1) * BANK);
        const r = await runDa65({ bytes, startAddress: 0xF000, cpu: "6502", options: ["--comments", "4"] });
        segments.push({ asm: r.asm, bank: b });
      }
    }
  } else if (resolved === "atari7800") {
    // 7800: flat carts (≤48KB) map at the top of the address space — scan the
    // WHOLE cart (the old code scanned only $C000-$FFFF, hiding code at
    // $4000-$BFFF on 32/48KB carts). SuperGame banked carts (>48KB) page
    // 16KB banks into $8000-$BFFF with the last bank fixed at $C000 — scan
    // per-bank, tagged. A 128-byte .a78 header is stripped if present.
    const hasA78 = data.length >= 17 &&
      String.fromCharCode(...data.subarray(1, 10)) === "ATARI7800";
    const cart = hasA78 ? data.subarray(128) : data;
    const { runDa65 } = await import("../../toolchains/cc65/da65.js");
    if (cart.length <= 0xC000) {
      const start = (0x10000 - cart.length) & 0xFFFF;
      const r = await runDa65({ bytes: cart.slice(0), startAddress: start, cpu: "6502", options: ["--comments", "4"] });
      asm = r.asm;
    } else {
      const BANK = 0x4000;
      const nBanks = Math.ceil(cart.length / BANK);
      const scanBanks = Math.min(nBanks, SEGMENT_CAP);
      segmentsCapped = nBanks - scanBanks;
      segments = [];
      for (let b = 0; b < scanBanks; b++) {
        const bytes = cart.slice(b * BANK, (b + 1) * BANK);
        const startAddress = b === nBanks - 1 ? 0xC000 : 0x8000;
        const r = await runDa65({ bytes, startAddress, cpu: "6502", options: ["--comments", "4"] });
        segments.push({ asm: r.asm, bank: b });
      }
    }
  } else if (resolved === "c64") {
    // c64 .prg: 2-byte load addr + code. Disasm from the load addr through
    // EOF. For typical BASIC-stub programs that's $0801 + a few KB.
    const loadAddr = data[0] | (data[1] << 8);
    const codeLen = data.length - 2;
    const mapped = mapC64Address(data, loadAddr, codeLen, 0);
    const { runDa65 } = await import("../../toolchains/cc65/da65.js");
    const r = await runDa65({ bytes: mapped.bytes, startAddress: loadAddr, cpu: "6502", options: ["--comments", "4"] });
    asm = r.asm;
  } else if (resolved === "lynx") {
    // Lynx = 65C02 cart image after a 64-byte "LYNX" header; homebrew runs at
    // $0200. Strip the header and disassemble the flat image as 6502-family.
    const hasHdr = data.length >= 64 && data[0] === 0x4c && data[1] === 0x59 && data[2] === 0x4e && data[3] === 0x58;
    const base = hasHdr ? 64 : 0;
    const bytes = data.slice(base);
    const { runDa65 } = await import("../../toolchains/cc65/da65.js");
    const r = await runDa65({ bytes, startAddress: 0x0200, cpu: "6502", options: ["--comments", "4"] });
    asm = r.asm;
  } else if (resolved === "genesis") {
    // Genesis ROM maps 1:1 to 68000 $000000+. Disassemble from the reset
    // vector ($000004) to EOF (capped to keep the pass bounded on big carts).
    // Native binutils m68k objdump (complete ISA, correct instruction lengths).
    const resetPc = (data[4] << 24 | data[5] << 16 | data[6] << 8 | data[7]) >>> 0;
    const start = resetPc < data.length ? resetPc : 0x200;
    const CAP = 512 * 1024; // scan up to 512 KB of code
    const bytes = data.slice(start, Math.min(data.length, start + CAP));
    const { runObjdump } = await import("../../toolchains/objdump.js");
    asm = (await runObjdump({ bytes, arch: "m68k", startAddress: start })).asm;
  } else if (resolved === "pce") {
    // PC Engine HuCard: HuC6280 (65C02 superset), 8KB pages mapped via the
    // MPRs. ≤32KB images map flat at the top of the address space (the old
    // assumption — correct there). Bigger HuCards are banked: the old code
    // computed a WRAPPED start address (garbage for >64KB) — fixed: scan
    // every 8KB page, page 0 at $E000 (where MPR7 maps it at reset — the
    // vectors live there), pages 1+ at $8000 (a neutral MPR4 window; the
    // base only affects branch-target/auto-label matching, absolute operands
    // match regardless). A 512-byte copier header is stripped if present.
    const hasCopier = (data.length % 1024) === 512;
    const body = hasCopier ? data.subarray(512) : data;
    const { runDa65 } = await import("../../toolchains/cc65/da65.js");
    if (body.length <= 0x8000) {
      const start = (0x10000 - body.length) & 0xffff;
      const r = await runDa65({ bytes: body.slice(0), startAddress: start, cpu: "huc6280", options: ["--comments", "4"] });
      asm = r.asm;
    } else {
      const PAGE = 0x2000;
      const nPages = Math.ceil(body.length / PAGE);
      const scanPages = Math.min(nPages, SEGMENT_CAP);
      segmentsCapped = nPages - scanPages;
      segments = [];
      for (let b = 0; b < scanPages; b++) {
        const bytes = body.slice(b * PAGE, (b + 1) * PAGE);
        const startAddress = b === 0 ? 0xE000 : 0x8000;
        const r = await runDa65({ bytes, startAddress, cpu: "huc6280", options: ["--comments", "4"] });
        segments.push({ asm: r.asm, bank: b });
      }
    }
  } else if (resolved === "msx") {
    // MSX cartridge maps at $4000-$BFFF. MegaROMs (>32KB) page 16KB banks via
    // an ASCII16-style mapper — the old code scanned only the first 32KB.
    // Scan bank 0 at $4000 (its fixed home, header skipped) and banks 1+ at
    // $8000 (the conventional second window), tagged with the bank index.
    const hdr = data.length >= 2 && data[0] === 0x41 && data[1] === 0x42;
    const base = hdr ? 16 : 0;
    const { runObjdump } = await import("../../toolchains/objdump.js");
    if (data.length <= 0x8000 + base) {
      const bytes = data.slice(base, Math.min(data.length, base + 0x8000));
      asm = (await runObjdump({ bytes, arch: "z80", startAddress: 0x4000 + base })).asm;
    } else {
      const BANK = 0x4000;
      const nBanks = Math.ceil(data.length / BANK);
      const scanBanks = Math.min(nBanks, SEGMENT_CAP);
      segmentsCapped = nBanks - scanBanks;
      segments = [];
      for (let b = 0; b < scanBanks; b++) {
        const skip = b === 0 ? base : 0;
        const bytes = data.slice(b * BANK + skip, (b + 1) * BANK);
        const startAddress = b === 0 ? 0x4000 + base : 0x8000;
        segments.push({ asm: (await runObjdump({ bytes, arch: "z80", startAddress })).asm, bank: b });
      }
    }
  } else if (resolved === "gba") {
    // GBA = ARM7TDMI, ROM maps flat at 0x08000000. Disassemble as ARM (the
    // default; Thumb regions need disassembleRom with thumb:true). Native
    // binutils ARM objdump ships in romdev-platform-gba.
    const { runObjdump, objdumpAvailable } = await import("../../toolchains/objdump.js");
    if (!objdumpAvailable("arm")) {
      throw new Error("findReferences: GBA needs the ARM objdump WASM (romdev-platform-gba).");
    }
    const CAP = 512 * 1024;
    const bytes = data.slice(0, Math.min(data.length, CAP));
    const r = await runObjdump({ bytes, arch: "arm", startAddress: 0x08000000 });
    asm = r.asm;
  } else {
    throw new Error(`findReferences: platform '${resolved}' not supported yet.`);
  }

  let refs;
  if (segments) {
    refs = [];
    // NES refs keep the shipped `prgBank` tag; other banked platforms use the
    // platform-neutral `romBank`.
    const bankKey = resolved === "nes" ? "prgBank" : "romBank";
    for (const seg of segments) {
      for (const r of scanAsmForReferences(seg.asm, address, [])) {
        refs.push({ ...r, [bankKey]: seg.bank });
      }
    }
  } else {
    refs = scanAsmForReferences(asm, address, []);
  }
  // Add vector-table refs.
  if (resolved === "nes") {
    refs.push(...nesVectorRefs(data, address));
  }
  if (resolved === "sms" || resolved === "gg") {
    refs.push(...smsVectorRefs(data, address));
  }
  if (resolved === "gb" || resolved === "gbc") {
    refs.push(...gbVectorRefs(data, address));
  }
  if (resolved === "atari2600" || resolved === "atari7800") {
    refs.push(...atariVectorRefs(data, address));
  }

  return {
    path,
    platform: resolved,
    address: "$" + address.toString(16).toUpperCase(),
    refsFound: refs.length,
    refs: refs.slice(0, maxRefsReturned),
    truncated: refs.length > maxRefsReturned
      ? `${refs.length - maxRefsReturned} additional references not returned (raise maxRefsReturned).`
      : undefined,
    notes: [
      refs.length === 0
        ? `No references found. Address $${address.toString(16).toUpperCase()} may be unreached, or an indirect/computed jump target.`
        : null,
      segmentsCapped > 0
        ? `Scan covered the first ${SEGMENT_CAP} banks only — ${segmentsCapped} additional bank(s) were NOT scanned (very large cart).`
        : null,
    ].filter(Boolean).join(" ") || undefined,
  };
}

// findReferences folded into the `disasm` tool as target:'references' (the core,
// findReferencesCore above, is imported by disasm.js's router).
export function registerFindReferencesTools() { /* folded into `disasm` */ }
