// Call-stack reconstruction from a CPU register snapshot + the stack RAM. Turns
// "who called this routine?" from a captureMemory read + several lines of by-hand,
// off-by-one-prone return-address pointer math into one decoded field on a
// breakpoint hit. (v0.41.0 feedback note 005444 N1.)
//
// The ISA-specific part is the return-address convention. Phase 1 covers the
// 6502 family (the dominant RE target); the structure generalizes to Z80 / SM83 /
// m68k by adding a decoder. We DON'T claim a frame is real beyond what the raw
// stack bytes say — a 6502 stack also holds saved registers and data pushes, so
// each candidate is validated (the byte two-before the return target must be a
// `jsr` opcode $20) and flagged `confident` accordingly. Unvalidated candidates
// are still returned (some callers use jmp-based trampolines) but marked.
//
// Plain JS ESM + JSDoc.

/** 6502 JSR opcode. A real call frame's return address points just past it. */
const JSR_6502 = 0x20;

/**
 * Decode a 6502-family call stack from the stack page.
 *
 * 6502 stack model: page 1 ($0100-$01FF), SP points to the NEXT-FREE slot, so the
 * topmost pushed byte is at $0100 + ((S + 1) & 0xFF). JSR pushes the return
 * address (the address of its LAST operand byte = JSR_addr + 2) high byte first
 * then low byte — so on the stack the low byte sits at the lower address. To
 * recover the caller: read a little-endian word off the stack, subtract 2 (→ the
 * JSR instruction), and confirm the byte there is $20.
 *
 * @param {number} sp                 the S register (0x00-0xFF)
 * @param {Uint8Array} stackPage      the 256 bytes of $0100-$01FF
 * @param {(cpuAddr:number)=>(number|null)} readByteAt  read one byte at a CPU
 *   address (used to validate the $20 opcode); may return null if unmapped.
 * @param {number} [maxDepth=8]
 * @returns {Array<{ returnAddr:number, callerPc:number, confident:boolean }>}
 */
export function decode6502Backtrace(sp, stackPage, readByteAt, maxDepth = 8) {
  const frames = [];
  // Walk upward from the first occupied slot toward $01FF, reading LE words.
  let idx = (sp + 1) & 0xff; // index into the page of the topmost pushed byte
  while (frames.length < maxDepth && idx <= 0xfe) {
    const lo = stackPage[idx];
    const hi = stackPage[idx + 1];
    if (lo == null || hi == null) break;
    const returnAddr = (hi << 8) | lo;
    const callerPc = (returnAddr - 2) & 0xffff;
    let confident = false;
    if (returnAddr >= 0x8000) {
      // a plausible code return address; validate the JSR opcode if we can read it
      const op = readByteAt ? readByteAt(callerPc) : null;
      confident = op === JSR_6502;
    }
    if (confident) {
      frames.push({ returnAddr, callerPc, confident });
    } else if (returnAddr >= 0x8000 && frames.every((f) => !f.confident)) {
      // keep plausible-but-unvalidated frames only while we haven't yet locked
      // onto a confident call chain (some callers use jmp-trampolines, no $20).
      frames.push({ returnAddr, callerPc, confident });
    } else if (frames.some((f) => f.confident)) {
      // we had a confident chain and hit a non-call word ($FF padding, saved
      // data) → we've walked off the live frames. Stop cleanly.
      break;
    }
    idx += 2;
  }
  // If any frame validated as a real JSR, drop trailing unconfident noise so the
  // caller sees the trustworthy chain. Otherwise return the best-effort guesses.
  const anyConfident = frames.some((f) => f.confident);
  return anyConfident ? frames.filter((f) => f.confident) : frames;
}

/** Parse a hex register value that may carry a "$"/"0x" prefix → number, or NaN. */
function regNum(v) {
  return parseInt(String(v ?? "").replace(/^\$|^0x/i, ""), 16);
}

/**
 * Decode a stack of 16-bit LE return addresses (Z80 `call` / SM83 `call`): the
 * stack grows DOWN and SP points at the low byte of the topmost return address;
 * each `call` pushed a 2-byte LE return = the address of the instruction AFTER
 * the call. We can't cheaply recover the call instruction's own length (Z80 call
 * is 3 bytes, but a computed jump-in differs), so callerPc IS the return address
 * and we mark it `confident` when it lands in a plausible code range. SP-relative,
 * so the caller supplies a word reader (handles the platform's RAM mapping).
 *
 * @param {number} sp
 * @param {(cpuAddr:number)=>(number|null)} readWordLE  read a 16-bit LE word
 * @param {number} [maxDepth=8]
 * @param {number} [codeMin=0x0000]  return addresses below this are treated as data
 */
function decode16BitStack(sp, readWordLE, maxDepth = 8, codeMin = 0x0150) {
  const frames = [];
  let addr = sp & 0xffff;
  for (let i = 0; i < maxDepth; i++) {
    const ret = readWordLE(addr);
    if (ret == null) break;
    const confident = ret >= codeMin && ret <= 0xffff;
    if (confident) {
      frames.push({ returnAddr: ret, callerPc: ret, confident: true });
    } else if (frames.every((f) => !f.confident)) {
      frames.push({ returnAddr: ret, callerPc: ret, confident: false });
    } else {
      break; // had a confident chain, hit a non-code word → off the frames
    }
    addr = (addr + 2) & 0xffff;
  }
  const anyConfident = frames.some((f) => f.confident);
  return anyConfident ? frames.filter((f) => f.confident) : frames;
}

