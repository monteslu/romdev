// This throughput change extends existing options, not tool/op names.
// Deliberate future surface changes require an explicit review of this contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolRegistry } from "../src/http/tool-registry.js";

test("throughput options preserve the existing 38 tools and 45 decomp operations", () => {
  const registry = buildToolRegistry("throughput-surface-contract");
  assert.deepEqual([...registry.keys()].sort(), [
    "assembleSnippet", "audioDebug", "background", "breakpoint", "build", "cart", "catalog", "cheats", "cpu",
    "decomp", "disasm", "encodeArt", "encodeAudio", "examples", "feedback", "files", "frame", "host", "importArt",
    "input", "loadMedia", "memory", "pack", "palette", "platform", "playtest", "recordSession", "regression",
    "romPatch", "runUntil", "sprites", "state", "symbols", "text", "tiles", "videoDebug", "wasm", "watch",
  ]);
  assert.deepEqual(registry.get("decomp").shape.op.options, [
    "setup", "import", "status", "refresh", "list", "map", "plan", "batch", "resolve", "context", "generate", "types",
    "compare", "search", "job", "jobs", "candidates", "integrate", "verify", "progress", "smoke", "overlays",
    "symbolize", "state", "trace", "coverage", "workbench", "dispatch", "experiment", "gate", "typeGraph", "rank",
    "ledger", "scenario", "capabilities", "knownSource", "assets", "artifacts", "handoff", "skill", "diagnose",
    "research", "variants", "layout", "replay",
  ]);
  for (const [name, option] of [["decomp", "threads"], ["decomp", "traceMode"], ["disasm", "emit"],
    ["disasm", "allOffsets"], ["frame", "compareLength"], ["loadMedia", "slot"]]) {
    assert.ok(registry.get(name).shape[option], `${name}.${option}`);
  }
});
