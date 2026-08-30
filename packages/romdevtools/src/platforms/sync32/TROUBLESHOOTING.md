# sync32 — troubleshooting

Symptom → cause → fix. Every entry here is a failure that actually happened
while bringing the platform up, not a hypothetical.

## Build

**`undefined reference to memset`** (or `memcpy`) — the compile lost
`-ffreestanding`. Without it gcc assumes a hosted environment and is free to
turn a struct or array initializer into a `bl memset`, which then cannot link
against a cart that has no libc. romdev passes it; if you are driving `cc1`
yourself, keep it. Note that `-nostartfiles` is a *driver* option and `cc1`
rejects it — dropping both together is the mistake that produces this.

**`undefined reference to __aeabi_uldivmod`** (or `__aeabi_d*`, `__aeabi_f2d`,
`__aeabi_ldiv0`) — the code needs a **libgcc** helper: 64-bit division, or
double-precision float. These are compiler support routines, not libc, and
romdev links the bundled ARMv8-M libgcc for exactly this. If you see it anyway,
the link is missing that archive.

Both are also a performance signal. The FPU is single-precision, so a `double`
means slow soft-float calls; a 64-bit divide is a library call rather than an
instruction. Switching to `float` and 32-bit math usually makes the symbol
disappear *and* the game faster.

**`entry _start=0x… is outside the ram image`** — the linker script does not
match the mode. `ram.ld` links for 0x20030000 and `xip.ld` for 0x10100000; the
packer computes `entry - base` and refuses a nonsense offset rather than writing
a header that would jump into nothing. Build with the `mode` you intend.

**`'main.s32e' is a name the console owns`** — a resource in `data` collided
with a reserved name inside the game namespace (`main.s32e`, `info.txt`,
`.s32id`). Rename the file.

**A `NAME: MACRO`-style parse error, or flags rejected as "valid for the driver
but not for C"** — you are passing driver options to `cc1`. It takes
`-ffreestanding`, `-O2`, `-ffunction-sections`; it does not take
`-nostartfiles`, `-Wl,…`, or `-T`.

## Running

**Black screen, but the frame counter advances** — the game is running and
drawing nothing. Usual causes: no `present()` in the loop (nothing is ever
shown); drawing to `canvas()` without `canvas_mark()`, so the console uploads no
rows; or a palette that was never set, leaving every index black. Check in that
order.

**Nothing happens at all / the cart does not boot** — confirm the header. A
`.s32` starts with `SY32` and a 64-byte header, and `api_version` in it is the
*minimum the console must provide*. Declaring `api: 2` and running on v1
firmware is a refusal, not a crash.

**A game with resources cannot find its files** — it was built as a bare
executable rather than the archive form. The disk API is sandboxed to the
game's own directory, so a cart with no namespace has nothing to read. Pass
`data`/`dataPaths` at build time and set `api: 2`.

## Audio

**Audio is silent, or the sink mutes after a moment** — the classic mistake is
pushing a whole video frame of audio in one `audio_push()`. The ring holds
`S32_AUDIO_RING` (1024) frames and one frame of 48kHz audio is 800, so a single
big push exceeds `audio_space()`, and the excess is **dropped silently**. The
stream then runs under 48kHz, and against the HDMI clock the console declares,
a sink resolves that mismatch by muting.

Push in smaller chunks across the frame, always bounded by `audio_space()`:

```c
int space = api->audio_space();
if (space > 0) api->audio_push(buf, space < have ? space : have);
```

## Tooling

**A ROM file suddenly became a few bytes** — something passed the ROM's path
where a tool writes its OUTPUT. `memory({op:'readCart'})` takes the ROM to read
as **`romPath`**; its `path`/`outputPath` is where bytes get *written*. (Before
0.132.0 the schema declared `path` twice and the input silently became an output
path — that is fixed, but the general shape of the mistake is easy to repeat
with any tool that has both.)

Recovery: a built ROM is usually a gitignored build output, so `git checkout`
will not bring it back — rebuild it from its sources with `build(...)`. Keep
outputs out of source directories to begin with.

## Input

**Works on your setup, not on someone else's** — the game depends on analog
sticks. `lx/ly/rx/ry` are reported *when the hardware has them* and are never
guaranteed. Treat the d-pad and buttons as the only required input, and check
`pad.connected`.
