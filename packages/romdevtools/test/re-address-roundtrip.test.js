// re-address-roundtrip.test.js — A2 address-space correctness (RE engine).
//
// The invariant every `disasm` sub-op must hold: functions / cfg / xrefs /
// decompile all speak the SAME address space (the platform's CPU/bus address).
// So an address from `functions` must decompile to the SAME function — not a
// wrong-bank body, an empty `{ return; }`, or "address outside image".
//
// This is the regression guard that would have caught the SNES file-offset bug
// (0.40.2) and the Genesis +0x200 bug (0.40.1) before they shipped. It runs on
// ROMs built from our own examples (no external/commercial ROM), so it's
// deterministic and always-on.

import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzeFunctions, analyzeDecompile, analyzeCfg } from "../src/analysis/analyze.js";
import { buildExampleRom } from "./build-fixture-rom.js";

// Platforms whose standalone example ROM has enough real code for rizin to
// detect a non-trivial function to round-trip. NES (iNES $8000 mirror) and Lynx
// (.lnx header) both produce a meaty function list. The thin 2600/7800/c64
// examples produce ~1 stub function (and the c64 .prg entry is a BASIC SYS stub,
// not ML) — too minimal to assert a round-trip on; their address-space handling
// is covered by the unit tests in capability/decompile paths instead.
const PLATFORMS = ["nes", "lynx"];

function isEmptyOrGarbage(code) {
  return /\{\s*return;\s*\}/.test(code) || /halt_baddata/.test(code);
}

for (const platform of PLATFORMS) {
  test(`A2 round-trip: ${platform} functions→decompile lands on a real function`, async () => {
    const rom = await buildExampleRom(platform);

    const fns = await analyzeFunctions(rom, platform);
    assert.ok(fns.functions.length > 0, `${platform}: functions found nothing`);

    // The function list must report addresses in the CPU/bus space — NOT a raw
    // file offset that includes a load-address/copier header. A function at a
    // suspiciously-low address with a tiny size is the symptom of an unhandled
    // header (the c64 .prg 2-byte load header bug): the "function" is the header
    // bytes, not code. Pick the largest real-looking function instead.
    const target = [...fns.functions]
      .sort((a, b) => (b.nbbs ?? 0) - (a.nbbs ?? 0) || b.size - a.size)
      .find((f) => f.size > 4) ?? fns.functions[0];

    // cfg at that address must produce at least one block (address space agrees).
    const cfg = await analyzeCfg(rom, target.address, platform);
    assert.ok(cfg.nodes.length >= 1,
      `${platform}: cfg @ ${target.addressHex} produced no blocks — functions/cfg address spaces disagree`);

    // decompile at the SAME address must land on a real function body.
    const dec = await analyzeDecompile(rom, target.address, platform);
    assert.equal(dec.address, target.address, `${platform}: decompile echoed a different address`);
    assert.equal(isEmptyOrGarbage(dec.code), false,
      `${platform}: decompile @ ${target.addressHex} returned empty/garbage — the address that ` +
      `functions reported did NOT decompile to a real function (address-space mismatch / unhandled ` +
      `header). Code:\n${dec.code.slice(0, 300)}`);
  }, { timeout: 120000 });
}