/**
 * Decode an m68k call stack. `jsr`/`bsr` push a 4-byte (longword) return address;
 * the stack grows down and A7 (SP) points at the topmost return longword (stored
 * big-endian). The return address is the instruction AFTER the jsr/bsr; we report
 * it as callerPc (recovering the call's own length needs a disasm pass). Genesis
 * RAM is $FF0000-$FFFFFF (mirrored), so SP is a 24-bit bus address.
 *
 * @param {number} sp
 * @param {(cpuAddr:number)=>(number|null)} readLongBE  read a 32-bit BE longword
 * @param {number} [maxDepth=8]
 */
function decodeM68kStack(sp, readLongBE, maxDepth = 8) {
  const frames = [];
  let addr = sp >>> 0;
  for (let i = 0; i < maxDepth; i++) {
    const ret = readLongBE(addr);
    if (ret == null) break;
    // Plausible m68k code address: even, inside the 24-bit address space, and not
    // obviously garbage ($00000000 / $FFFFFFFF). ROM is $000000+; RAM is $FF0000+.
    const a = ret & 0xffffff;
    const confident = (a & 1) === 0 && a !== 0 && a !== 0xffffff && a < 0x1000000;
    if (confident) {
      frames.push({ returnAddr: a, callerPc: a, confident: true });
    } else if (frames.every((f) => !f.confident)) {
      frames.push({ returnAddr: a, callerPc: a, confident: false });
    } else {
      break;
    }
    addr = (addr + 4) >>> 0;
  }
  const anyConfident = frames.some((f) => f.confident);
  return anyConfident ? frames.filter((f) => f.confident) : frames;
}

/**
 * Build a backtrace from a register snapshot + a stack reader, dispatching on CPU
 * family. Returns null if the platform isn't supported or the snapshot lacks a
 * stack pointer — callers treat null as "no backtrace available", not an error.
 *
 * Coverage: 6502 family (nes/2600/7800/c64/lynx/pce), m68k (genesis), Z80
 * (sms/gg/msx), SM83 (gb/gbc) — 13 of 14. GBA (ARM) is intentionally excluded:
 * ARM's BL leaves the return address in the LINK REGISTER, not on the stack, so a
 * stack walk doesn't recover the call chain without frame-pointer/unwind analysis.
 *
 * @param {Object} opts
 * @param {string} opts.platform
 * @param {Object} opts.regs           the `named` register map (hex strings)
 * @param {(region:string, offset:number, length:number)=>Uint8Array} opts.readMemory
 * @param {(cpuAddr:number)=>(number|null)} [opts.readByteAt]  validate the 6502 JSR opcode
 * @param {(cpuAddr:number, bytes:number)=>(number|null)} [opts.readCpuWord]  read
 *   a little-endian word at a CPU address (Z80/SM83 stacks live in work RAM at the
 *   SP, not a fixed page) — required for z80/sm83.
 * @param {(cpuAddr:number)=>(number|null)} [opts.readCpuLongBE]  read a 32-bit
 *   big-endian longword at a 68K bus address — required for genesis.
 * @param {number} [opts.maxDepth=8]
 * @returns {{ frames: Array, isa: string } | null}
 */
export function buildBacktrace({ platform, regs, readMemory, readByteAt, readCpuWord, readCpuLongBE, maxDepth = 8 }) {
  if (!regs) return null;
  const SIXTYFIVE_OH_TWO = new Set(["nes", "atari2600", "atari7800", "c64", "lynx", "pce"]);
  const Z80_FAMILY = new Set(["sms", "gg", "msx", "gb", "gbc"]); // z80 + sm83: same 2-byte LE call frame
  if (SIXTYFIVE_OH_TWO.has(platform)) {
    const sp = regNum(regs.s);
    if (Number.isNaN(sp)) return null;
    let stackPage;
    try { stackPage = readMemory("system_ram", 0x0100, 0x100); } catch { return null; }
    if (stackPage.length < 0x100) {
      const full = new Uint8Array(0x100);
      full.set(stackPage.subarray(0, 0x100));
      stackPage = full;
    }
    const frames = decode6502Backtrace(sp, stackPage, readByteAt, maxDepth);
    return { isa: "6502", frames };
  }
  if (Z80_FAMILY.has(platform)) {
    const sp = regNum(regs.sp);
    if (Number.isNaN(sp) || !readCpuWord) return null;
    const readWordLE = (a) => readCpuWord(a, 2);
    const frames = decode16BitStack(sp, readWordLE, maxDepth);
    return { isa: platform === "gb" || platform === "gbc" ? "sm83" : "z80", frames };
  }
  if (platform === "genesis") {
    const sp = regNum(regs.sp);
    if (Number.isNaN(sp) || !readCpuLongBE) return null;
    const frames = decodeM68kStack(sp, readCpuLongBE, maxDepth);
    return { isa: "m68k", frames };
  }
  return null; // gba (ARM, link-register calls) — not a stack walk
}
