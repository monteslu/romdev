; ── BASIC stub: SYS 2061 ────────────────────────────────────────────
; The standard 12-byte BASIC bootstrap at $0801 that lets a user type
; `LOAD"NAME",8,1` followed by `RUN`. The stub is a one-line BASIC
; program tokenized to SYS 2061, where 2061 = $080D = the first byte
; AFTER the stub. So your machine-code main routine should start at $080D.
;
; Bytes:
;   $0801  $0B $08   ; pointer to next BASIC line ($080B)
;          $0A $00   ; line number 10
;          $9E       ; SYS token
;          "2061"    ; ASCII "2061"
;          $00       ; end of statement
;          $00 $00   ; end of BASIC program (null pointer)
;
; After this stub, put `.org $080D` (or just continue assembling) and
; place your real main routine there.

.segment "STARTUP"
    .word $080B                ; next line pointer
    .word 10                   ; line number
    .byte $9E                  ; SYS
    .byte "2061", $00          ; "2061" + line terminator
    .word $0000                ; end-of-program

; Your code starts at $080D — define your reset entry there.
