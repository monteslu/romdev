// HTTP tool surface — POST /tool/:name + /openapi.json + /romdev/SKILL.md +
// /tool/:name/schema, all generated from the one tool registry. Tests the
// generators + the runTool validate-then-run path directly (no live server
// needed); a couple assert the registry/handler wiring end to end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildToolRegistry, runTool, toolJsonSchema } from "../src/http/tool-registry.js";
import { buildOpenApi } from "../src/http/routes.js";
import { buildSkillDoc, skillToolReference, mcpPreamble, skillPreamble } from "../src/http/skill-doc.js";
import { swaggerHtml, swaggerAsset } from "../src/http/swagger.js";
import { observer } from "../src/observer/bus.js";

test("runTool emits observer `call` events so /livestream updates for HTTP/skill calls", async () => {
  const reg = buildToolRegistry("sess-live");
  const got = [];
  const onEvent = (e) => { if (e.type === "call") got.push(e); };
  observer.on("event", onEvent);
  try {
    await runTool(reg.get("catalog"), { op: "status" }, "sess-live");   // ok
    await runTool(reg.get("catalog"), { op: "bogus" }, "sess-live");    // error
  } finally {
    observer.off?.("event", onEvent);
  }
  const mine = got.filter((e) => e.sessionKey === "sess-live");
  assert.ok(mine.length >= 2, "two call events emitted");
  assert.equal(mine[0].tool, "catalog");
  assert.equal(mine[0].ok, true);
  assert.equal(typeof mine[0].durationMs, "number");
  assert.equal(mine[1].ok, false, "error call emits ok:false");
  assert.match(mine[1].error, /must be one of/);
  // platform field is present (null here — no ROM loaded in this session). The
  // KEY is the field exists so the livestream can show the system; a loaded-ROM
  // session carries the platform string (covered by the build test below).
  assert.ok("platform" in mine[0], "call event carries a platform field (null until a ROM loads)");
});

test("observer `call` event carries the loaded platform/system (livestream shows which console)", async () => {
  const sk = "sess-plat-" + randomUUID().slice(0, 8);
  const reg = buildToolRegistry(sk);
  const got = [];
  const onEvent = (e) => { if (e.sessionKey === sk) got.push(e); };
  observer.on("event", onEvent);
  const dir = await mkdtemp(join(tmpdir(), "plat-ev-"));
  try {
    await runTool(reg.get("scaffold"), { op: "game", platform: "nes", genre: "shmup", name: "g", path: join(dir, "nes") }, sk);
    await runTool(reg.get("build"), { output: "run", platform: "nes", path: join(dir, "nes"), frames: 20 }, sk);
    await runTool(reg.get("frame"), { op: "verify" }, sk);
  } finally {
    observer.off?.("event", onEvent);
    await rm(dir, { recursive: true, force: true });
  }
  // After a ROM is loaded, the call event for a frame op carries platform:'nes'
  // (so the human watching /livestream sees the system, not just the tool name).
  const frameEv = got.find((e) => e.tool === "frame");
  assert.ok(frameEv, "frame call event emitted");
  assert.equal(frameEv.platform, "nes", "frame call event carries platform:'nes'");
});

test("registry harvests the full consolidated tool surface with handler + schema", () => {
  const reg = buildToolRegistry(randomUUID());
  // Don't hardcode the count (it shifts as tools consolidate — e.g. dmaTrace→
  // watch({on:'dma'}), patchGbHeader→romPatch({op:'gbHeader'})). Just guard the
  // budget ceiling the manifest test owns, and a sane floor.
  assert.ok(reg.size >= 28 && reg.size <= 35, `tool count ${reg.size} outside the consolidated 28..35 range`);
  for (const [name, t] of reg) {
    assert.equal(typeof t.handler, "function", `${name} has a handler`);
    const js = toolJsonSchema(t.inputSchema);
    assert.equal(js.type, "object", `${name} schema is an object`);
    // strict → additionalProperties false (the unknown-param guard)
    assert.equal(js.additionalProperties, false, `${name} schema is strict`);
  }
});

test("runTool: valid call returns parsed JSON result", async () => {
  const reg = buildToolRegistry(randomUUID());
  const out = await runTool(reg.get("catalog"), { op: "categories" });
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.result.categories), "categories array returned");
});

test("runTool: bad enum → clean 'must be one of' (not a JSON dump)", async () => {
  const reg = buildToolRegistry(randomUUID());
  const out = await runTool(reg.get("catalog"), { op: "bogus" });
  assert.equal(out.ok, false);
  assert.match(out.error, /'op' must be one of: categories \| status/);
});

test("runTool: unknown/misspelled param → did-you-mean (not silently dropped)", async () => {
  const reg = buildToolRegistry(randomUUID());
  const out = await runTool(reg.get("memory"), { op: "read", region: "system_ram", addr: 5 });
  assert.equal(out.ok, false);
  assert.match(out.error, /unknown parameter 'addr'/);
  assert.match(out.error, /Did you mean 'offset'/);
});

test("runTool: wrong type → clean message", async () => {
  const reg = buildToolRegistry(randomUUID());
  const out = await runTool(reg.get("memory"), { op: "read", region: "system_ram", offset: "x" });
  assert.equal(out.ok, false);
  assert.match(out.error, /'offset' must be a number/);
});

