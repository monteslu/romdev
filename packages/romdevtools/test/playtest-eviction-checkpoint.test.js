// Human-playtest eviction survivability (v0.41.0 feedback note 125904 #2/#3):
//   - playtestCheckpointPath derives a deterministic disk path (next to the ROM,
//     or a per-session temp file for in-memory loads);
//   - getHost's eviction-recovery error points at that checkpoint when it exists;
//   - the checkpoint is a real .state that loads back through the host.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  playtestCheckpointPath, getHost, resetHost, clearHost, rememberLastMedia,
} from "../src/mcp/state.js";
import { resolveCore } from "../src/cores/registry.js";

test("playtestCheckpointPath: next to the ROM for a real file; temp for in-memory", () => {
  const onDisk = playtestCheckpointPath("sess1", "/games/homebrew.nes");
  assert.equal(onDisk, path.join("/games", "homebrew.playtest-autosave.state"));
  // in-memory / base64 load (mediaPath is "<…>") → a stable per-session temp file
  const inMem = playtestCheckpointPath("sess-2/weird:chars", "<memory>");
  assert.ok(inMem.startsWith(os.tmpdir()));
  assert.match(inMem, /romdev-playtest-sess-2_weird_chars\.autosave\.state$/);
  // null mediaPath behaves like in-memory
  assert.ok(playtestCheckpointPath("s", null).startsWith(os.tmpdir()));
});

test("eviction recovery hint points at the playtest checkpoint when it exists", () => {
  const key = "evict-hint-test";
  const romPath = "/tmp/romdev-test-evict/game.nes";
  const ckpt = playtestCheckpointPath(key, romPath);
  mkdirSync(path.dirname(ckpt), { recursive: true });
  try {
    // No host loaded (simulating an eviction), but this session loaded media
    // before AND a playtest checkpoint is on disk.
    rememberLastMedia(key, { platform: "nes", path: romPath });
    // without the file → hint must NOT claim a checkpoint
    let msg = "";
    try { getHost(key); } catch (e) { msg = e.message; }
    assert.match(msg, /No ROM loaded/);
    assert.doesNotMatch(msg, /auto-checkpoint is on disk/);

    // with the file present → hint names it + the load recipe
    writeFileSync(ckpt, Buffer.from([1, 2, 3]));
    msg = "";
    try { getHost(key); } catch (e) { msg = e.message; }
    assert.match(msg, /auto-checkpoint is on disk/);
    assert.match(msg, new RegExp(`state\\(\\{ op: "load", path: "${ckpt.replace(/[/\\]/g, "\\$&")}" \\}\\)`));
  } finally {
    clearHost(key);
    try { unlinkSync(ckpt); } catch { /* best-effort */ }
  }
});

test("a written checkpoint .state loads back into a host (round trip)", { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ckpt-rt-"));
  const key = "ckpt-roundtrip";
  try {
    // load a real ROM, advance, serialize to the checkpoint path (as the playtest
    // tick would), then on a FRESH host load it back and confirm the frame count.
    let romPath = null;
    for (const c of [process.env.HOME + "/code/cliemu/homebrew_collection/nes/robotfindskitten.nes"]) {
      try { await readFile(c); romPath = c; break; } catch { /* next */ }
    }
    if (!romPath) { console.log("no NES ROM fixture; skipping round trip"); return; }
    const rom = new Uint8Array(await readFile(romPath));
    const core = resolveCore("nes");

    const h1 = resetHost(key);
    await h1.loadCore(core.jsPath, core.wasmPath);
    await h1.loadMedia({ platform: "nes", bytes: rom, virtualName: "/rom.nes" });
    h1.stepFrames(77);
    // Stamp a sentinel into RAM so we can prove the EXACT state round-trips (the
    // host-side frameCount is intentionally not part of the serialized core state).
    h1.writeMemory("system_ram", 0x40, new Uint8Array([0xab, 0xcd, 0xef]));
    const blob = h1.serializeState();
    const ramAtSave = [...h1.readMemory("system_ram", 0, 0x100)];
    const ckpt = path.join(dir, "auto.state");
    await writeFile(ckpt, Buffer.from(blob));

    // fresh host (simulating recovery after eviction) loads the checkpoint.
    const h2 = resetHost(key);
    await h2.loadCore(core.jsPath, core.wasmPath);
    await h2.loadMedia({ platform: "nes", bytes: rom, virtualName: "/rom.nes" });
    h2.unserializeState(new Uint8Array(await readFile(ckpt)));
    const ramAfterRestore = [...h2.readMemory("system_ram", 0, 0x100)];
    assert.deepEqual(ramAfterRestore, ramAtSave, "checkpoint restored the exact RAM the human reached");
    const sentinel = [...h2.readMemory("system_ram", 0x40, 3)];
    assert.deepEqual(sentinel, [0xab, 0xcd, 0xef], "the sentinel survived the round trip");
  } finally {
    clearHost(key);
    await rm(dir, { recursive: true, force: true });
  }
});
