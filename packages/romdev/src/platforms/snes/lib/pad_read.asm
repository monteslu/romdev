; SNES — controller read + edge detection.
;
; The SNES has auto-joypad-read built into the H/W: at the start of each
; frame, the CPU reads both controller ports and latches the results
; into $4218/$4219 (port 1) and $421A/$421B (port 2). The 16-bit value
; mirrors the controller's serial protocol:
;
;   bit 15: B           bit 7: A
;   bit 14: Y           bit 6: X
;   bit 13: Select      bit 5: L
;   bit 12: Start       bit 4: R
;   bit 11: Up          bits 0-3: (device id padding; ignore)
;   bit 10: Down
;   bit  9: Left
;   bit  8: Right
;
; Important: you can ONLY read these registers AFTER auto-joypad-read
; completes (~$4210/$4211 status), but the typical pattern is to read
; them once at the top of your main-loop logic (which runs AFTER
; vblank). Read while $4212 bit 0 = 0 (auto-joypad idle).
;
; This snippet ALSO does edge detection: a `pressed` register that holds
; "buttons newly pressed THIS frame" (= held now & NOT held last frame),
; the standard "fire-once on press" pattern.

read_pad:
  rep #$20                  ; 16-bit A
  ; wait for auto-joypad-read to finish (idle = bit 0 of $4212 clear)
.wait:
  sep #$20
  lda $4212
  and #$01
  bne .wait
  rep #$20

  lda $4218                 ; 16-bit pad bits
  tay                       ; stash in Y
  ; pressed = current AND NOT previous
  eor pad_held              ; XOR with prev = changed bits
  and $0000,y               ; (re-anding with current via Y — alternative below)
  ; cleaner: pressed = current AND NOT prev
  tya
  pha
  lda pad_held
  eor #$FFFF
  and $01,s                 ; AND with current from stack
  sta pad_pressed
  pla
  sta pad_held
  rts

; Usage in game code:
;   lda pad_pressed
;   bit #$1000                ; Start
;   beq .no_start_press
;   ; ... fire-once on Start press ...
; .no_start_press:
;   bit #$0800                ; Up held? (use pad_held for "is held")
;   ...

; ---- DP reservations ----
; Place these in your DP area:
;   pad_held:    .res 2     ; 16-bit, last frame's joypad bits
;   pad_pressed: .res 2     ; 16-bit, bits newly down this frame
