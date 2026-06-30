; romdev single-bank GameTank: the ACP firmware embedded UNCOMPRESSED (the SDK
; deflate-compresses it + inflatemem()s it; the bare path has no zopfli, so we
; assemble audio_fw.asm to a raw 4 KB ACP image and memcpy it in). The build
; stages the assembled image next to this file as acp_image.bin.
.export _AudioFWPkg
.segment "COMMON"
_AudioFWPkg:
    .incbin "acp_image.bin"
