// script-grammar decoder — the declarative bytecode decode (disasm
// target:'script'). Fixture is a generic level-script-shaped format:
// per-record trigger word prefix, flag-gated fields with implied defaults,
// a counted entry list, a terminated pair list, and a chain/stop command —
// the shapes real game script interpreters use.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeScript } from "../src/analysis/script-grammar.js";

const GRAMMAR = {
  endian: "little",
  recordPrefix: [{ name: "trigger", type: "u16" }],
  commands: {
    0: { name: "SetSpeed", fields: [{ name: "frac", type: "u8" }, { name: "whole", type: "u8" }] },
    3: { name: "Chain", fields: [{ name: "next", type: "u16", pointer: true }], stop: true, chain: "next" },
    5: { name: "Advance" },
    6: {
      name: "Features",
      fields: [
        { name: "count", type: "u8" },
        {
          name: "entries", repeat: { count: "count" },
          fields: [
            { name: "flags", type: "u8" },
            { name: "delay", type: "u8", if: { field: "flags", mask: 0x80, eq: 0 } },
            { name: "reload", type: "u8", if: { field: "flags", mask: 0xA0, eq: 0 }, default: 0x20 },
            { name: "col", type: "u8" },
          ],
        },
      ],
    },
    8: {
      name: "Remap",
      fields: [{
        name: "pairs", repeat: { until: { name: "idx", type: "u8", gte: 8 } },
        fields: [{ name: "value", type: "u8" }],
      }],
    },
  },
};

test("decodes prefix + scalar fields + stop/chain", () => {
  const bytes = Uint8Array.from([
    0x10, 0x00, /*trig 16*/ 0, 0x80, 0x02,      // SetSpeed frac=$80 whole=2
    0x40, 0x00, /*trig 64*/ 3, 0x34, 0x9C,      // Chain -> $9C34
  ]);
  const r = decodeScript(bytes, GRAMMAR, { baseAddress: 0x8000 });
  assert.equal(r.recordCount, 2);
  assert.deepEqual(r.records[0].prefix, { trigger: 16 });
  assert.equal(r.records[0].name, "SetSpeed");
  assert.deepEqual(r.records[0].fields, { frac: 0x80, whole: 2 });
  assert.equal(r.records[0].address, "$8000");
  assert.equal(r.stopped.reason, "stop-command");
  assert.equal(r.stopped.chainTarget, "$9C34");
  assert.deepEqual(r.pointers, ["$9C34"]);
});

test("flag-gated fields: mask conditions + implied defaults", () => {
  // entry A: flags 0x00 → delay + reload present. entry B: flags 0x20 →
  // delay present, reload implied $20. entry C: flags 0x80 → neither.
  const bytes = Uint8Array.from([
    0x00, 0x00, 6, 3,
    0x00, 11, 12, 1,       // A: flags, delay, reload, col
    0x20, 13, 2,           // B: flags, delay, col   (reload implied)
    0x80, 3,               // C: flags, col
  ]);
  const r = decodeScript(bytes, GRAMMAR);
  const [a, b, c] = r.records[0].fields.entries;
  assert.deepEqual(a, { flags: 0x00, delay: 11, reload: 12, col: 1 });
  assert.deepEqual(b, { flags: 0x20, delay: 13, reload: { value: 0x20, implied: true }, col: 2 });
  // C fails the reload condition too (0x80 & 0xA0 != 0) → implied default.
  assert.deepEqual(c, { flags: 0x80, reload: { value: 0x20, implied: true }, col: 3 });
  assert.equal(r.stopped.reason, "end-of-data");
});

test("terminated list consumes terminator and stops", () => {
  const bytes = Uint8Array.from([
    0x00, 0x00, 8, /*pairs*/ 0, 0x2A, 3, 0x17, /*term*/ 9,
    0x05, 0x00, 5, // Advance still decodes after the list
  ]);
  const r = decodeScript(bytes, GRAMMAR);
  assert.deepEqual(r.records[0].fields.pairs, [{ idx: 0, value: 0x2A }, { idx: 3, value: 0x17 }]);
  assert.equal(r.records[1].name, "Advance");
});

test("unknown opcode stops with a machine-readable reason", () => {
  const bytes = Uint8Array.from([0x00, 0x00, 99]);
  const r = decodeScript(bytes, GRAMMAR, { baseAddress: 0x4000 });
  assert.equal(r.recordCount, 0);
  assert.deepEqual(r.stopped, { reason: "unknown-opcode", opcode: 99, at: "$4002" });
});

test("truncated record reports end-of-data, keeps prior records", () => {
  const bytes = Uint8Array.from([0x00, 0x00, 0, 0x80]); // SetSpeed missing `whole`
  const r = decodeScript(bytes, GRAMMAR);
  assert.equal(r.recordCount, 0);
  assert.equal(r.stopped.reason, "end-of-data");
  assert.match(r.stopped.note, /truncated/);
});

test("big-endian scalars and maxRecords cap", () => {
  const g = { endian: "big", commands: { 1: { name: "P", fields: [{ name: "v", type: "u16" }] } } };
  const bytes = Uint8Array.from([1, 0x12, 0x34, 1, 0x00, 0x05]);
  const r = decodeScript(bytes, g, { maxRecords: 1 });
  assert.equal(r.records[0].fields.v, 0x1234);
  assert.equal(r.stopped.reason, "max-records");
});

test("scriptCore maps a CPU address through the platform mapper (nes)", async () => {
  const { scriptCore } = await import("../src/mcp/tools/disasm.js");
  const path = new URL("./roms/nestest.nes", import.meta.url).pathname;
  const r = await scriptCore({
    target: "script", path, platform: "nes", address: 0xC000,
    grammar: { commands: {}, unknownOpcode: "stop" },
  });
  // 16KB PRG maps $C000 to file offset 16 (after the iNES header).
  assert.equal(r.fileOffset, 16);
  assert.equal(r.stopped.reason, "unknown-opcode");
  assert.equal(r.stopped.at, "$C000");
});
