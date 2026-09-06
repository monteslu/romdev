// disasm-platform-contract.test.js — the disasm `platform` enum is derived
// from the capability manifest, so a platform that declares disasm/decompile
// can be named explicitly (the 0.135.1 report: n64 worked by inference and
// was REJECTED by the schema). Ties MCP + HTTP schemas to the manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CAPABILITIES } from "../src/cores/capabilities.js";
import { DISASM_PLATFORMS, supportsDisasmTarget } from "../src/mcp/tools/disasm.js";
import { buildToolRegistry, toolJsonSchema } from "../src/http/tool-registry.js";

test("every manifest platform with disasm or decompile is accepted by disasm.platform", () => {
  for (const [p, c] of Object.entries(CAPABILITIES)) {
    if (c.ops?.disasm || c.ops?.decompile) assert.ok(DISASM_PLATFORMS.includes(p), `${p} declares disasm/decompile but the schema rejects it`);
  }
  for (const p of ["n64", "ps1", "dreamcast", "nes", "snes", "genesis", "gba"]) assert.ok(DISASM_PLATFORMS.includes(p), p);
});

test("the HTTP/MCP schema carries the same enum (one registry)", () => {
  const reg = buildToolRegistry(randomUUID());
  const js = toolJsonSchema(reg.get("disasm").inputSchema);
  const en = js.properties.platform.enum;
  assert.deepEqual([...en].sort(), [...DISASM_PLATFORMS].sort());
});

test("unsupported target/platform combinations are a precise capability error, not a silent fallthrough", () => {
  assert.equal(supportsDisasmTarget("n64", "decompile"), true);
  assert.equal(supportsDisasmTarget("n64", "functions"), true);
  assert.equal(supportsDisasmTarget("n64", "project"), false, "the 8/16-bit reassembly pipeline is not the MIPS engine");
  assert.equal(supportsDisasmTarget("nes", "project"), true);
  assert.equal(supportsDisasmTarget("pico8", "source"), true);
  assert.equal(supportsDisasmTarget("pico8", "decompile"), false);
});

test("decomp tool is registered with its op surface", () => {
  const reg = buildToolRegistry(randomUUID());
  assert.ok(reg.has("decomp"));
  const js = toolJsonSchema(reg.get("decomp").inputSchema);
  for (const op of ["import", "resolve", "generate", "compare", "search", "job", "integrate", "progress", "smoke"]) assert.ok(js.properties.op.enum.includes(op), op);
});
