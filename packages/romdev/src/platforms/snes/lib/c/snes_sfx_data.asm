; ── snes_sfx_data.asm — SPC700 driver + sample-bank + music bytes ───
;
; Embeds the prebuilt apu_blob.bin (driver code at ARAM $0200, padded
; to $1000, sample bank at $1000, zero-padded to $5000, song table at
; $5000) as a labeled byte array the C side accesses via
; `extern const u8 apu_blob[]` plus a linker-defined end symbol so
; sfx_init can compute the payload size at runtime — that way bumping
; the song table size doesn't require updating a hardcoded length.
;
; Why .rodata1: the asset is read-only payload — never executed by
; the 65816, just streamed via APUIO ports to the SPC700.
;
; To rebuild apu_blob.bin from sources see src/platforms/snes/lib/audio/
; — the apu_blob.asm there is the asar input that assembles spc_driver
; + sample_bank + music into a single upload payload.

.include "hdr.asm"

.section ".rodata1" superfree

apu_blob:
.incbin "apu_blob.bin"
apu_blob_end:

.ends
