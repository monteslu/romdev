// findReferences — given a target CPU address, find every instruction in a
// ROM that references it.
//
// Built on top of the disassembler — we run the full PRG / ROM through
// da65 then scan the asm text for operands that match the target address.
// Also walks the vector table so reset/nmi/irq references show up even
// though they're not "instructions" per se.

import { readFile } from "node:fs/promises";
import { jsonContent, safeTool } from "../util.js";
import { mapNesAddress, mapSnesAddress, mapAtari2600Address, mapAtari7800Address, mapC64Address } from "./disasm.js";

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
    for (const m of operand.matchAll(/\$([0-9A-Fa-f]+)\b/g)) {
      const v = parseInt(m[1], 16);
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

  // Disassemble the whole code area.
  let asm;
  if (resolved === "nes") {
    const prgSize = data[4] * 16384;
    const startAddress = prgSize === 16384 ? 0xC000 : 0x8000;
    const bytes = data.slice(16, 16 + prgSize);
    const { runDa65 } = await import("../../toolchains/cc65/da65.js");
    const r = await runDa65({ bytes, startAddress, cpu: "6502", options: ["--comments", "4"] });
    asm = r.asm;
  } else if (resolved === "snes") {
    const mapped = mapSnesAddress(data, 0x008000, 0x8000, mapper);
    const startAddress = 0x008000;
    const { runDa65 } = await import("../../toolchains/cc65/da65.js");
    const r = await runDa65({
      bytes: mapped.bytes, startAddress, cpu: "65816",
      options: ["--comments", "4"],
      info: `RANGE { START $${(startAddress & 0xFFFF).toString(16).toUpperCase()}; END $${((startAddress + mapped.bytes.length - 1) & 0xFFFF).toString(16).toUpperCase()}; TYPE Code; ADDRMODE "MX"; };\n`,
    });
    asm = r.asm;
  } else if (resolved === "sms" || resolved === "gg") {
    // SMS: disasm slot 0+1 ($0000-$7FFF, fixed in the sega mapper).
    // Slot 2 ($8000-$BFFF) is banked — skip cross-bank scanning for now.
    const bytes = data.slice(0, Math.min(data.length, 0x8000));
    const { runZ80dasm } = await import("../../toolchains/z80dasm.js");
    const r = runZ80dasm({ bytes, startAddress: 0x0000 });
    asm = r.asm;
  } else if (resolved === "gb" || resolved === "gbc") {
    // GB: bank 0 + bank 1 default ($0000-$7FFF). Higher banks are
    // game-mapper-controlled — agents pass `bank` to disasm a specific
    // bank but findReferences sticks to the fixed-mapping region.
    const bytes = data.slice(0, Math.min(data.length, 0x8000));
    const { runSm83dasm } = await import("../../toolchains/sm83dasm.js");
    const r = runSm83dasm({ bytes, startAddress: 0x0000 });
    asm = r.asm;
  } else if (resolved === "atari2600") {
    // 2600 cart maps to $F000-$FFFF (top of 4 KB bank). For larger
    // banked carts we scan the last 4 KB which is what's typically
    // resident at boot.
    const mapped = mapAtari2600Address(data, 0xF000, 0x1000, 0);
    const { runDa65 } = await import("../../toolchains/cc65/da65.js");
    const r = await runDa65({ bytes: mapped.bytes, startAddress: 0xF000, cpu: "6502", options: ["--comments", "4"] });
    asm = r.asm;
  } else if (resolved === "atari7800") {
    // 7800 cart maps to $4000-$FFFF; agents typically focus on the top
    // 16 KB ($C000-$FFFF) where reset+main code lives.
    const start = 0xC000;
    const mapped = mapAtari7800Address(data, start, 0x10000 - start, 0);
    const { runDa65 } = await import("../../toolchains/cc65/da65.js");
    const r = await runDa65({ bytes: mapped.bytes, startAddress: start, cpu: "6502", options: ["--comments", "4"] });
    asm = r.asm;
  } else if (resolved === "c64") {
    // c64 .prg: 2-byte load addr + code. Disasm from the load addr through
    // EOF. For typical BASIC-stub programs that's $0801 + a few KB.
    const loadAddr = data[0] | (data[1] << 8);
    const codeLen = data.length - 2;
    const mapped = mapC64Address(data, loadAddr, codeLen, 0);
    const { runDa65 } = await import("../../toolchains/cc65/da65.js");
    const r = await runDa65({ bytes: mapped.bytes, startAddress: loadAddr, cpu: "6502", options: ["--comments", "4"] });
    asm = r.asm;
  } else if (resolved === "genesis") {
    // Genesis ROM maps 1:1 to 68000 $000000+. Disassemble from the reset
    // vector ($000004) to EOF (capped to keep the pure-JS pass bounded on
    // big carts). The m68k disassembler emits $XXXXXX absolute operands and
    // L______ labels that scanAsmForReferences matches.
    const { runM68kdasm } = await import("../../toolchains/m68kdasm.js");
    const resetPc = (data[4] << 24 | data[5] << 16 | data[6] << 8 | data[7]) >>> 0;
    const start = resetPc < data.length ? resetPc : 0x200;
    const CAP = 512 * 1024; // scan up to 512 KB of code
    const bytes = data.slice(start, Math.min(data.length, start + CAP));
    const r = runM68kdasm({ bytes, startAddress: start });
    asm = r.asm;
  } else if (resolved === "pce") {
    // PC Engine HuCard: HuC6280 (65C02 superset). da65 has an explicit huc6280
    // CPU mode. The cart maps to the top of the address space (no header).
    const body = data.slice(0);
    const start = (0x10000 - body.length) & 0xffff;
    const { runDa65 } = await import("../../toolchains/cc65/da65.js");
    const r = await runDa65({ bytes: body, startAddress: start, cpu: "huc6280", options: ["--comments", "4"] });
    asm = r.asm;
  } else if (resolved === "msx") {
    // MSX cartridge maps at $4000-$BFFF; skip the 16-byte "AB" header, then
    // disassemble the Z80 image from $4010.
    const hdr = data.length >= 2 && data[0] === 0x41 && data[1] === 0x42;
    const base = hdr ? 16 : 0;
    const bytes = data.slice(base, Math.min(data.length, base + 0x8000));
    const { runZ80dasm } = await import("../../toolchains/z80dasm.js");
    const r = runZ80dasm({ bytes, startAddress: 0x4000 + base });
    asm = r.asm;
  } else {
    throw new Error(`findReferences: platform '${resolved}' not supported yet.`);
  }

  const refs = scanAsmForReferences(asm, address, []);
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
    notes: refs.length === 0
      ? `No references found. Address $${address.toString(16).toUpperCase()} may be unreached, or an indirect/computed jump target.`
      : undefined,
  };
}

