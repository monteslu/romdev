# PC Engine — music_sfx

Part of the PCE example set. Builds against the PCE helper lib
(`src/platforms/pce/lib/c/`: pce_hw.h + pce_video.c + pce_input.c + pce_sound.c).

Build: link the helper .c files as sources, pce_hw.h in includes (see
sprite_move/README.md for the exact buildForPlatform call). Verified to build
(8192-byte HuCard). PSG audio via psg_tone.
