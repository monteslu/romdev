// romdev single-bank GameTank: no asset pipeline. Stub the sfx tables music.c
// indexes (play_sound_effect needs them); set_note / load_instrument don't, so
// games drive audio note-by-note with those. Empty tables = play_sound_effect is
// harmless (the engine reads zeros).
#ifndef GEN_ASSETS_INDEX_H
#define GEN_ASSETS_INDEX_H
static const unsigned char ASSET__sfx_bank_table[1] = { 0 };
static const unsigned int  ASSET__sfx_ptr_table[1]  = { 0 };
#endif
