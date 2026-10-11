# PC Engine - catch_game

Part of the PCE example set. Builds against the PCE helper lib
(pce_hw.h + pce_video.c + pce_input.c + pce_sound.c), which the fork copies in.

Build: `examples({op:'fork', example:'pce/catch_game', name, path})`, then
`build({output:'project', path:<the new project dir>})`. Verified to build
(8192-byte HuCard). Full game loop: paddle + falling object + collision.
