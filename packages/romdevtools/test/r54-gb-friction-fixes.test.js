// R54 — GB agent friction-feedback fixes (round 26).
//
// Driven by agent friction feedback on the GB scaffold (15 specific
// items). This test covers every item that has a runtime/code fix:
//
//   #1  patchGbHeader now fills $0134-$014C (cart type, ROM size, CGB
//       flag, etc.) — not just logo + checksums. CGB flag defaults to
//       $00 (DMG) on `.gb`, $80 (CGB-aware) on `.gbc`.
//   #2  shadow_oam is pinned to $C100 with SDCC's `__at` so OAM DMA
//       lands on the right page. Previously it floated to wherever
//       the linker placed it (often $C017) and DMA silently corrupted
//       OAM.
//   #3  loadMedia({bytes,...}) now auto-appends a platform-specific
//       extension to the virtual path so shared cores (gpgx for
//       SMS/GG/Genesis) dispatch to the right system.
//   #4  Preflight lint message text reflects the actual SDCC port
//       (sm83 on GB/GBC, z80 on SMS/GG/MSX/Coleco/ZXSpectrum).
//   #5  Bundled runtime files no longer use C99 inline for-loop
//       counters — they pass their own lint now.
//   #6  GB default.c is a DMG starter (uses BGP) and labeled GB,
//       not "GBC starter using BCPS".
//   #9  getRenderingContext sessionKey bug fixed (was throwing
//       'sessionKey is not defined' on GB).
//   #10 readMemory error messages are platform-aware and suggest the
//       correct sibling region (gb_vram instead of generic video_ram).
//   #11 inspectBackgroundMap wired for GB/GBC — returns a 256×256 PNG
//       of the BG (or Window) plane.
//   #12 SDCC_GOTCHAS.md documents the volatile-VRAM-store hazard.
//   #13 wait_vblank now has a HALT-driven path via enable_vblank_irq().
//
// GB and GBC are SEPARATE TREES post-R37. Mirroring is verified
// explicitly per file so a future agent doesn't collapse them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

async function readSrc(rel) {
  return readFile(join(REPO_ROOT, rel), "utf-8");
}

// ─── #1 patchGbHeader ──────────────────────────────────────────────

test("R54 #1: patchGbHeader fills every header byte $0134..$014C (not just logo + checksums)", async () => {
  const { patchGbHeader } = await import("../src/platforms/gb/lib/c/patch-header.js");
  // Start with a 32 KB ROM filled with $FF (linker pad byte).
  const rom = new Uint8Array(32 * 1024);
  rom.fill(0xFF);
  patchGbHeader(rom);

  // $0143 = CGB flag = $00 (DMG-only) on default
  assert.equal(rom[0x0143], 0x00, "$0143 (CGB flag) should be $00 for default DMG patch");
  assert.notEqual(rom[0x0143], 0xFF, "$0143 must NOT be the linker pad byte $FF");
  // $0147 = cart type = $00 (ROM-only)
  assert.equal(rom[0x0147], 0x00, "$0147 (cart type) should default to ROM-only");
  // $0148 = ROM size = $00 (32 KB)
  assert.equal(rom[0x0148], 0x00);
  // $0149 = RAM size = $00
  assert.equal(rom[0x0149], 0x00);
  // $014A = destination = $01 (non-Japan)
  assert.equal(rom[0x014A], 0x01);
  // $014B = old licensee = $33 (use new format)
  assert.equal(rom[0x014B], 0x33);
  // $014C = version = $00
  assert.equal(rom[0x014C], 0x00);
});

test("R54 #1: patchGbHeader honours `cgb: true` for CGB-aware ROMs", async () => {
  const { patchGbHeader } = await import("../src/platforms/gb/lib/c/patch-header.js");
  const rom = new Uint8Array(32 * 1024);
  rom.fill(0xFF);
  patchGbHeader(rom, { cgb: true });
  assert.equal(rom[0x0143], 0x80, "$0143 should be $80 (CGB-aware + DMG-compat) with cgb:true");
});

