// R25 C64 template parity tests. Adds hello_sprite + tile_engine on
// top of the existing default; createProject scaffolds them and the
// resulting source files build via the cc65 path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

async function readSource(rel) {
  return readFile(join(REPO_ROOT, rel), "utf-8");
}

const C64_TEMPLATES = ["hello_sprite", "tile_engine"];

test("R25 C64 hello_sprite + tile_engine build via buildForPlatform", { timeout: 120000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const hdr = await readSource("src/platforms/c64/lib/c64_registers.h");
  for (const t of C64_TEMPLATES) {
    const main = await readSource(`examples/c64/templates/${t}.c`);
    const r = await buildForPlatform({
      platform: "c64",
      language: "c",
      source: main,
      includes: { "c64_registers.h": hdr },
    });
    assert.equal(r.ok, true, `c64/${t} build failed at ${r.stage}: ${(r.log || "").slice(-300)}`);
    // .prg starts with a 2-byte little-endian load address. cc65 defaults to $0801.
    assert.equal(r.binary[0], 0x01, `c64/${t}: load-address low byte wrong`);
    assert.equal(r.binary[1], 0x08, `c64/${t}: load-address high byte wrong`);
  }
});

test("R25 createProject scaffolds the new C64 templates with the runtime header", async () => {
  const { createProjectImpl } = await import("../src/mcp/tools/project.js");
  for (const t of C64_TEMPLATES) {
    const projPath = await mkdtemp(join(tmpdir(), `r25-c64-${t}-`));
    const r = await createProjectImpl({
      platform: "c64",
      name: `c64-${t}`,
      path: projPath,
      template: t,
      overwrite: true,
    });
    assert.equal(r.platform, "c64");
    assert.equal(r.template, t);
    assert.ok(r.files.includes("main.c"), `${t}: no main.c in files`);
    assert.ok(r.files.includes("c64_registers.h"), `${t}: no c64_registers.h in files`);
    // R25 also ships MENTAL_MODEL + TROUBLESHOOTING via the R22 auto-copy
    // since createProject now copies them into the project tree when they
    // exist for the platform.
    assert.ok(r.files.includes("MENTAL_MODEL.md"), `${t}: missing MENTAL_MODEL.md`);
    assert.ok(r.files.includes("TROUBLESHOOTING.md"), `${t}: missing TROUBLESHOOTING.md`);
  }
});
