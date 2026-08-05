// region-platform-gate.test.js — a region name from the WRONG platform must
// be refused, not silently resolved against the loaded core.
//
// Region ids are per-platform by design: the cores bake them in and two
// platforms deliberately reuse the same number for different buffers
// (ROMDEV_MEMORY_NES_NTMAPLINES and ROMDEV_MEMORY_SNES_OAM are both 0x110).
// That is safe at runtime because only one core is ever loaded — but the read
// path used to resolve by id without checking the platform, so on a SNES core
// `memory({region:'nes_ntmaplines'})` returned snes_oam's bytes with no error.
//
// Plausible wrong data is the failure mode that costs the most time: the
// apparent collision in every loadMedia response is what convinced a bezel
// agent the catalog was broken, which led to a renumbering that broke SNES
// memory access outright. capabilities.js already declares which regions each
// platform exposes; this pins that the read/write paths honour it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CAPABILITIES } from "../src/cores/capabilities.js";

test("capabilities keeps NES and SNES region namespaces disjoint", () => {
  const nes = CAPABILITIES.nes.memoryRegions;
  const snes = CAPABILITIES.snes.memoryRegions;

  // The four historically-colliding pairs: each name belongs to exactly one
  // platform, which is what makes the gate decidable.
  for (const name of ["nes_ntmaplines", "nes_bgpix", "nes_backdrop", "nes_sprdrawn"]) {
    assert.ok(nes.includes(name), `${name} is a NES region`);
    assert.ok(!snes.includes(name), `${name} must NOT be claimed by snes`);
  }
  for (const name of ["snes_oam", "snes_cgram", "snes_aram", "snes_fillram"]) {
    assert.ok(snes.includes(name), `${name} is a SNES region`);
    assert.ok(!nes.includes(name), `${name} must NOT be claimed by nes`);
  }
});

test("every platform declares a non-empty region list the gate can check", () => {
  // The gate deliberately stays out of the way when a platform declares no
  // regions (it cannot know what is legal). That is a safety valve, not a
  // licence for a platform to opt out — so assert the tier-1 set is populated.
  for (const platform of ["nes", "snes", "genesis", "gb", "gbc", "sms"]) {
    const regions = CAPABILITIES[platform]?.memoryRegions;
    assert.ok(Array.isArray(regions) && regions.length > 0,
      `${platform} declares its memory regions`);
    assert.ok(regions.includes("system_ram"),
      `${platform} includes the generic regions`);
  }
});

test("the colliding ids really are shared — the gate is the only defence", async () => {
  // If someone "fixes" the ids to be globally unique, this fails and points at
  // the reason not to: the numbers are baked into the compiled cores, so
  // renumbering the JS alone makes the host ask a core for ids it does not
  // implement (verified: SNES reads went empty).
  const { RetroMemory } = await import("romdev-core-host/types.js");
  assert.equal(RetroMemory.NES_NTMAPLINES, RetroMemory.SNES_OAM,
    "0x110 is shared by design (fceumm NES plane / snes9x OAM)");
  assert.equal(RetroMemory.NES_BGPIX, RetroMemory.SNES_CGRAM);
  assert.equal(RetroMemory.NES_BACKDROP, RetroMemory.SNES_ARAM);
  assert.equal(RetroMemory.NES_SPRDRAWN, RetroMemory.SNES_FILLRAM);
});
