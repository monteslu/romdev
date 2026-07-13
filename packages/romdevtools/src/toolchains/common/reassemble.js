// Byte-exact disassemble → reassemble using NATIVE tools end to end.
//
// `reassembleForPlatform` is the entry point. It disassembles with the native
// binutils objdump for the CPU and reassembles with the matching native
// assembler, healing any instruction the assembler rejects to an exact `.byte`:
//   - 6502/65816 (NES/SNES/Atari/C64/PCE/Lynx) → da65 → ca65/ld65 (reassembleCc65Native)
//   - m68k (Genesis)                            → objdump → m68k-elf-as/ld/objcopy
//   - arm (GBA)                                 → objdump → arm-none-eabi-as/ld/objcopy
//   - z80 (SMS/GG/MSX) + gbz80 (GB/GBC)         → objdump → z80-elf-as + objcopy
//     (gbz80 objects can't be ld-linked, so as + `.org` + objcopy)
//
// objdump and `as` share GNU syntax, so the GNU CPUs need NO instruction
// translation — objdump's lines feed straight back into `as`. The byte-exact
// guarantee is the heal loop: assemble, diff vs the original, pin any
// mismatching/rejected line to a `.byte` of its exact bytes, retry. Always
// byte-exact; readability = how many lines stayed instructions.

const hex2 = (b) => "$" + (b & 0xFF).toString(16).padStart(2, "0").toUpperCase();

// Label form across disassemblers: `L` + 4..8 hex digits (m68k targets can be
// 24-bit, e.g. an $E0FF00xx RAM mirror → LE0FF0080).
const LABEL_RE = /^(L[0-9A-Fa-f]{4,8}):\s*$/;

/** Parse one disasm line into {label?, code?, bytes?[]}. */
function parseLine(line) {
  // Label-only line: `L00023C:`
  const lm = line.match(LABEL_RE);
  if (lm) return { label: lm[1] };
  // Code + trailing `; ADDR BB BB` comment.
  const cm = line.match(/^\s*(.*?)\s*;\s*([0-9A-Fa-f]{4,8})\s+((?:[0-9A-Fa-f]{2}\s*)+)\s*$/);
  if (cm) {
    const bytes = cm[3].trim().split(/\s+/).map((h) => parseInt(h, 16));
    return { code: cm[1].trim(), addr: parseInt(cm[2], 16), bytes };
  }
  // A label on the same line as code: `L00023C:  jmp ...`  (rare)
  const both = line.match(/^(L[0-9A-Fa-f]{4,8}):\s+(.*?)\s*;\s*([0-9A-Fa-f]{4,8})\s+((?:[0-9A-Fa-f]{2}\s*)+)\s*$/);
  if (both) {
    const bytes = both[4].trim().split(/\s+/).map((h) => parseInt(h, 16));
    return { label: both[1], code: both[2].trim(), addr: parseInt(both[3], 16), bytes };
  }
  // Assembler STATE directives that emit no bytes but MUST be preserved for the
  // reassembly to be correct — chiefly the 65816 width directives `.a8/.a16/
  // .i8/.i16` (and `.setcpu`), which tell ca65 the accumulator/index size so
  // `lda #imm` etc. get the right operand width. Dropping them silently
  // mis-encodes everything after a width switch.
  const dir = line.match(/^\s*(\.(?:setcpu|a8|a16|i8|i16|smart)\b.*)$/i);
  if (dir) return { directive: dir[1].trim() };
  return {}; // comment/blank — skip
}

/** First differing byte index, or -1 if equal up to min length. */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// ── Per-platform orchestrator ───────────────────────────────────────────────
//
// Disassemble a chunk of bytes for `platform` at CPU address `startAddress`,
// then reassemble it BYTE-EXACT in that platform's native assembler. Returns
// the reassembled source + verification. Picks the native disassembler and
// assembler per CPU family:
//   6502/65816 (nes/snes/atari/c64/pce/lynx) → da65 → ca65/ld65
//   z80 (sms/gg/msx) + sm83 (gb/gbc)          → objdump → z80-elf-as + objcopy
//   m68k (genesis)                            → objdump → m68k-elf-as/ld/objcopy
//   arm (gba)                                 → objdump → arm-none-eabi-as/ld/objcopy

