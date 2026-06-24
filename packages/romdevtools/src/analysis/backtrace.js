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

/**
 * Build a backtrace from a register snapshot + a stack reader, dispatching on CPU
 * family. Returns null if the platform isn't supported or the snapshot lacks a
 * stack pointer — callers should treat null as "no backtrace available", not an
 * error.
 *
 * @param {Object} opts
 * @param {string} opts.platform
 * @param {Object} opts.regs           the `named` register map (hex strings)
 * @param {(region:string, offset:number, length:number)=>Uint8Array} opts.readMemory
 * @param {(cpuAddr:number)=>(number|null)} [opts.readByteAt]  validate opcodes
 * @param {number} [opts.maxDepth=8]
 * @returns {{ frames: Array, isa: string } | null}
 */
export function buildBacktrace({ platform, regs, readMemory, readByteAt, maxDepth = 8 }) {
  if (!regs) return null;
  const SIXTYFIVE_OH_TWO = new Set(["nes", "atari2600", "atari7800", "c64", "lynx", "pce"]);
  if (SIXTYFIVE_OH_TWO.has(platform)) {
    // Register snapshots format values as "$EF" / "0xEF"; strip the prefix.
    const sp = parseInt(String(regs.s ?? "").replace(/^\$|^0x/i, ""), 16);
    if (Number.isNaN(sp)) return null;
    let stackPage;
    try { stackPage = readMemory("system_ram", 0x0100, 0x100); } catch { return null; }
    // NES/2600 RAM is mirrored/short; if the read is shorter than a page, pad.
    if (stackPage.length < 0x100) {
      const full = new Uint8Array(0x100);
      full.set(stackPage.subarray(0, 0x100));
      stackPage = full;
    }
    const frames = decode6502Backtrace(sp, stackPage, readByteAt, maxDepth);
    return { isa: "6502", frames };
  }
  return null; // other ISAs: not yet decoded (phase 1 = 6502 family)
}
