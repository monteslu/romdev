// decomp({op:'skill', action:'write'}) is the remedy the server names when the
// installed skill is stale, and it wrote a SECOND, thinner document than the
// one GET /skills/romdev/SKILL.md serves: no hard rule, no HTTP routes or
// sessions, no AGENTS.md body, no tool reference. Following the remedy made the
// installed skill worse. Both now come from liveSkillDoc().
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import express from "express";
import { mountHttpToolRoutes } from "../src/http/routes.js";
import { liveSkillDoc, skillPreamble } from "../src/http/skill-doc.js";

const stripStamp = (md) => md.replace(/^ {2}generated(From)?: .*\n/gm, "");

test("the written skill is the served skill, plus its generated stamp", async () => {
  const app = express();
  const { stop } = mountHttpToolRoutes(app, { version: "9.9.9" });
  try {
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const served = await (await fetch(`http://127.0.0.1:${server.address().port}/skills/romdev/SKILL.md`)).text();
    server.close();
    const written = await liveSkillDoc({ generatedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(stripStamp(written), served, "same document apart from the generated lines");
    assert.match(written, /generated: "2026-01-01T00:00:00.000Z"/);
    for (const part of [/NEVER install a host compiler/, /POST \/tool\/\{name\}/, /## Making a game/, /# TOOL REFERENCE/, /never invented/, /op:'ledger'/]) {
      assert.match(written, part);
    }
  } finally {
    stop();
  }
});

test("a process with no HTTP routes builds the same document (tool calls run in host runner processes)", async () => {
  // The first version of this fix registered the builder from routes.js, and
  // the live decomp call failed: it runs in a host runner, where no routes exist.
  const url = new URL("../src/http/skill-doc.js", import.meta.url).href;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e",
    `const { liveSkillDoc } = await import(${JSON.stringify(url)}); process.stdout.write(await liveSkillDoc());`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(out, await liveSkillDoc());
});

test("the skill sends wasmcart carts to romdev, in its trigger description and its preamble", async () => {
  const md = await liveSkillDoc();
  const description = /^description: (.*)$/m.exec(md)[1];
  assert.match(description, /wasmcart/i, "a skill that never says wasmcart is never loaded for cart work");
  assert.match(skillPreamble, /POST \/tool\/loadMedia \{\\?"platform\\?":\\?"wasmcart\\?"/);
  assert.match(skillPreamble, /cart directory/);
  assert.ok(!/\bMCP\b/.test(md), "the skill channel never mentions MCP");
});
