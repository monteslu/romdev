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
  // GameTank's W65C02S is a 65C02 superset — same 6502-family da65/ca65 path.
  // 65C02-only opcodes da65 doesn't decode floor to `.byte` (still byte-exact).
  gametank: "6502",
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
  const { platform, bytes, startAddress, codeSpans } = a;
  const family = CPU_FAMILY[platform];
  if (!family) throw new Error(`reassembleForPlatform: no reassembly path for platform '${platform}'`);

  // ── disassemble (NATIVE binutils objdump — no hand-rolled decoders) ──
  // 6502/65816 use da65 (cc65's real disassembler); everything else uses the
  // matching binutils objdump. normalizeObjdump emits romdev's house format
  // (`<insn> ; ADDR bytes`) the heal loop's parseLine consumes.
  let disasm;
  if (family === "6502" || family === "65816") {
    const { runDa65 } = await import("../cc65/da65.js");
    // THE readability-floor fix (65816): when we have a code map, disassemble
    // each code span INDEPENDENTLY and dump the gaps as `.byte`. Two reasons a
    // single whole-region da65 pass floors to 0%:
    //   1. da65's `--comments 4` ASCII gutter broke the byte-capture regex → 0
    //      code lines recognized → everything floored. (regex fixed below.)
    //   2. On 65816, `.a8/.i8` width state set by a `rep/sep` inside one span
    //      leaks across the `.byte` gap into the next span, whose real entry
    //      width differs → operand widths wrong → byte counts wrong → cascade →
    //      the heal loop can't reconverge → floor.
    // Per-span disassembly cures (2): each span re-seeds width at its own entry
    // and can't desync the next. It's also FAST — each span is small, so its
    // heal loop is cheap, versus one superlinear 32KB heal (that measured 300s
    // for 21%). See reassemble65816Spans.
    if (family === "65816" && Array.isArray(codeSpans) && codeSpans.length) {
      return reassemble65816Spans(bytes, startAddress, codeSpans);
    }
    const r = await runDa65({ bytes, startAddress, cpu: family === "65816" ? "65816" : "6502", options: ["--comments", "4"], codeSpans });
    disasm = r.asm;
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

// Recognize a da65 `--comments 4` code line and pull {addr, bytes} out of its
// `; ADDR BB BB ..` comment. The byte group is single-space-separated hex pairs
// followed by an ASCII gutter (2+ spaces then the rendering) or EOL — so we stop
// at a double-space, NOT at `$` (anchoring to `$` matches nothing → the 0%
// readability floor bug). Labels/comments/directives are not code.
const DA65_CODE_RE = /^\s*\S.*?\s*;\s*([0-9A-Fa-f]{4,8})\s+((?:[0-9A-Fa-f]{2}(?: [0-9A-Fa-f]{2})*))(?:\s{2,}|\s*$)/;
function parseDa65Code(line) {
  if (/^\s*(?:L[0-9A-Fa-f]+:|;|\.)/.test(line)) return null;
  const m = line.match(DA65_CODE_RE);
  if (!m) return null;
  return { addr: parseInt(m[1], 16), bytes: m[2].trim().split(/\s+/).map((h) => parseInt(h, 16)) };
}

/**
 * 65816 readability path: disassemble each code span INDEPENDENTLY (so a span's
 * `.a8/.i8` width state can't leak across a data gap into the next span and
 * desync it), heal each span's da65 output line-by-line to byte-exact, and
 * stitch the healed code spans + `.byte` gaps into one `.org`-anchored source.
 * Every span is small → its heal loop is cheap → the whole region is fast AND as
 * readable as the real code allows (versus one 32KB heal that floored to 21% in
 * 300s).
 *
 * @param {Uint8Array} original  full region bytes
 * @param {number} startAddress  CPU address of region byte 0
 * @param {{start:number,end:number}[]} spans region-relative code byte offsets
 *   (sorted, merged, non-overlapping)
 * @returns same shape as reassembleForPlatform
 */
async function reassemble65816Spans(original, startAddress, spans) {
  const { runDa65 } = await import("../cc65/da65.js");
  const { runCa65, runLd65 } = await import("../cc65/cc65.js");

  // Heal one contiguous CODE span to byte-exact ca65 source. da65 decodes it as
  // code (its own info Code RANGE); any line ca65 rejects (bare wdm/cop/brk, a
  // data mis-decode inside the span) is pinned to `.byte`. Small spans → few
  // passes. Returns { asm, readable, total } — asm has NO `.setcpu`/`.org`
  // (the stitcher supplies those once for the whole region).
  const healSpan = async (spanBytes, spanAddr) => {
    const r = await runDa65({ bytes: spanBytes, startAddress: spanAddr, cpu: "65816",
      options: ["--comments", "4"], codeSpans: [{ start: 0, end: spanBytes.length }] });
    // Keep only the body lines (drop da65's banner comments + equates block —
    // the stitcher emits shared equates isn't needed; ca65 tolerates the raw
    // `Lxxxx := $..` lines, so keep those, drop only the leading `;` banner and
    // the `.setcpu`). We strip `.setcpu`; equates/labels/width dirs stay.
    const lines = r.asm.split(/\r?\n/).filter((l) => !/^\s*\.setcpu\b/.test(l));
    const meta = lines.map(parseDa65Code);
    const forced = new Set();
    const total = meta.filter(Boolean).length;
    const cfg = `MEMORY{M:start $${spanAddr.toString(16)},size $${spanBytes.length.toString(16)},type ro,file %O,fill yes,fillval $FF;}\nSEGMENTS{CODE:load M,type ro;}\n`;
    const codeByText = new Map();
    lines.forEach((line, i) => { if (meta[i]) { const t = line.trim(); if (!codeByText.has(t)) codeByText.set(t, i); } });
    const build = () => {
      const rows = [`\t.setcpu "65816"`, `\t.org $${spanAddr.toString(16).toUpperCase()}`];
      lines.forEach((line, i) => rows.push(forced.has(i) ? "\t.byte " + meta[i].bytes.map(hex2).join(",") : line));
      return rows.join("\n") + "\n";
    };
    const assemble = async (src) => {
      const ca = await runCa65({ source: src, target: "none" }).catch(() => null);
      if (!ca || !ca.object) return { bytes: null, log: ca?.log || "" };
      const ld = await runLd65({ objects: { "o.o": ca.object }, target: "none", linkerConfig: cfg }).catch(() => null);
      return { bytes: ld && ld.binary ? new Uint8Array(ld.binary) : null, log: "" };
    };
    // Bound heal effort. A span that needs MANY pins is really mis-classified
    // data (rizin over-claimed a data blob as a function); grinding it one pin
    // per re-assembly is the slow path (a 500-line junk span = 500 assemblies).
    // So bail to a clean `.byte` dump once too many lines are pinned — cheaper
    // AND more honest (a 40%-pinned "function" isn't readable code anyway). The
    // pass cap is a hard ceiling; the pin-ratio bail is the usual early exit.
    const cap = Math.min(total + 8, 60);
    const bailPins = Math.max(12, Math.ceil(total * 0.35));
    for (let pass = 0; pass < cap; pass++) {
      if (forced.size >= bailPins) break; // too much data mis-decoded → floor span
      const src = build();
      const srcLines = src.split("\n");
      const { bytes: out, log } = await assemble(src);
      if (out && out.length === spanBytes.length && firstDiff(spanBytes, out) < 0) {
        // Split the emitted lines into equates (`Lxxxx := $..`) and body. The
        // stitcher dedups equates region-wide (each span re-declares the same
        // targets → collisions if emitted per-span).
        const equates = [], body = [];
        lines.forEach((line, i) => {
          if (forced.has(i)) { body.push("\t.byte " + meta[i].bytes.map(hex2).join(",")); return; }
          if (/^\s*L[0-9A-Fa-f]+\s*:=/.test(line)) equates.push(line.trim());
          else if (!/^\s*;/.test(line) && line.trim() !== "") body.push(line);
        });
        return { equates, body, readable: total - forced.size, total };
      }
      if (!out) {
        let pinned = false;
        for (const m of log.matchAll(/^[^\n]*?:(\d+):\s*(?:\x1b\[[0-9;]*m)*\s*Error/gm)) {
          const sl = (srcLines[parseInt(m[1], 10) - 1] || "").trim();
          const idx = codeByText.get(sl);
          if (idx != null && !forced.has(idx)) { forced.add(idx); pinned = true; }
        }
        if (pinned) continue;
        const next = meta.findIndex((mm, i) => mm && !forced.has(i));
        if (next < 0) break;
        forced.add(next);
        continue;
      }
      // byte mismatch: pin the line owning the first diff.
      const d = firstDiff(spanBytes, out);
      const off = (d < 0 ? Math.min(out.length, spanBytes.length) : d) + spanAddr;
      let owner = -1;
      for (let i = 0; i < meta.length; i++) {
        if (!meta[i]) continue;
        if (meta[i].addr <= off && off < meta[i].addr + meta[i].bytes.length) { owner = i; break; }
        if (meta[i].addr <= off) owner = i;
      }
      if (owner < 0 || forced.has(owner)) {
        const next = meta.findIndex((mm, i) => mm && !forced.has(i));
        if (next < 0) break;
        forced.add(next);
      } else forced.add(owner);
    }
    // Span didn't converge as code → emit it as `.byte` (still byte-exact when
    // stitched). Readable 0 for this span.
    const body = [];
    for (let i = 0; i < spanBytes.length; i += 16) body.push("\t.byte " + Array.from(spanBytes.slice(i, i + 16)).map(hex2).join(","));
    return { equates: [], body, readable: 0, total };
  };

  // Walk the region: alternating gaps (`.byte`) and healed code spans. Spans are
  // region-relative, sorted, non-overlapping.
  const dataRows = (rel, len) => {
    const rows = [];
    for (let i = rel; i < rel + len; i += 16) rows.push("\t.byte " + Array.from(original.slice(i, Math.min(rel + len, i + 16))).map(hex2).join(","));
    return rows;
  };
  let cursor = 0, readable = 0, total = 0;
  const healed = await Promise.all(spans.map((s) => healSpan(original.slice(s.start, s.end), startAddress + s.start)));
  // Dedup equates region-wide. da65 equates a target label to a FIXED address
  // (`L2992D := $2992D`), so identical names always carry the same value — a
  // plain by-name dedup is safe. But a name that is ALSO defined as an in-body
  // `Lxxxx:` label (da65 labels a target that lands at the start of a decoded
  // line) would double-define → emit the equate ONLY for names never defined by
  // a label. This keeps cross-span references (`jsr LFF0D` where $FF0D is in
  // another span but not at a line start there → no label → must be equated)
  // resolvable, which dropping all in-region equates broke.
  const labelDefs = new Set(); // names defined as `Lxxxx:` in some span body
  for (const h of healed) {
    for (const line of h.body) {
      const lm = line.match(/^\s*(L[0-9A-Fa-f]+):/);
      if (lm) labelDefs.add(lm[1]);
    }
  }
  const equateSet = new Map(); // name → line
  for (const h of healed) {
    for (const e of h.equates) {
      const m = e.match(/^(L[0-9A-Fa-f]+)\s*:=\s*\$[0-9A-Fa-f]+/);
      if (!m) continue;
      if (labelDefs.has(m[1])) continue;    // defined by a real label → skip equate
      if (!equateSet.has(m[1])) equateSet.set(m[1], e);
    }
  }
  const out = [`\t.setcpu "65816"`, ...[...equateSet.values()], `\t.org $${startAddress.toString(16).toUpperCase()}`];
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (s.start > cursor) out.push(...dataRows(cursor, s.start - cursor)); // data gap before span
    out.push(...healed[i].body);
    readable += healed[i].readable; total += healed[i].total;
    cursor = s.end;
  }
  if (cursor < original.length) out.push(...dataRows(cursor, original.length - cursor)); // trailing data

  const cfg = `MEMORY{M:start $${startAddress.toString(16)},size $${original.length.toString(16)},type ro,file %O,fill yes,fillval $FF;}\nSEGMENTS{CODE:load M,type ro;}\n`;
  // Assemble; any `Lxxxx` da65 referenced but that no surviving label defines
  // (target mid-instruction, or in a floored span) comes back "undefined". Every
  // such name IS an address literal (`L940F` = $940F) — synthesize the equate
  // and retry. A couple of repair rounds resolves the whole dangling set.
  let src = out.join("\n") + "\n";
  const definedNames = new Set([...equateSet.keys(), ...labelDefs]);
  const extraEquates = [];
  let ca = null, bytes = null;
  for (let repair = 0; repair < 6; repair++) {
    ca = await runCa65({ source: src, target: "none" }).catch(() => null);
    if (ca && ca.object) {
      const ld = await runLd65({ objects: { "o.o": ca.object }, target: "none", linkerConfig: cfg }).catch(() => null);
      bytes = ld && ld.binary ? new Uint8Array(ld.binary) : null;
      break;
    }
    // Collect undefined `Lxxxx` symbols from the ca65 log and equate them.
    // Strip ANSI colour codes first — ca65 wraps the symbol name in them
    // (`Symbol ‘\x1b[92mL940F\x1b[97m’ is undefined`), which would otherwise
    // split the quote from the name and defeat the match.
    const plainLog = (ca?.log || "").replace(/\x1b\[[0-9;]*m/g, "");
    let added = false;
    for (const m of plainLog.matchAll(/Symbol\s+['‘’]?(L([0-9A-Fa-f]+))['‘’]?\s+is undefined/g)) {
      const name = m[1];
      if (definedNames.has(name)) continue;
      definedNames.add(name);
      extraEquates.push(`${name} := $${parseInt(m[2], 16).toString(16).toUpperCase()}`);
      added = true;
    }
    if (!added) break;
    // Re-emit with the repair equates prepended (after .setcpu).
    const lines2 = out.slice();
    lines2.splice(1, 0, ...extraEquates);
    src = lines2.join("\n") + "\n";
  }
  const ok = !!bytes && bytes.length === original.length && firstDiff(original, bytes) < 0;
  if (ok) {
    return { family: "65816", source: src, bytes, ok: true, total, dcLines: total - readable,
      readablePercent: total ? Math.round(100 * readable / total) : 100 };
  }
  // Stitched whole-region assembly failed (a cross-span label/width edge) — fall
  // back to the proven whole-region native heal so we still ship byte-exact.
  const r = await runDa65({ bytes: original, startAddress, cpu: "65816", options: ["--comments", "4"], codeSpans: spans });
  return reassembleCc65Native(r.asm, startAddress, original, "65816");
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
  // da65's `--comments 4` line shape is:
  //   `  <insn>   ; <ADDR> <BB BB ..>   <ascii-gutter>`
  // i.e. the raw bytes are followed by a right-aligned ASCII rendering of those
  // bytes (`x`, `.`, `B.`). The byte group is therefore NOT at end-of-line — it's
  // followed by padding + the gutter. Anchoring the byte capture to `$` (as an
  // earlier version did) matches ZERO code lines, so every instruction reads as
  // non-code → codeLineCount 0 → the heal loop can't tell code from data and the
  // whole region floors to `.byte` at 0% readable. THIS is the readability-floor
  // bug. Capture `; ADDR BB BB ...` and stop at 2+ spaces (the gutter gap) or EOL.
  const lines = disasm.split(/\r?\n/);
  const meta = lines.map((line) => { const p = parseDa65Code(line); return p ? { code: true, ...p } : { code: false }; });
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
    if (!ca || !ca.object) return { bytes: null, log: ca?.log || "" };
    const ld = await runLd65({ objects: { "o.o": ca.object }, target: "none", linkerConfig: cfg }).catch(() => null);
    return { bytes: ld && ld.binary ? new Uint8Array(ld.binary) : null, log: "" };
  };

  // build() injects one `.org` line after `.setcpu`, so a ca65 error at source
  // line N maps to disasm line N-1 IF it's past the injection, else N. We map by
  // matching the reported line's text back to a meta code line instead — robust
  // to any line-shifting. Pre-index code lines by their trimmed da65 text.
  const codeByText = new Map();
  lines.forEach((line, i) => { if (meta[i].code) { const t = line.trim(); if (!codeByText.has(t)) codeByText.set(t, i); } });

  let source = build();
  const codeLineCount = meta.filter((m) => m.code).length;
  for (let pass = 0; pass < 80; pass++) {
    source = build();
    const srcLines = source.split("\n");
    const { bytes: out, log } = await assemble(source);
    if (out && out.length === original.length && firstDiff(original, out) < 0) {
      return { family, source, bytes: out, ok: true, total: codeLineCount, dcLines: forced.size,
        readablePercent: codeLineCount ? Math.round(100 * (1 - forced.size / codeLineCount)) : 100 };
    }
    if (!out) {
      // ca65/ld failed. Pin EVERY code line ca65 flagged this pass (da65 emits a
      // handful of instructions ca65 won't re-accept — bare `wdm`, some implied/
      // stack forms — and data mis-decoded inside a rizin span). Pinning one at a
      // time would blow the 80-pass budget and floor a mostly-good region; pin
      // them all at once so the loop converges in a few passes.
      let pinnedAny = false;
      for (const m of log.matchAll(/^[^\n]*?:(\d+):\s*(?:\x1b\[[0-9;]*m)*\s*Error/gm)) {
        const srcLine = (srcLines[parseInt(m[1], 10) - 1] || "").trim();
        const idx = codeByText.get(srcLine);
        if (idx != null && !forced.has(idx)) { forced.add(idx); pinnedAny = true; }
      }
      if (pinnedAny) continue;
      // Couldn't map any error line to a code line — fall back to pinning the
      // first not-yet-pinned code line so the loop still makes progress.
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
    const { bytes: out } = await assemble(flat);
    const ok = !!out && out.length === original.length && firstDiff(original, out) < 0;
    return { family, source: flat, bytes: out ?? null, ok, total: codeLineCount, dcLines: codeLineCount,
      readablePercent: 0,
      note: ok ? "incremental heal did not converge; emitted byte-exact data-only (low readability)" : "could not reach byte-exact even as data" };
  }
}

// ── ASSEMBLE-ONLY path (the byte-exact ROUND-TRIP rebuild) ───────────────────
//
// reassembleForPlatform above DISASSEMBLES bytes and heals them back. But
// build({output:'reassemble'}) rebuilds from region .asm files that
// disasm({target:'project'}) already emitted (and that an agent may have
// EDITED). Those files are the platform's native dialect already — ca65 for
// 6502/65816, GNU-as for m68k/arm/z80/sm83 — so we just ASSEMBLE them; no
// disassemble, no heal loop. `assembleRegionText` is that half: source text +
// its origin/length → the produced bytes (or null + log on error). It reuses
// the SAME per-family as/ld/objcopy/ca65/ld65 calls the heal path uses, so a
// region that round-trips in disasm reassembles identically here.

/**
 * Assemble one region's .asm source (possibly hand-edited) back to raw bytes,
 * using the platform's native assembler chain. No disassembly, no heal loop —
 * the source is already the right dialect.
 * @param {Object} a
 * @param {string} a.platform
 * @param {string} a.asmText     the region .asm contents (comments ok; leading `; ...` header ignored by the assembler)
 * @param {number} a.startAddress CPU/origin address of the first byte
 * @param {number} a.byteLength   expected produced length (the region's original size)
 * @returns {Promise<{ ok:boolean, bytes:Uint8Array|null, family:string, log?:string }>}
 */
export async function assembleRegionText(a) {
  const { platform, asmText, startAddress, byteLength } = a;
  const family = CPU_FAMILY[platform];
  if (!family) throw new Error(`assembleRegionText: no reassembly path for platform '${platform}'`);

  if (family === "6502" || family === "65816") {
    const { runCa65, runLd65 } = await import("../cc65/cc65.js");
    const cpuTag = family === "65816" ? "65816" : "6502";
    const cfg = `MEMORY{M:start $${startAddress.toString(16)},size $${byteLength.toString(16)},type ro,file %O,fill yes,fillval $FF;}\nSEGMENTS{CODE:load M,type ro;}\n`;
    // The emitted .asm carries `.setcpu`/`.org` from the heal path; if a hand-
    // edited file dropped them, ca65 still needs the CPU + origin, so ensure both.
    let src = asmText;
    if (!/^\s*\.setcpu\b/m.test(src)) src = `\t.setcpu "${cpuTag}"\n` + src;
    if (!/^\s*\.org\b/m.test(src)) src = src.replace(/(\.setcpu\s+"[^"]+")/, `$1\n\t.org $${startAddress.toString(16).toUpperCase()}`);
    const ca = await runCa65({ source: src, target: "none" }).catch((e) => ({ object: null, log: String(e) }));
    if (!ca || !ca.object) return { ok: false, bytes: null, family, log: ca?.log || "ca65 failed" };
    const ld = await runLd65({ objects: { "o.o": ca.object }, target: "none", linkerConfig: cfg }).catch((e) => ({ binary: null, log: String(e) }));
    if (!ld || !ld.binary) return { ok: false, bytes: null, family, log: ld?.log || "ld65 failed" };
    return { ok: true, bytes: new Uint8Array(ld.binary), family };
  }

  // GNU families (m68k/arm/z80/sm83): as → (ld) → objcopy. Mirror the toolset
  // selection + the SUBALIGN(1)/`.org`/no-link rules from reassembleGnuNative.
  let tools;
  if (family === "m68k") {
    const m = await import("../m68k-elf-gcc/gcc.js");
    tools = { runAs: m.runM68kAs, runLd: m.runM68kLd, runObjcopy: m.runM68kObjcopy, fmtLines: `OUTPUT_FORMAT("elf32-m68k")\nOUTPUT_ARCH(m68k)\n` };
  } else if (family === "arm") {
    const m = await import("../arm-none-eabi-gcc/gcc.js");
    tools = { runAs: m.runArmAs, runLd: m.runArmLd, runObjcopy: m.runArmObjcopy, fmtLines: "" };
  } else if (family === "z80" || family === "sm83") {
    const z = await import("../z80/binutils.js");
    tools = { runAs: z.runZ80As, runObjcopy: z.runZ80Objcopy, march: family === "sm83" ? "gbz80" : "z80", noLink: true };
  } else {
    throw new Error(`assembleRegionText: no reassembly path for family '${family}'`);
  }

  const { runAs, runLd, runObjcopy, fmtLines = "", noLink, march } = tools;
  const ld = `${fmtLines}ENTRY(_start)\nSECTIONS {\n  .text 0x${startAddress.toString(16)} : SUBALIGN(1) {\n    *(.text*) *(.rodata*) *(.data*)\n  }\n  /DISCARD/ : { *(.ARM.attributes) *(.comment) *(.note*) }\n}\n`;

  // GNU `as` for these CPUs does NOT treat `;` as a comment — `;` is a statement
  // separator. The emitted .asm uses `;` two ways: a LEADING `; …` metadata header
  // block, and a TRAILING `; ADDR` address comment on each `.byte`/instruction
  // line (from dataRegionSource + normalizeObjdump). Strip BOTH: drop the leading
  // comment-only lines, then cut any trailing `; …` off every remaining line.
  let gnuSrc;
  {
    const lines = asmText.split(/\r?\n/);
    let i = 0;
    while (i < lines.length && (lines[i].trim() === "" || lines[i].trimStart().startsWith(";"))) i++;
    gnuSrc = lines.slice(i).map((ln) => {
      const c = ln.indexOf(";");
      return (c >= 0 ? ln.slice(0, c) : ln).replace(/\s+$/, "");
    }).join("\n");
  }
  // A DATA region (dataRegionSource) is just `.org` + `.byte` rows with no
  // `.section .text`/`_start:` scaffolding the link script needs. Wrap it so the
  // linked (m68k/arm) path finds `_start` at the origin; the code path already
  // carries its own scaffolding (skip if present). The no-link (z80/gbz80) path
  // keeps its `.org` and never needs `_start`.
  if (!noLink && !/^\s*\.section\s+\.text/m.test(gnuSrc)) {
    gnuSrc = `.section .text\n.global _start\n_start:\n` + gnuSrc.replace(/^\s*\.org\s+\S+\s*$/m, "");
  }
  gnuSrc = gnuSrc + "\n";
  const a2 = await runAs({ source: gnuSrc, march }).catch((e) => ({ object: null, log: String(e) }));
  if (!a2 || !a2.object) return { ok: false, bytes: null, family, log: a2?.log || "as failed" };
  let elf;
  if (noLink) {
    elf = a2.object;
  } else {
    const l = await runLd({ objects: { "main.o": a2.object }, linkScript: ld }).catch((e) => ({ elf: null, log: String(e) }));
    if (!l || !l.elf) return { ok: false, bytes: null, family, log: l?.log || "ld failed" };
    elf = l.elf;
  }
  const o = await runObjcopy({ elf }).catch((e) => ({ binary: null, log: String(e) }));
  if (!o || !o.binary) return { ok: false, bytes: null, family, log: o?.log || "objcopy failed" };
  let bin = new Uint8Array(o.binary);
  // producedLength = how many REAL bytes the region assembled to (for the no-link
  // path, minus the `.org` leading-zero pad). The caller checks this against the
  // region's expected byteLength so a length-changing edit is REFUSED, not
  // silently truncated by the slice below.
  const produced = noLink ? Math.max(0, bin.length - startAddress) : bin.length;
  if (noLink) {
    bin = bin.slice(startAddress, startAddress + byteLength);
  } else if (bin.length > byteLength) {
    bin = bin.slice(0, byteLength);
  }
  return { ok: true, bytes: bin, family, producedLength: produced };
}
