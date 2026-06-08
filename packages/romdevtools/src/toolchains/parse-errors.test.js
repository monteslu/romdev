import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBuildLog } from "./parse-errors.js";

test("cc65/ca65/ld65 errors are parsed with file/line", () => {
  const log = `
--- ca65 ---
/work/main.s:12: Error: Cannot open include file 'longbranch.mac'
/work/main.c:3:9: Warning: Symbol 'x' is unused
`;
  const issues = parseBuildLog(log);
  assert.ok(issues.length >= 2);
  const err = issues.find((i) => i.severity === "error");
  assert.ok(err);
  assert.equal(err.file, "/work/main.s");
  assert.equal(err.line, 12);
  assert.equal(err.stage, "ca65");
  const warn = issues.find((i) => i.severity === "warning");
  assert.ok(warn);
  assert.equal(warn.col, 9);
});

test("dasm errors parse cleanly", () => {
  const log = `
main.asm (1): error: Unknown Mnemonic 'is'.
`;
  const issues = parseBuildLog(log);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "error");
  assert.equal(issues[0].line, 1);
  assert.equal(issues[0].stage, "dasm");
});

test("asar bare error without file/line still captured", () => {
  const log = `
error: The ROM title appears to be garbage.
`;
  const issues = parseBuildLog(log);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "error");
  assert.match(issues[0].message, /garbage/);
});

test("wlalink unresolved-label error is extracted from the symbol-table flood", () => {
  // Real wlalink output: a huge `stack_item:`/`id:` dump, then the real error.
  const log = `
--- wlalink ---
stack_item: label (+)          : pad_keysdown
stack_item: value (+)          : 4.000000/$4 (RAM) 4.000000/$4 (ROM)
id: 502 file: /work/libc.obj line: 198 type: 1 bank: 0 position: 1 section_status: 1
----------------------------------------------------------------------
/work/main.obj: /work/main.asm:18: FIX_REFERENCES: Reference to an unknown label "this_symbol_does_not_exist".
`;
  const issues = parseBuildLog(log);
  // Exactly ONE issue — the flood lines must NOT become issues.
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "error");
  assert.equal(issues[0].file, "/work/main.asm");
  assert.equal(issues[0].line, 18);
  assert.equal(issues[0].stage, "wlalink");
  assert.match(issues[0].message, /unknown label "this_symbol_does_not_exist"/);
  // SNES parity: the undefined-label failure carries the same actionable hint
  // ld65/sdld/GNU ld give, and names the offending label.
  assert.ok(issues[0].hint, "wlalink undefined-label has a hint");
  assert.match(issues[0].hint, /never defined or linked/);
  assert.match(issues[0].hint, /this_symbol_does_not_exist/);
});

test("wla-65816 assembler error parses with file/line", () => {
  const log = `
--- wla-65816 (main.c → .obj) ---
/work/main.asm:12: ERROR: Unknown instruction "lda#".
`;
  const issues = parseBuildLog(log);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "error");
  assert.equal(issues[0].line, 12);
  assert.match(issues[0].message, /Unknown instruction/);
});

