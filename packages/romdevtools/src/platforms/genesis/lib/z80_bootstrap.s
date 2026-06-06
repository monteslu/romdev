; Genesis Z80 — boot sequence + bus protocol.
;
; The Z80 sits next to the 68K with its own 8KB RAM at $A00000-$A01FFF
; (mirrored as $A02000-$A03FFF). Power-on state: Z80 is RESET and the
; 68K owns the bus. To use the Z80, you must:
;
;   1. Request the Z80 bus (set $A11100 bit 0 to 1)
;   2. Wait for grant ($A11100 bit 0 reads back as 1)
;   3. Copy your Z80 driver code into Z80 RAM
;   4. Reset the Z80 then release reset ($A11200 bit 0)
;   5. Release the bus (clear $A11100 bit 0)
;
; The Z80 then runs your driver autonomously. The 68K can still poke at
; Z80 RAM by re-acquiring the bus, but each round-trip costs cycles and
; the Z80 is paused for the duration. Most games communicate via shared
; bytes in Z80 RAM (e.g. a "play music #" command byte at a known address).
;
; ** Gotcha: Z80 ROM-bank access window. ** The Z80 can address only 16
; bits, so to reach the 68K's 24-bit ROM space it uses a $8000-$FFFF
; banking window. Bits are written one at a time to $A06000 — see the
; Z80-side code for the protocol. Most sound drivers don't need this;
; samples and code fit in 8KB Z80 RAM.

Z80_RAM     = $A00000
Z80_BUSREQ  = $A11100
Z80_RESET   = $A11200

; ---- z80_init: full reset + bus-grant + bring-up ----------------------
;
; Call once at game init. Doesn't load any driver — that's the job of
; z80_load_driver below.
z80_init:
  ; ---- 1. Assert reset and bus request ----
  move.w  #$0100,Z80_BUSREQ    ; assert bus request (bit 0 high in word write)
  move.w  #$0100,Z80_RESET     ; assert reset
  ; ---- 2. Wait for bus grant ----
.wait_grant:
  btst.b  #0,Z80_BUSREQ
  bne.s   .wait_grant           ; bit clear = grant; bit set = still waiting
  ; ---- 3. (Caller may now write to Z80 RAM) ----
  rts

; ---- z80_load_driver: copy driver code into Z80 RAM ---------------------
;
; Assumes z80_init has been called (bus is held). Pass:
;   A0 = source address (68K ROM)
;   D0 = number of bytes to copy
z80_load_driver:
  lea     Z80_RAM,a1
.copy:
  move.b  (a0)+,(a1)+
  subq.l  #1,d0
  bne.s   .copy
  rts

; ---- z80_start: release reset, release bus, Z80 begins executing -------
z80_start:
  move.w  #$0000,Z80_RESET     ; release reset
  ; The Z80 needs a few cycles to reset before we release the bus.
  ; Typical practice: 16 NOPs. cycles_to_wait varies; this is safe.
  moveq   #16,d0
.wait:
  dbra    d0,.wait
  move.w  #$0000,Z80_BUSREQ    ; release bus — Z80 starts running from $0000
  rts

; ---- z80_send_command: hand a byte to the running Z80 ------------------
;
; Pattern: pause the Z80, write the command to a known shared address,
; resume. The Z80's main loop polls that address and reacts. For minimum
; pause time, batch multiple bytes into one bus grant.
;
; Inputs:
;   D0 = command byte
;   A1 = address in Z80 RAM where command byte lives (caller-defined; e.g.
;        $A00100 is a common convention)
z80_send_command:
  move.w  #$0100,Z80_BUSREQ    ; pause Z80
.wait:
  btst.b  #0,Z80_BUSREQ
  bne.s   .wait
  move.b  d0,(a1)              ; write command
  move.w  #$0000,Z80_BUSREQ    ; resume Z80
  rts

; ---- Minimal Z80 driver template (separately assembled, then incbin'd) -
;
; Assemble the Z80 portion with a Z80 assembler (sjasmplus, asar -arch z80,
; etc.) then `incbin` the resulting binary at a label that z80_load_driver
; copies. Example Z80 main loop:
;
;   .org 0000h
;   di
;   ld sp, $2000        ; stack at top of Z80 RAM
;   loop:
;     ld a, ($0100)     ; read command byte
;     or a
;     jr z, loop        ; 0 = no command
;     ; ... dispatch a, then clear it ...
;     xor a
;     ld ($0100), a
;     jr loop
