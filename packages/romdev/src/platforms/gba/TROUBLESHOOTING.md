# Game Boy Advance — troubleshooting

When something's broken. Read MENTAL_MODEL.md first
(via `getPlatformDoc({platform:"gba", name:"mental_model"})`).

## ⚠️ ROM compiles + loads but the screen never updates (frozen on frame 1)

**Single most common GBA gotcha.** Symptom: `runSource` returns a
black screen (or only the very first frame's contents, never any
sprite/animation update). You added `VBlankIntrWait()` to the main
loop — but the BIOS function halts the CPU **forever** waiting for a
vblank IRQ to fire. You forgot to install the IRQ handler table.

Fix — call BEFORE the first `VBlankIntrWait()`:

```c
/* libtonc */
irq_init(NULL);
irq_add(II_VBLANK, NULL);
```

```c
/* libgba */
irqInit();
irqEnable(IRQ_VBLANK);
```

Both runtimes provide BIOS-VBlank-handling. With libtonc, `irq_init`
installs the master handler + `irq_add(II_VBLANK, NULL)` registers a
no-op for vblank (just so the IRQ fires + the BIOS counter increments).
With libgba, `irqInit()` does both steps.

Every bundled R28 scaffold (`tonc_hello`, `tonc_hello_sprite`, `shmup`,
`platformer`, `puzzle`, `sports`, `racing`) sets this up — copy the
pattern.

## Text on screen

**Use TTE (Tonc Text Engine) — that's the default runtime's path.**
libtonc is the default GBA C runtime as of R28 and TTE handles text
rendering without needing libsysbase:

```c
#include <tonc.h>

int main(void) {
    tte_init_chr4c_default(0, BG_CBB(0) | BG_SBB(31));
    REG_DISPCNT = DCNT_MODE0 | DCNT_BG0;
    tte_write("Hello, GBA!\n");
    tte_printf("Score: %d", score);
    while (1) { VBlankIntrWait(); }
}
```

`tte_write` + `tte_printf` render directly into BG tile maps — no
libsysbase, no devkitPro setup, works out of the box with the
bundled runtime.

## ⚠️ iprintf doesn't work on the libgba path. Why?

**Only an issue if you opt into `runtime: "libgba"` (the devkitPro
SDK path) — the default libtonc runtime sidesteps this entirely with
TTE.** Most devkitARM tutorials show `iprintf("Hello\n")` as the
hello-world pattern. **This will NOT compile against our libgba build.**

### Why we excluded it

libgba's `console.c` provides iprintf-style stdio routing: writes get
captured by devkitPro's libsysbase and rendered as text on a
tile-based BG. Implementing that requires `<sys/iosupport.h>` +
`<sys/statvfs.h>` + `<sys/dir.h>` + ~a dozen more libsysbase headers
that vanilla newlib does NOT ship. Porting devkitPro's libsysbase to
our toolchain is multi-day work that is currently deferred.

The trade-off: we got `#include <gba.h>` working end-to-end and 95% of
the libgba API. iprintf is the 5% missing. R28 added libtonc as the
default precisely because TTE provides the same capability without
the libsysbase dependency.

### Workarounds — pick the one that fits your case

#### 0. Just use the default libtonc runtime (easiest)

`tte_write("Hello\n")` works out of the box. Drop the `runtime: "libgba"`
flag from your `buildSource` call and use `#include <tonc.h>` instead
of `#include <gba.h>`.

#### 1. mGBA's BIOS debug interface (works on either runtime)

mGBA exposes BIOS addresses that route writes to its debug console:

```c
#define MGBA_DEBUG_ENABLE  (*(volatile u16*)0x4FFF780)
#define MGBA_DEBUG_LEVEL   (*(volatile u16*)0x4FFF700)
#define MGBA_DEBUG_FLAGS   (*(volatile u16*)0x4FFF702)
#define MGBA_DEBUG_STRING  ((volatile char*)0x4FFF600)

void mgba_log(const char *msg) {
    MGBA_DEBUG_ENABLE = 0xC0DE;
    if (MGBA_DEBUG_ENABLE != 0x1DEA) return;  /* not mGBA */
    int i;
    for (i = 0; i < 255 && msg[i]; i++) MGBA_DEBUG_STRING[i] = msg[i];
    MGBA_DEBUG_STRING[i] = 0;
    MGBA_DEBUG_FLAGS = 2 | 0x100;  /* level 2 = info, send */
}
```

Works in our test pipeline + lets the agent inspect logs via mGBA's
state. Won't work on real hardware but real hardware isn't usually
the loop you're iterating in.

#### 2. Hand-roll a tile-text renderer

About 30 lines of C. Upload an 8x8 font into VRAM, set up a BG with a
character map, write tile indices for the chars you want. Slower to
write than iprintf the first time but works on real hardware AND mGBA.

#### 3. Install devkitPro natively + use their libgba

Apt-install devkitPro (`apt install devkitpro-pacman` + `dkp-pacman -S
gba-dev`), then build your project against THAT libgba.a — which has
console.c + libsysbase. Works as a fallback if you genuinely need
iprintf and the above two don't cut it. You lose romdev's zero-
install promise but everything else still works.

A deferred enhancement is to port libsysbase into our build so
iprintf "just works."

## Adding sound to a scaffold

Both runtimes bundle `gba_sfx.h` + `gba_sfx.c` next to your `main.c`
(courtesy of `createProject`). The shape:

```c
#include "gba_sfx.h"

int main(void) {
    sfx_init();                    /* once at startup */
    sfx_tone(1, 1900, 4);          /* ch1 square wave, pew */
    sfx_tone(2, 1300, 6);          /* ch2 square wave, blip */
    sfx_noise(8);                  /* ch4 noise, explosion */
}
```

`freq_period` is the GBA 11-bit frequency code. Hz ≈ 131072 / (2048 -
freq_period). Useful values: 1900 = pew, 1500 = boing, 1300 = blip,
800 = low thump. `length_frames` is the 64-step countdown (~3.9ms
each, max 63). Channels 3 (wave RAM) + Direct Sound (PCM via DMA) are
NOT wrapped — that's a music-track concern, not a sfx concern, and
needs more setup than a one-call helper provides. Reach for maxmod
(separate library, not bundled) when you want music + samples.

## BG0 tile data disappears after TTE init

If your BG0 grid renders fine in isolation but vanishes when you also
init TTE on BG1, you've got a VRAM region collision. TTE writes the
default 4bpp font into its destination char-block — if your BG0
char-block overlaps it, the font load wipes your tiles.

Fix: put BG0's char-block + screen-block well away from TTE's. The
bundled `puzzle.c` uses BG0 at `BG_CBB(3) | BG_SBB(28)` while TTE
runs on BG1 at `BG_CBB(2) | BG_SBB(30)`. Each char-block is 16 KB
(holds 512 4bpp tiles) and each screen-block is 2 KB (one 32×32
tilemap). Char-blocks 0+1 partially overlap screen-blocks 24-31 in
VRAM, which is fine as long as you don't try to use both at the same
addresses.

## "ROM builds but the screen is black"

Three common modes:

1. **You forgot `REG_DISPCNT = MODE_x | BGn_ON`.** After reset the
   GBA's DISPCNT is in "forced blank" mode (bit 7 set). libgba's
   crt0 doesn't unblank for you — that's your `main()`'s job. Set
   a video mode and turn on at least one BG.
2. **You used MODE_3 but wrote to VRAM as bytes.** Mode 3 framebuffer
   is u16 per pixel (BGR555). Writing single bytes to odd addresses
   silently drops data (VRAM has 16-bit-write hardware). Use
   `MODE3_FB[row][col] = RGB5(r,g,b);` or `*(u16*)addr = ...`.
3. **You ran a `while (1) { }` immediately after main without
   `VBlankIntrWait`.** The screen DOES render — but with no input
   updates, no animation, the user thinks "nothing's happening."
   Add an input + animation loop with `VBlankIntrWait`.

## "Build fails with `undefined reference to '_init'` or `'fake_heap_end'`"

These are devkitARM startup-code symbols. Our build pipeline
auto-links `crti.o`/`crtn.o` (for `_init`) and a generated
`fake_heap_end` stub. If you're seeing these errors, you're probably
running `buildGbaC` against an old cached version of the toolchain
script. Restart the MCP server.

## "Build fails with `int8_t not defined` or `stdint.h not found`"

The GBA C build mounts newlib + libgcc headers into `/work/` for the
cc1 invocation. If you see this, your build is somehow missing the
sysinclude/ tree. Verify
`src/platforms/gba/lib/libgba/sysinclude/stdint.h` exists; if not,
re-run `scripts/build-libgba.sh` which fetches devkitPro's
iosupport.h + ships the toolchain's newlib headers.

## "GCC complains about `__syscall_prlimit64`"

That's a warning (not an error) from cc1's emscripten host runtime —
the WASM build of cc1 references `prlimit64` for memory limits, but
emscripten libc doesn't implement it. cc1 falls back to a default and
proceeds. Ignore.

## "ROM works in mGBA but won't boot on real hardware"

Real hardware checks the Nintendo logo at $04-$9F (156 bytes). Our
`gba_crt0.s` leaves it zeroed because including the actual logo
bytes would be a copyright issue. To boot on real hardware:

1. Build with our toolchain.
2. Run devkitARM's `gbafix` tool on the output `.gba` — it patches in
   the logo + checksum bytes. devkitPro distributes `gbafix` as part
   of their host tools; install separately when you're shipping to
   real cartridges.
3. The result is real-hardware compatible.

mGBA, VBA-M, and most other emulators skip the logo check.

## "OAM doesn't update / sprites stuck"

OAM is at $07000000. The GBA hardware locks OAM during HBlank/VBlank
of certain modes. Writes outside the right window get dropped. Safest
pattern: write OAM during VBlank (via `VBlankIntrWait` + then OAM
updates immediately after).

libgba helpers don't auto-defer to vblank — `OAM[i]` writes whenever
you call them. If you're writing during the visible region with
"hblank-interval-free" disabled in DISPCNT, the GBA freezes OAM and
your writes are lost.

## "First C build is slow (~1-2 s) but later ones are fast"

Expected. The cc1.wasm is 141 MB unstripped — first invocation mmaps
it into a worker, instantiates the module. Subsequent builds reuse the
warm worker pool (R12). Steady-state builds are sub-second.

A future optimization (R28?): rebuild cc1.wasm with `-O3 --strip-debug`
to get it down to ~17 MB like the m68k toolchain has. Functionality
is identical either way; just smaller bundle.

## "Save states don't work on `.gba` ROMs"

mGBA save states work — `saveState` / `loadState` MCP tools should
function on any loaded GBA ROM. If you find a specific game where they
don't, file an issue — most likely a mGBA-side bug, not ours.