export const CPU_FAMILY = {
  nes: "6502", c64: "6502", atari2600: "6502", atari7800: "6502", lynx: "6502",
  snes: "65816",
  sms: "z80", gg: "z80", msx: "z80",
  gb: "sm83", gbc: "sm83",
  genesis: "m68k", megadrive: "m68k", md: "m68k",
  gba: "arm",
  // PC Engine's HuC6280 is a 65C02 superset — the 6502-family da65/ca65 path
  // reassembles it (da65 also has an explicit --cpu huc6280 mode for decode).
  pce: "6502",
};

/**
 * @param {Object} a
 * @param {string} a.platform
 * @param {Uint8Array} a.bytes        the chunk to disassemble (already mapped to CPU space)
 * @param {number} a.startAddress     CPU address of byte 0
 * @returns {Promise<{ family:string, source:string, bytes:Uint8Array|null, ok:boolean,
 *   total:number, dcLines:number, readablePercent:number, note?:string }>}
 */
export async function reassembleForPlatform(a) {
  const { platform, bytes, startAddress } = a;
  const family = CPU_FAMILY[platform];
  if (!family) throw new Error(`reassembleForPlatform: no reassembly path for platform '${platform}'`);

  // ── disassemble (NATIVE binutils objdump — no hand-rolled decoders) ──
  // 6502/65816 use da65 (cc65's real disassembler); everything else uses the
  // matching binutils objdump. normalizeObjdump emits romdev's house format
  // (`<insn> ; ADDR bytes`) the heal loop's parseLine consumes.
  let disasm;
  if (family === "6502" || family === "65816") {
    const { runDa65 } = await import("../cc65/da65.js");
    const r = await runDa65({ bytes, startAddress, cpu: family === "65816" ? "65816" : "6502", options: ["--comments", "4"] });
    disasm = r.asm;
    // da65 output is already valid cc65 — heal it in place (cc65 reassembles its
    // own syntax natively).
    return reassembleCc65Native(disasm, startAddress, bytes, family);
  }
  // ALL non-6502 CPUs: disassemble with native objdump, reassemble with the
  // matching native binutils `as`/`ld`/`objcopy`. objdump output IS GNU-as
  // syntax, so there's no translation — keep its lines verbatim and pin only the
  // instructions `as` rejects (absolute branch/PC-relative forms) to `.byte`.
  // NO hand-rolled decoders anywhere.
  const { runObjdump } = await import("../objdump.js");
  if (family === "m68k") {
    disasm = (await runObjdump({ bytes, arch: "m68k", startAddress })).asm;
    const m = await import("../m68k-elf-gcc/gcc.js");
    return reassembleGnuNative(disasm, startAddress, bytes,
      { runAs: m.runM68kAs, runLd: m.runM68kLd, runObjcopy: m.runM68kObjcopy, fmtLines: `OUTPUT_FORMAT("elf32-m68k")\nOUTPUT_ARCH(m68k)\n` }, family);
  }
  if (family === "arm") {
    disasm = (await runObjdump({ bytes, arch: "arm", startAddress })).asm;
    const m = await import("../arm-none-eabi-gcc/gcc.js");
    return reassembleGnuNative(disasm, startAddress, bytes,
      { runAs: m.runArmAs, runLd: m.runArmLd, runObjcopy: m.runArmObjcopy }, family);
  }
  if (family === "z80" || family === "sm83") {
    // z80 binutils `as` handles BOTH the Z80 (-march=z80) and the Game Boy CPU
    // (-march=gbz80) — the same objdump that disassembled them.
    const arch = family === "sm83" ? "gbz80" : "z80";
    disasm = (await runObjdump({ bytes, arch, startAddress })).asm;
    const z = await import("../z80/binutils.js");
    return reassembleGnuNative(disasm, startAddress, bytes,
      { runAs: z.runZ80As, runObjcopy: z.runZ80Objcopy, march: arch, noLink: true }, family);
  }
  throw new Error(`reassembleForPlatform: no reassembly path for family '${family}'`);
}

/**
 * Reassemble a GNU-toolchain CPU (m68k / arm) from native objdump output using
 * the matching binutils `as`/`ld`/`objcopy`. objdump and as share GNU syntax, so
 * we keep objdump's instruction lines almost verbatim (only `$hex`→`0x`, our
 * house normalization) and place a label at each in-range branch target. Heal:
 * assemble; for any instruction `as` REJECTS (PC-relative/branch forms objdump
 * prints absolutely), pin that line to a `.byte` of its exact bytes and retry.
 * Floor = clean all-`.byte` (proven byte-exact). No hand-rolled de/encoding.
 * @returns same shape as reassembleForPlatform
 */