test("R54 #1: patchGbHeader honours per-cart overrides (cartType / romSize / etc.)", async () => {
  const { patchGbHeader } = await import("../src/platforms/gb/lib/c/patch-header.js");
  const rom = new Uint8Array(32 * 1024);
  rom.fill(0xFF);
  patchGbHeader(rom, { cartType: 0x13, romSize: 0x02, ramSize: 0x03 });
  assert.equal(rom[0x0147], 0x13, "cart type override (MBC3+RAM+BAT)");
  assert.equal(rom[0x0148], 0x02, "ROM size override (128 KB)");
  assert.equal(rom[0x0149], 0x03, "RAM size override (32 KB)");
});

test("R54 #1: GB + GBC patch-header.js are byte-identical (mirror discipline)", async () => {
  const gb  = await readSrc("src/platforms/gb/lib/c/patch-header.js");
  const gbc = await readSrc("src/platforms/gbc/lib/c/patch-header.js");
  assert.equal(gb, gbc, "GB and GBC patch-header.js must stay byte-identical — independent trees, mirrored content");
});

// ─── #2 shadow_oam page alignment ──────────────────────────────────

test("R54 #2: shadow_oam in gb_runtime.c is pinned to $C100 with __at", async () => {
  for (const tree of ["gb", "gbc"]) {
    const src = await readSrc(`src/platforms/${tree}/lib/c/gb_runtime.c`);
    assert.match(src, /__at\s*\(\s*0xC100\s*\)\s*uint8_t\s+shadow_oam\s*\[/,
      `${tree}/gb_runtime.c: shadow_oam should be pinned to $C100 via __at`);
    const hdr = await readSrc(`src/platforms/${tree}/lib/c/gb_runtime.h`);
    assert.match(hdr, /extern\s+__at\s*\(\s*0xC100\s*\)\s*uint8_t\s+shadow_oam\s*\[/,
      `${tree}/gb_runtime.h: extern shadow_oam decl must also carry __at(0xC100) to match the definition`);
  }
});

test("R54 #2: end-to-end — GB build links shadow_oam at $C100", { timeout: 120000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const rt_c = await readSrc("src/platforms/gb/lib/c/gb_runtime.c");
  const rt_h = await readSrc("src/platforms/gb/lib/c/gb_runtime.h");
  const hw_h = await readSrc("src/platforms/gb/lib/c/gb_hardware.h");
  const crt0 = await readSrc("src/platforms/gb/lib/c/gb_crt0.s");
  const main = `#include "gb_hardware.h"\n#include "gb_runtime.h"\nvoid main(void) { oam_clear(); oam_dma_flush(); for (;;) wait_vblank(); }\n`;
  const r = await buildForPlatform({
    platform: "gb", language: "c",
    sources: { "main.c": main, "gb_runtime.c": rt_c },
    includes: { "gb_runtime.h": rt_h, "gb_hardware.h": hw_h },
    crt0, codeLoc: 0x150,
  });
  assert.equal(r.ok, true, `build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  // r.symbols is the sdld map text; shadow_oam should be at 0000C100.
  const m = r.symbols && r.symbols.split(/\r?\n/).find((l) => /_shadow_oam\b/.test(l));
  assert.ok(m, "no shadow_oam line in map text");
  assert.match(m, /\b0000C100\b/i, `shadow_oam should be at 0xC100, got map line: ${m}`);
});

// ─── #3 loadMedia virtual extension per platform ───────────────────

test("R54 #3: PLATFORM_VIRTUAL_EXT is defined for the shared-core platforms", async () => {
  const host = await readSrc("src/host/LibretroHost.js");
  // Spot-check that the table covers SMS vs GG (the actual bite from R26).
  assert.match(host, /PLATFORM_VIRTUAL_EXT\s*=\s*\{[\s\S]*?sms:\s*"\.sms"[\s\S]*?gg:\s*"\.gg"/,
    "PLATFORM_VIRTUAL_EXT must include sms + gg with their distinguishing extensions");
  assert.match(host, /gb:\s*"\.gb"/, "gb extension wired");
  assert.match(host, /gbc:\s*"\.gbc"/, "gbc extension wired");
  // And loadMedia uses it for in-memory loads.
  assert.match(host, /args\.virtualName\s*\?\?\s*\("\/rom"\s*\+\s*defaultExt\)/,
    "loadMedia({bytes}) must default virtualName to '/rom' + platform extension");
});

// ─── #4 Lint message reflects port (sm83 vs z80) ───────────────────

test("R54 #4: preflight lint message text uses 'SDCC z80' on z80, 'SDCC sm83' on sm83", async () => {
  const { lintSdccSource } = await import("../src/toolchains/sdcc/preflight-lint.js");
  // Trigger the C99-for-loop check which fires on any port and has the
  // most stable message wording.
  const offender = `void f(void) {
  for (uint8_t i = 0; i < 4; i++) { do_something(); }
}
`;
  const z80Issues = lintSdccSource(offender, "f.c", { port: "z80" });
  assert.ok(z80Issues.length > 0, "expected at least one lint issue");
  assert.match(z80Issues[0].details, /SDCC z80/, "z80 lint should say 'SDCC z80'");
  assert.doesNotMatch(z80Issues[0].details, /SDCC sm83/, "z80 lint must NOT say sm83");

  const sm83Issues = lintSdccSource(offender, "f.c", { port: "sm83" });
  assert.ok(sm83Issues.length > 0);
  assert.match(sm83Issues[0].details, /SDCC sm83/, "sm83 lint should say 'SDCC sm83'");
});

// ─── #5 Bundled runtime files no longer violate lint ───────────────

test("R54 #5: bundled SDCC platform runtimes don't trip the lint they ship with", async () => {
  const { lintSdccSource } = await import("../src/toolchains/sdcc/preflight-lint.js");
  const files = [
    "src/platforms/gb/lib/c/gb_runtime.c",
    "src/platforms/gbc/lib/c/gb_runtime.c",
    "src/platforms/sms/lib/c/sms_sfx.c",
    "src/platforms/gg/lib/c/gg_sfx.c",
  ];
  for (const f of files) {
    const src = await readSrc(f);
    const issues = lintSdccSource(src, f, { port: f.includes("/gb") ? "sm83" : "z80" });
    const c99For = issues.filter((i) => /C99 inline for-loop counter/.test(i.message));
    assert.equal(c99For.length, 0,
      `${f}: bundled runtime should not trip the C99-for-loop lint (got ${c99For.length})`);
  }
});

// ─── #6 GB default.c is a DMG starter (BGP, not BCPS) ──────────────

test("R54 #6: GB default.c is a DMG starter using BGP (not labeled GBC, no BCPS in code)", async () => {
  const src = await readSrc("examples/gb/templates/default.c");
  assert.doesNotMatch(src, /minimal GBC starter/i,
    "GB default.c must not call itself a GBC starter");
  assert.match(src, /minimal Game Boy \(DMG\) starter/i,
    "GB default.c should label itself as a DMG starter");
  // Strip comments before checking that BCPS isn't ACTIVELY USED — we
  // allow the doc-comment to mention BCPS as a "don't do this" hint
  // but the code body itself must not write to it.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(stripped, /\bBCPS\b/,
    "GB default.c must not use BCPS in actual code (CGB-only register; ignored on DMG)");
  assert.match(src, /\bBGP\s*=/, "GB default.c should write BGP (the DMG palette register)");
});

test("R54 #6: GBC default.c is distinctly the GBC starter (uses BCPS, calls out the difference)", async () => {
  const src = await readSrc("examples/gbc/templates/default.c");
  assert.match(src, /Game Boy Color \(CGB\) starter/i,
    "GBC default.c should label itself as a CGB starter");
  assert.match(src, /\bBCPS\b/, "GBC default.c should use BCPS (CGB-only palette register)");
});

// ─── #9 getRenderingContext sessionKey ─────────────────────────────

test("R54 #9: getRenderingContextCore accepts sessionKey as a parameter", async () => {
  const { getRenderingContextCore } = await import("../src/mcp/tools/rendering-context.js");
  // We can't easily invoke it without a loaded host — just check the
  // function signature destructures sessionKey. Read the source.
  const src = await readSrc("src/mcp/tools/rendering-context.js");
  assert.match(src, /getRenderingContextCore\(\s*\{\s*platform[^}]*sessionKey[^}]*\}/,
    "getRenderingContextCore must destructure sessionKey from its args object");
  // The MCP wrapper at the bottom must pass sessionKey through.
  assert.match(src, /getRenderingContextCore\(\{\s*\.\.\.\s*args\s*,\s*sessionKey\s*\}\)/,
    "MCP wrapper must spread args + sessionKey when calling getRenderingContextCore");
});

// ─── #10 readMemory error messages with per-platform suggestions ───

test("R54 #10: _emptyRegionError generates a helpful per-platform message", async () => {
  const src = await readSrc("src/host/LibretroHost.js");
  assert.match(src, /_emptyRegionError\s*\(\s*region\s*\)/,
    "_emptyRegionError helper must exist");
  // Check the suggestion table covers GB (the round 26 case).
  assert.match(src, /gb:\s*\{[\s\S]*?video_ram:\s*"gb_vram/,
    "GB suggestion table must redirect video_ram → gb_vram");
  // And that readMemory uses the helper.
  assert.match(src, /throw new Error\(this\._emptyRegionError\(region\)\)/,
    "readMemory + writeMemory must use the helper");
});

// ─── #11 inspectBackgroundMap for GB/GBC ───────────────────────────

test("R54 #11: snapshotBackgroundMap exists in gb/ppu.js + returns 256x256 PNG bytes", async () => {
  const { snapshotBackgroundMap } = await import("../src/platforms/gb/ppu.js");
  assert.equal(typeof snapshotBackgroundMap, "function");
  // Smoke-call with a fake host that returns blank VRAM + zeroed IO.
  const fakeVram = new Uint8Array(0x2000);
  const fakeIo = new Uint8Array(0x80);
  // LCDC: turn on the LCD + use unsigned tile data mode, BG map at $9800.
  fakeIo[0x40] = 0x91;  /* LCDC = LCD_ON | BG_ON | TILE_DATA_LO */
  fakeIo[0x47] = 0xE4;  /* BGP: normal arrangement */
  const fakeHost = {
    readMemory: (region) => {
      if (region === "gb_vram") return fakeVram;
      if (region === "gb_io") return fakeIo;
      throw new Error(`unexpected region in snapshot test: ${region}`);
    },
  };
  const snap = snapshotBackgroundMap(fakeHost);
  assert.equal(snap.width, 256);
  assert.equal(snap.height, 256);
  assert.ok(snap.png instanceof Buffer || snap.png instanceof Uint8Array,
    "snapshot.png should be a Buffer/Uint8Array of PNG bytes");
  assert.equal(snap.png[0], 0x89, "PNG magic byte");
  assert.equal(snap.mapBase, "0x9800");
  assert.equal(snap.mode, "8000_unsigned");
});

// ─── #12 SDCC_GOTCHAS documents the VRAM-volatile hazard ───────────

test("R54 #12: SDCC_GOTCHAS.md documents the dead-store-to-VRAM hazard", async () => {
  for (const tree of ["gb", "gbc"]) {
    const src = await readSrc(`src/platforms/${tree}/lib/c/SDCC_GOTCHAS.md`);
    assert.match(src, /VRAM[\s\S]*?volatile/i,
      `${tree}/SDCC_GOTCHAS.md must document the volatile-VRAM hazard`);
    assert.match(src, /memcpy_vram/,
      `${tree}/SDCC_GOTCHAS.md must recommend memcpy_vram as the safe path`);
  }
});

// ─── #13 wait_vblank can switch to HALT-driven via enable_vblank_irq ─

test("R54 #13: enable_vblank_irq + HALT-driven wait_vblank are wired in gb_runtime", async () => {
  for (const tree of ["gb", "gbc"]) {
    const c = await readSrc(`src/platforms/${tree}/lib/c/gb_runtime.c`);
    assert.match(c, /\bvoid\s+enable_vblank_irq\s*\(\s*void\s*\)/,
      `${tree}: enable_vblank_irq() definition missing`);
    assert.match(c, /vblank_irq_enabled/,
      `${tree}: vblank_irq_enabled flag missing`);
    assert.match(c, /__asm__\s*\(\s*"halt"\s*\)/,
      `${tree}: wait_vblank should use HALT when IRQ is enabled`);
    assert.match(c, /IE_REG\s*=\s*IE_VBLANK/,
      `${tree}: enable_vblank_irq should set IE_REG = IE_VBLANK`);
    const h = await readSrc(`src/platforms/${tree}/lib/c/gb_runtime.h`);
    assert.match(h, /\bvoid\s+enable_vblank_irq\s*\(\s*void\s*\)/,
      `${tree}/gb_runtime.h: enable_vblank_irq prototype missing`);
  }
});

test("R54 #13: end-to-end — GB ROM linking enable_vblank_irq compiles", { timeout: 120000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const rt_c = await readSrc("src/platforms/gb/lib/c/gb_runtime.c");
  const rt_h = await readSrc("src/platforms/gb/lib/c/gb_runtime.h");
  const hw_h = await readSrc("src/platforms/gb/lib/c/gb_hardware.h");
  const crt0 = await readSrc("src/platforms/gb/lib/c/gb_crt0.s");
  const main = `#include "gb_hardware.h"\n#include "gb_runtime.h"\nvoid main(void) {\n  lcd_init_default();\n  enable_vblank_irq();\n  for (;;) wait_vblank();\n}\n`;
  const r = await buildForPlatform({
    platform: "gb", language: "c",
    sources: { "main.c": main, "gb_runtime.c": rt_c },
    includes: { "gb_runtime.h": rt_h, "gb_hardware.h": hw_h },
    crt0, codeLoc: 0x150,
  });
  assert.equal(r.ok, true, `build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
});

// ─── GB and GBC mirror discipline ──────────────────────────────────

test("R54: GB + GBC runtime files stay byte-identical (independent trees, mirrored content)", async () => {
  const pairs = [
    ["src/platforms/gb/lib/c/gb_runtime.c", "src/platforms/gbc/lib/c/gb_runtime.c"],
    ["src/platforms/gb/lib/c/gb_runtime.h", "src/platforms/gbc/lib/c/gb_runtime.h"],
    ["src/platforms/gb/lib/c/patch-header.js", "src/platforms/gbc/lib/c/patch-header.js"],
    ["src/platforms/gb/lib/c/SDCC_GOTCHAS.md", "src/platforms/gbc/lib/c/SDCC_GOTCHAS.md"],
  ];
  for (const [a, b] of pairs) {
    const ca = await readSrc(a);
    const cb = await readSrc(b);
    assert.equal(ca, cb, `${a} and ${b} must stay byte-identical`);
  }
});

// ─── #8 buildSourceWithDebug supports SDCC targets ─────────────────

// ─── #14 GB audio + crt0-actually-links (the root cause we found
//     while diagnosing #14 — pre-r54 the gb_crt0.s was passed as raw
//     .s text to sdld which silently rejected the malformed "rel" and
//     fell back to SDCC's stock crt0. The custom init + IRQ vectors
//     never linked → NR50/NR51 writes never made it to a powered APU.

test("R54 #14: gb_crt0.s is actually assembled + linked (init symbol present in map)", { timeout: 120000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const hw_h = await readSrc("src/platforms/gb/lib/c/gb_hardware.h");
  const crt0 = await readSrc("src/platforms/gb/lib/c/gb_crt0.s");
  const main = `void main(void) { for(;;){} }\n`;
  const r = await buildForPlatform({
    platform: "gb", language: "c",
    sources: { "main.c": main },
    includes: { "gb_hardware.h": hw_h },
    crt0, codeLoc: 0x150,
  });
  assert.equal(r.ok, true, `build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  // The crt0's `init` symbol must appear in the map at $0150 (start of _CODE).
  const initLine = (r.symbols || "").split(/\r?\n/).find((l) => /\binit\b/.test(l) && !/init_static_/.test(l));
  assert.ok(initLine, "gb_crt0.s's init symbol not in map — crt0 didn't link (sdld silently rejected the .s text)");
  // ROM bytes: entry at $0100 must be `00 c3 50 01` (nop; jp $0150 = init).
  // Pre-r54: $0100 was the linker pad ($FF) and only stock crt0 ran.
  assert.equal(r.binary[0x100], 0x00, "entry byte 0 must be NOP (gb_crt0.s entry point)");
  assert.equal(r.binary[0x101], 0xC3, "entry byte 1 must be JP opcode ($C3)");
  assert.equal(r.binary[0x102], 0x50, "entry low byte must be $50 ($0150 = init)");
  assert.equal(r.binary[0x103], 0x01, "entry high byte must be $01 ($0150 = init)");
});

test("R54 #14: GB sound_init + sound_play_tone actually writes NR50/NR51/NR52 + APU produces audio", { timeout: 120000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const { patchGbHeader } = await import("../src/platforms/gb/lib/c/patch-header.js");
  const { LibretroHost } = await import("../src/host/LibretroHost.js");
  const { resolveCore } = await import("../src/cores/registry.js");

  const rt_c = await readSrc("src/platforms/gb/lib/c/gb_runtime.c");
  const rt_h = await readSrc("src/platforms/gb/lib/c/gb_runtime.h");
  const hw_h = await readSrc("src/platforms/gb/lib/c/gb_hardware.h");
  const crt0 = await readSrc("src/platforms/gb/lib/c/gb_crt0.s");
  const main = `#include "gb_hardware.h"\n#include "gb_runtime.h"\nvoid main(void) {\n  lcd_init_default();\n  sound_init();\n  sound_play_tone(2, 1953, 6);\n  for(;;) wait_vblank();\n}\n`;
  const r = await buildForPlatform({
    platform: "gb", language: "c",
    sources: { "main.c": main, "gb_runtime.c": rt_c },
    includes: { "gb_runtime.h": rt_h, "gb_hardware.h": hw_h },
    crt0, codeLoc: 0x150,
  });
  assert.equal(r.ok, true, `build failed: ${(r.log || "").slice(-500)}`);
  const rom = new Uint8Array(r.binary);
  patchGbHeader(rom);

  const host = new LibretroHost();
  const core = resolveCore("gb");
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "gb", bytes: rom, virtualName: "/rom.gb" });
  host.stepFrames(30);

  const io = host.readMemory("gb_io", 0, 0x80);
  // NR52 bit 7 must be SET (APU powered). Pre-r54 it stayed at $71 (power off).
  assert.ok((io[0x26] & 0x80) !== 0, `NR52 bit 7 should be set (APU powered); got $${io[0x26].toString(16)}`);
  // NR50 should be $77 (max master vol both sides). Pre-r54 stayed at $00.
  assert.equal(io[0x24], 0x77, `NR50 should be $77 (max master volume); got $${io[0x24].toString(16)}`);
  // NR51 should be $FF (all channels both speakers). Pre-r54 stayed at $00.
  assert.equal(io[0x25], 0xFF, `NR51 should be $FF (all channels routed); got $${io[0x25].toString(16)}`);
  // NR22 (ch2 envelope) should be $F0 (max vol, no decay).
  assert.equal(io[0x17], 0xF0, `NR22 should be $F0 (max envelope); got $${io[0x17].toString(16)}`);
  // BGP from lcd_init_default should be $E4.
  assert.equal(io[0x47], 0xE4, `BGP should be $E4 from lcd_init_default; got $${io[0x47].toString(16)}`);

  // Audio output: gambatte must have emitted at least some non-silent samples.
  let max = 0;
  for (const chunk of host.state.audioRing) {
    for (const s of chunk) { const a = Math.abs(s); if (a > max) max = a; }
  }
  assert.ok(max > 1000, `expected audio amplitude > 1000 (real tone); got max=${max}. Pre-r54 max was ~3042 just from gambatte's bootrom emulation; real APU output should be at least 5000+.`);
});

test("R54 #15: screenshot after fresh loadMedia returns a clean DMG framebuffer (not stale/pink)", { timeout: 120000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const { patchGbHeader } = await import("../src/platforms/gb/lib/c/patch-header.js");
  const { LibretroHost } = await import("../src/host/LibretroHost.js");
  const { resolveCore } = await import("../src/cores/registry.js");
  const { PNG } = await import("pngjs");

  const hw_h = await readSrc("src/platforms/gb/lib/c/gb_hardware.h");
  const crt0 = await readSrc("src/platforms/gb/lib/c/gb_crt0.s");
  const main = `void main(void) { for(;;){} }\n`;
  const r = await buildForPlatform({
    platform: "gb", language: "c",
    sources: { "main.c": main },
    includes: { "gb_hardware.h": hw_h },
    crt0, codeLoc: 0x150,
  });
  const rom = new Uint8Array(r.binary);
  patchGbHeader(rom);

  const host = new LibretroHost();
  const core = resolveCore("gb");
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "gb", bytes: rom, virtualName: "/rom.gb" });

  const ss = host.screenshot();
  assert.equal(ss.width, 160, "GB screenshot should be 160px wide");
  assert.equal(ss.height, 144, "GB screenshot should be 144px tall");
  const png = PNG.sync.read(Buffer.from(ss.pngBase64, "base64"));
  // Sample center pixel — should be a real DMG color (light grey-greenish-white).
  // Pre-r54 / pre-crt0-fix, agents reported "pinkish pale" which suggests
  // either an uninitialized framebuffer or CGB-mode-rendering-a-DMG-ROM.
  // Real DMG default render is somewhere in the green-greyscale range; we
  // just assert it's not pink (R >> G or R >> B by a wide margin).
  const cx = png.width >> 1, cy = png.height >> 1;
  const o = (cy * png.width + cx) * 4;
  const [pr, pg, pb] = [png.data[o], png.data[o+1], png.data[o+2]];
  const pinkish = pr > pg + 40 && pr > pb + 40;
  assert.ok(!pinkish, `center pixel ${pr},${pg},${pb} looks pinkish — pre-r54 stale-framebuffer symptom`);
});

