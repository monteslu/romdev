// NES-PPU-on-SNES per-frame runtime (phase 2) — unit + e2e tests.
//
// Unit: the emitted runtime defines the right labels + seam, and the asm shape is
// stable. E2E (the real gate): assemble a tiny SNES ROM that wires the runtime's
// NMI handler to a synthetic "game" whose NMI writes an animating sprite to the
// shadow OAM, boot it in snes9x, and assert the sprite (a) reaches SNES OAM in the
// converted format and (b) ANIMATES frame-to-frame — i.e. the per-vblank flush +
// game-NMI path actually runs live, not a static one-shot.

import { test } from "node:test";
import assert from "node:assert/strict";

import { emitPpuRuntime } from "../src/analysis/nes-ppu-runtime.js";
import { runAsar } from "../src/toolchains/asar/asar.js";
import { resolveCore } from "../src/cores/registry.js";
import { resetHost, clearHost } from "../src/mcp/state.js";

test("emitPpuRuntime: defines the NMI handler, init, flush + its own seam", () => {
  const asm = emitPpuRuntime({ nesNmiLabel: "GAME_NMI" });
  assert.match(asm, /NES_RT_NMI:/, "the vblank handler");
  assert.match(asm, /NES_RT_INIT:/, "the init (enables NMI + sprites)");
  assert.match(asm, /NES_RT_FLUSH_SPRITES:/, "the OAM flush");
  // it provides its OWN seam (so the main wrapper must NOT also include nes_seam)
  assert.match(asm, /NES_PPU_WRITE:/);
  assert.match(asm, /NES_PPU_READ:/);
  // the OAMDMA register ($4014 → low byte $14) is captured as the shadow page.
  // This is a register compare (X holds the reg low byte) so 8-bit is correct.
  assert.match(asm, /cpx #\$14\b/, "captures the OAMDMA page");
  // it calls the game's NMI body
  assert.match(asm, /jsr\s+GAME_NMI/);
  // enables the vblank NMI
  assert.match(asm, /sta !NMITIMEN/);
  // The two index loops in the flush run with 16-bit X/Y (rep #$10), so their
  // counters MUST be width-explicit (.w) — the exact footgun the shim hit.
  const wide = (asm.match(/\b(cpx|cpy)\.w #\$[0-9a-f]+/gi) || []);
  assert.ok(wide.length >= 2, `both flush-loop counters are .w: found ${JSON.stringify(wide)}`);
  // No BARE 16-bit-context loop counter should slip through as 8-bit. The only
  // bare cp* allowed is the $14 register compare (genuinely 8-bit).
  const bare = (asm.match(/\b(cpx|cpy) #\$[0-9a-f]+/gi) || []).filter((s) => !/\$14/.test(s));
  assert.equal(bare.length, 0, `no width-ambiguous loop counter: ${JSON.stringify(bare)}`);
});

test("emitPpuRuntime: with no game NMI, still emits the flush-only handler", () => {
  const asm = emitPpuRuntime({ nesNmiLabel: null });
  assert.match(asm, /NES_RT_NMI:/);
  assert.doesNotMatch(asm, /jsr\s+GAME_NMI/);
  assert.match(asm, /sprite flush only/i);
});

test("runtime e2e: shadow OAM flushes to SNES OAM and sprites ANIMATE on snes9x", { timeout: 120000 }, async () => {
  const key = "ppu-runtime-e2e";
  const runtime = emitPpuRuntime({ nesNmiLabel: "GAME_NMI" });
  // Synthetic recompiled "game": reset seeds one sprite at $0200, enables the
  // runtime, then loops. Its NMI bumps the sprite's Y (animation) and re-issues
  // OAMDMA from page $02 so the seam learns the page. Mirrors what a real
  // recompiled NES game does, minus the full game logic.
  const src = `
lorom
org $00FFC0
        db "RUNTIME E2E          "
        db $20,$00,$09,$00,$01,$33,$00
        dw $0000,$0000
org $00FFEA
        dw NES_RT_NMI           ; native NMI
org $00FFFA
        dw NES_RT_NMI           ; emulation NMI (the game runs in E-mode)
org $00FFFC
        dw RESET
org $00FFFE
        dw IRQ
org $008000
RESET:
        sei
        clc
        xce
        rep #$30
        ldx #$1FFF
        txs
        sep #$30
        lda #$50
        sta $0200               ; sprite0 Y
        lda #$01
        sta $0201               ; sprite0 tile
        stz $0202               ; sprite0 attr
        lda #$40
        sta $0203               ; sprite0 X
        clc
        xce
        jsr NES_RT_INIT         ; native-mode init (enable NMI + sprites)
        sec
        xce                     ; → emulation mode (the game runs here)
        cli
LOOP:   jmp LOOP
GAME_NMI:
        inc $0200               ; animate: bump sprite0 Y each vblank
        lda #$02
        sta $4014               ; OAMDMA from page $02 (seam captures it)
        rts
IRQ:    rti
${runtime}
`;
  try {
    const asar = await runAsar({ source: src });
    assert.equal(asar.exitCode, 0, `asar failed: ${(asar.log || "").slice(0, 500)}`);

    const core = resolveCore("snes");
    const host = resetHost(key);
    await host.loadCore(core.jsPath, core.wasmPath);
    await host.loadMedia({ platform: "snes", bytes: new Uint8Array(asar.binary), virtualName: "/rom.sfc" });

    host.stepFrames(10);
    const a = [...host.readMemory("snes_oam", 0, 4)];
    host.stepFrames(10);
    const b = [...host.readMemory("snes_oam", 0, 4)];
    host.stepFrames(10);
    const c = [...host.readMemory("snes_oam", 0, 4)];

    // Converted format: SNES OAM = [X, Y, tile, attr]. X/tile/attr are constant.
    assert.equal(a[0], 0x40, "SNES OAM[0] = X (NES X=$40)");
    assert.equal(a[2], 0x01, "SNES OAM[2] = tile");
    assert.equal(a[3], 0x00, "SNES OAM[3] = attr (no flip, palette 0)");
    // The Y must climb monotonically — that's the per-frame flush + game NMI live.
    assert.ok(a[1] < b[1] && b[1] < c[1],
      `sprite0 Y must animate (flush runs every vblank): got ${a[1]} → ${b[1]} → ${c[1]}`);
    // And the NMI ran enough to move it a visible amount.
    assert.ok(c[1] - a[1] >= 15, `Y advanced ~1/frame over 20 frames: ${c[1] - a[1]}`);
  } finally {
    clearHost(key);
  }
});
