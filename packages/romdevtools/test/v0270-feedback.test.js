// Fixes from the 0.27.0 Zanac (NES mapper-2) feedback round:
//   #1 disasm({target:'project'}) banked-NES rebuild glue is now COMPLETE +
//      one-call (header segment, per-bank PRGn wrappers, multi-bank .cfg,
//      rebuild.json wired to all of it via linkerConfigPath) — byte-exact.
//   #2 build({linkerConfigPath}) reads the .cfg from disk.
//   #3 disasm({target:'references'}) scans EVERY PRG bank (was a flat blob
//      at $8000 → refsFound:0 on banked ROMs) + skips `#$nn` immediates.
//   #4 memory({op:'read', outputPath, echo:false}) suppresses the hex echo.
//   #5 memory({op:'diff'}) summary clusters carry before/after (≤8 bytes)
//      + minDelta filters churn.
//   #6 memory({op:'diffRuns'}) — the A/B input-diff primitive.
//   #7 input({op:'press'}) emits a guaranteed released→pressed edge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { registerDisasmTools } from "../src/mcp/tools/disasm.js";
import { registerMemoryTools } from "../src/mcp/tools/memory.js";
import { registerInputTools } from "../src/mcp/tools/input.js";
import { registerToolchainTools } from "../src/mcp/tools/toolchain.js";
import { _setHostForTest } from "../src/mcp/state.js";

const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

function toolHandler(registerFn, toolName, sessionKey) {
  const map = {};
  registerFn({ tool: (n, _d, _s, h) => { map[n] = h; } }, z, sessionKey);
  return map[toolName];
}

// A 4-bank mapper-2 iNES image whose banks hold REAL 6502 (a tiny loop +
// zero-page traffic) so the disassembler emits instructions, plus vectors in
// the fixed bank. Deterministic + self-contained.
function makeBankedNes() {
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a], 0);
  header[4] = 4;                      // 4 x 16KB PRG
  header[5] = 0;                      // CHR-RAM
  header[6] = (2 & 0xF) << 4 | 1;     // mapper 2, vertical
  const prg = new Uint8Array(4 * 16384);
  // Each bank: lda $02 / sta $02 / rol $F5 / jmp $8000 (or $C000 for last), pad with $EA (nop).
  for (let b = 0; b < 4; b++) {
    const base = b * 16384;
    const org = b === 3 ? 0xC000 : 0x8000;
    prg.set([0xA5, 0x02, 0x85, 0x02, 0x26, 0xF5, 0x4C, org & 0xFF, org >> 8], base);
    prg.fill(0xEA, base + 9, base + 16384);
  }
  // Vectors in the fixed (last) bank → $C000.
  const vec = 4 * 16384 - 6;
  prg[vec + 0] = 0x00; prg[vec + 1] = 0xC0; // NMI
  prg[vec + 2] = 0x00; prg[vec + 3] = 0xC0; // RESET
  prg[vec + 4] = 0x00; prg[vec + 5] = 0xC0; // IRQ
  const out = new Uint8Array(16 + prg.length);
  out.set(header, 0);
  out.set(prg, 16);
  return out;
}

