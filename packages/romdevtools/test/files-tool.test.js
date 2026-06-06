// `files` tool (consolidation of writeAsset/readAsset/listAssets) — round-trip.
// These three were previously untested; the consolidation adds coverage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFileCore, readFileCore, listFilesCore } from "../src/mcp/tools/assets.js";

test("files: write → read text round-trips", async () => {
  const p = join(tmpdir(), `romdev-files-${Date.now()}-a.txt`);
  const w = await writeFileCore({ path: p, text: "hello consolidation" });
  assert.equal(w.bytes, "hello consolidation".length);
  const r = await readFileCore({ path: p });
  assert.equal(r.text, "hello consolidation");
});

test("files: write base64 → read base64 round-trips", async () => {
  const p = join(tmpdir(), `romdev-files-${Date.now()}-b.bin`);
  const b64 = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]).toString("base64");
  await writeFileCore({ path: p, base64: b64 });
  const r = await readFileCore({ path: p, as: "base64" });
  assert.equal(r.base64, b64);
});

test("files: read honors the maxBytes cap (no silent huge dump)", async () => {
  const p = join(tmpdir(), `romdev-files-${Date.now()}-c.txt`);
  await writeFileCore({ path: p, text: "x".repeat(1000) });
  const r = await readFileCore({ path: p, maxBytes: 100 });
  assert.equal(r.truncated, true);
  assert.match(r.note, /raise maxBytes/i);
});

test("files: write requires text or base64", async () => {
  await assert.rejects(
    writeFileCore({ path: join(tmpdir(), "nope.txt") }),
    /either `text` or `base64`/,
  );
});

test("files: list filters by pattern", async () => {
  const tag = `romdev-list-${Date.now()}`;
  const p = join(tmpdir(), `${tag}-one.txt`);
  await writeFileCore({ path: p, text: "x" });
  const l = await listFilesCore({ path: tmpdir(), pattern: tag });
  assert.ok(l.count >= 1);
  assert.ok(l.items.every((i) => i.name.includes(tag)));
});
