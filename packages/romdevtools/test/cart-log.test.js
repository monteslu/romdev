// Cart output goes to a ring buffer, not to the server log.
//
// wasmcart writes a line or two PER FRAME to stderr. Echoed into the server
// log that was 58 MB in a day, and it buried the one thing the log existed to
// show: on 2026-08-19 the server was OOM-killed and the log simply stopped
// mid-boot, because no server-level line had been written for hours.
//
// The lines still matter while debugging a cart, so they are kept bounded and
// surfaced through catalog({op:'status'}) instead.

import { test } from "node:test";
import assert from "node:assert/strict";

import { pushCartLine, recentCartLog } from "../src/mcp/cart-log.js";

test("the ring is bounded -- a per-frame writer cannot grow it without limit", () => {
  // 10k lines is ~a minute of one cart at 60fps. The whole point is that this
  // costs the same as 200 lines.
  for (let i = 0; i < 10_000; i++) pushCartLine(`line ${i}`);
  const out = recentCartLog();
  assert.ok(out.length <= 200, `ring held ${out.length} lines; must stay bounded`);
  // And it keeps the NEWEST, which is what a debugger wants.
  assert.equal(out[out.length - 1], "line 9999");
});

test("empty lines are dropped rather than padding the ring", () => {
  const before = recentCartLog().length;
  pushCartLine("");
  pushCartLine(undefined);
  assert.equal(recentCartLog().length, before, "blank writes must not consume the buffer");
});

test("recentCartLog returns a copy -- a caller cannot corrupt the buffer", () => {
  pushCartLine("keep me");
  const snapshot = recentCartLog();
  snapshot.length = 0;
  assert.ok(recentCartLog().length > 0, "mutating the returned array must not empty the ring");
});

test("the module does not import the server (which would bind the port)", async () => {
  // tools/index.js reads this ring; server.js imports tools/index.js. Putting
  // the getter in server.js meant importing it ran its top level and tried to
  // bind :7331 -- a status field that fails with "port already in use". This
  // test is the guard: importing the tool surface must be side-effect free.
  await assert.doesNotReject(async () => {
    await import("../src/mcp/tools/index.js");
  }, "importing the tool surface must not start a server");
});
