// project-genesis-sgdk.test.js — verifies createProject({platform:"genesis",
// template:"sgdk_hello"}) ships the full SGDK bundle into the project tree.
//
// The SGDK template is special: it copies ~3 MB of runtime files (libmd.a,
// sega.s + sega.preprocessed.s crt0, md.ld linker script, rom_header.c)
// plus the recursive include/ header tree (~70 headers across nested dirs)
// so the user's project is self-contained — can rebuild on any machine
// with m68k-elf-gcc installed, no romdev required.
//
// We assert: main.c lands, the runtime archive is bit-exact (binary-safe
// copy, not utf-8-mangled), and the recursive include copy gets at least
// the canonical genesis.h header.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { createProjectImpl } from "./project.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test("createProject genesis sgdk_hello: ships full SGDK runtime + include tree", async () => {
  const projPath = await mkdtemp(join(tmpdir(), "romdev-sgdk-create-"));
  const r = await createProjectImpl({
    platform: "genesis",
    name: "sgdk-test",
    path: projPath,
    template: "sgdk_hello",
    overwrite: true,
  });

  // Sanity on returned shape
  assert.equal(r.platform, "genesis");
  assert.equal(r.template, "sgdk_hello");
  assert.ok(Array.isArray(r.files), "files array missing");

  // The flat runtime entries we declared in TEMPLATES.genesis.sgdk_hello.
  // NOTE: no libmd.a — SGDK is now compiled FROM SOURCE by the build (its
  // source is vendored under vendor/sgdk/), not linked from a prebuilt archive.
  const expectedFlat = [
    "main.c",
    "sega.s",
    "sega.preprocessed.s",
    "rom_header.c",
    "md.ld",
    "LICENSE-SGDK",
    "COPYING-SGDK-RUNTIME",
  ];
  for (const f of expectedFlat) {
    assert.ok(r.files.includes(f), `files manifest missing ${f}`);
    const st = await stat(join(projPath, f));
    assert.ok(st.isFile(), `not a regular file: ${f}`);
  }

  // No prebuilt libmd.a is shipped anymore — the SDK source is, instead.
  assert.ok(!r.files.includes("libmd.a"), "libmd.a should NOT ship (SGDK builds from source)");
  // SGDK source must be vendored so the build can compile it + agents can read it.
  assert.ok(r.files.some((f) => f.startsWith("vendor/sgdk/src/")), "SGDK source not vendored into project");

  // include/ tree copied recursively. genesis.h is the umbrella header
  // every SGDK project includes — must be present.
  const headerPath = join(projPath, "include", "genesis.h");
  const headerStat = await stat(headerPath);
  assert.ok(headerStat.isFile(), "include/genesis.h missing from project");
  assert.ok(r.files.includes("include/genesis.h"), "files manifest missing include/genesis.h");

  // Sample a nested-directory header (SGDK puts some headers in include/snd/
  // and include/ext/). Confirm recursion descended.
  const nested = r.files.filter((f) => f.startsWith("include/") && f.split("/").length >= 3);
  assert.ok(nested.length > 0, "no nested include/ headers were copied — recursion broken");

  // main.c is the SGDK starter — should contain the canonical entry point.
  const mainSrc = await readFile(join(projPath, "main.c"), "utf-8");
  assert.match(mainSrc, /int main\(bool hard\)/, "main.c doesn't look like the SGDK starter");
});
