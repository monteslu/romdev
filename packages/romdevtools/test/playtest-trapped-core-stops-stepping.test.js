// A WASM cart that TRAPS is not a transient failure. Once it traps (typically
// "memory access out of bounds" — its linear memory hit the maximum its own
// build declared), every subsequent frame traps identically forever.
//
// This actually happened: the OpenArena cart (391 MB of pk3s resident in a
// 2 GB-capped heap) trapped during a long bot match and the tick loop retried
// it every tick, burying the cause under identical log lines.
//
// The tick loop must still ride through a ONE-tick blip, though — a step error
// mid-swap (host being torn down and rebuilt by runSource/loadMedia) is
// genuinely transient and must not disable the window.
//
// These tests pin the policy that separates the two.

import { test } from "node:test";
import assert from "node:assert/strict";

const MAX_CONSECUTIVE_STEP_ERRORS = 3;

/**
 * The step-error policy, verbatim from playtest.js's tick: a failure bumps the
 * counter and disables stepping at the threshold; a SUCCESSFUL step resets it.
 * Kept as a standalone reducer so the policy can be tested without an SDL
 * window (the real loop needs a live display).
 */
function makeStepper() {
  let consecutiveStepErrors = 0;
  let steppingDisabled = false;
  return {
    get disabled() { return steppingDisabled; },
    get errors() { return consecutiveStepErrors; },
    tick(stepFn) {
      if (steppingDisabled) return "skipped";
      try {
        stepFn();
      } catch {
        consecutiveStepErrors++;
        if (consecutiveStepErrors >= MAX_CONSECUTIVE_STEP_ERRORS) {
          steppingDisabled = true;
          return "disabled";
        }
        return "error";
      }
      consecutiveStepErrors = 0;
      return "ok";
    },
  };
}

const trap = () => { throw new Error("memory access out of bounds"); };

test("a permanently trapped core stops being stepped after N failures", () => {
  const s = makeStepper();
  assert.equal(s.tick(trap), "error", "1st failure: keep going, might be transient");
  assert.equal(s.tick(trap), "error", "2nd failure: still keep going");
  assert.equal(s.tick(trap), "disabled", "3rd consecutive failure: give up");
  assert.equal(s.disabled, true);
});

test("once disabled, the core is never stepped again", () => {
  const s = makeStepper();
  for (let i = 0; i < 3; i++) s.tick(trap);
  assert.equal(s.disabled, true);

  // The bug being fixed: retrying a corpse 60x/second. Prove we do not even
  // CALL into the host once disabled.
  let called = 0;
  for (let i = 0; i < 100; i++) {
    assert.equal(s.tick(() => { called++; }), "skipped");
  }
  assert.equal(called, 0, "a disabled stepper must not call the host at all");
});

test("a transient one-tick blip does NOT disable the window", () => {
  const s = makeStepper();
  // Exactly the mid-swap case: one throw, then the new host steps fine.
  assert.equal(s.tick(trap), "error");
  assert.equal(s.tick(() => {}), "ok", "the rebuilt host steps normally");
  assert.equal(s.disabled, false, "one blip must never disable stepping");
  assert.equal(s.errors, 0, "a good frame clears the counter");
});

test("alternating failures never accumulate to the threshold", () => {
  const s = makeStepper();
  // A core that fails every other frame is degraded, not trapped — the counter
  // must reset on each success rather than creeping up to the limit.
  for (let i = 0; i < 20; i++) {
    s.tick(trap);
    s.tick(() => {});
  }
  assert.equal(s.disabled, false, "intermittent errors are not a trap");
});

test("two failures then a success then two more stays alive", () => {
  const s = makeStepper();
  s.tick(trap);
  s.tick(trap);
  assert.equal(s.errors, 2, "one short of the threshold");
  s.tick(() => {});
  assert.equal(s.errors, 0);
  s.tick(trap);
  s.tick(trap);
  assert.equal(s.disabled, false, "the reset genuinely restored the full budget");
});
