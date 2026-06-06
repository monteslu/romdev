// Persistent save-state round-trip: save the live emulator to a disk blob,
// advance, restore from disk, and confirm the state came back. This is the
// cross-session escape hatch (no boot replay). Also covers the size-mismatch
// guard on unserializeState.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "../src/host/index.js";
import { buildC } from "../src/toolchains/cc65/cc65.js";

async function bootNes() {
  const r = await buildC({ source: "void main(void){while(1){}}\n", target: "nes" });
  assert.equal(r.exitCode, 0, "build failed:\n" + r.log);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ss-test-"));
  const romPath = path.join(tmp, "test.nes");
  await writeFile(romPath, r.binary);
  const resolved = resolveCore("nes");
  const host = new LibretroHost();
  await host.loadCore(resolved.jsPath, resolved.wasmPath);
  await host.loadMedia({ platform: "nes", path: romPath });
  return { host, tmp };
}

test("saveState→disk→unserialize restores the live state (no boot replay)", async () => {
  const { host, tmp } = await bootNes();
  try {
    host.stepFrames(120);
    const blobA = host.serializeState();
    const snapPath = path.join(tmp, "snap.state");
    await writeFile(snapPath, blobA);

    // Advance well past the snapshot.
    host.stepFrames(600);
    const blobB = host.serializeState();
    // Sanity: the two states differ (the ROM kept running).
    assert.notDeepEqual(Array.from(blobA), Array.from(blobB), "state should change after stepping");

    // Restore the disk snapshot and confirm we're back at snapshot A.
    const restored = new Uint8Array(await readFile(snapPath));
    host.unserializeState(restored);
    const blobC = host.serializeState();
    assert.deepEqual(Array.from(blobC), Array.from(blobA), "restored state should equal the snapshot");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}, { timeout: 30000 });

test("unserializeState rejects a wrong-size blob with a clear error", async () => {
  const { host, tmp } = await bootNes();
  try {
    host.stepFrames(10);
    assert.throws(
      () => host.unserializeState(new Uint8Array(8)), // absurdly small
      /size mismatch|different platform/i,
    );
    assert.throws(() => host.unserializeState(new Uint8Array(0)), /empty blob/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}, { timeout: 30000 });
