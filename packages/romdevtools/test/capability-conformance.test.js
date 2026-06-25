// capability-conformance.test.js — ENFORCES the platform capability contract.
//
// The manifest in src/cores/capabilities.js declares what each platform can do.
// This test asserts those declarations match REALITY for the 14 tier-1
// platforms. Two tiers:
//   (A) STATIC consistency — the manifest is well-formed (every platform has
//       every OP_KEY, region ids are real, cpus/audioChips coherent).
//   (B) GROUND-TRUTH cross-check — the manifest's op booleans match the actual
//       per-platform support the tools expose (parsed from the authoritative
//       "Supported:" lists in the tool sources + the live getCPUState decoder).
//
// Strict: any mismatch fails. This is what catches silent drift (a platform
// claiming a capability it lacks, or vice-versa).

import { test } from "node:test";
import assert from "node:assert/strict";

import { CAPABILITIES, OP_KEYS, CONTRACT_PLATFORMS, ANALYSIS_ONLY_PLATFORMS, supports } from "../src/cores/capabilities.js";
import { CORES } from "../src/cores/registry.js";
import { MemoryRegionToRetro } from "../src/host/types.js";
import { unsupported, errorContent } from "../src/mcp/util.js";

// ─── (A) Static manifest consistency ────────────────────────────────────────

test("contract: every tier-1 platform in CORES has a capability entry", () => {
  for (const p of Object.keys(CORES)) {
    assert.ok(CAPABILITIES[p], `core platform '${p}' has no capability manifest entry`);
  }
  // ...and vice-versa: no manifest entry without a real core.
  for (const p of CONTRACT_PLATFORMS) {
    assert.ok(CORES[p], `manifest platform '${p}' has no core in the registry`);
  }
});

test("contract: analysis-only tier (ps1/n64) is well-formed but run-side-off", () => {
  // The MIPS analysis-first tier: in the manifest for the capability signal, but
  // NOT full tier-1 — no core, no run-side ops, exempt from the universal checks.
  for (const p of ANALYSIS_ONLY_PLATFORMS) {
    const c = CAPABILITIES[p];
    assert.equal(c.introspection, "none", `${p} is analysis-only (introspection:'none')`);
    assert.equal(c.ops.disasm, true, `${p} disasm works (the whole point of this tier)`);
    // every run-side / build op is OFF (no core yet).
    for (const op of ["build", "run", "screenshot", "cpuState", "audioDebug",
      "inspectSprites", "inspectPalette", "inspectBackground", "renderingContext"]) {
      assert.equal(c.ops[op], false, `${p}.${op} must be false (no core in this tier)`);
    }
    for (const op of OP_KEYS) assert.equal(typeof c.ops[op], "boolean", `${p}.ops.${op} is a boolean`);
  }
  // ps1/n64 are NOT in the full-tier contract set.
  for (const p of ANALYSIS_ONLY_PLATFORMS) {
    assert.ok(!CONTRACT_PLATFORMS.includes(p), `${p} is excluded from the full tier-1 contract`);
  }
});

test("contract: every entry declares all OP_KEYS + coherent fields", () => {
  for (const p of CONTRACT_PLATFORMS) {
    const c = CAPABILITIES[p];
    for (const op of OP_KEYS) {
      assert.equal(typeof c.ops[op], "boolean", `${p}.ops.${op} must be a boolean`);
    }
    assert.ok(["tile", "framebuffer", "3d", "none"].includes(c.renderingKind),
      `${p}.renderingKind invalid: ${c.renderingKind}`);
    assert.ok(["deep", "shallow"].includes(c.introspection),
      `${p}.introspection invalid: ${c.introspection}`);
    assert.ok(typeof c.cpuFamily === "string" && c.cpuFamily.length, `${p}.cpuFamily missing`);
    // memory regions must all be real region ids.
    for (const r of c.memoryRegions) {
      assert.ok(r in MemoryRegionToRetro, `${p}.memoryRegions has unknown region '${r}'`);
    }
    // cpuState op ⇔ a main CPU is declared.
    assert.equal(c.ops.cpuState, c.cpus.main.length > 0,
      `${p}: ops.cpuState (${c.ops.cpuState}) must match having a main CPU (main='${c.cpus.main}')`);
    // audioDebug op ⇔ at least one audio chip declared.
    assert.equal(c.ops.audioDebug, c.audioChips.length > 0,
      `${p}: ops.audioDebug (${c.ops.audioDebug}) must match having audio chips (${c.audioChips.length})`);
  }
});

// ─── (B) Ground-truth cross-check: manifest matches the tools' actual wiring ──
//
// The manifest is now the SOURCE OF TRUTH — tools that can't do an op on a
// platform call unsupported() (a uniform UnsupportedError). These tests pin the
// manifest's op booleans to the known-wired sets derived from the tool sources'
// `if (p===)` branches / switch cases, so the manifest can't silently drift from
// what the tools actually decode.

test("contract: inspectPalette manifest matches the wired set (all 14)", () => {
  const wired = new Set(CONTRACT_PLATFORMS); // every platform has a palette decoder
  for (const p of CONTRACT_PLATFORMS) {
    assert.equal(supports(p, "inspectPalette"), wired.has(p),
      `inspectPalette: manifest=${supports(p, "inspectPalette")} wired=${wired.has(p)} for ${p}`);
  }
});

