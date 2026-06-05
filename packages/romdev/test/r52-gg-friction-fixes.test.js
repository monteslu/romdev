// R52 — GG-agent friction-feedback fixes.
//
// Driven by agent friction feedback on the Game Gear scaffold.
// Captured problems + the fixes shipped here:
//
//   1. createProject({platform:"gg"}) wrote an unrunnable stub. Now
//      ships a real runtime-correct default.c + bundles gg_crt0.s
//      so the GG default actually boots into Mode 4 with a visible
//      'H' tile.
//   2. createGame had no entry for gg. Now wired (gg has the same 5
//      genre scaffolds as sms — shmup/platformer/puzzle/sports/racing).
//   3-4. GG + SMS MENTAL_MODEL footguns documented (8-sprites-per-
//      scanline, SAT $D0 terminator, OAM hardware-vs-visible coords).
//   5-6. R6 vdp_init/load_tiles comment bug — said "sprite tiles at
//      $2000" when R6=0xFB actually puts them at $0000. Fixed across
//      sms + gg vdp_init.c, sms + gg load_tiles.c, gg + sms MENTAL_MODEL.
//   7. New copyStarterSnippets tool — one call writes every snippet
//      to a destination dir instead of pumping the bytes through the
//      agent's context.
//
// This test bundles assertions for each fix so a regression in any
// one of them lights up clearly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

async function readSrc(rel) {
  return readFile(join(REPO_ROOT, rel), "utf-8");
}

