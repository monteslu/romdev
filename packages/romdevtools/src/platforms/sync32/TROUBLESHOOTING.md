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

**`ld: warning: main.elf has a LOAD segment with RWX permissions`** — expected
and harmless: a flat cart image IS one segment that is loaded, read and
executed. romdev strips it from a successful build's log tail, as it does the
WASM host's `warning: unsupported syscall: __syscall_prlimit64` (cc1 probing
for a memory limit the host does not implement — one line per translation
unit, meaning nothing). Neither is a diagnostic.

**`multiple definition of \`game_main'`** from `build({output:'project'})` —
the directory holds two entry points (the game and, say, an `asset_check.c`
verification harness), and a project build treats every `.c` as a translation
unit. Keep the harness; pass `exclude: ['asset_check.c']` (names or globs) and
it stays out of the link. Swap the exclusion to build the harness instead.

**Headers shared with another target live outside the project dir** — pass
`includeDirs: ['/abs/shared']`. `includePaths` is an exact virtual-name → file
*map*, not a search path, so a forgotten entry surfaces as a plain
`foo.h: No such file or directory`; `includeDirs` stages a whole tree keyed by
relative path.

## Running

**`build({output:'run'})` refuses the cart (`retro_load_game returned false`)
but `build({output:'rom', outputPath})` + `loadMedia({path})` runs it** — that
was a romdev bug through 0.135.1: the s32core is a NODERAWFS build (it
`fopen()`s the cart by real path and streams `<name>/` off disk), and the run
path did not tell the host so, so the in-memory bytes were never spilled to a
temp file. Fixed in 0.136.0 — `output:'run'` is the documented first step of a
fork again. If you see it on a newer server, the cart really is refused: check
the header (`SY32`, 64 bytes) and that `mode` matches the linker script.

**`loadMedia` says `loaded:true` and the very next call says "No ROM
loaded"** — your calls are landing in different sessions. On a 2026-07-28 MCP
client (Claude Code 2.1.x) the server keys a session to your connection and
every result ends with a `session: <id>` line; pass `session:"<id>"` on later
calls (or your own stable slug from the start) and the emulator stays put.
Over plain HTTP send the same `x-romdev-session` header on every call AND
reuse the `Mcp-Session-Id` from one `initialize` — re-initializing per call
mints a fresh session even with the header set, which is how a second playtest
window gets opened with the first one orphaned.

**Sprites have transparent holes, or a solid box around them** — index 0 is
the global transparent key for `sprite()`. Holes mean your quantizer put a real
colour into slot 0; a box means your transparent pixels landed on some other
index. Reserve index 0 for transparency and start art colours at 1
(`encodeArt({stage:'tiles', platform:'sync32'})` reserves it by default; pass
`baseIndex` to place a bank higher up).

**A colour renders as the wrong colour** (a grey road comes out blue, a green
court comes out black) — `rect()`/`clear()` snap to the **nearest palette
entry**, because the canvas is 8-bit indexed. If the palette only holds sprite
colours, every background colour you pass is rounded to one of those. Add the
colours you draw with to the palette. This is not a bug and there is no way to
draw an off-palette colour.

**A sprite does not appear at all** — check the sheet cell. `sprite(sh, sx, sy,
w, h, ...)` reads columns `sx..sx+w-1`; art drawn outside that span is silently
clipped. Drawing a 4px bullet at x=54 in a cell that starts at x=48 with w=8
puts half of it outside the blit.

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

**"How many bytes may my image be?"** — `platform({op:'capabilities',
platform:'sync32'})` reports `imageBudget` per mode (ram: 311 296 bytes for
text+rodata+data+bss; xip: 12 MB flash for code+rodata plus the same 311 296
for data+bss). It is the linker script's number, not an estimate.

**"Which key jumps in the playtest window?"** — `input({op:'layout',
platform:'sync32'})`: the `S32_PAD_*` bits, the libretro name mapping (s32core
maps a/b/x/y BY NAME, so `{a:true}` is `S32_PAD_A`), and the window's keyboard
binding (Z = libretro b = `S32_PAD_B`, X = libretro a = `S32_PAD_A`, arrows =
d-pad, Enter = START, RShift = SELECT).

**`frame({op:'verify'})` says "nearlyBlank" on a game that looks fine** — the
check flags a screen that is >92% one colour, which is tuned for tilemap
platforms whose backgrounds fill the frame. A sync32 game composing sprites
over a flat `clear()` backdrop — a shmup on space, a paddle game on an empty
court — legitimately sits at 93-98% one colour while being completely correct.
Look at the screenshot before believing the verdict; on this platform
`verified:false` is evidence to check, not a failure.


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
