// 0.30.0 RE-tooling round (from v0.28.0 NES reverse-engineering feedback):
//   #1  op:'searchUnknown' — Cheat-Engine unknown-initial-value hunt: seed the
//       WHOLE region, narrow by dec/inc/changed across events (find the
//       lives/timer address you can't see).
//   #3  op:'diff' direction/range filters (changeDir/deltaEq/before*/after*) so
//       a 537-byte death diff returns the ~3 rows you want.
//   #2b op:'diff' honors outputPath (+ echo:false) like op:'read' does.
//   #2a op:'readCart' by banked {cpuAddress, bank} — the inverse of the
//       breakpoint result's bank/prgOffset.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { registerMemoryTools } from "../src/mcp/tools/memory.js";
import { registerWatchMemoryTools } from "../src/mcp/tools/watch-memory.js";
import { _setHostForTest } from "../src/mcp/state.js";

const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

function toolHandler(registerFn, toolName, sessionKey) {
  const map = {};
  registerFn({ tool: (n, _d, _s, h) => { map[n] = h; } }, z, sessionKey);
  return map[toolName];
}

function fakeMemHost(initial, platform = "nes", cartRaw = null) {
  const mem = Uint8Array.from(initial);
  return {
    status: { platform, loaded: true, frameCount: 0 },
    readMemory(_region, offset = 0, length) {
      const end = length != null ? offset + length : mem.length;
      return mem.slice(offset, end);
    },
    regionSize() { return mem.length; },
    writeMemory(_region, offset, bytes) { mem.set(bytes, offset); },
    getCartRom() {
      if (!cartRaw) throw new Error("no cart");
      const headerSkipped = platform === "nes" ? 16 : 0;
      return { bytes: cartRaw.subarray(headerSkipped), raw: cartRaw, base: 0, headerSkipped, mapped: true, platform, note: "test" };
    },
  };
}

test("#1 op:'searchUnknown' seeds the whole region, then dec-narrows to the hidden byte", async () => {
  const key = "su";
  const host = fakeMemHost(new Uint8Array(256));
  host.writeMemory("system_ram", 0x50, Uint8Array.from([7]));   // the hidden "lives"
  _setHostForTest(key, host);
  const memory = toolHandler(registerMemoryTools, "memory", key);

  const seed = parse(await memory({ op: "searchUnknown", region: "system_ram", name: "h" }));
  assert.equal(seed.count, 256, "searchUnknown seeds EVERY byte (no value filter)");
  assert.equal(seed.mode, "unknown");

  // lose a life (7->6) while another byte wiggles UP — dec must isolate the life
  host.writeMemory("system_ram", 0x50, Uint8Array.from([6]));
  host.writeMemory("system_ram", 0x60, Uint8Array.from([255]));
  const r1 = parse(await memory({ op: "searchNext", name: "h", compare: "dec" }));
  // lose another (6->5); dec again
  host.writeMemory("system_ram", 0x50, Uint8Array.from([5]));
  const r2 = parse(await memory({ op: "searchNext", name: "h", compare: "dec" }));
  assert.equal(r2.count, 1, "two dec-narrows isolate the lives byte");
  assert.match(r2.candidates[0], /^0x50=/);
  assert.ok(r1.count >= 1);
});

test("#3 op:'diff' direction/range filters isolate 'decreased by exactly 1 from a small value'", async () => {
  const key = "df";
  const host = fakeMemHost(new Uint8Array(256));
  host.writeMemory("system_ram", 0x40, Uint8Array.from([5, 200, 137])); // lives, score, junk
  _setHostForTest(key, host);
  const memory = toolHandler(registerMemoryTools, "memory", key);

  await memory({ op: "snapshot", region: "system_ram", name: "t" });
  // lives 5->4 (dec 1, small); score 200->210 (+10); junk 137->5 (dec big)
  host.writeMemory("system_ram", 0x40, Uint8Array.from([4, 210, 5]));

  const r = parse(await memory({ op: "diff", region: "system_ram", name: "t", view: "raw", changeDir: "dec", beforeMax: 9, deltaEq: -1 }));
  assert.equal(r.filterMatches, 1, "filters keep ONLY the lives byte");
  assert.equal(r.changes[0].offset, "0x40");
  assert.equal(r.changes[0].before, "05");
  assert.equal(r.changes[0].after, "04");

  // changeDir:'dec' alone keeps lives + junk (both went down), not score
  const r2 = parse(await memory({ op: "diff", region: "system_ram", name: "t", view: "raw", changeDir: "dec" }));
  assert.equal(r2.filterMatches, 2);
});

