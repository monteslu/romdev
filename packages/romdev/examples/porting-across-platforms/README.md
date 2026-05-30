# Porting a small arcade game across platforms

When you build the *same* game (a shmup, a fixed-shooter, a single-screen
arcade game) on many retro systems, the hard part is **not** "write C" or "write
asm." It's **choosing the right rendering primitive for each machine.** Pick
wrong and you get output that's technically correct but looks bad — SNES sprites
that read as dots, an Atari 2600 that looks like a barcode, a blank Lynx screen.
This guide is the per-platform cheat-sheet so you reach for the right primitive
on the first try.

## The matrix

For a Space-Invaders-shaped game (player at the bottom, a grid of enemies,
shields/HUD, shots):

| Platform | Enemies / player / shots | Shields & HUD | The thing that bites you |
| --- | --- | --- | --- |
| **GBA** | hardware OBJ sprites (or bitmap mode) | OBJ or BG | Easiest target — lots of headroom, simple output looks good. ⚠ Set up IRQs (`irq_init`+`irq_add(II_VBLANK)`) before `VBlankIntrWait()` or the BIOS halts forever. |
| **Genesis** | VDP sprites + tiles | sprites or BG plane | Strong fit. ⚠ Step 60+ frames after boot before judging output — the VDP init takes a moment. |
| **SMS** | VDP sprites + BG tiles | BG tilemap | ⚠ 8 sprites per scanline. Put score/status on the BG tilemap, not sprites. |
| **Game Gear** | VDP sprites + BG | BG tiles | Same as SMS **plus** the visible screen is the center 160×144 of a 256×192 hardware space. Keep sprites inside the visible box (the scaffold ships `VIS_*` constants). |
| **NES** | OAM sprites + CHR | BG nametable tiles | ⚠ 8 sprites per scanline → ≤5–6 enemies per row. ⚠ **Stage OAM (oam_clear/oam_spr) BEFORE `ppu_wait_nmi`** — the NMI DMAs shadow OAM at vblank start. ⚠ ~512 B of BSS on chr-ram (check `ramUsage` in the build result). |
| **SNES** | OBJ sprites — use **chunky metasprites** (16×16 / 24×16), not lone 8×8 | OBJ or BG | The "looks like dots" trap: naive 8×8 OBJs are technically valid but tiny. Build a real CHR tileset, set OBJ size + the right palette line + CHR base. ⚠ Call `sfx_init()` AFTER `setScreenOn()` (a stalled SPC upload before screen-on = black screen). |
| **GB / GBC** | OAM sprites | OAM + BG | ⚠ Copy tiles into VRAM with `memcpy_vram()`, never a raw `for(i){dst[i]=src[i]}` loop (SDCC miscompiles it → CPU crash). ⚠ uint16_t for loop bounds >255. On GBC, stage+DMA the first OAM frame before enabling the LCD. |
| **C64** | VIC-II hardware sprites (cannon/shots) + character cells (invaders/shields) | character cells | It's a **computer/`.prg`**, not a ROM console. The character grid is great for the invader formation; hardware sprites for the few moving things. |
| **Atari Lynx** | **full-redraw with `tgi_bar` rectangles** (Suzy blitter) | tgi_bar | ⚠ The loop MUST be: `while(tgi_busy()){}` → full-screen `tgi_bar` clear → draw → `tgi_updatedisplay()`. Skipping the busy-wait or using `tgi_clear()` = blank screen. Full redraw every frame is fine for a small game. |
| **Atari 7800** | **MARIA display-list entries** (a "sprite" is a DL header) | DL entries / coarse | ⚠ No sprite table or tilemap. Build the DLL once at init; per frame, PATCH the existing DL entries in place (X / graphics ptr / palette). A full per-frame DLL rebuild = tearing/corruption. ≤~32 objects per scanline. |
| **Atari 2600** | **TIA players + missiles, beam-raced** | reused player / coarse playfield | ⚠ The hardest. No framebuffer — everything is per-scanline register writes. P0 = ship (double-width), P1 + `NUSIZ1` hardware copies = invader row, P1 reused in a lower scanline region = shields, M0 = shot. Don't use playfield bits for aliens — it looks like a barcode. 128 B RAM. |

## The one rule behind all of it

**Match the primitive to the machine's native model, not to your mental
model of "sprites."** Three machines in this list don't have a conventional
sprite table at all:

- **Lynx** is a blitter — you draw rectangles into a framebuffer every frame.
- **7800** is a display-list processor — a "sprite" is a list entry you patch.
- **2600** is a beam-raced register machine — you change TIA registers per
  scanline; objects are reused vertically.

If you try to force a tile/OAM mental model onto those three, you get blank or
broken output. The other nine are sprite+tile machines where the main variables
are the sprite-per-scanline limit and where text/HUD should live (BG, not
sprites, on the constrained ones).

## Recommended workflow

1. **Prototype on GBA or Genesis first.** They have the most headroom, so you
   nail the *gameplay* (movement, collision, waves, scoring) where the hardware
   won't fight you.
2. **Then port downward**, swapping only the rendering layer per the matrix.
   The game logic is the same C; the `stage_sprites()` / draw routine is what
   changes per platform.
3. **Read the platform's `MENTAL_MODEL.md` + `TROUBLESHOOTING.md`** (via
   `getPlatformDoc`) before writing its render layer — they lead with that
   platform's specific footgun.
4. **Verify visually, not just by exit code.** `runSource` returns a screenshot;
   `inspectSprites` / `getRenderingContext` / `readMemory` turn "blank screen"
   into a concrete diagnosis. "It compiled" means nothing until you see a frame.
