; Genesis — reading the 3-button controller with edge detection.
;
; Genesis controllers connect via TWO I/O ports: $A10003 (port 1) and
; $A10005 (port 2). Each is a single byte, but the BITS you read depend
; on the state of the TH select line (bit 6 of the corresponding control
; register at $A10009 / $A1000B).
;
; **3-button pad layout, by TH state:**
;
;   TH=1 reads (set bit 6 of control reg high, then read data):
;     bit 0: Up        bit 4: B
;     bit 1: Down      bit 5: C
;     bit 2: Left      bits 6,7: unused
;     bit 3: Right
;
;   TH=0 reads:
;     bit 0: Up        bit 4: A
;     bit 1: Down      bit 5: Start
;     bits 2,3: 0      bits 6,7: unused
;
; All bits are ACTIVE-LOW (pressed = 0). Most code inverts to make 1 =
; pressed for sanity.
;
; **6-button pad** uses extra TH transitions to expose XYZ + Mode. Not
; covered here — see Sega's official 6-button protocol doc. Most modern
; homebrew supports 3-button and treats 6-button as "ignore extras."
;
; ** Important libretro gotcha: ** genesis_plus_gx (and most cores) read
; the controller via input({op:'set'})() ONCE PER FRAME via retro_input_poll +
; retro_input_state. The hardware semantics above are emulated; the
; first read on a fresh-loaded ROM may return all-zeros because the
; agent's input({op:'set'}) hasn't been called yet. Don't bug-hunt this; just
; step a frame after input({op:'set'}) before reading.

PAD1_DATA  equ $A10003
PAD1_CTRL  equ $A10009

; ---- read_pad: snapshot one frame of controller 1 into d0 -----------
;
; Returns a packed 16-bit word in d0:
;   bit  0: Up      bit  4: A       bit  8: Up      bit 12: B
;   bit  1: Down    bit  5: Start   bit  9: Down    bit 13: C
;   bit  2: 0       bit  6: 0       bit 10: Left    bit 14: 0
;   bit  3: 0       bit  7: 0       bit 11: Right   bit 15: 0
;
; (Low byte = TH=0 read; high byte = TH=1 read. Caller can mask out
; the bits they care about.)
;
; The values are ACTIVE-HIGH after this routine — 1 = pressed.
read_pad:
  movem.l d1/a0,-(sp)
  lea     PAD1_DATA,a0
  ; --- TH=0 read (UDxxASxx) ---
  move.b  #$00,PAD1_CTRL
  nop
  nop
  move.b  (a0),d0
  not.b   d0                 ; invert: 1 = pressed
  ; --- TH=1 read (UDLRBCxx) ---
  move.b  #$40,PAD1_CTRL
  nop
  nop
  move.b  (a0),d1
  not.b   d1
  ; --- pack into d0 high byte ---
  lsl.w   #8,d1
  or.w    d1,d0
  ; --- mask off the unused bits (bits 2-3 in TH=0, bits 6-7) ---
  ; Mask: %0111001111110011 = $73F3. Layout below for review:
  ;   high byte (TH=1 read): 0111 0011 = $73 — bits 14,12,11,9,8 used; 15,13,10 unused
  ;   low  byte (TH=0 read): 1111 0011 = $F3 — bits 7,6,5,4,1,0 used; 3,2 unused
  and.w   #$73F3,d0
  movem.l (sp)+,d1/a0
  rts

; ---- read_pad_with_edges: held + pressed + released, w/ d0/d1/d2 out -
;
; Requires WRAM at pad1_held (see wram.s for the layout).
; After call:
;   d0 = current held bits  (1=pressed)
;   d1 = newly pressed bits (1=pressed THIS frame, was 0 LAST frame)
;   d2 = newly released bits (1=released this frame)
;
; Typical use:
;   jsr   read_pad_with_edges
;   btst  #4, d1              ; A newly pressed?
;   beq.s .no_a_press
;   jsr   on_a_pressed
; .no_a_press:
read_pad_with_edges:
  bsr     read_pad
  move.w  pad1_held,d3
  ; pressed = current AND NOT last
  move.w  d0,d1
  not.w   d3
  and.w   d3,d1
  ; released = NOT current AND last
  not.w   d0
  move.w  pad1_held,d2
  and.w   d0,d2
  not.w   d0                  ; restore d0 = current held
  ; update held cache
  move.w  d0,pad1_held
  rts
