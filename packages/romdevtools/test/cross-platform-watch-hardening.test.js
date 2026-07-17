// Cross-platform generalization of the v0.94.0 round-1/2 fixes (0.98.0):
//   - Mirror canonicalization at arm time for EVERY mirror platform, not just
//     SNES: NES $0800-$1FFF, GB/GBC echo $E000-$FDFF, SMS/GG $E000-$FFFB,
//     Genesis $E00000-$FEFFFF. (Residual: only snes9x canonicalizes LIVE
//     accesses core-side; a mirror-form WRITER on the others still needs a
//     core hook patch — arm-side canon fixes the common agent mistake.)
//   - conditionWidth:16 is endianness-aware: Genesis 68k words are BIG-endian
//     (high byte at `address`), so 'equals' arms `address` there, not
//     address+1, and word composition follows suit.
//   - readCart findHex maps GB/GBC (MBC window) and SMS/GG (Sega mapper).

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { LibretroHost } from "../src/host/LibretroHost.js";
import { registerMemoryTools } from "../src/mcp/tools/memory.js";
import { registerWatchMemoryTools } from "../src/mcp/tools/watch-memory.js";
import { _setHostForTest } from "../src/mcp/state.js";

const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

function toolHandler(registerFn, toolName, sessionKey) {
  const map = {};
  registerFn({ tool: (n, _d, _s, h) => { map[n] = h; } }, z, sessionKey);
  return map[toolName];
}

// ── mirror canonicalization, all platforms ──────────────────────────────────

test("mirror canon: NES/GB/SMS/Genesis alias windows map to canonical RAM; non-mirrors untouched", () => {
  const canon = (platform, addr) =>
    LibretroHost.prototype._canonWatchAddress.call({ status: { platform } }, addr);
  // NES: $0800-$1FFF → $0000-$07FF
  assert.equal(canon("nes", 0x0805), 0x0005);
  assert.equal(canon("nes", 0x1FFF), 0x07FF);
  assert.equal(canon("nes", 0x07FF), 0x07FF, "already canonical");
  assert.equal(canon("nes", 0x2005), 0x2005, "PPU regs untouched");
  // GB/GBC: echo $E000-$FDFF → $C000-$DDFF
  assert.equal(canon("gb", 0xE123), 0xC123);
  assert.equal(canon("gbc", 0xFDFF), 0xDDFF);
  assert.equal(canon("gb", 0xFE00), 0xFE00, "OAM untouched");
  // SMS/GG: $E000-$FFFB → $C000-$DFFB; mapper regs untouched
  assert.equal(canon("sms", 0xE010), 0xC010);
  assert.equal(canon("gg", 0xFFFB), 0xDFFB);
  assert.equal(canon("sms", 0xFFFC), 0xFFFC, "mapper regs untouched");
  // Genesis: $E00000-$FEFFFF → $FF0000 | offset
  assert.equal(canon("genesis", 0xE20218), 0xFF0218);
  assert.equal(canon("genesis", 0xFE1234), 0xFF1234);
  assert.equal(canon("genesis", 0xFF0218), 0xFF0218, "already canonical");
  assert.equal(canon("genesis", 0x000218), 0x000218, "cart ROM space untouched (read-watches on tables stay literal)");
});

// ── conditionWidth:16 endianness (Genesis BE) ───────────────────────────────

function fakeHost(platform, { ram = new Uint8Array(0x10000), onStep } = {}) {
  const h = {
    status: { platform, loaded: true, frameCount: 0 },
    _wp: { hits: 0 },
    watchpointSupported: () => true,
    armed: [],
    setWatchpoint(addr, enabled, opts) {
      if (enabled) h.armed.push({ addr, opts: opts ?? null });
      return { conditionApplied: !!opts };
    },
    stepFrames() { h.frame = (h.frame ?? 0) + 1; if (onStep) onStep(h, h.frame); },
    getWatchpoint(clear) {
      const w = { ...h._wp };
      if (clear) h._wp = { ...h._wp, hits: 0 };
      return w;
    },
    readMemory(_r, off, len) { return ram.slice(off, off + len); },
    getRegSnapshot: () => null,
  };
  h.ram = ram;
  return h;
}

