// accessScan — the address-aware reader/writer scan (disasm target:'accessScan').
// Unit-tests the asm-text scanner per CPU family, plus the end-to-end core on
// a real NES ROM and the literal-pool refusal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { scanAsmForAccess, accessFamilyFor, findReferencesCore } from "../src/mcp/tools/find-references.js";

const ROM = new URL("./roms/nestest.nes", import.meta.url).pathname;

const ASM_6502 = [
  "        sta     $0182                           ; C100 8D 82 01",
  "        sta     $0181,y                         ; C103 99 81 01",
  "        lda     $0100,y                         ; C106 B9 00 01",
  "        sta     ($81),y                         ; C109 91 81",
  "        lda     #$82                            ; C10B A9 82",
  "        inc     $0182                           ; C10D EE 82 01",
  "        sta     $0190,x                         ; C110 9D 90 01",
].join("\n");

test("6502: direct, base-window indexed, page base; indirect+immediate excluded", () => {
  const sites = scanAsmForAccess(ASM_6502, 0x0182, { family: "6502", window: 2 });
  const by = Object.fromEntries(sites.map((s) => [s.atAddress, s]));
  assert.equal(by.$C100.kind, "write");
  assert.equal(by.$C100.via, undefined);                    // direct
  assert.deepEqual([by.$C103.via, by.$C103.indexOffset], ["indexedBase", 1]);
  assert.equal(by.$C103.kind, "write");
  assert.deepEqual([by.$C106.via, by.$C106.indexOffset], ["pageBase", 0x82]);
  assert.equal(by.$C106.kind, "read");
  assert.equal(by.$C10D.kind, "rmw");
  assert.equal(by.$C109, undefined);   // ($81),y base is a pointer location, not an array base
  assert.equal(by.$C10B, undefined);   // immediate
  assert.equal(by.$C110, undefined);   // base $0190 is ABOVE the target
  assert.equal(sites.length, 4);
});

const ASM_Z80 = [
  "        ld      ($C123),a                       ; 0100 32 23 C1",
  "        ld      a,($C123)                       ; 0103 3A 23 C1",
  "        ld      hl,$C122                        ; 0106 21 22 C1",
  "        ld      hl,$C0F0                        ; 0109 21 F0 C0",
].join("\n");

test("z80/sm83: paren position classifies write vs read; pointerLoad base window", () => {
  const sites = scanAsmForAccess(ASM_Z80, 0xC123, { family: "z80", window: 2 });
  const by = Object.fromEntries(sites.map((s) => [s.atAddress, s]));
  assert.equal(by.$100.kind, "write");
  assert.equal(by.$103.kind, "read");
  assert.deepEqual([by.$106.kind, by.$106.via, by.$106.indexOffset], ["pointerLoad", "indexedBase", 1]);
  assert.equal(by.$109, undefined);    // $C0F0 outside window, not the page base
  assert.equal(sites.length, 3);
});

test("family map covers the mapped platforms; literal-pool ISAs map to null", () => {
  assert.equal(accessFamilyFor("nes"), "6502");
  assert.equal(accessFamilyFor("snes"), "65816");
  assert.equal(accessFamilyFor("gb"), "sm83");
  assert.equal(accessFamilyFor("msx"), "z80");
  assert.equal(accessFamilyFor("genesis"), "m68k");
  assert.equal(accessFamilyFor("gba"), null);
});

test("end-to-end on a real NES ROM returns classified sites + summary", async () => {
  const r = await findReferencesCore({ path: ROM, platform: "nes", address: 0x0002, accessScan: { window: 2 } });
  assert.ok(r.sitesFound > 0, "nestest writes $0002 constantly");
  assert.ok(r.summary.writers > 0);
  assert.ok(r.sites.every((s) => typeof s.kind === "string" && typeof s.instruction === "string"));
  assert.match(r.notes, /watch\(\{on:'range'/);
  assert.equal(r.window, 2);
});

test("literal-pool ISA refuses loudly with the live-tool pointer", async () => {
  await assert.rejects(
    () => findReferencesCore({ path: ROM, platform: "gba", address: 0x03000010, accessScan: {} }),
    /literal-pool|watch\(/,
  );
});
