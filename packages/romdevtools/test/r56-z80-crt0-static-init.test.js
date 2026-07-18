// R56 — z80 (SMS/GG) crt0 did not initialise C statics.
//
// Found 2026-06-08 while investigating two reported "SDCC sm83 miscompiles"
// from a GBC Columns build session (a degenerate 32-bit xorshift PRNG and a
// looped grid-collision read). NEITHER reproduced as an sm83 codegen bug —
// the GBC results were byte-for-byte correct. But the same xorshift repro on
// the SMS/GG z80 port booted its `static uint32_t rng = 0x1357;` as 0, so the
// PRNG never advanced and every "roll" came out identical ("monochrome RNG").
//
// Root cause: the bundled sms_crt0.s / gg_crt0.s declared `_INITIALIZER` (the
// ROM image of value-initialised statics) AFTER the `_DATA` RAM block in the
// area list, so sdld placed _INITIALIZER in RAM instead of ROM. The gsinit
// `ldir` then copied uninitialised RAM onto itself → every initialised static
// booted as 0. The crt0 also had NO BSS-zero loop, so uninitialised statics
// booted with power-on WRAM garbage. The sm83 GB crt0 (fixed in R55/R27) does
// both correctly; the z80 crt0s never did.
//
// Fix: move `.area _INITIALIZER` into the ROM group (before `_DATA`) and add a
// `_DATA` BSS-zero loop in gsinit, mirroring gb_crt0.s.
//
// This test builds a tiny C program whose statics MUST boot to known values,
// runs it on the real gpgx SMS core, and reads them back from WRAM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const readSrc = (rel) => readFile(join(REPO_ROOT, rel), "utf-8");

// Statics with known initialisers + one BSS static. main() copies their RAW
// BOOT VALUES to $D000.. before touching them, so we read exactly what gsinit
// produced. $D000 is clear of the C runtime's _DATA/_BSS at $C000.
const STATIC_INIT_SRC = `
typedef unsigned char  uint8_t;
typedef unsigned short uint16_t;
typedef unsigned long  uint32_t;
static uint32_t gv32 = 0x1357UL;   /* low->high: 0x57,0x13,0x00,0x00 */
static uint16_t gv16 = 0xBEEF;     /* 0xEF,0xBE */
static uint8_t  gv8  = 0x42;       /* 0x42 */
static uint8_t  bss8;              /* must be 0 (BSS zeroed) */
void main(void) {
    volatile uint8_t *w = (volatile uint8_t *)0xD000;
    w[0] = (uint8_t)(gv32 & 0xFF);
    w[1] = (uint8_t)((gv32 >> 8) & 0xFF);
    w[2] = (uint8_t)((gv32 >> 16) & 0xFF);
    w[3] = (uint8_t)((gv32 >> 24) & 0xFF);
    w[4] = (uint8_t)(gv16 & 0xFF);
    w[5] = (uint8_t)((gv16 >> 8) & 0xFF);
    w[6] = gv8;
    w[7] = bss8;
    w[8] = 0xA5;             /* sentinel: main reached + wrote */
    for (;;) { }
}
`;

// The agent's actual symptom: a 32-bit xorshift PRNG seeded by a static
// initialiser. If the static boots 0, the PRNG stays 0 and every roll is
// identical. Correct sequence (computed in JS) is well-varied.
const XORSHIFT_SRC = `
typedef unsigned char  uint8_t;
typedef unsigned long  uint32_t;
static uint32_t rng = 0x1357UL;
static uint32_t xorshift(void) {
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    return rng;
}
void main(void) {
    volatile uint8_t *w = (volatile uint8_t *)0xD000;
    uint8_t i;
    uint32_t v;
    for (i = 0; i < 12; i++) { v = xorshift(); w[i] = (uint8_t)(1 + (v % 6)); }
    w[0x20] = 0xA5;
    for (;;) { }
}
`;

