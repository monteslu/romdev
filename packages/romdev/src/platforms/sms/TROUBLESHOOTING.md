# Sega Master System / Game Gear — troubleshooting

When something's broken. Read MENTAL_MODEL.md first for the
"what's going on" version (via `getPlatformDoc({platform:"sms", name:"mental_model"})`).

## "ROM builds but the screen is blank / black"

The VDP starts with display disabled (R1 bit 6 = 0). You have to
explicitly turn it on AFTER you've uploaded palette + tiles +
name table:

```c
sms_vdp_init();       /* sets display OFF as a side effect */
sms_load_palette(...);
sms_load_tiles(...);
sms_set_tilemap_cell(...);
sms_vdp_display_on(); /* ← without this, blank forever */
```

If you forget `sms_vdp_display_on()` your ROM boots and runs, but
the display register R1 keeps bit 6 clear and you see nothing.

## "Sprites are invisible / stuck at top of screen"

Two common modes:

1. **You forgot to call `sms_sat_upload()`.** The SAT shadow lives
   in WRAM; `sms_sprite_set()` only updates the shadow.
   `sms_sat_upload()` pushes the shadow to VRAM $3F00. Skip it →
   the VDP draws whatever stale SAT it had from boot.
2. **Y = 0xD0 anywhere in the SAT.** The SMS uses Y = 0xD0 as a
   "stop renderer at this slot" marker. If your first sprite has
   Y = 0xD0 (or you leave the default after `sms_sprite_init`), NO
   sprites render. Always set Y to a real value before drawing.

## "Colors look wrong / too dark"

SMS CRAM is **2 bits per channel** (4 levels: 0, 1, 2, 3 → encoded
as 0x00, 0x01, 0x02, 0x03 in the channel). So:

```
0x00 = black
0x3F = white (red=3, green=3, blue=3 — all max)
0x03 = pure red
0x0C = pure green
0x30 = pure blue
```

If your colours look "washed out greenish," you may be passing
6-bit-per-channel values that get truncated, or you may have the
Game Gear's 4-bit-per-channel encoding wrongly applied to SMS.
Run on a real SMS-mode emulator to confirm.

## "SDCC crashes during compile (dbuf_append_str NULL / aopGet)"

R7-era SDCC sm83 had multiple register-allocator regressions
(see `feedback_sdcc_sm83_crashes.md`). Most are fixed in the
4.4.0 we ship with the 8 MB stack patch (R12). If you still hit
one:

- Wrap aggressive `for (;;) { switch + __sfr write }` loops in
  `do { ... } while (1)` (matches the bundled `default` template's
  branchless update pattern).
- Split very-long functions into smaller ones.
- Avoid mid-block `uint8_t var = expr;` — hoist to function top
  (SDCC z80 is C89-strict).

The full list of patterns and workarounds is in
`src/platforms/sms/lib/README.md` (look for the SMS-14 codegen
notes).

## "Sound from PSG is silent / distorted"

Three things to check:

1. **PSG writes are byte-wise on port $7F.** A `uint16_t` write
   only sends the low byte; the high byte is dropped.
2. **The latch-register byte must come first.** Each PSG channel
   needs `0x80 | (chan << 5) | (vol & 0x0F)` etc., then the data
   bytes. Random write order = silent or random noise.
3. **Audio is disabled in some emulator save-state restores.** Try
   `reset()` first before debugging.

## "Game Gear ROM boots black / wrong colors"

GG ROMs need:

- 4-bit-per-channel palette (use `gg_load_palette`, not `sms_load_palette`)
- Lower-left 160×144 area of the 256×192 VDP framebuffer (it's
  hardware-cropped on the GG screen — content outside that window
  is invisible)
- Some GG-specific I/O (port $00 for Start, port $06 for stereo
  PSG mute control)

If you ported an SMS ROM straight to `.gg` it'll boot and run, but
the colours will be very dark (2-bit values reinterpreted as 4-bit)
and the visible area is in the top-left corner.

## "ROM > 32 KB doesn't run"

The default template is single-bank (32 KB). To use the Sega
mapper for larger ROMs, write `bank_n` to `$FFFE` (slot 1) or
`$FFFF` (slot 2) before reading from $4000-$7FFF / $8000-$BFFF
respectively. SDCC's default sm83/z80 link doesn't auto-page;
you write the bank-switch yourself in code, then `jp` into the
new bank.

For most agent-driven games, stay in 32 KB and the mapper never
matters.

## "Save states don't restore VDP state"

genesis_plus_gx (which we use for SMS) snapshots VDP/CRAM/VRAM
fully. If you find a sprite missing after `loadState`, the cause
is usually game-side: your shadow OAM lives in WRAM, which IS
snapshotted, but your `oam_dma_flush`/`sms_sat_upload`-equivalent
fires *next frame* — so the very first frame after load may show
stale SAT until your loop ticks once.

## "First build is slow but later ones are fast"

Expected. SDCC z80 + sdasz80 + sdld cold-load takes ~1-2s for
the WASM mmap + class init. Steady-state builds are sub-second
thanks to the worker pool (R12).
