// gpgx core upgrades from the NBA-Jam-both-consoles feedback round (LIVE core):
//   #1 registersAtHit on Genesis — the register file is FROZEN at the hit
//      instant for pc-breaks AND write-watchpoints (pre-fix, gpgx's per-line
//      scheduler kept running the 68k after a hit, so post-frame register
//      reads were hundreds of instructions stale — the "2h of wrong-pointer
//      chases").
//   #1b the write-watchpoint PC is the EXECUTING instruction's first byte,
//      not the drifted prefetch PC (the orb-at-$2A7216-reported-as-$2A721C
//      off-by-one).
//   #2 cpu call pure mode — romdev_run_pure steps ONLY the 68k: no frame
//      machinery runs, so the game's own VBlank logic can't stomp the driven
//      routine's output buffer.
//   #5 a per-platform Genesis memory-read smoke (the "info is not defined"
//      regression was invisible to a fake-host-only suite).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildForPlatform } from "../src/toolchains/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "../src/host/index.js";

// A self-contained Genesis program with KNOWN addresses:
//   Start ($200): set up registers with sentinel values, then loop:
//     write_loop ($220): move.b d0,$FF0100 — the watched write, executed with
//       d0=$2A, a0=$00123456 (values registersAtHit must report exactly)
//   sub_write ($300): a subroutine for cpu-call: move.b d1,$FF0200 / rts
const SRC = `
        org     $000000
        dc.l    $00FFE000
        dc.l    Start
        dcb.l   62,Exception

        org     $000200
Start:
        move.w  #$2700,sr
        moveq   #$2A,d0
        move.l  #$00123456,a0
        org     $000220
write_loop:
        move.b  d0,$FF0100.l
        nop
        nop
        bra.s   write_loop

        org     $000300
sub_write:
        move.b  d1,$FF0200.l
        rts

Exception:
        bra.s   Exception
`;

async function liveGenesis() {
  const b = await buildForPlatform({ platform: "genesis", language: "asm", source: SRC });
  assert.ok(b.ok && b.binary, "genesis test ROM build failed: " + (b.log || "").slice(-300));
  const host = new LibretroHost();
  const core = resolveCore("genesis");
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "genesis", bytes: b.binary });
  host.stepFrames(2);
  return host;
}

test("gpgx write-watchpoint: exact instruction PC + frozen registersAtHit", { timeout: 120000 }, async () => {
  const host = await liveGenesis();
  host.setWatchpoint(0xFF0100, true);
  let w = null;
  for (let i = 0; i < 10; i++) {
    host.stepFrames(1);
    w = host.getWatchpoint();
    if (w.hits > 0) break;
  }
  host.setWatchpoint(0, false);
  assert.ok(w && w.hits > 0, "watchpoint never fired");
  // The writing instruction is the move.b at $220 — the EXECUTING instruction's
  // first byte, not the post-prefetch PC ($226 would be the old off-by-one).
  assert.equal(w.lastPC, 0x220, `write PC must be the move.b at $220, got $${w.lastPC.toString(16)}`);
  assert.equal(w.lastValue, 0x2A);
  // The full register file frozen AT the write.
  const snap = host.getRegSnapshot(true);
  assert.ok(snap && snap.kind === 3, "write hit must leave a kind-3 register snapshot");
  assert.equal(snap.named.d0, "$2A", "d0 at the write instant");
  assert.equal(snap.named.a0, "$123456", "a0 at the write instant (the dead-value drift bug)");
  assert.equal(snap.named.pc, "$220");
});

test("gpgx pc-breakpoint: CPU stays FROZEN for the rest of the frame (no register drift)", { timeout: 120000 }, async () => {
  const host = await liveGenesis();
  host.setPCBreak(0x220, true, false);
  let st = null;
  for (let i = 0; i < 10; i++) {
    host.stepFrames(1);
    st = host.getPCBreak(false);
    if (st.hit) break;
  }
  assert.ok(st && st.hit, "pc breakpoint never hit");
  assert.equal(st.lastPC, 0x220);
  // Snapshot at the hit:
  const snap = host.getRegSnapshot(false);
  assert.ok(snap && snap.kind === 1, "pc hit must leave a kind-1 register snapshot");
  assert.equal(snap.named.d0, "$2A");
  assert.equal(snap.named.a0, "$123456");
  // THE drift fix: with the CPU frozen after the hit, the LIVE register file
  // still matches the hit instant even after more frames run.
  host.stepFrames(3);
  assert.equal(host.getReg(16) >>> 0, 0x220, "live PC must stay frozen at the breakpoint across frames");
  assert.equal(host.getReg(8) >>> 0, 0x123456, "live a0 must not drift while frozen");
  host.setPCBreak(0, false, false);
  host.getPCBreak(true);
});

test("gpgx cpu call pure: runs the routine with NO frame machinery (framesRun 0)", { timeout: 120000 }, async () => {
  const host = await liveGenesis();
  assert.ok(host.runPureSupported(), "core must export romdev_run_pure");
  const r = host.callSubroutine({
    pc: 0x300,
    regs: { 1: 0x55 },        // d1 = $55
    sentinelPC: 0x000180,     // unused vector area — never executed otherwise
    sandbox: false,
    pure: true,
  });
  assert.equal(r.returned, true, "pure call must reach the sentinel: " + JSON.stringify(r));
  assert.equal(r.framesRun, 0, "pure mode must not step frames");
  assert.equal(r.pure, true);
  const out = host.readMemory("system_ram", 0x200, 1);
  assert.equal(out[0], 0x55, "the routine's write must land");
});

test("genesis memory read smoke (live host, every basic region path)", { timeout: 120000 }, async () => {
  const host = await liveGenesis();
  // The 0.27.0 "info is not defined" regression broke every region read while
  // the (fake-host) suite stayed green — this is the live-Genesis smoke.
  const ram = host.readMemory("system_ram", 0x100, 4);
  assert.equal(ram.length, 4);
  const vram = host.readMemory("video_ram", 0, 16);
  assert.equal(vram.length, 16);
  const cram = host.readMemory("genesis_cram", 0, 8);
  assert.equal(cram.length, 8);
  const sz = host.regionSize("system_ram");
  assert.equal(sz, 0x10000, "Genesis work RAM is 64KB");
});
