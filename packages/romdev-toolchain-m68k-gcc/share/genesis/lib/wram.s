; Genesis — declaring WRAM variables.
;
; Genesis has 64 KB of work RAM at $00FF0000-$00FFFFFF. To use it for
; game variables, you declare LABELS at addresses in that range.
;
; ** DO NOT use `org` for WRAM. ** vasm pads the ROM out to the
; highest `org` it sees, so `org $00FF0000` produces a 16 MB ROM file
; mostly full of zeros, and the variables you "wrote" there aren't
; actually stored anywhere — they're just labels pointing into space
; the CPU will overwrite at runtime. The 16 MB ROM also won't fit on
; real cartridges and confuses some emulators.
;
; ** USE `equ` instead. ** equ declares a NAMED CONSTANT at compile
; time; no bytes are emitted. The CPU reads/writes WRAM via normal
; m68k addressing modes; the label is just a memorable name for the
; address.
;
; Pattern: hand-allocate WRAM addresses by tracking a "next free byte"
; cursor. For larger projects use a macro or external manifest. For
; small games the explicit form below is clearer than any macro.

; ---- Example WRAM map (256 bytes used) -------------------------------

WRAM_BASE         equ $00FF0000

; Per-frame VBlank flag (set by NMI, cleared by main loop).
vblank_ready      equ WRAM_BASE + $0000   ; 1 byte

; Pad state — current frame + previous frame for edge detection.
pad1_held         equ WRAM_BASE + $0002   ; 2 bytes (one word per port)
pad1_pressed      equ WRAM_BASE + $0004   ; 2 bytes
pad1_released     equ WRAM_BASE + $0006   ; 2 bytes

; Game state machine.
game_state        equ WRAM_BASE + $0010   ; 1 byte: 0=title, 1=play, 2=gameover
state_timer       equ WRAM_BASE + $0012   ; 2 bytes: frames in current state

; Player / score (falling-block puzzle example).
score             equ WRAM_BASE + $0020   ; 4 bytes (BCD or binary)
lines_cleared     equ WRAM_BASE + $0024   ; 2 bytes
level             equ WRAM_BASE + $0026   ; 1 byte

; Soft-OAM (sprite list) staging area — DMA'd to VRAM each VBlank.
; This is the convention from sprite_table.s. 640 bytes = 80 sprites
; × 8 bytes/sprite (H40 mode). Place it on a 256-byte boundary for
; alignment-friendly DMA source addressing.
soft_oam          equ $00FFE000           ; 640 bytes through $00FFE27F

; ---- Reading/writing WRAM variables ---------------------------------
;
; Treat WRAM addresses just like any other address. The 68K's full
; addressing range covers them; you don't need bank-switching like SNES
; or NES.
;
; Examples:
;
;   ; Increment score
;   addq.l   #1, score
;
;   ; Edge detect: pressed = held AND NOT held_last_frame
;   move.w   pad1_held, d0
;   move.w   pad1_last, d1
;   not.w    d1
;   and.w    d0, d1                ; d1 = newly-pressed bits
;   move.w   d1, pad1_pressed
;
;   ; Clear soft OAM (hide all sprites by Y=0)
;   lea      soft_oam, a0
;   moveq    #160-1, d0            ; 640 / 4 = 160 longwords
; .clear:
;   clr.l    (a0)+
;   dbra     d0, .clear
;
; ---- ROM-side initialization tip ------------------------------------
;
; WRAM is RANDOM on power-on. If your code reads a variable before
; writing it, you'll get garbage. Standard practice: at _reset, clear
; the whole WRAM range before doing anything else. This snippet:
;
;   lea      WRAM_BASE, a0
;   move.l   #($10000/4)-1, d0     ; 64KB / 4 bytes = 16384 longwords
; .clrwram:
;   clr.l    (a0)+
;   dbra     d0, .clrwram
;
; ...takes ~70 ms but guarantees a clean slate. Most homebrew skips it
; and relies on initializing each variable explicitly; do whichever
; matches your debug comfort level.
