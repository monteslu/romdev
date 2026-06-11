// SMS/GG project-dir builds MUST link the bundled (or in-dir) crt0 — the
// RetroDECK "every SMS/GG scaffold is a black screen" bug.
//
// build({output:'project'}) used to SKIP the dir's *_crt0.s on the belief that
// "buildForPlatform auto-injects the bundled crt0". It does not (only the
// output:'rom'/'run' MCP handlers auto-inject), so every project-path SMS/GG
// build linked SDCC's STOCK z80 crt0 — whose boot sequence is
// `ld a,#2 / rst $08 / halt` — and main() never ran: black screen at boot on
// every emulator/hardware, while output:'run' verifications stayed green via
// the other code path. The fix routes an in-dir *_crt0.s through the crt0
// channel and falls back to the bundled crt0 when the dir has none.
//
// The assertion is on the ROM's first byte: our crt0 boots with `di` (0xF3);
// the stock crt0's first byte is `ld a,#2` (0x3E). Also pins the TMR SEGA
// header + the platform-correct region nibble ($4C SMS export / $7C GG
// international — an SMS region on a .gg flips gpgx into SMS-compat mode).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildProjectCore } from "../src/mcp/tools/toolchain.js";

function parse(res) { return JSON.parse(res.content.find((c) => c.type === "text").text); }

// Minimal C program — no runtime helpers needed; we only assert BOOT bytes.
const MAIN_C = `void main(void){ volatile unsigned char x = 1; while(1){ x++; } }\n`;

async function buildBareProject(platform) {
  const dir = await mkdtemp(path.join(tmpdir(), `romdev-${platform}-crt0-`));
  const out = path.join(dir, `out.${platform}`);
  try {
    await writeFile(path.join(dir, "main.c"), MAIN_C);
    const r = parse(await buildProjectCore({ path: dir, platform, outputPath: out }));
    assert.equal(r.ok, true, `${platform} project build failed:\n` + (r.logTail || r.log || "").slice(-400));
    return new Uint8Array(await readFile(out));
  } finally {
    // keep nothing; rom bytes already read
    await rm(dir, { recursive: true, force: true });
  }
}

function assertBootsOurCrt0(rom, platform, expectedRegion) {
  assert.equal(rom[0], 0xF3,
    `${platform}: ROM byte 0 should be DI (0xF3) from the bundled crt0 — ` +
    `got 0x${rom[0].toString(16)} (0x3E = SDCC stock crt0 = never calls main, black screen)`);
  assert.equal(rom.length >= 0x8000, true, `${platform}: ROM must be padded to >=32KB for the header`);
  const magic = String.fromCharCode(...rom.slice(0x7FF0, 0x7FF8));
  assert.equal(magic, "TMR SEGA", `${platform}: TMR SEGA header missing at $7FF0`);
  assert.equal(rom[0x7FFF], expectedRegion,
    `${platform}: region/size byte should be $${expectedRegion.toString(16).toUpperCase()} — ` +
    `got $${rom[0x7FFF].toString(16).toUpperCase()}`);
}

test("SMS project-dir build links the bundled crt0 (di boot) + SMS-region header", { timeout: 120000 }, async () => {
  const rom = await buildBareProject("sms");
  assertBootsOurCrt0(rom, "sms", 0x4C);
});

test("GG project-dir build links the bundled crt0 (di boot) + GG-region header", { timeout: 120000 }, async () => {
  const rom = await buildBareProject("gg");
  assertBootsOurCrt0(rom, "gg", 0x7C);
});
