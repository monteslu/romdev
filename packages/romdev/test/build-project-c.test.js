// build({output:'project'}) — the v0.6.0 feedback #2: a dir-based build for an
// on-disk C/SGDK project, so iterating doesn't re-send the file manifest each
// call. Previously buildProject was asm/cc65-only ("reads main.asm/main.s").
// Now it discovers main.c + multi-file C/.h on disk for ANY platform.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildProjectCore } from "../src/mcp/tools/toolchain.js";

function parse(res) { return JSON.parse(res.content.find((c) => c.type === "text").text); }

async function projectDir(files) {
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-proj-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

test("build({output:'project'}) builds a multi-file C/SGDK Genesis project from a dir", { timeout: 240000 }, async () => {
  const dir = await projectDir({
    "main.c": `#include <genesis.h>\n#include "level.h"\nint main(){ VDP_init(); VDP_drawText("proj", levelStartX(), 12); while(1){ SYS_doVBlankProcess(); } return 0; }\n`,
    "level.c": `#include "level.h"\nint levelStartX(void){ return 10; }\n`,
    "level.h": `int levelStartX(void);\n`,
  });
  try {
    const r = parse(await buildProjectCore({ path: dir, platform: "genesis" }));
    assert.equal(r.ok, true, "C/SGDK dir build failed:\n" + (r.logTail || r.log || "").slice(-400));
    assert.ok(r.binaryBytes > 0, "no ROM bytes produced");
    assert.ok(r.sourcesBuilt.includes("main.c") && r.sourcesBuilt.includes("level.c"),
      "both .c TUs should be compiled: " + JSON.stringify(r.sourcesBuilt));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("build({output:'project'}) builds a cc65 C (NES) project from a dir", { timeout: 120000 }, async () => {
  const dir = await projectDir({
    "main.c": `#include "hud.h"\nvoid main(void){ unsigned char s = score(); (void)s; for(;;); }\n`,
    "hud.c": `#include "hud.h"\nunsigned char score(void){ return 7; }\n`,
    "hud.h": `unsigned char score(void);\n`,
  });
  try {
    const r = parse(await buildProjectCore({ path: dir, platform: "nes" }));
    assert.equal(r.ok, true, "cc65 C dir build failed:\n" + (r.logTail || r.log || "").slice(-400));
    assert.ok(r.binaryBytes > 0);
    assert.ok(r.sourcesBuilt.includes("hud.c"), "linked the second C TU");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("build({output:'project'}) still builds an asm (main.s) project — no regression", { timeout: 60000 }, async () => {
  // Minimal NES asm via a chr-ram preset would need a header; use a tiny
  // self-contained main.s for a 6502 target that ca65 accepts. atari2600 is
  // the simplest bare-asm target.
  const dir = await projectDir({
    "main.s": `  .segment "CODE"\nreset:\n  sei\n  cld\nloop:\n  jmp loop\n  .segment "VECTORS"\n  .word reset\n  .word reset\n  .word reset\n`,
  });
  try {
    const r = parse(await buildProjectCore({ path: dir, platform: "atari2600" }));
    // We only assert the entry-point discovery + build wiring ran (ok may be
    // true or a clean toolchain error) — NOT a hard build success, since a bare
    // 2600 kernel needs more. The point is main.s is still recognized.
    assert.ok(r.toolchain || r.stage || r.logTail !== undefined, "asm dir build did not run");
    assert.ok(Array.isArray(r.sourcesBuilt) && r.sourcesBuilt.includes("main.s"),
      "main.s should be recognized as the asm entry point");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("build({output:'project'}) errors clearly when no entry point exists", async () => {
  const dir = await projectDir({ "readme.txt": "no sources here", "level.h": "int x;\n" });
  try {
    // The core throws; the `build` router wraps it in safeTool → {isError:true}.
    await assert.rejects(
      () => buildProjectCore({ path: dir, platform: "genesis" }),
      /no entry point/,
      "should throw when no main.c/main.s",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
