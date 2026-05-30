; famitone_bridge.s — tiny C-callable bridge around FamiTone2's asm entry
; points. Exposes three cc65 __fastcall__ functions:
;
;   void __fastcall__ famitone_init(const uint8_t *music_data);
;     A/X = lo/hi byte of pointer (cc65 fastcall: last arg in A:X).
;     Calls FamiToneInit with NTSC = 1.
;
;   void __fastcall__ famitone_play(uint8_t song_index);
;     A = song index. Calls FamiToneMusicPlay.
;
;   void __fastcall__ famitone_update(void);
;     Calls FamiToneUpdate. Wire this once per frame, right after
;     ppu_wait_nmi() returns.
;
; cc65 calling convention notes:
;   - last arg lives in A (low) / X (high) for word-sized params
;   - functions clobber A/X/Y freely
;   - returns: byte in A, word in A:X; void returns ignored
;
; The C wrapper names are `_famitone_*` (cc65 prepends an underscore to
; every C identifier).

.export _famitone_init, _famitone_play, _famitone_update

.import FamiToneInit, FamiToneMusicPlay, FamiToneUpdate

.segment "CODE"

; void __fastcall__ famitone_init(const uint8_t *music_data);
; cc65 passes the pointer in A (low) / X (high). FamiToneInit wants
; X (low) / Y (high), with A = 1 for NTSC, 0 for PAL.
_famitone_init:
        ; A = lo, X = hi (cc65 fastcall for a single pointer)
        pha                ; save lo
        txa
        tay                ; Y = hi
        pla
        tax                ; X = lo
        lda     #1         ; NTSC
        jmp     FamiToneInit

; void __fastcall__ famitone_play(uint8_t song);
; cc65 fastcall passes the single byte in A. FamiToneMusicPlay also
; takes A = song index, so this is a straight tail-call.
_famitone_play:
        jmp     FamiToneMusicPlay

; void __fastcall__ famitone_update(void);
_famitone_update:
        jmp     FamiToneUpdate
