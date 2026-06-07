// Verify createProject scaffolds correctly for every platform that has a
// template — and that the resulting project actually builds via the same
// MCP tools an agent would call.
//
// Each subtest:
//   1. Calls createProject({platform, name, path}) into a tmpdir.
//   2. Confirms the expected files landed on disk.
//   3. Calls buildSource/runSource with the project's own files and
//      asserts the build succeeds. This is the contract: createProject
//      output is self-sufficient.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";

async function startClient() {
  const server = new McpServer({ name: "tpl-test", version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tpl-test-client", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

/** @param {string} json */
function parseToolJson(res) {
  assert.equal(res.isError, undefined, "tool returned isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
}

// ── Per-platform scaffold-only tests ───────────────────────────────────
// We assert: createProject writes the expected files. We DON'T attempt
// to build (each build is ~250-800ms and there are 7 platforms; better
// to keep the whole suite fast and have one e2e per platform elsewhere).
const SCAFFOLD_CHECKS = [
  { platform: "sms",     expectFiles: ["main.c", "sms_hw.h", "README.md", ".gitignore"] },
  { platform: "gg",      expectFiles: ["main.c", "README.md", ".gitignore"] },
  { platform: "c64",     expectFiles: ["main.c", "c64_registers.h", "README.md", ".gitignore"] },
  // SNES + Genesis default to C now (PVSnesLib / SGDK). The asm scaffolds
  // are still available via template:"asm".
  { platform: "snes",    expectFiles: ["main.c", "data.asm", "README.md", ".gitignore"] },
  { platform: "genesis", expectFiles: ["main.c", "README.md", ".gitignore"] },
];

for (const c of SCAFFOLD_CHECKS) {
  test(`createProject(${c.platform}) writes the expected files`, async () => {
    const client = await startClient();
    const tmp = mkdtempSync(path.join(os.tmpdir(), `tpl-${c.platform}-`));
    try {
      const res = parseToolJson(await client.callTool({
        name: "scaffold",
        arguments: { op: "project",  platform: c.platform, name: "demo", path: tmp, overwrite: true },
      }));
      assert.equal(res.platform, c.platform);
      const onDisk = readdirSync(tmp).sort();
      for (const f of c.expectFiles) {
        assert.ok(onDisk.includes(f), `expected ${f} in ${tmp} — got ${onDisk.join(", ")}`);
      }
      // README should mention romdev + the right toolchain.
      const readme = readFileSync(path.join(tmp, "README.md"), "utf-8");
      assert.ok(/romdev/.test(readme), "README missing romdev reference");
      // The build verb is `build({output:'run'|'rom'})` (the consolidated tool).
      // It must NOT cite the removed runSource/buildSource names (doc drift).
      assert.ok(/build\(\{?\s*output/.test(readme), "README missing build({output:...}) verb");
      assert.ok(!/runSource|buildSource/.test(readme), "README still cites removed runSource/buildSource");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

// ── A single end-to-end build test per new platform that confirms the
// scaffolded project actually compiles. Picks SMS (cleanest hw.h) +
// C64 (cc65 path) + SNES (asar path with incsrc snippets) + Genesis
// (vasm68k path with incsrc snippets) — covers all four toolchain
// flavors among the new templates. The other Z80 platform (gg) shares
// the SDCC z80 path validated by SMS. ───────────────────────────────

test("createProject(sms) → build succeeds end-to-end", async () => {
  const client = await startClient();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tpl-sms-build-"));
  try {
    parseToolJson(await client.callTool({
      name: "scaffold",
      arguments: { op: "project",  platform: "sms", name: "demo", path: tmp, overwrite: true },
    }));
    const sourcePath = path.join(tmp, "main.c");
    const hwPath = path.join(tmp, "sms_hw.h");
    const build = parseToolJson(await client.callTool({
      name: "build",
      arguments: { output: "rom", 
        platform: "sms",
        sourcePath,
        includePaths: { "sms_hw.h": hwPath },
      },
    }));
    assert.equal(build.ok, true, "sms build failed:\n" + build.log);
    assert.ok(build.binaryBytes > 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("createProject(c64) → build succeeds end-to-end", async () => {
  const client = await startClient();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tpl-c64-build-"));
  try {
    parseToolJson(await client.callTool({
      name: "scaffold",
      arguments: { op: "project",  platform: "c64", name: "demo", path: tmp, overwrite: true },
    }));
    const sourcePath = path.join(tmp, "main.c");
    const build = parseToolJson(await client.callTool({
      name: "build",
      arguments: { output: "rom",  platform: "c64", sourcePath },
    }));
    assert.equal(build.ok, true, "c64 build failed:\n" + build.log);
    assert.ok(build.binaryBytes > 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// R19b: SNES C-mode template (PVSnesLib). Scaffolds main.c + data.asm,
// builds via language:"c" sources map, expects a ROM ≥32KB out.
test("createProject(snes, template:c_hello) → builds via PVSnesLib runtime", async () => {
  const client = await startClient();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tpl-snes-c-"));
  try {
    const create = parseToolJson(await client.callTool({
      name: "scaffold",
      arguments: { op: "project",  platform: "snes", template: "c_hello", name: "demo", path: tmp, overwrite: true },
    }));
    // Confirm both files landed.
    const onDisk = readdirSync(tmp).sort();
    for (const f of ["main.c", "data.asm", "README.md", ".gitignore"]) {
      assert.ok(onDisk.includes(f), `missing ${f} — got ${onDisk.join(", ")}`);
    }
    // Read both files + call buildSource with sources map.
    const mainC = readFileSync(path.join(tmp, "main.c"), "utf-8");
    const dataAsm = readFileSync(path.join(tmp, "data.asm"), "utf-8");
    const build = parseToolJson(await client.callTool({
      name: "build",
      arguments: { output: "rom", 
        platform: "snes",
        language: "c",
        sources: { "main.c": mainC, "data.asm": dataAsm },
      },
    }));
    assert.equal(build.ok, true, "snes-c template build failed:\n" + build.log);
    assert.equal(build.toolchain, "tcc816+wladx");
    assert.ok(build.binaryBytes >= 32 * 1024, "expected ≥32KB ROM, got " + build.binaryBytes);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