test("sticky session: two calls on the same key share host state; different keys are isolated", async () => {
  // catalog({op:'status'}) reflects per-session host; build two registries with
  // different keys → independent. (Full load→read is covered live; here we assert
  // the registry-per-session model gives distinct handler closures.)
  const a = buildToolRegistry("sess-A");
  const b = buildToolRegistry("sess-B");
  assert.notEqual(a.get("memory").handler, b.get("memory").handler, "distinct per-session handlers");
});

test("OpenAPI: one POST /tool/{name} path per tool, with requestBody schema", () => {
  const reg = buildToolRegistry("__meta__");
  const oa = buildOpenApi(reg, "9.9.9");
  assert.equal(oa.openapi, "3.1.0");
  assert.equal(oa.info.version, "9.9.9");
  assert.equal(Object.keys(oa.paths).length, reg.size);
  const mem = oa.paths["/tool/memory"].post;
  assert.ok(mem.summary.length > 0);
  assert.equal(mem.requestBody.required, true);
  assert.ok(mem.requestBody.content["application/json"].schema.properties.op, "op in requestBody schema");
  // the session header is documented
  assert.ok(mem.parameters.some((p) => p.name === "x-romdev-session"));
});

test("skill doc: frontmatter + skill preamble + body + tool reference; no MCP mention", () => {
  const reg = buildToolRegistry("__meta__");
  const md = buildSkillDoc({ registry: reg, agentsBody: "## Body\nshared knowledge", version: "1.2.3" });
  assert.match(md, /^---\nname: romdev/);
  assert.match(md, /description: Homebrew retro game/);
  assert.match(md, /POST \/tool\/\{name\}/);
  assert.match(md, /# TOOL REFERENCE/);
  assert.match(md, /## memory/);
  assert.match(md, /shared knowledge/, "shared AGENTS body included");
  // CHANNEL SPLIT: the skill doc must NOT mention MCP.
  assert.ok(!/\bMCP\b/.test(md), "skill doc must not mention MCP");
});

test("sanitizer scrubs MCP-connection FRAMING from the body (not just the literal 'MCP')", () => {
  // The real AGENTS.md uses some MCP-channel framing ("this server", "connect
  // your agent", "MCP", reconnect). None of that should reach the skill surface.
  // (The opening line is channel-neutral now, so it's NOT scrubbed — it's fine on
  // both channels — but any remaining MCP-only framing in the body must be.)
  const agentsLike = [
    "# romdev — Agent guide",
    "",
    "This is romdev's generic orientation. Read it once.",
    "",
    "## What this server does",
    "Drives the build loop. Anything else this server can do.",
    "These MCP tools run in-process. Restart its MCP connection once if needed.",
    "When in doubt, connect your agent and go.",
  ].join("\n");
  const md = buildSkillDoc({ registry: buildToolRegistry("__meta__"), agentsBody: agentsLike, version: "1.0.0" });
  assert.ok(!/\bMCP\b/.test(md), "no literal MCP");
  assert.ok(!/connect your agent/i.test(md), "no 'connect your agent'");
  assert.ok(!/this server/i.test(md), "no 'this server' connection framing");
  assert.ok(!/restart its MCP connection|MCP connection/i.test(md), "no reconnect instruction");
  assert.match(md, /## What romdev does/, "header re-framed to 'What romdev does'");
});

test("channel preambles are disjoint: mcp mentions MCP-calling, skill mentions routes; neither mentions the other", () => {
  assert.match(mcpPreamble, /register at session init|call any by name/i);
  assert.ok(!/POST \/tool/.test(mcpPreamble), "mcp preamble has no HTTP routes");
  assert.match(skillPreamble, /POST \/tool/);
  assert.ok(!/\bMCP\b/.test(skillPreamble), "skill preamble has no MCP");
});

test("swagger HTML renders the title, points at the spec, and uses NO CDN (local assets only)", () => {
  const html = swaggerHtml({ specUrl: "/openapi.json", title: "romdev API" });
  assert.match(html, /<title>romdev API<\/title>/);
  assert.match(html, /\/openapi\.json/);
  assert.match(html, /\/romdev\/SKILL\.md/, "offline fallback links the skill doc");
  // self-hosted: references our local /documentation/* assets, never a CDN.
  assert.match(html, /\/documentation\/swagger-ui\.css/);
  assert.match(html, /\/documentation\/swagger-ui-bundle\.js/);
  assert.ok(!/cdn|jsdelivr|https?:\/\//i.test(html), "no external/CDN URLs in the docs page");
});

test("swagger assets are served from bundled swagger-ui-dist (offline), path-traversal blocked", () => {
  assert.ok(swaggerAsset("swagger-ui.css")?.length > 1000, "css served from local dist");
  assert.ok(swaggerAsset("swagger-ui-bundle.js")?.length > 1000, "js served from local dist");
  assert.equal(swaggerAsset("../package.json"), null, "no path traversal");
  assert.equal(swaggerAsset("evil.js"), null, "only known asset names");
});

test("skillToolReference lists every tool with its POST params", () => {
  const reg = buildToolRegistry("__meta__");
  const ref = skillToolReference(reg);
  for (const name of reg.keys()) assert.ok(ref.includes(`## ${name}`), `${name} in reference`);
  assert.match(ref, /POST \/tool\/memory` params:/);
});