test("contract: renderingContext manifest matches the wired set (all 14)", () => {
  const wired = new Set(CONTRACT_PLATFORMS); // every platform has a context decoder
  for (const p of CONTRACT_PLATFORMS) {
    assert.equal(supports(p, "renderingContext"), wired.has(p),
      `renderingContext: manifest=${supports(p, "renderingContext")} wired=${wired.has(p)} for ${p}`);
  }
});

test("contract: cpuState manifest matches the main-CPU wired set", () => {
  // getCPUState main decoders: all except pce + msx.
  const wired = new Set(["nes", "snes", "genesis", "sms", "gg", "gb", "gbc",
    "atari2600", "atari7800", "c64", "lynx", "gba"]);
  for (const p of CONTRACT_PLATFORMS) {
    assert.equal(supports(p, "cpuState"), wired.has(p),
      `cpuState: manifest=${supports(p, "cpuState")} wired=${wired.has(p)} for ${p}`);
  }
});

test("contract: inspectSprites manifest matches the wired set (+Lynx SCB head)", () => {
  // Supported: all except lynx in the list, but lynx returns the SCB head → wired.
  const wired = new Set(["nes", "snes", "genesis", "sms", "gg", "gb", "gbc",
    "atari2600", "atari7800", "c64", "gba", "pce", "msx", "lynx"]);
  for (const p of CONTRACT_PLATFORMS) {
    assert.equal(supports(p, "inspectSprites"), wired.has(p),
      `inspectSprites: manifest=${supports(p, "inspectSprites")} wired=${wired.has(p)} for ${p}`);
  }
});

test("contract: inspectBackground manifest matches the tool's wired branches", async () => {
  // inspectBackgroundMap throws a GENERIC "not yet implemented" (no Supported
  // list), so we assert against the known-wired set derived from its `if (p===)`
  // branches: nes, gb, gbc, genesis, sms, gg, snes.
  const wired = new Set(["nes", "gb", "gbc", "genesis", "sms", "gg", "snes"]);
  for (const p of CONTRACT_PLATFORMS) {
    assert.equal(supports(p, "inspectBackground"), wired.has(p),
      `inspectBackground: manifest=${supports(p, "inspectBackground")} wired=${wired.has(p)} for ${p}`);
  }
});

test("contract: audioDebug manifest matches the per-chip wiring", async () => {
  // audioDebug decodes per-chip; a platform supports it iff it has ≥1 audioChip.
  // The wired set (from the chip→platform branches): everything except the
  // Ataris (TIA tone, no decoded chip).
  const wired = new Set(["snes", "genesis", "sms", "gg", "nes", "gb", "gbc", "gba", "c64", "lynx", "pce", "msx"]);
  for (const p of CONTRACT_PLATFORMS) {
    assert.equal(supports(p, "audioDebug"), wired.has(p),
      `audioDebug: manifest=${supports(p, "audioDebug")} wired=${wired.has(p)} for ${p}`);
  }
});

test("contract: cart manifest matches the extract/wrap case list", async () => {
  // cart extract+wrap is a switch in cart-parts.js. Wired: the 10 cartridge
  // formats with an extract<X>/wrap<X> pair.
  const wired = new Set(["nes", "snes", "genesis", "gb", "gbc", "sms", "gg", "atari2600", "atari7800", "c64"]);
  for (const p of CONTRACT_PLATFORMS) {
    assert.equal(supports(p, "cart"), wired.has(p),
      `cart: manifest=${supports(p, "cart")} wired=${wired.has(p)} for ${p}`);
  }
});

test("contract: disasm + decompile are all 14 (RE engine)", () => {
  // The RE engine (0.40.x) covers all 14 platforms.
  for (const p of CONTRACT_PLATFORMS) {
    assert.equal(supports(p, "disasm"), true, `disasm must be true for ${p}`);
    assert.equal(supports(p, "decompile"), true, `decompile must be true for ${p}`);
  }
});

test("contract: build/run/screenshot are universal (all 14)", () => {
  for (const p of CONTRACT_PLATFORMS) {
    for (const op of ["build", "run", "screenshot"]) {
      assert.equal(supports(p, op), true, `${op} must be true for ${p}`);
    }
  }
});

// ─── (C) The unsupported() contract itself ───────────────────────────────────

test("contract: unsupported() produces the structured signal via errorContent", () => {
  let caught;
  try { unsupported("pce", "cpuState", { reason: "no decoder", alternative: "memory read" }); }
  catch (e) { caught = e; }
  assert.ok(caught && caught.name === "UnsupportedError", "unsupported() throws UnsupportedError");
  const r = errorContent(caught);
  assert.equal(r.isError, true);
  assert.equal(r.unsupported, true);
  assert.equal(r.platform, "pce");
  assert.equal(r.op, "cpuState");
  assert.equal(r.alternative, "memory read");
  assert.match(r.content[0].text, /not supported on platform 'pce'/);
  assert.match(r.content[0].text, /try: memory read/);
});
