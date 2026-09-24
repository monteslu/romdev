// genesis_plus_gx Z80: the dispatch hook runs AFTER the interrupt check, so an
// IRQ entry is seen at the handler's first instruction.
//
// Before, the hook ran first: it recorded the interrupted pc (which then did
// NOT execute) and the handler's first instruction ran unseen. The instruction
// trace showed `$0109 $0073` for `$0109 $0038 $0073`, and a pc breakpoint on
// $0038 never fired on an IRQ entry. A synthetic ROM with the VDP frame IRQ
// on and IM 1 reproduces it on every frame.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LibretroHost } from "romdev-core-host/index.js";
import { resolveCore } from "../src/cores/registry.js";

function irqRom() {
  const rom = new Uint8Array(0x8000);
  rom.set([0xf3, 0xed, 0x56, 0x31, 0xf0, 0xdf, 0xc3, 0x00, 0x01], 0x0000); // di ; im 1 ; ld sp,$DFF0 ; jp $0100
  rom.set([0xdb, 0xbf, 0xfb, 0xed, 0x4d], 0x0038);                         // in a,($BF) ; ei ; reti
  rom.set([0xed, 0x45], 0x0066);                                           // retn
  // VDP reg 1 = $E0 (display + frame interrupt) ; ei ; loop: jr loop
  rom.set([0x3e, 0xe0, 0xd3, 0xbf, 0x3e, 0x81, 0xd3, 0xbf, 0xfb, 0x18, 0xfe], 0x0100);
  return rom;
}

const core = (() => { try { return resolveCore("sms"); } catch { return null; } })();

test("gpgx Z80: an IRQ entry is traced and breakable at the vector", { skip: !core && "genesis_plus_gx not staged", timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-smsirq-"));
  const h = new LibretroHost();
  try {
    const romPath = path.join(dir, "irq.sms");
    writeFileSync(romPath, irqRom());
    await h.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender, noderawfs: core.noderawfs });
    await h.loadMedia({ platform: "sms", path: romPath });
    h.stepFrames(10);
    h.setTrace({ capacity: 1 << 16 });
    h.stepFrames(1);
    const pcs = [...h.readTrace(0).pc];
    h.setTrace({ enabled: false });
    const at = pcs.indexOf(0x38);
    assert.ok(at > 0, `the handler's first instruction ($0038) is in the trace: ${pcs.slice(-8).map((p) => p.toString(16))}`);
    assert.equal(pcs[at - 1], 0x109, "entered from the idle loop");
    assert.deepEqual(pcs.slice(at, at + 3), [0x38, 0x3a, 0x3b], "then the handler runs in order");
    assert.equal(pcs.filter((p) => p === 0x38).length, 1, "one frame interrupt per frame");
    const hit = h.runUntilPC(0x38, 3);
    assert.equal(hit.hit, true, "a pc breakpoint on the vector fires on an IRQ entry");
  } finally {
    h.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