test("R52 gg_crt0.s is bundled and registered in GG_RUNTIME", async () => {
  const crt0 = await readSrc("src/platforms/gg/lib/c/gg_crt0.s");
  assert.match(crt0, /\.module\s+gg_crt0/);
  assert.match(crt0, /im\s+1/,        "missing IM 1 — won't take vblank IRQs cleanly");
  assert.match(crt0, /ld\s+sp,\s*#0xDFF0/i, "stack pointer not initialised to $DFF0");
  assert.match(crt0, /call\s+_main/,  "doesn't call main()");

  const project = await readSrc("src/mcp/tools/project.js");
  assert.match(project, /lib\/c\/gg_crt0\.s/, "GG_RUNTIME does not register gg_crt0.s");
});

test("R52 GG default template is the new visible-and-runnable one (not the counter stub)", async () => {
  const def = await readSrc("examples/gg/templates/default.c");
  // The new default initialises the VDP + loads a tile + enables display.
  // The old stub (still at examples/gg/main.c for backward compat) just
  // bumped a global byte forever.
  assert.match(def, /vdp_init\s*\(/, "default.c: must call vdp_init()");
  assert.match(def, /load_palette\s*\(/, "default.c: must load a palette");
  assert.match(def, /load_tile\s*\(/, "default.c: must load tile data");
  assert.match(def, /wait_vblank\s*\(/, "default.c: must wait for vblank");
  assert.match(def, /vdp_write_reg\s*\(\s*1\s*,\s*0xE0\s*\)/i,
    "default.c: must enable display (R1 = 0xE0) — otherwise screen stays black");

  const project = await readSrc("src/mcp/tools/project.js");
  // TEMPLATES.gg.default must point to templates/default.c, not the bare main.c stub.
  const ggBlock = project.slice(project.indexOf("TEMPLATES.gg = {"), project.indexOf("TEMPLATES.c64 = {"));
  assert.match(ggBlock, /default:\s*\{[\s\S]*?main:\s*"templates\/default\.c"/,
    "TEMPLATES.gg.default must point to templates/default.c, not the old main.c stub");
});

test("R52 GG default.c + gg_crt0.s compiles end-to-end (32 KB ROM)", { timeout: 120000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const main = await readSrc("examples/gg/templates/default.c");
  const crt0 = await readSrc("src/platforms/gg/lib/c/gg_crt0.s");
  const r = await buildForPlatform({
    platform: "gg",
    language: "c",
    sources: { "main.c": main, "gg_crt0.s": crt0 },
    crt0,
  });
  assert.equal(r.ok, true, `gg default build failed at ${r.stage}: ${(r.log || "").slice(-500)}`);
  assert.equal(r.binary.length, 32768, "gg default should pad to 32 KB cart size");
});

test("R52 createGame supports platform:'gg' (all 5 genres)", async () => {
  // R61: createGame derives genre availability from TEMPLATES (no GENRE_MAP).
  // Assert the source of truth — TEMPLATES.gg registers all 5 genres — by
  // checking each genre key appears inside the `TEMPLATES.gg = { ... };` block.
  const project = await readSrc("src/mcp/tools/project.js");
  const start = project.indexOf("TEMPLATES.gg = {");
  assert.ok(start > 0, "TEMPLATES.gg block not found");
  const end = project.indexOf("\n};", start);
  const block = project.slice(start, end);
  for (const genre of ["shmup", "platformer", "puzzle", "sports", "racing"]) {
    assert.match(block, new RegExp(`\\n\\s+${genre}:\\s*\\{`),
      `TEMPLATES.gg must register the '${genre}' genre`);
  }
});

test("R52 R6 sprite-tile-base comment corrected on GG + SMS (not '$2000')", async () => {
  for (const p of ["gg", "sms"]) {
    const init = await readSrc(`src/platforms/${p}/lib/c/vdp_init.c`);
    // The fixed comment line is something like
    //   "R6:  sprite tile data at $0000 (set 0xFF for $2000)".
    // The buggy line was just "sprite tile data at $2000".
    assert.match(init, /sprite tile data at \$0000/,
      `${p}/vdp_init.c: R6 comment should say "$0000" (R6=0xFB clears SA13)`);
    assert.doesNotMatch(init, /R6.*sprite tile data at \$2000(?!.*0xFF)/,
      `${p}/vdp_init.c: still has the old "tiles at $2000" claim on R6`);

    // load_tiles example also corrected (used to say `0x2000, my_tiles, ... // sprite bank`).
    const load = await readSrc(`src/platforms/${p}/lib/c/load_tiles.c`);
    assert.match(load, /load_tiles\(0x0000/,
      `${p}/load_tiles.c: example should target 0x0000 to match the default R6`);
  }
});

test("R52 GG MENTAL_MODEL documents the four GG footguns", async () => {
  const doc = await readSrc("src/platforms/gg/MENTAL_MODEL.md");
  assert.match(doc, /8 sprites per scanline/i,        "missing 8-sprites-per-scanline note");
  assert.match(doc, /\$D0/,                            "missing SAT $D0 terminator note");
  assert.match(doc, /hardware[\s-]+space/i,            "missing OAM hardware-vs-visible coord note");
  assert.match(doc, /R6.*\$0000/,                      "missing R6 = $0000 correction");
});

test("R52 SMS MENTAL_MODEL documents the shared SMS/GG footguns", async () => {
  const doc = await readSrc("src/platforms/sms/MENTAL_MODEL.md");
  assert.match(doc, /\$D0/,                "missing SAT $D0 terminator note");
  assert.match(doc, /R6.*\$0000/,          "missing R6 = $0000 correction");
  // 8-sprites note already existed pre-R52 but should still be present after our edits.
  assert.match(doc, /8 sprites per scanline/i, "8-sprites-per-scanline note should remain");
});

test("R52 copyStarterSnippets writes files to disk + flattens lib/<lang>/", { timeout: 60000 }, async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { z } = await import("zod");
  const { registerTools } = await import("../src/mcp/tools/index.js");

  const server = new McpServer({ name: "r52", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "r52-c", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });

  const dst = mkdtempSync(join(tmpdir(), "r52-snip-"));
  try {
    const r = await client.callTool({
      name: "scaffold",
      arguments: { op: "copySnippets",  platform: "gg", destinationDir: dst, language: "c" },
    });
    assert.equal(r.isError, undefined, "copyStarterSnippets failed: " + JSON.stringify(r));
    const payload = JSON.parse(r.content[0].text);
    assert.ok(payload.written.length > 0, "no files reported as written");
    // Every src that lived at lib/c/foo.c should land at <dst>/foo.c, NOT <dst>/c/foo.c.
    const dstFiles = readdirSync(dst);
    assert.ok(dstFiles.includes("gg_hw.h"), "gg_hw.h didn't land at the flattened path");
    assert.ok(dstFiles.includes("vdp_init.c"), "vdp_init.c didn't land at the flattened path");
    assert.ok(!dstFiles.includes("c"), "lib/c/ subdir was not flattened — should be siblings");
    // Bytes round-trip cleanly.
    const golden = readFileSync(join(REPO_ROOT, "src/platforms/gg/lib/c/gg_hw.h"));
    const copied = readFileSync(join(dst, "gg_hw.h"));
    assert.equal(copied.length, golden.length, "byte count mismatch on copied gg_hw.h");
  } finally {
    rmSync(dst, { recursive: true, force: true });
  }
});

test("R52 sprite_init on SMS + GG no longer fills Y with $D0 (the terminator footgun)", async () => {
  for (const p of ["sms", "gg"]) {
    const src = await readSrc(`src/platforms/${p}/lib/c/sprite_table.c`);
    // The OLD body had `shadow_oam[0] = 0xD0;` + a loop filling 1..63 with 0xD0.
    // The NEW body fills with $E0 (off-screen, NOT terminator) via OAM_Y_HIDDEN.
    assert.doesNotMatch(src, /shadow_oam\[i\]\s*=\s*0x[Dd]0\s*;/,
      `${p}/sprite_table.c: should NOT initialise unused slots to $D0 — that's the renderer terminator`);
    assert.match(src, /OAM_Y_HIDDEN\s+0x[Ee]0/i,
      `${p}/sprite_table.c: should define OAM_Y_HIDDEN as $E0 (off-screen, non-terminator)`);
    assert.match(src, /shadow_oam\[i\]\s*=\s*OAM_Y_HIDDEN/,
      `${p}/sprite_table.c: sprite_init should fill with OAM_Y_HIDDEN, not a literal $D0`);
  }
});

test("R52 SDCC preflight lint reports EVERY mid-block decl in a block (not just the first)", async () => {
  const { lintSdccSource } = await import("../src/toolchains/sdcc/preflight-lint.js");
  // Two mid-block decls in the same function. Previously the linter
  // suppressed everything after the first, leading to the "warning at
  // line N, real decl at N+6" off-by-N footgun reported in feedback
  // round 24. Now both should be reported.
  const src = `
void f(void) {
    int a = 1;
    a = a + 1;             /* code — flips sawCode */
    int b = 2;             /* mid-decl #1 */
    b = b + a;
    int c = 3;             /* mid-decl #2 */
    (void)c;
}
`;
  const issues = lintSdccSource(src, "f.c");
  const midDecls = issues.filter((i) => /Mid-block declaration/.test(i.message));
  assert.equal(midDecls.length, 2,
    `expected 2 mid-block decl warnings, got ${midDecls.length}: ${JSON.stringify(midDecls.map((m) => m.line))}`);
  // Lines should be 5 and 7 (the two `int b = 2;` and `int c = 3;` decls).
  assert.deepEqual(midDecls.map((m) => m.line).sort((a, b) => a - b), [5, 7],
    "wrong line numbers reported for mid-block decls");
  // Second occurrence carries an ordinal hint so the agent knows there
  // are multiple in the block.
  assert.match(midDecls[1].message, /#2/, "second decl should be marked with ordinal");
});

test("R52 createProject({withSnippets:true}) drops snippet files alongside main", { timeout: 60000 }, async () => {
  const { createProjectImpl } = await import("../src/mcp/tools/project.js");
  const dst = mkdtempSync(join(tmpdir(), "r52-withsnip-"));
  try {
    const r = await createProjectImpl({
      platform: "gg",
      name: "withsnip-test",
      path: dst,
      withSnippets: true,
      overwrite: true,
    });
    // The "default" template's runtime already writes gg_crt0.s — that
    // collision should be skipped by withSnippets, not duplicated.
    const files = readdirSync(dst).sort();
    // Snippets we EXPECT to land beyond the default-runtime baseline:
    assert.ok(files.includes("gg_hw.h"),      "gg_hw.h should be copied via withSnippets");
    assert.ok(files.includes("vdp_init.c"),   "vdp_init.c should be copied via withSnippets");
    assert.ok(files.includes("sprite_table.c"), "sprite_table.c should be copied via withSnippets");
    assert.ok(files.includes("gg_sfx.c"),     "gg_sfx.c should be copied via withSnippets");
    // Default-runtime files still present:
    assert.ok(files.includes("gg_crt0.s"),    "gg_crt0.s should be present (from GG_DEFAULT_RUNTIME)");
    assert.ok(files.includes("main.c"),       "main.c always present");
    // No double-write:
    assert.equal(r.files.filter((f) => f === "gg_crt0.s").length, 1,
      "gg_crt0.s should appear in files exactly once");
    // snippetsCopied list is returned and non-empty:
    assert.ok(Array.isArray(r.snippetsCopied) && r.snippetsCopied.length > 0,
      "withSnippets:true should populate snippetsCopied[]");
  } finally {
    rmSync(dst, { recursive: true, force: true });
  }
});

test("R52 createProject({withSnippets:false}) is the unchanged baseline (no snippets dropped)", { timeout: 60000 }, async () => {
  const { createProjectImpl } = await import("../src/mcp/tools/project.js");
  const dst = mkdtempSync(join(tmpdir(), "r52-nosnip-"));
  try {
    const r = await createProjectImpl({
      platform: "gg",
      name: "nosnip-test",
      path: dst,
      overwrite: true,
      // withSnippets omitted — defaults to false
    });
    const files = readdirSync(dst).sort();
    assert.ok(!files.includes("vdp_init.c"),
      "without withSnippets, vdp_init.c should NOT be in the project");
    assert.equal(r.snippetsCopied, null,
      "snippetsCopied should be null when withSnippets:false");
  } finally {
    rmSync(dst, { recursive: true, force: true });
  }
});

test("R52 copyStarterSnippets honours include[] whitelist + counts files", { timeout: 30000 }, async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { z } = await import("zod");
  const { registerTools } = await import("../src/mcp/tools/index.js");

  const server = new McpServer({ name: "r52b", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "r52b-c", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: "loadCategory", arguments: { category: "all" } });

  const dst = mkdtempSync(join(tmpdir(), "r52-snip-"));
  try {
    const r = await client.callTool({
      name: "scaffold",
      arguments: { op: "copySnippets", 
        platform: "gg",
        destinationDir: dst,
        language: "c",
        include: ["vdp_init", "gg_hw"],
      },
    });
    assert.equal(r.isError, undefined);
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.written.length, 2, "include whitelist should narrow to exactly 2 files");
    const names = payload.written.map((w) => w.name).sort();
    assert.deepEqual(names, ["gg_hw", "vdp_init"], "wrong files copied for include whitelist");
    const dstFiles = readdirSync(dst).sort();
    assert.deepEqual(dstFiles, ["gg_hw.h", "vdp_init.c"], "extra files leaked into destinationDir");
  } finally {
    rmSync(dst, { recursive: true, force: true });
  }
});
