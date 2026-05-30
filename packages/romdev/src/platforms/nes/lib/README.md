# NES starter snippets

Small, vetted ca65 routines for the common boilerplate that every NES
homebrew project needs to get right before any of the interesting code
runs. Drop them into your project as-is or via the `getStarterSnippets`
MCP tool.

| File | What it does |
| --- | --- |
| `reset.s` | Standard reset handler — disable IRQs, clear RAM, wait two vblanks, place OAM off-screen. Call your init at the end. |
| `wait_vblank.s` | Polls `$2002` bit 7 until vblank. Use during setup. |
| `read_pad.s` | Reads controller 1 into `keydown`. Counted 8-iteration loop (safe). Also computes `keynew` for one-shot triggers. |
| `oam_dma.s` | Transfers shadow OAM at `$0200` to the PPU. Call from NMI. |
| `clear_oam.s` | Moves all 64 sprites off-screen by setting Y=$FF. Use during init. |
| `load_palette.s` | Uploads a 32-byte palette table to `$3F00`. |
| `clear_nametable.s` | Fills nametable 0 with one tile + zeros the attribute table. |

## Why these exist

While building `nova-catch.nes` end-to-end via this MCP server, the agent
hit several classic NES foot-guns the hard way:

1. **The seed-bit-through-rol `read_pad` idiom is fragile**: the version
   most NES tutorials show uses `lda #1; sta keydown; ... rol keydown ;
   bcc :-` to count loop iterations via a sentinel bit. It works most of
   the time. When it doesn't, you get zero input and no error message.
   The counted-loop version here is safer and only one byte longer.

2. **`.res` inside a `.proc` allocates in whatever segment is currently
   active**: putting a temp variable inside `.proc update_player`
   silently allocates it in CODE segment ROM space, where writes go to
   void and reads return garbage. Declare all zeropage in
   `.segment "ZEROPAGE"` at the top.

3. **cc65 reserves the first 2 zeropage bytes** for its runtime, so your
   first `.res 1` declaration lands at `$02`, not `$00`. Use the
   `getMemoryMap` MCP tool to find your variables' actual addresses
   instead of probing empirically.

These snippets sidestep all of that.
