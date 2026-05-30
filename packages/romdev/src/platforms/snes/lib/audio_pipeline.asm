; SNES — audio pipeline overview (this is a doc snippet, not asm to .include).
;
; The SNES has a separate Sony SPC700 coprocessor that handles ALL sound.
; The main 65816 CPU cannot make a beep — it can only upload a program +
; sample data to the SPC700, then send commands telling it what to play.
;
; You write TWO programs:
;   1. An SPC700 driver (arch spc700) — lives in ARAM, polls $F4 for
;      command bytes from the main CPU, pokes DSP registers ($00-$7F)
;      to start/stop voices.
;   2. The 65816 uploader — runs once at boot. Walks the $BBAA handshake
;      protocol at $2140-$2143 to copy your SPC driver bytes into ARAM,
;      then jumps it.
;
; This MCP server provides:
;   - `buildSource({platform:"spc700", source})` — assembles standalone
;     SPC700 code to a flat raw binary (no SNES header, no padding).
;     Write your driver in arch-spc700 .asm, build separately, then
;     `.incbin` the resulting .bin into your SNES main.asm.
;   - `pcmToBrr({pcmPath, outputPath, loop})` — encodes raw 16-bit signed
;     PCM (mono, little-endian) into SNES BRR format. Generate the PCM
;     yourself (sox, ffmpeg, mathematical square wave, AI-generated wav
;     with the header stripped) and run it through this.
;
; What you write yourself:
;   - The SPC driver (~150-300 bytes typical). Polls $F4 for command byte,
;     reads sample index, pokes DSP $4C (KON) to trigger voice. See
;     snesdev wiki "SPC700 reference" and "DSP" pages for register layout.
;   - The 65816 IPL upload routine (~100-150 bytes). Sends $CC to $2140 to
;     start the handshake, then streams the SPC blob byte-by-byte via the
;     $BBAA/$BB+1 protocol described on the snesdev wiki "APU I/O" page.
;   - Your `play_sfx N` API on the 65816 side: typically just `lda #N /
;     sta $2140` and let the SPC driver react.
;
; What you put in your main.asm:
;
;   ; Late in ROM, the asset blobs.
;   spc_image:
;     incbin "spc_driver.bin"      ; from buildSource(platform:"spc700")
;   spc_image_end:
;
;   brr_shoot:
;     incbin "shoot.brr"           ; from pcmToBrr(pcmPath:"shoot.pcm")
;   brr_shoot_end:
;
;   brr_hit:
;     incbin "hit.brr"
;   brr_hit_end:
;
;   ; Tables the IPL routine and SPC driver share by convention.
;   spc_image_size: dw spc_image_end - spc_image
;   spc_load_addr:  dw $0200       ; ARAM address the driver runs at
;
; Where to put samples in ARAM: typically right after the driver code,
; aligned on a 9-byte boundary (BRR blocks). The driver should know
; (compile-time or runtime) where samples start so it can build the
; DSP sample directory ($XX00 = 4-byte entries, start addr + loop addr).
;
; Helpful references — the snesdev wiki pages "APU I/O", "SPC700 reference",
; "BRR sample format", "DSP". These are the canonical specs. The actual
; protocol is short (a 4-page wiki article); the trick is just getting all
; four pieces aligned.