export function registerFindReferencesTools(server, z) {
  server.tool(
    "findReferences",
    "Use this before changing a routine to answer \"what else calls or reads this address?\" — scans the " +
    "ROM's code (via the disassembler) for operands matching a target CPU address and classifies each as " +
    "call/jump/branch/read/write/use; also walks the vector table. Supported: nes, snes, sms, gg, gb, gbc, " +
    "atari2600, atari7800, c64, genesis. LIMITATION: only direct addressing is matched — indirect jumps " +
    "(`jmp ($XXXX)`), jump tables, and computed jsr's are NOT found; on banked ROMs it scans one bank, so " +
    "cross-bank references can be missed.",
    {
      path: z.string().describe("Absolute path to the ROM file."),
      platform: z.enum(["nes", "snes", "sms", "gg", "gb", "gbc", "atari2600", "atari7800", "c64", "genesis"]).optional().describe("Override platform detection."),
      address: z.number().int().min(0).max(0xFFFFFF).describe("Target CPU address — find references TO this address."),
      mapper: z.enum(["lorom", "hirom"]).optional().describe("SNES only: override mapper detection."),
      maxRefsReturned: z.number().int().min(1).max(2048).default(256),
    },
    safeTool(async (args) => {
      const r = await findReferencesCore(args);
      return jsonContent(r);
    }),
  );
}
