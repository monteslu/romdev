# Game Gear — troubleshooting

When something's broken. Read MENTAL_MODEL.md first
(`getPlatformDoc({platform:"gg", name:"mental_model"})`).

## "ROM runs but content is off the screen"

GG's visible viewport is **160×144 centered in a 256×192 framebuffer**.
Anything you draw outside `(48, 24)..(207, 167)` is in the border —
visible in headless emulator screenshots (gpgx shows the whole frame)
but invisible on real hardware.

The bundled scaffolds are direct ports of the SMS scaffolds and target
the full 256×192 area. Works fine for development under gpgx; for
shipping to a real GG, reposition sprite + tilemap content to the
visible center.

## "START button doesn't work"

GG splits the START button onto a GG-specific port (`$00` bit 7,
active low), separate from the D-pad/A/B which are on `$DC` like
SMS. `gg_joypad_read()` already merges them — START shows up in bit 7
of the returned byte (`JOY_START` mask).

If you copied an SMS scaffold that uses PAUSE-as-START semantics
(SMS pause button is at port $DD bit 4 IIRC), it won't work on GG;
swap to JOY_START.

## "I drive the game with setInput but the fire/action button doesn't fire"

The GG button map is **inverted** vs the libretro names (same genesis_plus_gx
core as SMS). Button 1 (main fire) is libretro **b**, button 2 is libretro **a**
— so `setInput({a:true})` presses button **2**, not button 1 (`JOY_B1`).

Fix:
- Button 1 (`JOY_B1`) → `setInput({ports:[{b:true}]})` or `{west:true}`
- Button 2 (`JOY_B2`) → `{a:true}` / `{east:true}`
- START → `{start:true}`

Prefer spatial names or `pressButton({button:'1'|'2'})`.
`getInputLayout({platform:'gg'})` has the full map.

## "Sound only comes out of one speaker"

GG has a stereo control register at port `$06` that the SMS doesn't
have. After power-on it defaults to a sensible state on real hardware
but on some emulators / on real cartridge dev kits the L/R bits
might be cleared. Force mono explicitly:

```c
__sfr __at 0x06 PORT_GG_PSG_STEREO;  /* already in gg_hw.h */
PORT_GG_PSG_STEREO = 0xFF;  /* all 4 channels to both speakers */
```

(0xFF = bits 0-3 enable channels 0-3 on the right speaker, bits 4-7
enable on the left.)

## "Palette looks wrong — colors too saturated/wrong shade"

GG palette is **4-4-4 BGR** (12 bits per entry) — twice as deep as
SMS's 2-2-2. If you ported SMS palette bytes directly, you're feeding
6-bit values into a 12-bit register and getting the wrong shade.

Convert SMS palette bytes → GG palette bytes by reading the 2-2-2
fields out of each SMS byte and shifting them to 4-4-4 nibbles:

```c
uint16_t sms_to_gg(uint8_t sms_byte) {
    uint8_t r = (sms_byte) & 0x03;        /* 2 bits */
    uint8_t g = (sms_byte >> 2) & 0x03;
    uint8_t b = (sms_byte >> 4) & 0x03;
    /* Scale 0..3 -> 0..F by *5 (close enough for 4-bit). */
    return (uint16_t)((r * 5) | ((g * 5) << 4) | ((b * 5) << 8));
}
```

Then store as `low = (gg & 0xFF)`, `high = (gg >> 8) & 0xFF` for the
two-byte little-endian CRAM entry.

## "Linking error: undefined reference to sms_joypad_read_p2"

GG only has one controller. The SMS scaffolds use `sms_joypad_read_p2`
for the two-controller patterns (Pong, 2P shmup). When porting, drop
the P2 read + force `p2 = 0` so the AI fallback always engages.

The bundled GG `sports.c` already does this — copy that pattern when
porting other SMS multiplayer code.

## "Build errors mention 'TMR SEGA' or ROM header"

Same magic as SMS — gpgx accepts headerless ROMs fine for development.
For real-hardware ROM-burning include a header at $7FF0:

```
db "TMR SEGA"
dw 0                  ; reserved
dw 0                  ; checksum (gpgx ignores)
db 0x00, 0x00, 0x00   ; product code BCD
db 0x00               ; product code high + version
db 0x40               ; region (0x40 = GG)
db 0x4C               ; ROM size (0x4C = 32 KB)
```

The bundled scaffolds build without a header — sufficient for the
emulator-driven workflow. Add one before shipping to a cartridge.
