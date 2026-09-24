import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { recompileToWasmcart } from "./build.js";
import { wcGetInfoWat, abiBlock, readRecompileInfo } from "./cart-abi.js";

// A toy backend: the "ROM" is a byte string the cart copies into its
// framebuffer. Enough to exercise emit -> assemble -> section -> pack.
const toy = {
  platforms: ["toy"],
  describe(rom) { return { supported: rom.length > 0, unsupportedReason: "empty ROM", bytes: rom.length }; },
  recompileSection(rom, sha1) {
    return { name: "romdev.recompile", json: { platform: "toy", referenceCore: "none", romSha1: sha1, regions: { rom: { offset: 0x100, length: rom.length } } } };
  },
  async *emitWat(rom, opts) {
    const b = abiBlock(0x10000);
    yield '(module (memory (export "memory") 2)\n';
    yield wcGetInfoWat({ info: b.info, width: 4, height: 4, fb: 0x200, input: b.input, time: b.time });
    let s = "";
    for (const x of rom) s += "\\" + x.toString(16).padStart(2, "0");
    yield `(data (i32.const 0x100) "${s}")\n`;
    yield '(func (export "wc_init")) (func (export "wc_render") (memory.copy (i32.const 0x200) (i32.const 0x100) (i32.const 16))))';
    Object.assign(opts.stats, { arms: rom.length, lowered: rom.length - 1, trapped: 1 });
  },
};

test("recompileToWasmcart packs a validated cart with the romdev.recompile section", async (t) => {
  const dir = mkdtempSync(join(import.meta.dirname, ".buildtest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const romPath = join(dir, "toy.bin");
  writeFileSync(romPath, Uint8Array.from({ length: 16 }, (_, i) => i * 3));
  const out = join(dir, "toy.wasc");
  const r = await recompileToWasmcart({ platform: "toy", romPath, outputPath: out, backend: toy });
  assert.equal(r.lowered, "15/16 arms lowered, 1 trap");
  assert.equal(r.layout.platform, "toy");
  assert.equal(r.layout.regions.rom.offset, 0x100);
  assert.ok(!existsSync(out + ".cart.wasm"), "temp wasm removed");
  const files = unzipSync(readFileSync(out));
  assert.ok(files["cart.wasm"] && files["manifest.json"]);
  const wasm = files["cart.wasm"];
  assert.ok(WebAssembly.validate(wasm));
  assert.equal(readRecompileInfo(wasm).romSha1, r.romSha1);
  const { instance } = await WebAssembly.instantiate(wasm);
  instance.exports.wc_render();
  assert.equal(new Uint8Array(instance.exports.memory.buffer)[0x200 + 5], 15);

  const w = await recompileToWasmcart({ platform: "toy", romPath, outputPath: join(dir, "toy.wat"), emit: "wat", backend: toy });
  assert.ok(readFileSync(w.outputPath, "utf8").startsWith("(module"));

  await assert.rejects(recompileToWasmcart({ platform: "toy", rom: new Uint8Array(0), outputPath: out, backend: toy }), /refused: empty ROM/);
});
