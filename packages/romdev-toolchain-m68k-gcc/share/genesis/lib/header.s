; Genesis / Mega Drive — cartridge header.
;
; The 68000 reads the reset vector from $0000-$0007 (initial SSP at $00,
; reset PC at $04). Immediately after is the 256-byte ROM header at $100
; — every Genesis ROM needs this in a specific format or the BIOS will
; refuse to boot the cart (some emulators are forgiving; real hardware
; isn't).
;
; Fields below are positional and must be the exact byte counts shown.
; vasm68k pads strings to their declared length with spaces if you use
; .ascii "..." inside a fixed area, but it's safer to space-pad manually
; to avoid subtle off-by-ones.

  org $00000000

; ---- 68K interrupt + exception vectors ($000-$0FF) -----------------------
vector_table:
  dc.l   $00FFE000          ; initial SSP — top of work RAM
  dc.l   _reset             ; reset PC — your entry point
  ; Vectors 2-63 (252 bytes) typically point to an exception handler.
  ; The lazy version: all default to _reset; real games install real
  ; handlers for bus error / address error / illegal instruction.
  rept 62
  dc.l   _exception_handler
  endr

; ---- ROM header ($100-$1FF) ----------------------------------------------
;
; The header is EXACTLY 256 bytes ($100-$1FF). Some online references
; claim the "notes" field is 40 bytes (which would push region past
; $1FF and overlap _reset at $200) — that's a transcription error.
; Authoritative layout (verified against snes9x's snes9x-libretro
; sister project genesis_plus_gx and Sega's original SDK docs):
;
;   $100-$10F  system name (16)
;   $110-$11F  copyright   (16)
;   $120-$14F  domestic title (48)
;   $150-$17F  overseas title (48)
;   $180-$18D  serial number  (14)
;   $18E-$18F  checksum    (2)
;   $190-$19F  device support (16)
;   $1A0-$1A3  ROM start (4)
;   $1A4-$1A7  ROM end   (4)
;   $1A8-$1AB  RAM start (4)
;   $1AC-$1AF  RAM end   (4)
;   $1B0-$1BB  SRAM tag  (12)
;   $1BC-$1BF  SRAM start (4)
;   $1C0-$1C3  SRAM end   (4)
;   $1C4-$1CF  modem info (12)
;   $1D0-$1EF  notes      (32)    ← NOT 40
;   $1F0-$1FF  region     (16)
;
; A label at _header_end (= $200) below would catch any miscount via
; vasm's section-overlap detection (gives a more readable error than
; "instruction at $1F8 collides with code at $200").
  org $00000100
  dc.b "SEGA MEGA DRIVE "                          ; $100 system name (16)
  dc.b "(C)YOU 2026.JAN "                          ; $110 copyright (16)
  dc.b "MY GAME                                         " ; $120 domestic title (48)
  dc.b "MY GAME                                         " ; $150 overseas title (48)
  dc.b "GM 00000000-00"                            ; $180 serial number (14)
  dc.w $0000                                       ; $18E checksum — leave 0 for emulator dev
  dc.b "J               "                          ; $190 device support: J=joypad (16)
  dc.l $00000000                                   ; $1A0 ROM start address
  dc.l ROM_END-1                                   ; $1A4 ROM end address (set by build)
  dc.l $00FF0000                                   ; $1A8 RAM start
  dc.l $00FFFFFF                                   ; $1AC RAM end
  dc.b "            "                              ; $1B0 SRAM tag — 12 spaces if no SRAM
  dc.l $00000000                                   ; $1BC SRAM start
  dc.l $00000000                                   ; $1C0 SRAM end
  dc.b "            "                              ; $1C4 modem info — 12 spaces ($1C4-$1CF)
  dc.b "                                "          ; $1D0 notes  — 32 spaces ($1D0-$1EF) ** NOT 40 **
  dc.b "JUE             "                          ; $1F0 region — 16 chars ($1F0-$1FF): J=Japan U=US E=EU

  org $00000200
_reset:
  ; Your initialization code goes here.
  ; Typical first steps:
  ;   - Disable interrupts: move.w #$2700, sr
  ;   - Init VDP (see vdp_init.s)
  ;   - Init Z80 (see z80_bootstrap.s)
  ;   - Build sprite table in WRAM
  ;   - Enable VBlank, drop to main loop
  move.w #$2700,sr           ; mask all interrupts during init
  ; ... your init here ...
.halt:
  bra.s .halt

_exception_handler:
  ; In real games this would dump CPU state for diagnostics. For
  ; debugging, having ANY exception handler beats the default "garbage
  ; PC" experience; for production, install per-vector handlers that
  ; reset the system or display an error.
  rte

ROM_END:
