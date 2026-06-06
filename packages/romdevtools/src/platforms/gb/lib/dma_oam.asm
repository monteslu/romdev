; Game Boy OAM DMA — single-cycle 160-byte copy from WRAM to OAM.
;
; The OAM DMA routine MUST live in HRAM ($FF80-$FFFE) because:
;   - During DMA, the CPU can only execute from HRAM (the main bus is
;     monopolized for the 160-cycle transfer).
;   - The routine writes $XX to $FF46, then waits for the transfer to
;     complete with a small busy-loop.
;
; Usage: copy this stub to HRAM at startup, then call it whenever you
; want to upload shadow OAM from $XX00 (XX = (source >> 8)).
;
; Standard pattern: shadow OAM lives at $C000 (top of WRAM bank 0).
;   ld a, $C0
;   call OamDma
;
; The OAM DMA stops the CPU for 160 µs (~640 cycles); the only safe
; bus activity during it is HRAM reads.

SECTION "OamDmaSetup", ROM0
; Copy the HRAM-resident routine into place. Call this once during init.
oam_dma_setup::
  ld hl, OamDmaSource
  ld de, OamDma
  ld bc, OamDmaEnd - OamDmaSource
.loop
  ld a, [hl+]
  ld [de], a
  inc de
  dec bc
  ld a, b
  or c
  jr nz, .loop
  ret

; Source code that gets copied to HRAM.
OamDmaSource:
  ldh [$46], a          ; trigger DMA — A holds high byte of source
  ld a, $28             ; 40 × 4 byte sprite × ~1 cycle each ≈ 160 µs
.wait
  dec a
  jr nz, .wait
  ret
OamDmaEnd:

SECTION "OamDmaInHRAM", HRAM
OamDma:: ds OamDmaEnd - OamDmaSource

; Convenience location for shadow OAM in WRAM. Game code writes here;
; OAM DMA copies the 160 bytes to actual OAM at $FE00 each vblank.
SECTION "ShadowOAM", WRAM0[$C000]
ShadowOAM:: ds 160
