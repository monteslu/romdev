// cheats slot lifecycle (v0.41.0 feedback 213831 #3): applying a freeze on an
// address that already has one must REPLACE it (not stack two that fight over the
// byte), and op:'remove' must drop ONE cheat by slot/code without clearing the
// rest (op:'clear' is the nuke-all).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { registerCheatTools } from "../src/mcp/tools/cheats.js";
import { resetHost, clearHost } from "../src/mcp/state.js";
import { resolveCore } from "../src/cores/registry.js";

function tool(sessionKey) {
  const map = {};
  registerCheatTools({ tool: (n, _d, _s, h) => { map[n] = h; } }, z, sessionKey);
  return map.cheats;
}
const parse = (r) => JSON.parse(r.content.find((c) => c.type === "text").text);

test("apply REPLACES a same-address freeze; remove drops one; clear nukes all", { timeout: 60000 }, async () => {
  const key = "cheat-lifecycle";
  let romPath = null;
  for (const c of [process.env.HOME + "/code/cliemu/homebrew_collection/nes/robotfindskitten.nes"]) {
    try { await readFile(c); romPath = c; break; } catch { /* next */ }
  }
  if (!romPath) { console.log("no NES ROM fixture; skipping"); return; }

  const cheats = tool(key);
  const host = resetHost(key);
  const core = resolveCore("nes");
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "nes", bytes: new Uint8Array(await readFile(romPath)), virtualName: "/rom.nes" });
  host.stepFrames(60);
  try {
    // 1. apply a freeze on $5C
    let r = parse(await cheats({ op: "apply", code: "005C:02" }));
    assert.deepEqual(r.active.map((c) => c.code), ["005C:02"]);

    // 2. apply a DIFFERENT value on the SAME address → replaces (no stacking)
    r = parse(await cheats({ op: "apply", code: "005C:03" }));
    assert.equal(r.replacedSameAddress, true, "swapped, not stacked");
    assert.deepEqual(r.active.map((c) => c.code), ["005C:03"], "only one cheat on $5C");

    // 3. an unrelated freeze coexists
    r = parse(await cheats({ op: "apply", code: "0032:09" }));
    assert.equal(r.active.length, 2);

    // 4. remove ONLY the $5C freeze (by code) — the $32 one survives
    r = parse(await cheats({ op: "remove", code: "005C:03" }));
    assert.equal(r.removed, true);
    assert.deepEqual(r.active.map((c) => c.code), ["0032:09"], "remove dropped only $5C");

    // 5. remove by an unrelated/absent code reports removed:false, leaves state
    r = parse(await cheats({ op: "remove", code: "9999:01" }));
    assert.equal(r.removed, false);
    assert.equal(r.active.length, 1);

    // 6. clear nukes all
    r = parse(await cheats({ op: "clear" }));
    assert.equal(r.active.length, 0);
  } finally {
    clearHost(key);
  }
});

test("remove requires slot or code", { timeout: 60000 }, async () => {
  const key = "cheat-lifecycle-2";
  let romPath = null;
  for (const c of [process.env.HOME + "/code/cliemu/homebrew_collection/nes/robotfindskitten.nes"]) {
    try { await readFile(c); romPath = c; break; } catch { /* next */ }
  }
  if (!romPath) return;
  const cheats = tool(key);
  const host = resetHost(key);
  const core = resolveCore("nes");
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "nes", bytes: new Uint8Array(await readFile(romPath)), virtualName: "/rom.nes" });
  try {
    const res = await cheats({ op: "remove" });
    assert.equal(res.isError, true);
    assert.match(res.content.find((c) => c.type === "text").text, /provide `slot` .* or `code`/);
  } finally {
    clearHost(key);
  }
});
