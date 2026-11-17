// decomp({op:'skill', action:'write'}) is the remedy the server names when the
// installed skill is stale, and it wrote a SECOND, thinner document than the
// one GET /skills/romdev/SKILL.md serves: no hard rule, no HTTP routes or
// sessions, no AGENTS.md body, no tool reference. Following the remedy made the
// installed skill worse. Both now come from buildSkillDoc.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mountHttpToolRoutes } from "../src/http/routes.js";
import { currentSkillDoc, skillPreamble } from "../src/http/skill-doc.js";

test("the written skill is the served skill, plus its generated stamp", async () => {
  const app = express();
  const { stop } = mountHttpToolRoutes(app, { agentsBody: "## Body\nshared knowledge", version: "9.9.9" });
  try {
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const served = await (await fetch(`http://127.0.0.1:${server.address().port}/skills/romdev/SKILL.md`)).text();
    server.close();
    const written = currentSkillDoc({ generatedAt: "2026-01-01T00:00:00.000Z" });
    const strip = (md) => md.replace(/^ {2}generated(From)?: .*\n/gm, "");
    assert.equal(strip(written), served, "same document apart from the generated lines");
    assert.match(written, /generated: "2026-01-01T00:00:00.000Z"/);
    for (const part of [/NEVER install a host compiler/, /POST \/tool\/\{name\}/, /shared knowledge/, /# TOOL REFERENCE/, /never invented/, /op:'ledger'/]) {
      assert.match(written, part);
    }
  } finally {
    stop();
  }
});

test("the skill sends wasmcart carts to romdev, in its trigger description and its preamble", () => {
  const md = currentSkillDoc();
  const description = /^description: (.*)$/m.exec(md)[1];
  assert.match(description, /wasmcart/i, "a skill that never says wasmcart is never loaded for cart work");
  assert.match(skillPreamble, /POST \/tool\/loadMedia \{\\?"platform\\?":\\?"wasmcart\\?"/);
  assert.match(skillPreamble, /cart directory/);
});
