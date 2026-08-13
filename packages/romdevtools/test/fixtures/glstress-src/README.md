# glstress — a GL fixture with the three properties glcart.wasc lacks

Built to the shape the romdev dev asked for:

> "a cart that renders ABOVE the window size, re-sets its viewport per
> frame, and builds an MRT target. One cart with those three properties
> would have caught four of the five."

## Build

    node <wasmcart>/bin/wasmcart-pack.js \
      --wasm <wasmcart-lua>/build/engine.wasm --assets . \
      --name glstress --width 1920 --height 1080 -o glstress.wasc

A prebuilt `../glstress.wasc` is beside this directory.

## How to assert

Read `wasm({op:'debugState'})`:

| field   | meaning |
|---------|---------|
| `score` | **ok** — 1 only when every stage completed this frame |
| `aux`   | **stages** — bitfield, so a failure names WHICH stage died |

    stage 1  clear + scissor        bit 1
    stage 2  background fill        bit 2
    stage 3  MRT pass               bit 4
    stage 4  cubemap faces          bit 8
    stage 5  composite MRT back     bit 16
    stage 6  far-edge markers       bit 32
                                    all = 63

**Assert on `score`, never on screenshot pixels.** The cart paints its
background in stage 2, before the demanding work, so a non-black pixel
check reads PASSING on a broken frame. That trap cost two rounds of this
investigation.

**Warm up, or run ten trials.** The shared-context bug damages exactly the
first load after a `presentWindow` load; a single trial on a fresh server
passes. This is what made the dev and the client disagree for four rounds.

## Verified against the real bug (romdev 2f891b74)

    with the fix:      0/6  failed
    fix line removed:  9/10 failed, every failure stages=51

51 = 63 minus bits 4 and 8, i.e. it names the MRT and cubemap passes as
the casualties, which is exactly the attachment-validation failure the fix
addresses.

For comparison, `glcart.wasc` passes 3/3 with the fix removed — it is
64x64 and builds no MRT, so it never reaches the check.
