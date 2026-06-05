// Lynx (65C02) disassembly: confirm the disassembleRom enum/sniff + findReferences
// path are wired (they were gapped — only disassembleProject supported lynx).
// The cart is a flat 6502-family image after a 64-byte "LYNX" header, run at $0200.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildForPlatform } from "../src/toolchains/index.js";
import { runDa65 } from "../src/toolchains/cc65/da65.js";
import { reassembleForPlatform } from "../src/toolchains/common/reassemble.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("Lynx cart disassembles (65C02) and reassembles byte-exact", async () => {
  const src = await readFile(path.join(__dirname, "..", "examples", "lynx", "main.c"), "utf8");
  const b = await buildForPlatform({ platform: "lynx", source: src, sourceName: "main.c", language: "c" });
  assert.ok(b.binary, "lynx build failed");
  // 64-byte "LYNX" header, then the flat cart image at $0200.
  const hasHdr = b.binary[0] === 0x4c && b.binary[1] === 0x59 && b.binary[2] === 0x4e && b.binary[3] === 0x58;
  assert.equal(hasHdr, true, "expected a LYNX-headered .lnx");
  const body = b.binary.slice(64);

  // Read path (findReferences/disassembleRom both run this da65 call).
  const dis = await runDa65({ bytes: body.slice(0, 0x100), startAddress: 0x0200, cpu: "6502", options: ["--comments", "4"] });
  assert.match(dis.asm, /\.setcpu "6502"/, "da65 produced 6502 asm");

  // Project path (byte-exact rebuild).
  const r = await reassembleForPlatform({ platform: "lynx", bytes: body.slice(0, 0x100), startAddress: 0x0200 });
  assert.equal(r.ok, true, "lynx must reassemble byte-exact");
}, { timeout: 60000 });
