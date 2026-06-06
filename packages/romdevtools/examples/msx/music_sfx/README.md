# MSX — music_sfx

AY-3-8910 PSG demo with on-screen state.

- **Channel A** plays a looping 8-note melody (~0.2 s/note).
- **Channel B** plays a soft bass line under it (harmony).
- **Channel C** fires a descending "blip" SFX on the joystick **trigger** press
  edge (`gttrig(1)`, bit 7 = pressed).

On screen (sprites — screen 2's font isn't loaded, so sprites are the reliable
"visible state"):

- A **step sequencer**: eight beat markers, the one for the current melody step
  lights **yellow**, the rest are gray. They're split across two rows of four so
  the VDP's 4-sprites-per-scanline limit doesn't drop any.
- A **big 16x16 ring indicator** turns **red** while the trigger is held (white
  when idle). Uses the VDP 16x16 sprite-size bit (`R1` bit 1).

Shows `msx_psg_tone(chan, period, vol)` / `msx_psg_off(chan)`, multi-channel PSG
mixing, and trigger input. AY note period = 1789772 / (16 × freq); period 0 =
silent.

Build (link the helper lib):

```js
buildForPlatform({
  platform: "msx",
  sources:  { "main.c": …, "msx_vdp.c": …, "msx_crt0.s": … },
  includes: { "msx_hw.h": … },
  crt0: ".module empty\n", sourceName: "main.c",
})
```

Verified on the bluemsx core: chA cycles 6 distinct note periods, chB 3 bass
periods, chC stays silent until the trigger is held then sweeps through 17
descending periods. Screenshots before/after a held trigger confirm the ring
indicator flips white → red and the sequencer beat lights — see
`audioDebug({op:'inspect', chip:"ay8910"})` and `memory({op:'read'}, "msx_psg_regs", …)`.
