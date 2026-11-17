// frame's description says stepAndShot "takes the same crop/scale/overlayBoxes/
// source as 'screenshot'" and that verify takes `frames` to boot-then-check in
// one call, and both handlers use them (doStepAndShot hands them to shootPng,
// doVerify passes frames to computeVerify). The per-op scope checker reads each
// parameter's own description, which named only op=screenshot (and left verify
// off `frames`), so both calls were refused before the handler ran. Read the
// REAL registered shape so the test tracks the text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { makeScopeChecker } from "../src/mcp/util.js";
import { registerFrameTools } from "../src/mcp/tools/frame.js";

function frameShape() {
  let shape;
  registerFrameTools({ tool: (name, _desc, s) => { if (name === "frame") shape = s; } }, z, "test");
  return shape;
}

test("stepAndShot takes crop, scale and overlayBoxes, as screenshot does", () => {
  const check = makeScopeChecker(frameShape(), "frame");
  for (const op of ["screenshot", "stepAndShot"]) {
    assert.equal(check({ op, crop: { x: 0, y: 0, w: 640, h: 40 } }), null, `${op} crop`);
    assert.equal(check({ op, scale: 0.5 }), null, `${op} scale`);
    assert.equal(check({ op, overlayBoxes: true }), null, `${op} overlayBoxes`);
  }
});

test("verify takes frames", () => {
  const check = makeScopeChecker(frameShape(), "frame");
  assert.equal(check({ op: "verify", frames: 240 }), null);
});

test("crop is still refused where nothing captures a picture", () => {
  const check = makeScopeChecker(frameShape(), "frame");
  assert.match(check({ op: "step", crop: { x: 0, y: 0, w: 8, h: 8 } }), /'crop' does not apply to op:'step'/);
});
