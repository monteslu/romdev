#include "gametank.h"
#include "gfx_sys.h"
#include "audio_coprocessor.h"
#include "music.h"
void sdk_init(void) {
    init_graphics();
    init_audio_coprocessor();
    init_music();
}
