# Master System — source you can read

Trust hierarchy:

1. **Bundled examples** (`examples/sms/templates/*.c`).
2. **Bundled runtime** — `src/platforms/sms/lib/c/sms_crt0.s`,
   `vdp_init.c`, `joypad_read.c`, `sprite_table.c`, `sms_sfx.c`,
   `sms_music.c`. All ~50-100 lines each, fully readable.
3. **SDCC z80 port** — WASM compiler shipped, source not bundled.
4. **Upstream GitHub**:

   | What | Upstream |
   |---|---|
   | SDCC | http://sdcc.sourceforge.net/ |
   | genesis_plus_gx libretro (handles SMS) | https://github.com/libretro/Genesis-Plus-GX |

## SMS hardware docs

- **SMS Power!** (canonical homebrew dev hub): https://www.smspower.org/Development/Documents
- **SN76489 PSG ref**: https://www.smspower.org/Development/SN76489
- **VDP register reference**: https://www.smspower.org/Development/VDPRegisters
- **Z80 reference**: https://www.zilog.com/docs/z80/um0080.pdf

## When to use what

- "How does my sprite SAT terminator work?" → MENTAL_MODEL § SAT $D0
- "SN76489 latch byte layout" → SMS Power PSG ref
- "VDP mode 4 specifics" → SMS Power VDP registers
- "genesis_plus_gx doesn't expose register X" → libretro GitHub
