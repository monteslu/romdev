// Tests for getPlatformDoc + listPlatformDocs.
//
// Verifies the docs shipped for nes/gb/snes/genesis/sms/atari7800/
// atari2600 are actually readable through the MCP tool surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DOC_PLATFORMS = ["nes", "gb", "gbc", "snes", "genesis", "sms", "gg", "lynx", "atari7800", "atari2600", "c64", "gba"];

// We can't easily spin up a full McpServer in a unit test; instead we
// shim a minimal server interface that records the registered tools so
// we can invoke them as plain functions. This matches how the other
// tool tests in this repo work.
function makeShim() {
  const tools = {};
  return {
    server: {
      tool(name, _desc, _schema, fn) {
        tools[name] = fn;
      },
    },
    tools,
  };
}

test("listPlatformDocs returns the shipped docs for every platform that has them", async () => {
  const { registerPlatformDocsTools } = await import("./platform-docs.js");
  const { server, tools } = makeShim();
  const z = { string: () => ({ describe: () => ({}) }) };
  registerPlatformDocsTools(server, z);

  for (const platform of DOC_PLATFORMS) {
    const result = await tools.listPlatformDocs({ platform });
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    assert.equal(parsed.platform, platform);
    assert.ok(Array.isArray(parsed.docs), `${platform}: docs not an array`);
    // mental_model must be one of them
    const names = parsed.docs.map((d) => d.name).sort();
    assert.ok(names.includes("mental_model"), `${platform}: no mental_model in ${JSON.stringify(names)}`);
    assert.ok(names.includes("troubleshooting"), `${platform}: no troubleshooting in ${JSON.stringify(names)}`);
  }
});

test("getPlatformDoc fetches the full file contents", async () => {
  const { registerPlatformDocsTools } = await import("./platform-docs.js");
  const { server, tools } = makeShim();
  const z = { string: () => ({ describe: () => ({}) }) };
  registerPlatformDocsTools(server, z);

  const r = await tools.getPlatformDoc({ platform: "genesis", name: "mental_model" });
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.platform, "genesis");
  assert.equal(parsed.name, "mental_model");
  assert.equal(parsed.file, "MENTAL_MODEL.md");
  assert.match(parsed.contents, /Sega Genesis|Mega Drive/);
  assert.ok(parsed.contents.length > 1000, "doc too short");
});

test("getPlatformDoc rejects unknown name", async () => {
  const { registerPlatformDocsTools } = await import("./platform-docs.js");
  const { server, tools } = makeShim();
  const z = { string: () => ({ describe: () => ({}) }) };
  registerPlatformDocsTools(server, z);

  const r = await tools.getPlatformDoc({ platform: "nes", name: "wrong_doc" });
  // safeTool returns errors as isError content, not throws
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unknown doc/);
});

test("getPlatformDoc serves the cross-platform romhacking playbook", async () => {
  const { registerPlatformDocsTools } = await import("./platform-docs.js");
  const { server, tools } = makeShim();
  const z = { string: () => ({ describe: () => ({}) }) };
  registerPlatformDocsTools(server, z);

  // listPlatformDocs surfaces it under the pseudo-platform.
  const list = JSON.parse((await tools.listPlatformDocs({ platform: "romhacking" })).content[0].text);
  assert.ok(list.docs.some((d) => d.name === "playbook"), "playbook not listed");

  const r = await tools.getPlatformDoc({ platform: "romhacking", name: "playbook" });
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.platform, "romhacking");
  assert.equal(parsed.name, "playbook");
  // Hits the key decision-tree points the feedback asked for.
  assert.match(parsed.contents, /searchValue/);
  assert.match(parsed.contents, /readCartRom/);
  assert.match(parsed.contents, /pre-rendered/i);
  assert.match(parsed.contents, /classifyRegion/);
  assert.ok(parsed.contents.length > 1500, "playbook too short");
});

test("getPlatformDoc returns helpful error for platform with no doc", async () => {
  const { registerPlatformDocsTools } = await import("./platform-docs.js");
  const { server, tools } = makeShim();
  const z = { string: () => ({ describe: () => ({}) }) };
  registerPlatformDocsTools(server, z);

  // We need a sentinel platform that intentionally has no docs.
  // History: c64 used to be the sentinel (R25 added docs); gg was next
  // (R36 added docs); msx was next but that platform is now removed.
  // Every shipped platform has docs, so use a nonexistent id as the sentinel.
  const r = await tools.getPlatformDoc({ platform: "nonexistent", name: "mental_model" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /No MENTAL_MODEL.md for platform 'nonexistent'/);
});