test("#2b op:'diff' honors outputPath; echo:false returns a slim envelope", async () => {
  const key = "do";
  const host = fakeMemHost(new Uint8Array(64));
  _setHostForTest(key, host);
  const memory = toolHandler(registerMemoryTools, "memory", key);
  const dir = mkdtempSync(join(tmpdir(), "diffout-"));
  try {
    await memory({ op: "snapshot", region: "system_ram", name: "t" });
    host.writeMemory("system_ram", 0, Uint8Array.from([1, 2, 3]));
    const out = join(dir, "d.json");
    const r = parse(await memory({ op: "diff", region: "system_ram", name: "t", view: "raw", outputPath: out, echo: false }));
    assert.equal(r.echo, false);
    assert.ok(!("changes" in r), "echo:false omits the heavy changes array");
    assert.equal(r.path, out);
    const fileData = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(fileData.changes.length, 3, "the FULL diff is written to disk");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#4 condition:'equals' — core handles it when supported (conditionApplied)", async () => {
  // Fake host whose watchpoint supports the condition export: it only 'hits'
  // when the (pretend) written value equals the requested conditionValue.
  let armedCond = null;
  const host = {
    status: { platform: "nes", loaded: true, frameCount: 0 },
    watchpointSupported: () => true,
    setWatchpoint: (_a, _en, opts) => { armedCond = opts?.condition ?? null; return { conditionApplied: !!opts?.condition }; },
    stepFrames: () => {},
    getWatchpoint: () => (armedCond === "equals"
      ? { hits: 1, lastPC: 0x8123, lastValue: 0x01, lastOldValue: 0x00 }
      : { hits: 0 }),
    getRegSnapshot: () => null,
  };
  _setHostForTest("bpc", host);
  const bp = toolHandler(registerWatchMemoryTools, "breakpoint", "bpc");
  const r = parse(await bp({ on: "write", precision: "exact", address: 0x0528, condition: "equals", conditionValue: 1, maxFrames: 3 }));
  assert.equal(r.found, true);
  assert.equal(r.condition, "equals");
  assert.equal(r.valueByte, "0x01");
  assert.equal(r.oldValueByte, "0x00", "the core's pre-write byte is surfaced");
  assert.ok(!("conditionAppliedBy" in r), "core handled it — not the host fallback");
});

test("#4 condition:'equals' requires conditionValue", async () => {
  const host = { status: { platform: "nes" }, watchpointSupported: () => true,
    setWatchpoint: () => ({ conditionApplied: false }), stepFrames: () => {}, getWatchpoint: () => ({ hits: 0 }) };
  _setHostForTest("bpc2", host);
  const bp = toolHandler(registerWatchMemoryTools, "breakpoint", "bpc2");
  const res = await bp({ on: "write", precision: "exact", address: 0x10, condition: "equals" });
  const text = res.content.find((c) => c.type === "text").text;
  assert.match(text, /conditionValue.*required/, "missing conditionValue is reported as an error");
});

test("#2a op:'readCart' maps a banked CPU address to PRG bytes (NES)", async () => {
  const key = "rc";
  // Minimal iNES: header (16B, 2×16KB PRG => 32KB) + PRG filled so $C000 is identifiable.
  const prgSize = 32 * 1024;
  const raw = new Uint8Array(16 + prgSize);
  raw.set([0x4e, 0x45, 0x53, 0x1a, 2, 0, 0, 0]); // NES\x1a, 2 PRG banks (32KB), mapper 0
  // mark the top-bank start ($C000 => prgOffset 0x4000 => fileOffset 0x4010) with a signature
  raw.set([0xAA, 0xBB, 0xCC, 0xDD], 16 + 0x4000);
  const host = fakeMemHost(new Uint8Array(64), "nes", raw);
  _setHostForTest(key, host);
  const memory = toolHandler(registerMemoryTools, "memory", key);

  const r = parse(await memory({ op: "readCart", cpuAddress: 0xC000, length: 4 }));
  assert.equal(r.cpuAddress, "0xC000");
  assert.equal(r.hex, "aabbccdd", "cpuAddress $C000 reads the fixed top bank");
  assert.equal(r.fileOffset, "0x4010");
});

// #5 schema slim — the inlined ~62-value region enum was dropped from the
// secondary region sub-params (validated at runtime instead). On runUntil the
// old enum was also a STALE 8-value list that wrongly schema-rejected valid
// non-NES regions. Prove the region sub-params now accept the full canonical
// set, and that the ONE primary discoverable enum (watch on:'mem' region) is
// intentionally kept.
function captureSchema(registerFn, toolName) {
  const schemas = {};
  registerFn({ tool: (n, _d, s) => { schemas[n] = s; } }, z, "schema-probe");
  return schemas[toolName];
}

test("#5 runUntil region accepts non-NES regions (old 8-value enum is gone, runtime-validated)", async () => {
  const { registerRunUntilTools } = await import("../src/mcp/tools/run-until.js");
  const schema = captureSchema(registerRunUntilTools, "runUntil");
  const obj = z.object(schema);
  // genesis_cram / c64_color_ram / nes_apu_regs were NOT in the old hardcoded
  // 8-value enum → would have thrown at the schema even though readMemory accepts them.
  for (const region of ["genesis_cram", "c64_color_ram", "nes_apu_regs", "system_ram"]) {
    assert.doesNotThrow(
      () => obj.parse({ condition: { type: "memory", region, offset: 0, equals: 1 } }),
      `runUntil should accept region ${region}`,
    );
  }
});

test("#5 watch on:'mem' single-range region KEEPS the discoverable enum (primary choice)", async () => {
  const schema = captureSchema(registerWatchMemoryTools, "watch");
  const obj = z.object(schema);
  // The primary on:'mem' region is still an enum: a garbage region is rejected
  // AT THE SCHEMA (so the canonical list stays discoverable where region IS the choice).
  assert.throws(
    () => obj.parse({ on: "mem", region: "not_a_real_region", offset: 0 }),
    "primary on:'mem' region stays an enum and rejects unknown values at the schema",
  );
  assert.doesNotThrow(() => obj.parse({ on: "mem", region: "genesis_cram", offset: 0 }));
});
