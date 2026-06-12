// worker-timeout.test.js — A5: a per-call timeout kills + recycles the worker
// so a hung WASM analysis can't wedge the shared pool.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runInWorker, _internalWorkers } from "../src/toolchains/_worker/pool.js";
import { rizinGluePath } from "../src/analysis/rizin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("A5: a job that exceeds timeoutMs is killed and returns a clean timeout result", async () => {
  // Run rizin with an impossibly-low timeout against a real (small) job. Even a
  // fast job won't finish in 1ms once module-load + run is counted, so the
  // timeout fires, the worker is SIGKILL'd, and we get a structured result —
  // NOT a hang.
  const res = await runInWorker({
    gluePath: rizinGluePath(),
    argv: ["-q", "-c", "aaa", "/work/rom.bin"],
    timeoutMs: 1,
    inputFiles: [{ vfsPath: "/work/rom.bin", encoding: "base64",
      data: Buffer.from(new Uint8Array(64)).toString("base64") }],
  });
  assert.equal(res.timedOut, true, "result is flagged timedOut");
  assert.match(res.log, /timeout/i, "log explains the timeout");
  assert.match(res.log, /scoped pass/i, "log suggests the scoped-pass workaround");
});

test("A5: the pool recovers after a timeout — next job runs fine", async () => {
  // Trigger a timeout, then run a NORMAL job. If the pool wedged, this would
  // hang; instead the recycled worker serves it.
  await runInWorker({
    gluePath: rizinGluePath(),
    argv: ["-q", "-c", "aaa", "/work/rom.bin"],
    timeoutMs: 1,
    inputFiles: [{ vfsPath: "/work/rom.bin", encoding: "base64",
      data: Buffer.from(new Uint8Array(64)).toString("base64") }],
  });

  // A generous timeout — this should complete normally.
  const ok = await runInWorker({
    gluePath: rizinGluePath(),
    argv: ["-q", "-c", "?e roundtrip > /work/out.txt", "/work/rom.bin"],
    timeoutMs: 60000,
    inputFiles: [{ vfsPath: "/work/rom.bin", encoding: "base64",
      data: Buffer.from(new Uint8Array(64)).toString("base64") }],
    outputFiles: [{ vfsPath: "/work/out.txt", encoding: "utf8" }],
  });
  assert.ok(!ok.timedOut, "the follow-up job did NOT time out (pool not wedged)");
  assert.ok(_internalWorkers().length >= 1, "pool replenished a worker");
}, { timeout: 120000 });