// Ground truth for XORSHIFT_SRC, computed independently here.
function expectedRolls(n) {
    let r = 0x1357 >>> 0;
    const out = [];
    for (let i = 0; i < n; i++) {
        r ^= (r << 13) >>> 0; r >>>= 0;
        r ^= (r >>> 17);      r >>>= 0;
        r ^= (r << 5) >>> 0;  r >>>= 0;
        out.push(1 + (r % 6));
    }
    return out;
}

async function buildRun(platform, src) {
    const { buildForPlatform } = await import("../src/toolchains/index.js");
    const { LibretroHost } = await import("romdev-core-host/LibretroHost.js");
    const { resolveCore } = await import("../src/cores/registry.js");
    // The live MCP path auto-injects the bundled crt0 for sms/gg; buildForPlatform
    // does not, so pass it explicitly (this is the crt0 under test).
    const crt0File = platform === "gg" ? "gg" : "sms";
    const crt0 = await readSrc(`src/platforms/${platform}/lib/c/${crt0File}_crt0.s`);
    const r = await buildForPlatform({ platform, language: "c", sources: { "main.c": src }, crt0 });
    assert.equal(r.ok, true, `${platform} build failed at ${r.stage}: ${(r.log || "").slice(-600)}`);
    const host = new LibretroHost();
    const core = resolveCore(platform);
    await host.loadCore(core.jsPath, core.wasmPath);
    await host.loadMedia({ platform, bytes: new Uint8Array(r.binary), virtualName: `/rom.${platform}` });
    host.stepFrames(20);
    // $D000 → system_ram offset 0x1000 (8KB WRAM, $C000-$DFFF; ramMask 0x1FFF).
    return host.readMemory("system_ram", 0x1000, 0x24);
}

for (const platform of ["sms", "gg"]) {
    test(`R56: ${platform} crt0 initialises value-statics + zeroes BSS`, { timeout: 180000 }, async () => {
        const w = await buildRun(platform, STATIC_INIT_SRC);
        assert.equal(w[8], 0xA5, `${platform}: main() didn't run (no sentinel) — crt0 boot broken`);
        assert.equal(w[0], 0x57, `${platform}: gv32 byte0 — static init failed (got 0x${w[0].toString(16)}, want 0x57)`);
        assert.equal(w[1], 0x13, `${platform}: gv32 byte1 (got 0x${w[1].toString(16)}, want 0x13)`);
        assert.equal(w[2], 0x00, `${platform}: gv32 byte2`);
        assert.equal(w[3], 0x00, `${platform}: gv32 byte3`);
        assert.equal(w[4], 0xEF, `${platform}: gv16 low (got 0x${w[4].toString(16)}, want 0xEF)`);
        assert.equal(w[5], 0xBE, `${platform}: gv16 high (got 0x${w[5].toString(16)}, want 0xBE)`);
        assert.equal(w[6], 0x42, `${platform}: gv8 (got 0x${w[6].toString(16)}, want 0x42)`);
        assert.equal(w[7], 0x00, `${platform}: bss8 — BSS not zeroed (got 0x${w[7].toString(16)}, want 0)`);
    });

    test(`R56: ${platform} static-seeded xorshift PRNG is varied, not monochrome`, { timeout: 180000 }, async () => {
        const w = await buildRun(platform, XORSHIFT_SRC);
        assert.equal(w[0x20], 0xA5, `${platform}: main() didn't run`);
        const got = Array.from(w.slice(0, 12));
        const want = expectedRolls(12);
        assert.deepEqual(got, want,
            `${platform}: xorshift rolls wrong. got [${got}] want [${want}]. ` +
            `All-equal output means the static seed booted 0 (the z80 crt0 _INITIALIZER bug).`);
        // Belt-and-suspenders: the sequence must actually vary.
        assert.ok(new Set(got).size >= 3, `${platform}: rolls are near-monochrome: [${got}]`);
    });
}