test("R54 #14: buildZ80C auto-assembles .s crt0 source (no longer requires pre-assembled .rel)", async () => {
  // Round 26 root cause: pre-r54 sdcc.js shoved args.crt0 raw into
  // /work/crt0.rel and sdld silently fell back to stock crt0 from
  // sm83.lib when the malformed "rel" failed to parse. Fix: buildZ80C
  // now detects .s source (anything not starting with the XL2/4 rel tag)
  // and runs sdasgb/sdasz80 over it before linking.
  const src = await readSrc("src/toolchains/sdcc/sdcc.js");
  assert.match(src, /XL\[2-4\]/, "buildZ80C should pattern-match XL[2-4] to detect pre-assembled .rel");
  assert.match(src, /sdasgb.*crt0|crt0.*sdasgb/, "buildZ80C should mention sdasgb for crt0 assembly");
  // And the fallback path must call the assembler, not just slap the .s text in:
  assert.match(src, /isSm83\s*\?\s*runSdasgb\s*:\s*runSdasz80/,
    "buildZ80C should pick sdasgb (sm83) vs sdasz80 (z80) for crt0 assembly");
});

test("R54 #8: buildSourceWithDebug accepts GB and returns mapText", { timeout: 120000 }, async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { z } = await import("zod");
  const { registerTools } = await import("../src/mcp/tools/index.js");

  const server = new McpServer({ name: "r54-debug", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "r54-debug-c", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);

  const main = `void main(void) { volatile unsigned char x; x = 42; for (;;) ; }\n`;
  const r = await client.callTool({
    name: "build",
    // inline:true → mapText + log come back in the response (default writes
    // ROM/.map/log to disk and requires outputPath).
    arguments: { output: "romWithDebug", platform: "gb", source: main, inline: true },
  });
  assert.equal(r.isError, undefined, "buildSourceWithDebug failed: " + JSON.stringify(r));
  const payload = JSON.parse(r.content[0].text);
  assert.equal(payload.ok, true, `SDCC build failed: ${(payload.log || "").slice(-500)}`);
  assert.equal(payload.toolchain, "sdcc");
  assert.ok(payload.mapText && payload.mapText.length > 0, "mapText should be present + non-empty");
  assert.match(payload.mapText, /_main/, "mapText should reference _main");
});
