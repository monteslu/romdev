// Atari 2600 callSubroutine instruction WATCHDOG — end to end (stella2014 6507).
//
// callSubroutine can be pointed at a routine that loops FOREVER. Each emulator
// frame spins inside M6502::execute, so the host's per-frame cap can't catch it
// and the WASM would hang. The watchdog (romdev_watchdog_set, hooked into
// M6502::execute, force-stops via romdev_pc_hit + StopExecutionBit) must
// force-stop at the host-set instruction budget and report watchdog:true — NOT
// hang.
//
// NOTE on harness: the 2600's RAM is only 128 bytes (RIOT) and the stack page
// $0100-$01FF mirrors into it, so the host's generic callSubroutine stack-seed
// (which writes the sentinel at $0100+SP) is out of bounds for this core — a
// pre-existing host-layer limitation, NOT the watchdog. So this test drives the
// watchdog through the SAME host primitives callSubroutine uses (setReg(PC) +
// setWatchdog + the exclusive frame loop watching getPCBreak().watchdog), which
// is exactly what the watchdog must catch, without the stack push.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runDasm } from "../src/toolchains/dasm/dasm.js";
import { resolveCore } from "../src/cores/registry.js";

// A 6507 cart with a labeled SPIN: jmp SPIN routine (an infinite loop the host
// can drive). The cart also runs a normal frame loop so it boots cleanly.
const SRC = `
  processor 6502
  org $F000

VSYNC   = $00
VBLANK  = $01
WSYNC   = $02
COLUBK  = $09

START:
  SEI
  CLD
  LDX #$FF
  TXS
  LDA #0
.clr:
  STA $00,X
  DEX
  BNE .clr
  LDA #$80
  STA COLUBK

MAIN:
  LDA #2
  STA VSYNC
  STA WSYNC
  STA WSYNC
  STA WSYNC
  LDA #0
  STA VSYNC
  LDA #2
  STA VBLANK
  LDX #37
.vb:
  STA WSYNC
  DEX
  BNE .vb
  LDA #0
  STA VBLANK
  LDX #192
.draw:
  STA WSYNC
  DEX
  BNE .draw
  LDA #2
  STA VBLANK
  LDX #30
.os:
  STA WSYNC
  DEX
  BNE .os
  JMP MAIN

  ; the infinite-loop target driven by the watchdog
SPIN:
  JMP SPIN

  org $FFFA
  .word START
  .word START
  .word START
`;

test("Atari 2600 watchdog force-stops an infinite loop (stella2014 6507)", { timeout: 150000 }, async () => {
  const asm = await runDasm({ source: SRC });
  assert.equal(asm.exitCode, 0, "dasm build failed:\n" + asm.log);
  assert.ok(asm.binary && asm.binary.length, "dasm produced no binary");

  // Resolve SPIN's absolute address from the dasm symbol table.
  const m = /(^|\n)\s*SPIN\s+([0-9a-fA-F]{4})\b/.exec(asm.symbols || "");
  assert.ok(m, "SPIN symbol not found in dasm .sym:\n" + (asm.symbols || "").slice(0, 400));
  const spinPC = parseInt(m[2], 16) >>> 0;
  assert.ok(spinPC >= 0xF000, "SPIN looks wrong: $" + spinPC.toString(16));

  const { LibretroHost } = await import("romdev-core-host/LibretroHost.js");
  const core = resolveCore("atari2600");
  assert.ok(core, "resolveCore('atari2600') returned null — stella2014_libretro.{js,wasm} missing?");
  const host = new LibretroHost();
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "atari2600", bytes: asm.binary, virtualName: "wd.a26" });

  // Boot into the main loop.
  host._runFramesExclusive(() => false, 30);

  assert.equal(host.watchdogSupported(), true, "watchdogSupported() false — romdev_watchdog_set missing on stella2014");
  assert.equal(host.pcBreakSupported(), true, "pcBreakSupported() false");

  // Point the CPU at the infinite-loop routine, arm the watchdog (the SAME
  // primitive callSubroutine uses), and run. The per-frame loop must terminate
  // via the watchdog flag — not hang.
  host.setReg(16, spinPC); // 6502 PC = reg-id 16
  host.setWatchdog(200000);
  host.setPCBreak(0xFFFF, true, false); // a PC the spin never reaches; only the watchdog can stop it
  let tripped = false, finalPC = null;
  try {
    host._runFramesExclusive(() => {
      const st = host.getPCBreak(false);
      if (st.hit) { tripped = !!st.watchdog; finalPC = st.lastPC; return true; }
      return false;
    }, 600);
  } finally {
    host.setPCBreak(0, false, false);
    host.setWatchdog(0);
    host.getPCBreak(true);
  }

  assert.equal(tripped, true, "watchdog did not trip on the infinite loop (finalPC=" + finalPC + ")");
  // The spin is a single 3-byte `JMP SPIN`; the watchdog freezes at the PC about
  // to execute, which lands within the JMP's own bytes — assert it's stuck in
  // the spin region (a few bytes of SPIN), not back in the boot/frame loop.
  assert.ok(Math.abs((finalPC >>> 0) - spinPC) <= 4,
    "watchdog finalPC ($" + (finalPC >>> 0).toString(16) + ") not at SPIN ($" + spinPC.toString(16) + ")");
  console.log("a2600 watchdog: tripped=" + tripped + " finalPC=$" + (finalPC >>> 0).toString(16) + " spinPC=$" + spinPC.toString(16));
});
