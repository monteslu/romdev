// v0.70.0 feedback: project mode ergonomics for an existing disassembly.
//  #2 — honor `options`/`defines` (asar --define was silently dropped)
//  #3 — `entry` override for a top file that isn't main.* (e.g. smw.asm)
//  #4 — stage subdirectory assets recursively (col/misc/x.pal wasn't read)
// These live in the SHARED project path (readProjectDir/buildProjectCore), so
// the fixes benefit every platform, not just SNES.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildProjectCore } from "../src/mcp/tools/toolchain.js";

function parse(res) { return JSON.parse(res.content.find((c) => c.type === "text").text); }

test("project mode: entry override + --define + recursive subdir asset (SNES asar)", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-v70-"));
  await mkdir(path.join(dir, "gfx"), { recursive: true });
  // entry is smw.asm (NOT main.asm); uses !_VER from a --define; incbins a subdir asset
  await writeFile(path.join(dir, "smw.asm"),
    "lorom\norg $008000\nprint \"VER=\", dec(!_VER)\nStart:\n  sei\n  incbin \"gfx/blob.bin\"\n.loop:\n  jmp .loop\norg $00FFFC\ndw Start\n");
  // a sibling .asm must route as an include, not a second source TU
  await writeFile(path.join(dir, "extra.asm"), "; sibling, not a 2nd source\n");
  await writeFile(path.join(dir, "gfx", "blob.bin"), Buffer.from([1, 2, 3, 4]));

  const res = await buildProjectCore({
    path: dir, platform: "snes", entry: "smw.asm",
    defines: { _VER: 1 }, outputPath: path.join(dir, "out.smc"),
  });
  const j = parse(res);
  try {
    assert.equal(j.ok, true, "build should succeed:\n" + (j.log || ""));
    assert.deepEqual(j.sourcesBuilt, ["smw.asm"], "only the entry is a source");
    assert.ok((j.binaryIncludes || []).includes("gfx/blob.bin"), "subdir asset must be staged: " + JSON.stringify(j.binaryIncludes));
    assert.ok(/VER=1/.test(j.log || ""), "--define _VER=1 must reach asar (log shows VER=1):\n" + (j.log || ""));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project mode: options array (raw --define) is honored too", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-v70b-"));
  await writeFile(path.join(dir, "main.asm"),
    "lorom\norg $008000\nprint \"V=\", dec(!FOO)\n  sei\n  rtl\norg $00FFFC\ndw $8000\n");
  const res = await buildProjectCore({ path: dir, platform: "snes", options: ["--define", "FOO=7"] });
  const j = parse(res);
  try {
    assert.equal(j.ok, true, "build should succeed:\n" + (j.log || ""));
    assert.ok(/V=7/.test(j.log || ""), "raw --define FOO=7 must reach asar:\n" + (j.log || ""));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project mode: a bad entry name is rejected with a clear error", { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-v70c-"));
  await writeFile(path.join(dir, "main.asm"), "lorom\norg $008000\nrtl\norg $00FFFC\ndw $8000\n");
  await assert.rejects(
    () => buildProjectCore({ path: dir, platform: "snes", entry: "nonexistent.asm" }),
    /entry 'nonexistent\.asm' not found/,
  );
  await rm(dir, { recursive: true, force: true });
});

// v0.71.0 feedback #1: project-mode `entry` must resolve a NESTED path (src/main.c),
// not just top-level files — common for decomps / SDK-layout projects.
test("project mode: entry resolves a nested path (src/main.c) + bare-name fallback", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-v71-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "game.s"),
    "lorom\norg $008000\nStart:\n  sei\n.loop:\n  jmp .loop\norg $00FFFC\ndw Start\n");
  try {
    // explicit nested path
    const a = parse(await buildProjectCore({ path: dir, platform: "snes", entry: "src/game.s" }));
    assert.equal(a.ok, true, `nested entry builds: ${(a.log || "").slice(-160)}`);
    assert.ok(a.sourcesBuilt.includes("src/game.s"), `nested entry is the source: ${JSON.stringify(a.sourcesBuilt)}`);
    // bare filename → unique nested match
    const b = parse(await buildProjectCore({ path: dir, platform: "snes", entry: "game.s" }));
    assert.equal(b.ok, true, "bare-name entry resolves to the unique nested file");
    // a bad entry errors with a project-relative hint
    await assert.rejects(
      () => buildProjectCore({ path: dir, platform: "snes", entry: "src/missing.s" }),
      /entry 'src\/missing\.s' not found/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
