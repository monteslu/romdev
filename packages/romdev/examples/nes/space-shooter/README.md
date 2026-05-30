# NES space-shooter — canonical "NES-shaped C" reference

A complete, runnable NES game in C (~440 lines) — a generic fixed-shooter
(player cannon vs. a descending alien grid, with shields and a HUD) that
demonstrates how to work *within* the NES's hard constraints instead of
fighting them. Fork this when you want a real game structure, not just a
hello-world. (Original example in the shoot-the-aliens *genre* — not a clone of
any specific commercial title.)

## Build

```
buildSource({
  platform: "nes",
  language: "c",
  sources: { "main.c": ..., "nes_runtime.c": ... },
  includes: { "nes_runtime.h": ... },
  linkerConfig: "chr-ram-runtime"
})
```

Use the **`chr-ram-runtime`** preset (not bare `chr-ram`): it bundles the crt0
(iNES header + reset vector), the NMI handler that DMAs shadow OAM each vblank,
and the `_shadow_oam` definition this game's `oam_spr`/`oam_clear` rely on. The
bare `chr-ram` preset has only an `nmi: rti` stub and no `_shadow_oam`, so it
fails to link here. Don't add your own crt0 source either — the preset supplies
it (a second one causes `Duplicate external identifier: __STARTUP__`). Produces
a 32 KB NROM `.nes` (CHR-RAM — tiles uploaded at runtime, no CHR-ROM bank). Check the `ramUsage` field in the build response: this game runs
at **BSS ≈ 371 B** of the ~512 B normal-RAM budget — comfortably under, but a
good illustration of how tight NES RAM is.

## What it teaches (the NES constraints, made concrete)

- **Tiny RAM → bit-packed state.** All 20 aliens live in `uint8_t
  alien_alive_mask[4]` (one bit per column), not a 20-byte array. Everything is
  `uint8_t`/`int8_t`; there are no large structs. This is *why* NES C looks the
  way it does — the ~512 B BSS ceiling forces it.
- **8-sprites-per-scanline limit → 5 alien columns.** The formation is 5 wide on
  purpose so a row never exceeds the hardware's per-scanline sprite cap (which
  would otherwise drop/flicker sprites). Wide-but-shallow beats tall-and-narrow.
- **OAM staging order.** `stage_sprites()` (which calls `oam_clear` + `oam_spr`)
  runs **before** `ppu_wait_nmi()` in the main loop. The NMI handler DMAs shadow
  OAM → real OAM at the *start* of vblank, so sprites must be staged before you
  wait. Staging after `ppu_wait_nmi()` is the #1 "sprites flicker/vanish" bug.
- **Sprites vs background, split by job.** Moving things (player, aliens, shots)
  are OAM sprites; static structure (shields, HUD score/wave/lives) are
  background tiles written with `tile_set`. Shields erode by swapping their BG
  tile as `hp` drops.
- **CHR-RAM upload.** `chr_ram_upload()` writes the tile bitmaps into both
  pattern tables at boot (NROM CHR-RAM has no tiles until you do).
- **APU SFX.** `sound_play_tone` / `sound_play_noise` for shoot / hit / death —
  fire-and-forget, no music driver needed.

## The main loop shape (copy this)

```c
for (;;) {
  stage_sprites();   /* oam_clear + oam_spr — BEFORE the wait */
  ppu_wait_nmi();    /* NMI DMAs shadow OAM at vblank start */
  pad = pad_poll(0);
  update_game(pad);  /* logic runs after vblank, off the hot path */
  draw_hud();
}
```

Game logic (movement, collision, spawning) runs *after* `ppu_wait_nmi()` so it
happens during the visible frame, not during vblank — keeps the vblank window
free for the DMA + any tile writes.