test("Genesis: rom_header multiple-definition gets an actionable hint", () => {
  // Real m68k-elf-ld output when the agent compiles SGDK's rom_header.c
  // alongside the auto-assembled sega.s.
  const log = `
--- ld ---
/work/build/rom_header.o:(.text+0x0): multiple definition of \`rom_header'
/work/build/sega.o:(.text.keepboot+0x100): first defined here
m68k-elf-ld: link failed
`;
  const issues = parseBuildLog(log);
  const dup = issues.find((i) => /multiple definition of `rom_header'/.test(i.message));
  assert.ok(dup, "should capture the duplicate-definition error");
  assert.equal(dup.severity, "error");
  assert.equal(dup.stage, "ld");
  assert.match(dup.hint, /remove rom_header\.c from your build/i);
  assert.match(dup.hint, /sega\.s/);
});

test("GNU ld: generic multiple-definition + undefined-reference parse with hints", () => {
  const log = `
--- ld ---
/work/a.o:(.text+0x4): multiple definition of \`g_state'
/work/b.o:(.text+0x4): first defined here
/work/main.o: in function \`main': undefined reference to \`VDP_init'
`;
  const issues = parseBuildLog(log);
  const dup = issues.find((i) => /multiple definition of `g_state'/.test(i.message));
  assert.ok(dup);
  assert.match(dup.hint, /more than one object file/);
  const undef = issues.find((i) => /undefined reference to `VDP_init'/.test(i.message));
  assert.ok(undef);
  assert.equal(undef.severity, "error");
  assert.match(undef.hint, /never defined or linked/);
});

test("Genesis: m68k gcc compiler diagnostic parses with file/line", () => {
  const log = `
--- gcc ---
/work/main.c:42:8: error: 'SPR_update' undeclared (first use in this function)
`;
  const issues = parseBuildLog(log);
  const e = issues.find((i) => i.severity === "error");
  assert.ok(e);
  assert.equal(e.file, "/work/main.c");
  assert.equal(e.line, 42);
  assert.equal(e.col, 8);
  assert.match(e.message, /SPR_update/);
});

test("ld65: linker segment-missing / memory-overflow reach issues[] (not just log)", () => {
  // v0.16.0 feedback (Jay): build({output:'project'}) on a CHR-ROM disassembly
  // applied the stock chr-RAM nes.cfg → ld65 emitted these, but issues[] was
  // EMPTY because they carry no file:line. They must now be captured + hinted.
  const log = `
--- ld65 ---
ld65: Warning: Segment 'HEADER' does not exist
ld65: Warning: Segment 'CHARS' does not exist
ld65: Error: Memory area overflow in 'ROM0', segment 'CODE' (6 bytes)
ld65: Error: Cannot generate most of the files due to memory area overflow
`;
  const issues = parseBuildLog(log);
  const err = issues.find((i) => /memory area overflow/i.test(i.message));
  assert.ok(err, "memory-overflow error must reach issues[]");
  assert.equal(err.severity, "error");
  assert.equal(err.stage, "ld65");
  assert.match(err.hint, /inesHeader|chr-rom/, "hint points at the NROM-rebuild path");
  const seg = issues.find((i) => /Segment 'HEADER' does not exist/.test(i.message));
  assert.ok(seg, "segment-missing warning must reach issues[]");
  assert.equal(seg.severity, "warning");
});

test("ld65: a normal file:line error is NOT double-counted by the linker pass", () => {
  const log = `
--- ld65 ---
/work/main.s:12: Error: Cannot open include file 'longbranch.mac'
`;
  const issues = parseBuildLog(log);
  const hits = issues.filter((i) => /Cannot open include file/.test(i.message));
  assert.equal(hits.length, 1, "file:line error counted exactly once");
  assert.equal(hits[0].file, "/work/main.s");
  assert.equal(hits[0].line, 12);
});

test("sdld undefined-global gets an actionable hint (SDCC platforms parity)", () => {
  // GB/GBC/SMS/GG/MSX: the #1 link failure is a missing source/runtime. It should
  // get the same 'add the file that defines it' hint GNU ld already gives.
  const log = `
--- sdld ---
?ASlink-Warning-Undefined Global '_sound_init' referenced by module '_main'
`;
  const issues = parseBuildLog(log);
  const undef = issues.find((i) => /Undefined Global/.test(i.message));
  assert.ok(undef, "undefined-global reaches issues[]");
  assert.equal(undef.severity, "error", "promoted to error (ROM won't run)");
  assert.ok(undef.hint, "has an actionable hint");
  assert.match(undef.hint, /never defined or linked/);
  assert.match(undef.hint, /sound_init/, "names the C symbol (underscore stripped)");
});

test("all FOUR linkers (ld65 / sdld / GNU ld / wlalink) carry a hint on an undefined symbol", () => {
  // One per linker = full 14-platform coverage:
  //   ld65 → NES/C64/Lynx/A2600/A7800/PCE ; sdld → GB/GBC/SMS/GG/MSX ;
  //   GNU ld → Genesis/GBA ; wlalink → SNES.
  const ld65 = parseBuildLog("--- ld65 ---\nld65: Error: Unresolved external `foo'")
    .find((i) => /Unresolved external/.test(i.message));
  assert.ok(ld65?.hint, "ld65 unresolved-external has a hint");
  const sdld = parseBuildLog("--- sdld ---\n?ASlink-Error-Undefined Global '_foo' referenced by module '_main'")
    .find((i) => /Undefined Global/.test(i.message));
  assert.ok(sdld?.hint, "sdld undefined-global has a hint");
  const gnu = parseBuildLog("--- ld ---\nmain.o: undefined reference to `foo'")
    .find((i) => /undefined reference/.test(i.message));
  assert.ok(gnu?.hint, "GNU ld undefined-reference has a hint");
  const wla = parseBuildLog("--- wlalink ---\n/work/main.obj: /work/main.asm:9: FIX_REFERENCES: Reference to an unknown label \"foo\".")
    .find((i) => /unknown label/.test(i.message));
  assert.ok(wla?.hint, "wlalink (SNES) unknown-label has a hint");
});
