// A project's splat step (`python -m splat split`, a vendored splat/split.py,
// or a venv's `splat split`) runs romdev-splat in-process through the recipe
// runner: no Python.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { classifyCommand, runRecipeLine } from "../src/decomp/recipe.js";

const YAML = `name: synthetic
options:
  basename: synth
  target_path: rom.bin
  base_path: .
  platform: n64
  compiler: IDO
  asm_path: asm
  asset_path: assets
  src_path: src
  build_path: build
  ld_script_path: synth.ld
  symbol_addrs_path: []
segments:
  - [0x0, bin, start]
  - name: main
    type: code
    start: 0x10
    vram: 0x80000400
    subsegments:
      - [0x10, asm, main]
  - [0x20]
`;

function project() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-splat-recipe-"));
  const rom = Buffer.alloc(0x20);
  rom.write("SYNTHETIC HEADER", 0, "latin1");
  [0x27bdffe8, 0x03e00008, 0x27bd0018, 0x00000000].forEach((w, i) => rom.writeUInt32BE(w, 0x10 + i * 4));
  fs.writeFileSync(path.join(d, "rom.bin"), rom);
  fs.writeFileSync(path.join(d, "synth.yaml"), YAML);
  return d;
}

test("splat invocations classify as romdev-splat, not as python", () => {
  assert.equal(classifyCommand(["uv", "run", "python", "-m", "splat", "split", "a.yaml"]).kind, "splat"); // no-python-guard: classifier input, never launched
  assert.equal(classifyCommand(["python3", "tools/splat/split.py", "a.yaml"]).kind, "splat"); // no-python-guard: classifier input, never launched
  assert.equal(classifyCommand([".venv/bin/splat", "split", "a.yaml"]).kind, "splat");
});

test("a splat recipe step splits a synthetic ROM in-process (asm, bin, linker script)", async () => {
  const outs = [];
  for (const line of ["python3 -m splat split synth.yaml", ".venv/bin/splat split synth.yaml"]) {
    const d = project();
    try {
      const r = await runRecipeLine(line, { cwd: d, tmpRoot: path.join(d, "tmp") });
      assert.equal(r.code, 0, r.unsupported ?? r.log);
      assert.equal(r.steps[0].kind, "splat");
      const asm = fs.readFileSync(path.join(d, "asm", "main.s"), "utf8");
      assert.match(asm, /addiu\s+\$sp, \$sp, -0x18/);
      assert.match(asm, /jr\s+\$ra/);
      assert.equal(fs.readFileSync(path.join(d, "assets", "start.bin")).toString("latin1"), "SYNTHETIC HEADER");
      const ld = fs.readFileSync(path.join(d, "synth.ld"), "utf8");
      assert.match(ld, /main_VRAM/);
      outs.push(asm + ld);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
  assert.equal(outs[0], outs[1]);
});

test("an unsupported splat option is reported, not guessed", async () => {
  const d = project();
  try {
    const r = await runRecipeLine("python3 -m splat split synth.yaml --no-such-flag", { cwd: d, tmpRoot: path.join(d, "tmp") });
    assert.equal(r.code, 127);
    assert.match(r.unsupported, /--no-such-flag/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
