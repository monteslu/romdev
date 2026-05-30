/* lynx_music.h — demo music bytestream for cc65's lynx_snd_play.
 *
 * Note: cc65 declares `void __fastcall__ lynx_snd_play(unsigned char ch,
 * unsigned char *music)` — the second arg is NON-const. Marking
 * `demo_music` as `const` causes a "discards qualifiers" warning at
 * every call site. We keep it non-const here so it matches the cc65
 * signature; the bytestream is logically read-only (lives in ROM) but
 * the cc65 API wants a writable pointer. (R56 fix; was const pre-r56.)
 */

#ifndef LYNX_MUSIC_H
#define LYNX_MUSIC_H

extern unsigned char demo_music[];

#endif
