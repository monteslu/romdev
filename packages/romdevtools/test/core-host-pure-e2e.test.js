// Phase 2 gate (ROMDEV_CORE_RUNNER_PLAN §6b): the isomorphic core must run a
// full emulation session from BYTES with the Node adapter DISABLED
// ({io: false} — exactly what a browser bundle gets), and the result must be
// byte-identical to the path-based Node load. The test does all the I/O; the
// host under test touches no disk, no tmpdir, no node:fs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as fceumm from "romdev-core-fceumm";
import { LibretroHost } from "romdev-core-host";

const ROM = fileURLToPath(new URL("./roms/nestest.nes", import.meta.url));

async function runSession(host, load) {
  await load();
  host.stepFrames(60);
  host.setInput({ ports: [{ start: true }] });
  host.stepFrames(60);
  return {
    hash: host.framebufferHash(),
    ram: Array.from(host.readMemory("system_ram", 0, 2048)),
    frames: host.getStatus().frameCount,
  };
}

test("bytes-only host ({io:false}) matches the path-based host byte-for-byte", async () => {
  const { jsPath, wasmPath } = fceumm.core;

  // Reference: the classic Node path-based load.
  const a = new LibretroHost();
  const resA = await runSession(a, async () => {
    await a.loadCore(jsPath, wasmPath);
    await a.loadMedia({ platform: "nes", path: ROM });
  });

  // Pure: the TEST does the I/O (as a browser bundle would via fetch);
  // the host gets only a factory + bytes and its Node adapter is disabled.
  const factory = (await import(pathToFileURL(jsPath).href)).default;
  const wasmBinary = new Uint8Array(await readFile(wasmPath));
  const romBytes = new Uint8Array(await readFile(ROM));
  const b = new LibretroHost();
  const resB = await runSession(b, async () => {
    await b.loadCore({ factory, wasmBinary, io: false });
    await b.loadMedia({ platform: "nes", bytes: romBytes });
  });

  assert.equal(resB.frames, resA.frames, "frame counts diverged");
  assert.equal(resB.hash, resA.hash, "framebuffer hashes diverged");
  assert.deepEqual(resB.ram, resA.ram, "system RAM diverged");

  // The pure host's typed-array surface works without the PNG tier.
  const f = b.getFramebuffer();
  assert.ok(f.pixels instanceof Uint8Array && f.width > 0 && f.height > 0);
  const rgba = b.screenshotRgba();
  assert.equal(rgba.rgba.length, f.width * f.height * 4);

  // And the pure host never grew a Node adapter or a real tmp dir.
  assert.equal(b._io, null, "pure host loaded the Node adapter");
  assert.equal(b.state.saveDir, "/romdev-save", "pure host upgraded its virtual save dir");
});

test("pure host refuses path-based loadMedia with a pointer to bytes", async () => {
  const { jsPath, wasmPath } = fceumm.core;
  const factory = (await import(pathToFileURL(jsPath).href)).default;
  const wasmBinary = new Uint8Array(await readFile(wasmPath));
  const host = new LibretroHost();
  await host.loadCore({ factory, wasmBinary, io: false });
  await assert.rejects(
    () => host.loadMedia({ platform: "nes", path: ROM }),
    /bytes/,
  );
});
