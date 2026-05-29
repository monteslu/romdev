// Verify that a crashing WASM worker (SIGKILL'd from outside) does not
// take down the parent, and the next call gets a fresh worker.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// cc65's WASM now ships in @romdev/toolchain-cc65; resolve from the package
// (with a local src/ fallback for the transition layout) — same pattern as
// the production resolver in src/toolchains/cc65/cc65.js.
function resolveCc65Glue() {
  try {
    const u = import.meta.resolve("@romdev/toolchain-cc65");
    const p = path.join(path.dirname(fileURLToPath(u)), "wasm", "cc65.js");
    if (existsSync(p)) return p;
  } catch { /* package not resolvable — fall through to local */ }
  return path.resolve(__dirname, "..", "src", "toolchains", "cc65", "wasm", "cc65.js");
}
const CC65_GLUE = resolveCc65Glue();

// Both tests share the same worker pool (module-scoped state); we
// shutdown only once at the very end via test.after hook isn't worth
// adding — just don't shutdown between tests.

test("worker handles benign error (bad glue path) — no exit", async () => {
  const { runInWorker } = await import("../src/toolchains/_worker/pool.js");
  await assert.rejects(
    runInWorker({
      gluePath: "/nonexistent/glue.js",
      argv: [],
    }),
    /ENOENT|no such file/,
  );
  // Worker still alive for the next job.
  const r = await runInWorker({
    gluePath: CC65_GLUE,
    argv: ["-t", "nes", "-o", "/work/out.s", "/work/main.c"],
    inputFiles: [{ vfsPath: "/work/main.c", encoding: "utf8", data: "void main(void){}\n" }],
    outputFiles: [{ vfsPath: "/work/out.s", encoding: "utf8" }],
  });
  assert.equal(r.exitCode, 0, "subsequent build should succeed on the same worker");
});

test("worker crash isolation: SIGKILL'd worker → parent survives + replenishes pool", async () => {
  const { runInWorker, shutdown, _internalWorkers } = await import("../src/toolchains/_worker/pool.js");
  // 1. Warm-up job (also re-spins workers if a previous test killed them).
  const r1 = await runInWorker({
    gluePath: CC65_GLUE,
    argv: ["-t", "nes", "-o", "/work/out.s", "/work/main.c"],
    inputFiles: [{ vfsPath: "/work/main.c", encoding: "utf8", data: "void main(void){}\n" }],
    outputFiles: [{ vfsPath: "/work/out.s", encoding: "utf8" }],
  });
  assert.equal(r1.exitCode, 0, "first build should succeed");

  // 2. SIGKILL THIS process's own worker children only — not any other
  //    test file's pool. Use the exported worker list to grab PIDs.
  const myPids = _internalWorkers().map((w) => w.child.pid).filter(Boolean);
  for (const pid of myPids) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  // Give time to handle exit + respawn.
  await new Promise((r) => setTimeout(r, 300));

  // 3. Next job hits the replacement worker.
  const r2 = await runInWorker({
    gluePath: CC65_GLUE,
    argv: ["-t", "nes", "-o", "/work/out.s", "/work/main.c"],
    inputFiles: [{ vfsPath: "/work/main.c", encoding: "utf8", data: "void main(void){}\n" }],
    outputFiles: [{ vfsPath: "/work/out.s", encoding: "utf8" }],
  });
  assert.equal(r2.exitCode, 0, "post-crash build should succeed against replacement worker");
  assert.ok(r2.outputs["/work/out.s"]?.length > 0, "post-crash build should produce asm output");

  // Shut down at the end so the test process can exit.
  await shutdown();
});
