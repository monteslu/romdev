; ── MARIA + TIA-audio register map (Atari 7800) ────────────────────
; MARIA lives at $20-$3F; TIA-audio at $15-$1A; control regs at $80-$87.
; Standard ca65 / cc65 inline-asm constants.

; ── MARIA palette + control ($20-$3F) ──────────────────────────────
BACKGRND  = $20     ; background color
P0C1      = $21     ; palette 0 color 1 (color 0 = BACKGRND, shared)
P0C2      = $22
P0C3      = $23
WSYNC     = $24     ; wait for sync — write any value to stall to next line
P1C1      = $25
P1C2      = $26
P1C3      = $27
MSTAT     = $28     ; MARIA status (read: bit 7 = vblank)
P2C1      = $29
P2C2      = $2A
P2C3      = $2B
DPPH      = $2C     ; display list list pointer high
P3C1      = $2D
P3C2      = $2E
P3C3      = $2F
DPPL      = $30     ; display list list pointer low
P4C1      = $31
P4C2      = $32
P4C3      = $33
CHARBASE  = $34     ; character map base (high byte)
P5C1      = $35
P5C2      = $36
P5C3      = $37
OFFSET    = $38     ; offset register (placeholder — write 0)
P6C1      = $39
P6C2      = $3A
P6C3      = $3B
CTRL      = $3C     ; MARIA control (DMA enable, char-mode, kangaroo, etc)
P7C1      = $3D
P7C2      = $3E
P7C3      = $3F

; ── TIA audio ($15-$1A) — yes, the 7800 still has the 2600's audio chip
AUDC0     = $15
AUDC1     = $16
AUDF0     = $17
AUDF1     = $18
AUDV0     = $19
AUDV1     = $1A

; ── Control registers ($80-$87) ────────────────────────────────────
INPTCTRL  = $01     ; access enabled at boot; write $07 to lock
SWCHA     = $280    ; joystick port A
SWCHB     = $282    ; console switches

; ── MARIA CTRL bits ($3C) ──────────────────────────────────────────
CTRL_KANGAROO   = $04   ; 1 = kangaroo (color 0 transparent)
CTRL_BORDER     = $08   ; 1 = border generated outside the visible area
CTRL_CHARWIDTH  = $10   ; 1 = 2-byte character mode
CTRL_DMA_OFF    = $40   ; 1 = DMA disabled (no DLL processing)
CTRL_COLORKILL  = $80   ; 1 = monochrome (color burst off)

; ── DL entry bits (5-byte header form) ─────────────────────────────
DL_INDIRECT     = $20   ; bit 5 of byte 2: use indirect-character mode
DL_WRITE        = $80   ; bit 7 of byte 2: 5-byte header (vs 4-byte)