test("banked NES: disasm project emits working glue; rebuild.json build() is byte-identical", { timeout: 240000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-banked-"));
  try {
    const romPath = path.join(dir, "banked.nes");
    const { writeFile } = await import("node:fs/promises");
    const orig = makeBankedNes();
    await writeFile(romPath, orig);

    const disasm = toolHandler(registerDisasmTools, "disasm");
    const proj = parse(await disasm({ target: "project", path: romPath, outputDir: path.join(dir, "proj") }));
    assert.equal(proj.roundTrip.allByteExact, true, "all banks must round-trip byte-exact");
    const call = proj.rebuild.buildCall;
    assert.ok(call, "banked NES must now emit a one-call rebuild (was build:null glue-missing)");
    assert.ok(call.linkerConfigPath, "rebuild must reference the emitted cfg via linkerConfigPath");
    assert.ok(call.sourcesPaths["nes_header.s"], "header segment source must be wired in");
    assert.ok(call.sourcesPaths["bank3_seg.s"], "every bank wrapper must be wired in");

    // Feed the emitted call STRAIGHT back to build() — the #1 ask.
    const build = toolHandler(registerToolchainTools, "build", "v0270-banked");
    const outPath = path.join(dir, "rebuilt.nes");
    const r = parse(await build({ ...call, outputPath: outPath }));
    assert.equal(r.ok, true, "rebuild build failed: " + (r.logTail || r.log || "").slice(-300));
    const rebuilt = await readFile(outPath);
    assert.equal(Buffer.compare(Buffer.from(orig), rebuilt), 0, "rebuilt ROM must be byte-identical");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("banked NES: references scan every bank (zero-page direct + indexed) and skip immediates", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-refs-"));
  try {
    const romPath = path.join(dir, "banked.nes");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(romPath, makeBankedNes());
    const disasm = toolHandler(registerDisasmTools, "disasm");

    // $F5 is touched by `rol $F5` in EVERY bank — the exact shape the Zanac
    // session reported as refsFound:0.
    const r = parse(await disasm({ target: "references", path: romPath, address: 0xF5, maxRefsReturned: 64 }));
    assert.ok(r.refsFound >= 4, `expected refs in all 4 banks, got ${r.refsFound}`);
    const banks = new Set(r.refs.map((x) => x.prgBank));
    assert.ok(banks.has(0) && banks.has(3), "refs must carry prgBank tags spanning switchable + fixed banks");

    // $02: lda/sta in every bank — and NO immediate false positives.
    const r2 = parse(await disasm({ target: "references", path: romPath, address: 0x02, maxRefsReturned: 64 }));
    assert.ok(r2.refsFound >= 8, "zp direct refs across banks");
    assert.ok(!r2.refs.some((x) => /#\$/.test(x.instruction)), "immediates (#$02) must not count as references");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── memory tool behaviors against a fake host ──────────────────────────────
function fakeMemHost(initial) {
  let mem = Uint8Array.from(initial);
  let held = [{}];
  let stepCount = 0;
  return {
    status: { platform: "nes", loaded: true, frameCount: 0 },
    readMemory(region, offset = 0, length) {
      const end = length != null ? offset + length : mem.length;
      return mem.slice(offset, end);
    },
    regionSize() { return mem.length; },
    writeMemory(region, offset, bytes) { mem.set(bytes, offset); },
    setInput({ ports }) { held = ports; },
    stepFrames(n) {
      stepCount += n;
      // deterministic evolution: byte 5 follows RIGHT (+2/frame); byte 9 counts frames (wiggle)
      for (let i = 0; i < n; i++) {
        if (held[0] && held[0].right) mem[5] = (mem[5] + 2) & 0xFF;
        mem[9] = (mem[9] + 1) & 0xFF;
      }
      return n;
    },
    serializeState() { return { mem: Uint8Array.from(mem), stepCount }; },
    unserializeState(s) { mem = Uint8Array.from(s.mem); stepCount = s.stepCount; },
  };
}

test("memory read outputPath + echo:false returns {path, bytes} with no hex", async () => {
  const key = "v0270-echo";
  _setHostForTest(key, fakeMemHost(new Uint8Array(64)));
  const memory = toolHandler(registerMemoryTools, "memory", key);
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-echo-"));
  try {
    const p = path.join(dir, "dump.bin");
    const withEcho = parse(await memory({ op: "read", region: "system_ram", offset: 0, length: 64, outputPath: p }));
    assert.ok(withEcho.hex, "default keeps the hex echo");
    const noEcho = parse(await memory({ op: "read", region: "system_ram", offset: 0, length: 64, outputPath: p, echo: false }));
    assert.equal(noEcho.hex, undefined, "echo:false must drop the inline hex");
    assert.ok(noEcho.path && noEcho.bytes === 64, "path + byte count still returned");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("memory diff summary carries before/after for small clusters; minDelta filters wiggle", async () => {
  const key = "v0270-diff";
  const host = fakeMemHost(new Uint8Array(64));
  _setHostForTest(key, host);
  const memory = toolHandler(registerMemoryTools, "memory", key);
  await memory({ op: "snapshot", region: "system_ram", name: "t" });
  host.writeMemory("system_ram", 5, Uint8Array.from([40]));   // big move (delta 40)
  host.writeMemory("system_ram", 32, Uint8Array.from([1]));   // 1-step wiggle (outside cluster gap)
  const d = parse(await memory({ op: "diff", region: "system_ram", name: "t" }));
  const c5 = d.clusters.find((c) => c.start === "0x5");
  assert.ok(c5 && c5.before === "00" && c5.after === "28", "small cluster must carry before/after hex");
  const filtered = parse(await memory({ op: "diff", region: "system_ram", name: "t", minDelta: 8 }));
  assert.equal(filtered.changedCount, 1, "minDelta must drop the 1-step wiggle byte");
});

test("memory diffRuns isolates the input-driven byte in one call", async () => {
  const key = "v0270-diffruns";
  _setHostForTest(key, fakeMemHost(new Uint8Array(64)));
  const memory = toolHandler(registerMemoryTools, "memory", key);
  const r = parse(await memory({ op: "diffRuns", region: "system_ram", frames: 10, portsA: [{ right: true }] }));
  assert.equal(r.divergentCount, 1, "only the input-driven byte diverges (the frame counter is identical in both runs)");
  assert.equal(r.clusters[0].start, "0x5");
  assert.equal(r.clusters[0].runA, "14");   // +2/frame * 10
  assert.equal(r.clusters[0].runB, "00");
});

test("input press emits a guaranteed released→pressed edge (pre-release frame)", async () => {
  const key = "v0270-press";
  const calls = [];
  _setHostForTest(key, {
    status: { platform: "nes", loaded: true, frameCount: 0 },
    setInput(s) { calls.push({ set: JSON.parse(JSON.stringify(s.ports)) }); },
    stepFrames(n) { calls.push({ step: n }); return n; },
  });
  const input = toolHandler(registerInputTools, "input", key);
  const r = parse(await input({ op: "press", button: "start", frames: 3 }));
  assert.equal(r.preReleaseFrames, 1);
  // sequence: release, step 1, press, step 3, release, step 1
  assert.deepEqual(calls[0], { set: [{}, {}] });
  assert.deepEqual(calls[1], { step: 1 });
  assert.equal(calls[2].set[0].start, true);
  assert.deepEqual(calls[3], { step: 3 });
  assert.deepEqual(calls[4], { set: [{}, {}] });
  assert.deepEqual(calls[5], { step: 1 });
});
