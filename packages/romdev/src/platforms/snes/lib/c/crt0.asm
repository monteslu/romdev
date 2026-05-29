; crt0.asm — minimum boot stub for tcc-65816 C programs on SNES.
;
; What this does (in order):
;   1. Reset vector lands here from hdr.asm. CPU starts in emulation mode.
;   2. Switch to native 65816 mode (clc / xce). Stack at $1FFF.
;   3. Set direct-page register to where tcc__r* registers live (page 0).
;   4. Copy initialized C globals from ROM (.glob.data) → RAM (.globram.data).
;   5. Zero the .bss segment.
;   6. JSL into main() (the C entry point).
;   7. Park CPU forever after main returns (stp).
;
; The "tcc__r*" naming is what tcc-65816 emits in its codegen — those
; addresses must be in zero page so tcc's `sta.b tcc__r0` works as a
; direct-page write (saves a byte on every reg-to-reg move).

.include "hdr.asm"

; ── Direct-page registers tcc-65816 reads/writes ────────────────────
; Must live at BANK 0 SLOT 1 ORGA 0 so direct-page math works out.
; ORGA 0 PRIORITY 1000 forces this RAMSECTION to live at $0000 and win
; any address collision.
.RAMSECTION ".registers" BANK 0 SLOT 1 ORGA 0 FORCE PRIORITY 1000
tcc__registers dsb 0
tcc__r0  dsb 2
tcc__r0h dsb 2
tcc__r1  dsb 2
tcc__r1h dsb 2
tcc__r2  dsb 2
tcc__r2h dsb 2
tcc__r3  dsb 2
tcc__r3h dsb 2
tcc__r4  dsb 2
tcc__r4h dsb 2
tcc__r5  dsb 2
tcc__r5h dsb 2
tcc__r9  dsb 2
tcc__r9h dsb 2
tcc__r10  dsb 2
tcc__r10h dsb 2
tcc__f2  dsb 2
tcc__f2h dsb 2
tcc__f3  dsb 2
tcc__f3h dsb 2
.ENDS

; ── RAM section sentinels ──────────────────────────────────────────
; tcc emits its globals into "globram.data" (RAM) and "glob.data" (ROM
; init image). The crt0 copies one to the other at boot. Place both
; sections so wlalink can compute SECTIONSTART/SECTIONEND symbols.
.RAMSECTION "globram.data" BANK $7F SLOT 3 KEEP
.ENDS

.RAMSECTION ".bss" BANK $7E SLOT 2
.ENDS

.BANK 0
.SECTION "glob.data" SEMIFREE ORG 0 KEEP
.ENDS

; ── Boot handlers ───────────────────────────────────────────────────
.SECTION "EmptyVectors" SEMIFREE ORG 0
EmptyHandler:
    rti
.ENDS

.EMPTYFILL $00   ; pad unused ROM with $00 = BRK (will crash, which is louder than NOP)

; ── tcc__start ─ the actual reset handler ─────────────────────────
.SECTION ".start" SEMIFREE ORG 0

.accu 16
.index 16
.16bit

tcc__start:
    sei                  ; disable interrupts until init is done
    clc                  ; clear carry…
    xce                  ; …then xchg to switch to native mode
    rep   #$18           ; binary mode, X/Y 16-bit
    ldx   #$1FFF
    txs                  ; stack at $1FFF

    rep   #$30           ; all registers 16-bit
    ; direct page = tcc register file
    lda.w #tcc__registers
    tad

    ; ── Copy initialized globals from ROM → RAM ───────────────────
    ; SECTIONSTART/END_<name> are auto-defined by wlalink.
    ldx   #0
data_copy_loop:
    cpx   #(SECTIONEND_glob.data-SECTIONSTART_glob.data)
    bcs   data_copy_done
    lda.l SECTIONSTART_glob.data,x
    sta.l SECTIONSTART_globram.data,x
    inx
    inx
    bra   data_copy_loop
data_copy_done:

    ; ── Zero the .bss section ────────────────────────────────────
    ; Data bank to $7E so .bss writes hit the right address space.
    pea   $7e7e
    plb
    plb

    ldx   #(((SECTIONEND_.bss-SECTIONSTART_.bss) & $fffe) + 2)
    beq   bss_clear_done
bss_clear_loop:
    dex
    dex
    stz.w $2000, x
    bne   bss_clear_loop
bss_clear_done:

    ; ── Zero tcc's first two pseudo-registers (some codegen relies on this) ─
    stz.b tcc__r0
    stz.b tcc__r1

    ; ── Call main ─────────────────────────────────────────────────
    jsl   main

    ; ── Park forever — exit code in tcc__r0 ──────────────────────
    stp
.ENDS