test("width-16 equals on Genesis arms the word's HIGH byte at `address` (big-endian)", async () => {
  const ram = new Uint8Array(0x10000);
  const host = fakeHost("genesis", {
    ram,
    onStep(h, frame) {
      if (frame === 2) {
        // 68k word $2000 at $FF0218: BE → high byte $20 at offset 0x218
        ram[0x0218] = 0x20; ram[0x0219] = 0x00;
        h._wp = { hits: 1, lastPC: 0x1234, lastValue: 0x20 };
      }
    },
  });
  _setHostForTest("beq", host);
  const bp = toolHandler(registerWatchMemoryTools, "breakpoint", "beq");
  const r = parse(await bp({ on: "write", precision: "exact", address: 0xFF0218, condition: "equals", conditionValue: 0x2000, conditionWidth: 16, maxFrames: 5 }));
  assert.equal(r.found, true);
  assert.equal(host.armed[0].addr, 0xFF0218, "BIG-endian: the high byte IS `address` — no +1 shift");
  assert.equal(host.armed[0].opts.value, 0x20, "core condition byte = the value's high byte");
  assert.equal(r.valueWord, "0x2000");
  assert.match(r.note, /big-endian/, "note states the layout");
});

test("width-16 increase on Genesis composes the word big-endian ($00FF→$0100 carry)", async () => {
  const ram = new Uint8Array(0x10000);
  ram[0x0100] = 0x00; ram[0x0101] = 0xFF; // BE word $00FF at $FF0100
  const host = fakeHost("genesis", {
    ram,
    onStep(h, frame) {
      if (frame === 2) {
        ram[0x0100] = 0x01; ram[0x0101] = 0x00; // BE word $0100
        h._wp = { hits: 2, lastPC: 0xABCD, lastValue: 0x01 };
      }
    },
  });
  _setHostForTest("bin", host);
  const bp = toolHandler(registerWatchMemoryTools, "breakpoint", "bin");
  const r = parse(await bp({ on: "write", precision: "exact", address: 0xFF0100, condition: "increase", conditionWidth: 16, maxFrames: 5 }));
  assert.equal(r.found, true);
  assert.equal(r.oldValueWord, "0x00FF");
  assert.equal(r.valueWord, "0x0100", "big-endian word compare crosses the carry correctly");
});

// ── findHex bank mapping: GB + SMS ──────────────────────────────────────────

test("findHex maps GB hits through the MBC window and SMS hits through slot 2", async () => {
  const gbRom = new Uint8Array(0x10000); // 4 banks
  gbRom.set([0xCD, 0x34, 0x12], 0x0123);          // bank 0 → $0123
  gbRom.set([0xCD, 0x34, 0x12], 0x2 * 0x4000 + 0x0456); // bank 2 → $4456
  const gbHost = {
    status: { platform: "gb", loaded: true, frameCount: 0 },
    getCartRom: () => ({ bytes: gbRom, raw: gbRom, base: 0, headerSkipped: 0, mapped: true, platform: "gb", note: "t" }),
  };
  _setHostForTest("fhg", gbHost);
  const memGb = toolHandler(registerMemoryTools, "memory", "fhg");
  const g = parse(await memGb({ op: "readCart", findHex: "CD3412" }));
  assert.equal(g.count, 2);
  assert.deepEqual([g.matches[0].cpuAddress, g.matches[0].bank], ["$123", 0]);
  assert.deepEqual([g.matches[1].cpuAddress, g.matches[1].bank], ["$4456", 2]);

  const smsRom = new Uint8Array(0x10000);
  smsRom.set([0x21, 0x00, 0xC0], 0x3 * 0x4000 + 0x0789); // bank 3 → slot 2 $8789
  const smsHost = {
    status: { platform: "sms", loaded: true, frameCount: 0 },
    getCartRom: () => ({ bytes: smsRom, raw: smsRom, base: 0, headerSkipped: 0, mapped: true, platform: "sms", note: "t" }),
  };
  _setHostForTest("fhs", smsHost);
  const memSms = toolHandler(registerMemoryTools, "memory", "fhs");
  const m = parse(await memSms({ op: "readCart", findHex: "2100C0" }));
  assert.equal(m.count, 1);
  assert.deepEqual([m.matches[0].cpuAddress, m.matches[0].bank], ["$8789", 3]);
});
