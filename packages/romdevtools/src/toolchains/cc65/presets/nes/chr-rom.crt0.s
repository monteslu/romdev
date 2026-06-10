; crt0 for NES CHR-ROM mode + nes_runtime NMI handler.
;
; Companion to the linkerConfig:"chr-rom" preset. Identical to
; chr-ram-runtime.crt0.s EXCEPT:
;   - the iNES header sets byte 5 = 1 (one 8KB CHR-ROM bank), and
;   - there is NO CHR-RAM clear loop — pattern tables come from the CHR-ROM
;     bank (the CHARS segment / ROM2 area) the PPU reads directly.
;
; The NMI handler is the canonical sprite-engine sequence (OAM DMA + VRAM-queue
; flush + scroll + PPUCTRL), same as the CHR-RAM runtime.
;
; Loaded silently by the linkerConfig:"chr-rom" preset.

        .export         _exit
        .export         __STARTUP__ : absolute = 1
        .export         start
        .export         nmi
        .export         irq
        .export         _shadow_oam

        .import         initlib, donelib, callmain
        .import         _main, zerobss, copydata
        .import         __RAM_START__, __RAM_SIZE__
        .import         __SRAM_START__, __SRAM_SIZE__
        .import         _vram_q_hi, _vram_q_lo, _vram_q_val
        .import         _vram_queue_head, _vram_queue_len, _vram_queue_lock

; Must match nes_runtime.c (QUEUE_MAX 32 ring buffer).
QUEUE_MASK   = 31
FLUSH_BUDGET = 16
        .import         _scroll_x, _scroll_y, _ppuctrl_value, _nmi_counter
        .importzp       c_sp

; ------------------------------------------------------------------------
; 16-byte iNES header — CHR-ROM (byte 5 = 1 → one 8KB CHR-ROM bank).

.segment "HEADER"
        .byte   $4e, $45, $53, $1a   ; "NES" + EOF
        .byte   2                    ; PRG-ROM banks (16K each) → 32K
        .byte   1                    ; CHR-ROM banks (8K each)  → 8K CHR-ROM
        .byte   %00000001            ; flags6 — vertical mirroring
        .byte   %00000000            ; flags7 — mapper hi nybble
        .byte   0, 0, 0, 0, 0, 0, 0, 0

; ------------------------------------------------------------------------
.segment "STARTUP"

start:
        sei
        cld
        ldx     #$ff
        txs

        ; Disable everything that could fire during init.
        lda     #0
        sta     $2000           ; disable NMI
        sta     $2001           ; disable rendering
        sta     $4010           ; disable DMC IRQ
        sta     $4015           ; disable APU channels
        bit     $2002           ; clear vblank flag

        ; Wait two VBlanks before touching the PPU (standard NES init).
@vbl1:  bit     $2002
        bpl     @vbl1
@vbl2:  bit     $2002
        bpl     @vbl2

        ; Initialise shadow_oam to Y=$FF (off-screen) before anything else.
        ldx     #0
        lda     #$ff
@oam:   sta     _shadow_oam,x
        inx
        bne     @oam

        ; NO CHR-RAM clear — pattern tables live in the CHR-ROM bank (CHARS).
        ; Just point PPUADDR at the palette ($3F00) ready for the caller.
        bit     $2002           ; reset PPUADDR latch
        lda     #$3F
        sta     $2006
        lda     #$00
        sta     $2006

        ; Clear BSS + copy DATA (cc65 conventions).
        jsr     zerobss
        jsr     copydata

        ; Set up cc65's C parameter stack pointer.
        lda     #<(__SRAM_START__ + __SRAM_SIZE__)
        ldx     #>(__SRAM_START__ + __SRAM_SIZE__)
        sta     c_sp
        stx     c_sp+1

        jsr     initlib
        jsr     callmain

_exit:  jsr     donelib
        jmp     start

; ------------------------------------------------------------------------
; NMI handler — runs every vblank when ppuctrl bit 7 is set.

.segment "STARTUP"

nmi:
        pha
        txa
        pha
        tya
        pha

        ; OAM DMA: copy 256 bytes from $0200 to PPU OAM. Takes 513 cycles.
        lda     #$00
        sta     $2003           ; PPU OAMADDR = 0
        lda     #$02            ; high byte of $0200
        sta     $4014           ; PPU OAMDMA — kicks off the copy

        ; ── Drain the VRAM queue — IN ASSEMBLY, on purpose ──────────────
        ; Vblank is ~2273 CPU cycles and the OAM DMA above just spent 513.
        ; Compiled C costs 200+ cycles per queue entry, so a C flush blows
        ; past the end of vblank — and PPUDATA writes during ACTIVE
        ; RENDERING land at corrupted addresses (the PPU's internal v
        ; register is busy fetching tiles; its coarse-X/fine-Y counters
        ; shear every late write). This loop costs ~40 cycles per entry,
        ; so FLUSH_BUDGET entries always finish safely inside vblank.
        ; QUEUE_MASK/FLUSH_BUDGET must match nes_runtime.c's ring buffer.
        lda     _vram_queue_lock
        bne     @flush_done     ; a push is mid-flight — skip this vblank
        lda     _vram_queue_len
        beq     @flush_done
        cmp     #FLUSH_BUDGET
        bcc     @flush_n_ok
        lda     #FLUSH_BUDGET
@flush_n_ok:
        sta     nmi_drain       ; loop counter
        sta     nmi_drained     ; remembered for the length update
        bit     $2002           ; reset the PPUADDR write latch
        ldx     _vram_queue_head
@flush_loop:
        lda     _vram_q_hi,x
        sta     $2006
        lda     _vram_q_lo,x
        sta     $2006
        lda     _vram_q_val,x
        sta     $2007
        inx
        txa
        and     #QUEUE_MASK     ; ring wrap
        tax
        dec     nmi_drain
        bne     @flush_loop
        stx     _vram_queue_head
        lda     _vram_queue_len
        sec
        sbc     nmi_drained
        sta     _vram_queue_len
@flush_done:

        ; Reset PPUADDR to $2000 so the PPU doesn't sample random VRAM as BG.
        bit     $2002
        lda     #$20
        sta     $2006
        lda     #$00
        sta     $2006

        ; Set scroll (two PPUSCROLL writes: x then y).
        lda     _scroll_x
        sta     $2005
        lda     _scroll_y
        sta     $2005

        ; Re-enable NMI + base nametable + pattern-table bits via cached PPUCTRL.
        lda     _ppuctrl_value
        sta     $2000

        ; Tick the frame counter so ppu_wait_nmi can return.
        inc     _nmi_counter

        pla
        tay
        pla
        tax
        pla
        rti

irq:    rti

; ------------------------------------------------------------------------
; Shadow OAM at $0200 — the NMI handler DMAs this to the PPU each frame.
.segment "OAM"
_shadow_oam: .res 256

; ------------------------------------------------------------------------
; NMI-private temporaries — deliberately NOT cc65's zp tmp1-4 (the NMI
; would corrupt them under interrupted C code).
.segment "BSS"
nmi_drain:   .res 1
nmi_drained: .res 1

.segment "VECTORS"
        .word   nmi             ; $FFFA
        .word   start           ; $FFFC
        .word   irq             ; $FFFE