async function reassembleGnuNative(disasm, startAddress, original, tools, family) {
  // tools: { runAs, runLd, runObjcopy, fmtLines, asArgs? } — the matching
  // binutils chain for this CPU. asArgs (e.g. for z80's -march=gbz80) ride
  // through to the assembler call (the z80 wrapper bakes march in itself).
  const { runAs, runLd, runObjcopy, fmtLines = "" } = tools;
  // SUBALIGN(1) is load-bearing: without it, the m68k ELF aligns .text to a 2-byte
  // (word) boundary, so `objcopy -O binary` emits 2 leading pad bytes and the whole
  // region shifts by 2 → byte-exact FAILS even for a pure `.byte` floor. Forcing
  // sub-alignment to 1 places the section exactly at its origin with no leading pad.
  // (ARM shares this linked path; harmless there where alignment already matches.)
  const ld = `${fmtLines}ENTRY(_start)\nSECTIONS {\n  .text 0x${startAddress.toString(16)} : SUBALIGN(1) {\n    *(.text*) *(.rodata*) *(.data*)\n  }\n  /DISCARD/ : { *(.ARM.attributes) *(.comment) *(.note*) }\n}\n`;

  // Parse objdump's normalized lines into {label?, code?, addr, bytes}.
  const lines = disasm.split(/\r?\n/).map(parseLine);
  // Which in-range addresses are branch targets (need a label def)?
  const addrOf = new Map();
  for (const p of lines) if (p.addr != null && p.bytes) addrOf.set(p.addr, p);
  const codeIdx = [];
  lines.forEach((p, i) => { if (p.code != null && p.bytes) codeIdx.push(i); });
  const forced = new Set();

  const toGas = (code) => code.replace(/\$([0-9A-Fa-f]+)\b/g, (_, h) => "0x" + h);

  const build = () => {
    const out = [".section .text", ".global _start"];
    // No-link (z80/gbz80) path: place the section with `.org` so labels resolve
    // to real addresses before objcopy (there's no linker to set the origin).
    if (tools.noLink) out.push(`.org 0x${startAddress.toString(16)}`);
    out.push("_start:");
    for (let i = 0; i < lines.length; i++) {
      const p = lines[i];
      if (p.label) { out.push(p.label + ":"); continue; }
      if (p.code != null && p.bytes) {
        if (forced.has(i)) out.push("\t.byte " + p.bytes.map((b) => "0x" + b.toString(16).padStart(2, "0")).join(","));
        else out.push("\t" + toGas(p.code));
      }
    }
    return out.join("\n") + "\n";
  };
  const assemble = async (src) => {
    const a = await runAs({ source: src, march: tools.march }).catch(() => ({ object: null, log: "" }));
    if (!a || !a.object) return { ok: false, log: a?.log || "" };
    let elf;
    if (tools.noLink) {
      // z80/gbz80: `as` resolves all in-file labels (one source file, no cross-
      // refs), and ld rejects gbz80 objects ("instruction sets incompatible").
      // Skip ld — objcopy the assembled object straight to binary. Correct
      // section addresses come from the `.org startAddress` the source carries.
      elf = a.object;
    } else {
      const l = await runLd({ objects: { "main.o": a.object }, linkScript: ld }).catch(() => null);
      if (!l || !l.elf) return { ok: false, log: l?.log || "" };
      elf = l.elf;
    }
    const o = await runObjcopy({ elf }).catch(() => null);
    if (!o || !o.binary) return { ok: false, log: "" };
    let bin = new Uint8Array(o.binary);
    if (tools.noLink) {
      // The `.org startAddress` makes objcopy emit `startAddress` leading zero
      // bytes (the section's offset). Slice to the real region.
      bin = bin.slice(startAddress, startAddress + original.length);
    } else if (bin.length > original.length) {
      bin = bin.slice(0, original.length);
    }
    return { ok: true, bytes: bin };
  };

  const totalCode = codeIdx.length;
  for (let pass = 0; pass < 80; pass++) {
    const src = build();
    const r = await assemble(src);
    if (r.ok) {
      if (r.bytes.length === original.length && firstDiff(original, r.bytes) < 0) {
        return { family, source: src, bytes: r.bytes, ok: true, total: totalCode, dcLines: forced.size,
          readablePercent: totalCode ? Math.round(100 * (1 - forced.size / totalCode)) : 100 };
      }
      // Assembled but bytes differ (and/or length changed). Compare each line's
      // bytes at its ABSOLUTE offset (p.addr - startAddress), NOT an accumulated
      // cursor — the linker anchors every line at its real address, so a single
      // line that `as` re-encoded to a different length doesn't desync the rest
      // (the cursor-accumulation approach drifted on the first length-changer and
      // pinned everything after it — the bug that floored literal-heavy ARM).
      // Pin EVERY mismatching instruction this pass so it converges in a few.
      let pinnedHere = false;
      for (let li = 0; li < lines.length; li++) {
        const p = lines[li];
        if (!p.bytes || p.code == null || forced.has(li)) continue;
        const off = p.addr - startAddress;
        let match = off >= 0 && off + p.bytes.length <= r.bytes.length;
        if (match) for (let k = 0; k < p.bytes.length; k++) if (r.bytes[off + k] !== p.bytes[k]) { match = false; break; }
        if (!match) { forced.add(li); pinnedHere = true; }
      }
      if (!pinnedHere) {
        // Bytes all matched at their addresses but totals still differ (length
        // mismatch with no per-line diff — e.g. a re-encode that shifted later
        // lines). Pin the next unpinned code line to make progress.
        const n = codeIdx.find((i) => !forced.has(i));
        if (n == null) break;
        forced.add(n);
      }
      continue;
    }
    // `as` rejected something → pin every code line whose translated text the
    // error log names. The wrapped source has a 3-line preamble.
    const srcLines = src.split("\n");
    let pinned = false;
    for (const m of (r.log || "").matchAll(/:(\d+):\s*(?:Error|Warning):/g)) {
      const ln = parseInt(m[1], 10) - 1;
      const text = (srcLines[ln] || "").trim();
      for (const i of codeIdx) { if (forced.has(i)) continue; if (("\t" + toGas(lines[i].code)).trim() === text) { forced.add(i); pinned = true; break; } }
    }
    if (!pinned) { const n = codeIdx.find((i) => !forced.has(i)); if (n == null) break; forced.add(n); }
  }
  // Floor: clean all-`.byte` (proven byte-exact, no labels to perturb layout).
  // Mirror build()'s `.org` for the no-link (z80/gbz80) path: without it,
  // objcopy emits the section from file offset 0, and assemble()'s
  // `bin.slice(startAddress, …)` then returns bytes that are `startAddress`-short
  // (empty for a $4000/$8000-based region) — so any non-zero-org region (MSX
  // $4010, GB bank1 $4000, …) silently fails the floor. The linked path sets the
  // origin via the link script, so it must NOT carry a redundant `.org`.
  const rows = [".section .text", ".global _start"];
  if (tools.noLink) rows.push(`.org 0x${startAddress.toString(16)}`);
  rows.push("_start:");
  for (let i = 0; i < original.length; i += 16) rows.push("\t.byte " + Array.from(original.slice(i, i + 16)).map((b) => "0x" + b.toString(16).padStart(2, "0")).join(","));
  const r = await assemble(rows.join("\n") + "\n");
  const ok = r.ok && r.bytes.length === original.length && firstDiff(original, r.bytes) < 0;
  return { family, source: rows.join("\n") + "\n", bytes: ok ? r.bytes : null, ok, total: totalCode, dcLines: totalCode,
    readablePercent: 0, note: ok ? "byte-exact (data-only floor — some instructions didn't round-trip)" : "could not reach byte-exact" };
}

/**
 * Reassemble cc65 (6502/65816) families by using da65's output AS-IS — it's
 * already valid cc65 with its own equate/label structure. We inject `.org`
 * after `.setcpu` (the proven byte-exact recipe) and heal by replacing any
 * da65 CODE line that doesn't reassemble to its own bytes with a `.byte` of
 * those bytes (recovered from the line's `; ADDR BB` comment). Preserves
 * da65's equates/labels/`.a8`/`.i8` exactly.
 * @returns same shape as reassembleForPlatform
 */
async function reassembleCc65Native(disasm, startAddress, original, family) {
  const { runCa65, runLd65 } = await import("../cc65/cc65.js");
  const cpuTag = family === "65816" ? "65816" : "6502";
  const cfg = `MEMORY{M:start $${startAddress.toString(16)},size $${original.length.toString(16)},type ro,file %O,fill yes,fillval $FF;}\nSEGMENTS{CODE:load M,type ro;}\n`;

  // Split da65 output into lines, tagging code lines with their {addr,bytes}.
  const lines = disasm.split(/\r?\n/);
  const meta = lines.map((line) => {
    const m = line.match(/^\s*(?!L[0-9A-Fa-f]+:|;|\.)(\S.*?)\s*;\s*([0-9A-Fa-f]{4,8})\s+((?:[0-9A-Fa-f]{2}\s*)+)\s*$/);
    if (m) return { code: true, addr: parseInt(m[2], 16), bytes: m[3].trim().split(/\s+/).map((h) => parseInt(h, 16)) };
    return { code: false };
  });
  const forced = new Set(); // line indices replaced with .byte

  const build = () => {
    const out = lines.map((line, i) => {
      if (forced.has(i)) return "\t.byte " + meta[i].bytes.map(hex2).join(",");
      return line;
    });
    // inject `.org` right after `.setcpu`
    const src = out.join("\n").replace(/(\.setcpu\s+"[^"]+")/, `$1\n\t.org $${startAddress.toString(16).toUpperCase()}`);
    return src;
  };
  const assemble = async (src) => {
    const ca = await runCa65({ source: src, target: "none" }).catch(() => null);
    if (!ca || !ca.object) return null;
    const ld = await runLd65({ objects: { "o.o": ca.object }, target: "none", linkerConfig: cfg }).catch(() => null);
    return ld && ld.binary ? new Uint8Array(ld.binary) : null;
  };

  let source = build();
  const codeLineCount = meta.filter((m) => m.code).length;
  for (let pass = 0; pass < 80; pass++) {
    source = build();
    const out = await assemble(source);
    if (out && out.length === original.length && firstDiff(original, out) < 0) {
      return { family, source, bytes: out, ok: true, total: codeLineCount, dcLines: forced.size,
        readablePercent: codeLineCount ? Math.round(100 * (1 - forced.size / codeLineCount)) : 100 };
    }
    if (!out) {
      // ca65/ld failed — pin the first not-yet-pinned code line and retry.
      const next = meta.findIndex((m, i) => m.code && !forced.has(i));
      if (next < 0) break;
      forced.add(next);
      continue;
    }
    // byte mismatch: pin the code line owning the first diff.
    const d = firstDiff(original, out);
    const off = (d < 0 ? Math.min(out.length, original.length) : d) + startAddress;
    let owner = -1;
    for (let i = 0; i < meta.length; i++) {
      if (meta[i].code && meta[i].addr <= off && off < meta[i].addr + meta[i].bytes.length) { owner = i; break; }
      if (meta[i].code && meta[i].addr <= off) owner = i;
    }
    if (owner < 0 || forced.has(owner)) {
      const next = meta.findIndex((m, i) => m.code && !forced.has(i));
      if (next < 0) break;
      forced.add(next);
    } else {
      forced.add(owner);
    }
  }
  // Guaranteed floor: a CLEAN all-`.byte` dump of the original bytes (no da65
  // equates/labels/width-directives to desync). This is byte-exact on every
  // cc65 target we tested (incl. 65816, where mixing pinned `.byte` with live
  // instructions can break `.a8`/`.i8` width state — so when the incremental
  // heal can't converge, we emit pure data). Lower readability, but correct.
  {
    const rows = [`\t.setcpu "${cpuTag}"`, `\t.org $${startAddress.toString(16).toUpperCase()}`];
    for (let i = 0; i < original.length; i += 16) {
      rows.push("\t.byte " + Array.from(original.slice(i, i + 16)).map(hex2).join(","));
    }
    const flat = rows.join("\n") + "\n";
    const out = await assemble(flat);
    const ok = !!out && out.length === original.length && firstDiff(original, out) < 0;
    return { family, source: flat, bytes: out ?? null, ok, total: codeLineCount, dcLines: codeLineCount,
      readablePercent: 0,
      note: ok ? "incremental heal did not converge; emitted byte-exact data-only (low readability)" : "could not reach byte-exact even as data" };
  }
}
