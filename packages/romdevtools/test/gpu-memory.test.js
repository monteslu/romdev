// GPU memory reporting: make an invisible leak visible.
//
// On 2026-08-20 this server was found holding 26.69 GB of GTT. GTT is not a
// GPU-side pool -- it is ordinary system RAM mapped into the GPU's address
// space -- so that was 26.69 GB of a 54 GB machine, checked out to the GPU and
// unavailable to everything else. It dropped to 0.16 GB the instant the server
// exited, so it was unambiguously ours.
//
// The reason it needed a forensic pass to find is the part worth guarding:
// NOTHING ORDINARY SHOWS IT. ps, top and process RSS all attribute GTT to the
// GPU rather than to the process, so the server looked like a 3 GB process on
// a machine with 2.7 GB free. It surfaces per-process only in DRM fdinfo.
//
// Measured for scale, on this hardware: a healthy loaded GL cart reports
// gttMb 18 / vramMb 165. The leak was gttMb 26690 -- about 1500x.

import { test } from "node:test";
import assert from "node:assert/strict";

import { gpuMemory, gpuMemoryWarning } from "../src/mcp/gpu-memory.js";

test("gpuMemory() never throws, whatever the host looks like", () => {
  // Runs on CI boxes with no GPU, no DRM fds, and non-Linux developers'
  // machines. Reporting nothing is correct; failing is not.
  const out = gpuMemory();
  assert.ok(out === null || typeof out === "object");
  if (out) {
    assert.equal(typeof out.driver, "string");
    if (out.gttMb !== undefined) assert.equal(typeof out.gttMb, "number");
    if (out.vramMb !== undefined) assert.equal(typeof out.vramMb, "number");
  }
});

test("a healthy cart is silent -- the warning must not cry wolf", () => {
  // A real loaded GL cart measured 18 MB GTT on this hardware; a busy server
  // with several cores and a window runs in the low hundreds. Warning at that
  // level would train everyone to ignore it.
  assert.equal(gpuMemoryWarning({ gttMb: 18, driver: "amdgpu" }), null);
  assert.equal(gpuMemoryWarning({ gttMb: 500, driver: "amdgpu" }), null);
  assert.equal(gpuMemoryWarning({ gttMb: 1500, driver: "amdgpu" }), null);
});

test("the leak that prompted this is caught, and the message explains WHY it matters", () => {
  const warn = gpuMemoryWarning({ gttMb: 26690, driver: "amdgpu" });
  assert.ok(warn, "26 GB of GTT must not be reported as normal");
  assert.match(warn, /26\.1 GB/, "states the actual figure");
  // The single most important sentence: a reader who does not know what GTT
  // is will otherwise dismiss it as 'GPU memory, not my problem'.
  assert.match(warn, /SYSTEM RAM/, "must say GTT is system RAM, not GPU-side");
  assert.match(warn, /ps.*top|top.*ps/s, "must say why ps/top do not show it");
});

test("no GPU, or a driver that publishes no GTT, warns about nothing", () => {
  assert.equal(gpuMemoryWarning(null), null);
  assert.equal(gpuMemoryWarning({ driver: "i915" }), null, "no gttMb key = nothing to judge");
});

test("the threshold sits between 'busy' and 'broken'", () => {
  // Not a magic number: a legitimately heavy workload (several 3D cores plus a
  // window) lives in the hundreds of MB, and the observed leak was 26_000. Any
  // threshold in between works; this pins that the chosen one is in between,
  // so a later tweak cannot silently drift into either failure mode.
  assert.equal(gpuMemoryWarning({ gttMb: 2047, driver: "amdgpu" }), null);
  assert.ok(gpuMemoryWarning({ gttMb: 2048, driver: "amdgpu" }));
});
