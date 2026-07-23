/*
 * detrng — deterministic-replay + debug-events fixture cart.
 * Exercises WC_DETERMINISTIC_RNG (wc_set_seed/wc_rand), WC_DEBUG_FIELDS,
 * and wc_debug_mark. Renders RNG noise so determinism (or its absence)
 * is visible in the framebuffer hash.
 *
 * Rebuild (emcc + the wasmcart repo checkout for wc_cart.h):
 *   emcc detrng.c -O2 -I<wasmcart>/include -s STANDALONE_WASM=1 --no-entry \
 *     -s EXPORTED_FUNCTIONS='["_wc_init","_wc_render","_wc_get_info","_wc_debug_state","_wc_set_seed"]' \
 *     -s ERROR_ON_UNDEFINED_SYMBOLS=0 -o detrng.wasm
 *   npx wasmcart-pack --wasm detrng.wasm --name detrng -o detrng.wasc
 */
#include "wasmcart.h"
#include "wc_cart.h"

#define WIDTH  128
#define HEIGHT 128
#define AUDIO_CAP 1024

static uint32_t framebuffer[WIDTH * HEIGHT];
static float audio_ring[AUDIO_CAP * 2];
static uint32_t audio_write_cursor;
static wc_pad_t pads[4];
static wc_time_t time_info;
static wc_info_t info;
static wc_host_info_t host_info;

static uint32_t frame_n;
static uint32_t noise_x;
static uint32_t player_x = 64;

WC_DETERMINISTIC_RNG

WC_DEBUG_FIELDS(
    WC_DBG("frame_n",  frame_n,  WC_DBG_U32),
    WC_DBG("noise_x",  noise_x,  WC_DBG_U32),
    WC_DBG("player_x", player_x, WC_DBG_U32)
)

__attribute__((export_name("wc_get_info")))
wc_info_t* wc_get_info(void) {
    info.version = WC_ABI_VERSION;
    info.width = WIDTH;
    info.height = HEIGHT;
    info.fb_ptr = (uint32_t)framebuffer;
    info.audio_ptr = (uint32_t)audio_ring;
    info.audio_cap = AUDIO_CAP;
    info.audio_write_ptr = (uint32_t)&audio_write_cursor;
    info.input_ptr = (uint32_t)pads;
    info.save_ptr = 0;
    info.save_size = 0;
    info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = (uint32_t)&host_info;
    info.flags = WC_FLAG_AUDIO_F32 | WC_FLAG_DEBUG | WC_FLAG_DETERMINISTIC;
    return &info;
}

__attribute__((export_name("wc_init")))
void wc_init(void) {
    WC_LOG("detrng init");
    wc_debug_mark(1); /* mark 1 = init */
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    wc_pad_t* pad = &pads[0];
    if (pad->buttons & WC_BTN_LEFT)  player_x -= 2;
    if (pad->buttons & WC_BTN_RIGHT) player_x += 2;
    if (player_x > WIDTH - 8) player_x = WIDTH - 8;

    /* RNG noise field — every pixel consumes the stream, so two runs with the
       same seed hash identically and different seeds diverge on frame 1. */
    for (int i = 0; i < WIDTH * HEIGHT; i++) {
        framebuffer[i] = wc_rand() & 0x00FFFFFF;
    }
    noise_x = wc_rand_range(WIDTH);

    /* player marker: an 8x8 white block the input tests can steer */
    for (int y = 60; y < 68; y++)
        for (int x = (int)player_x; x < (int)player_x + 8; x++)
            framebuffer[y * WIDTH + x] = 0x00FFFFFF;

    frame_n++;
    if (frame_n == 5) wc_debug_mark(2); /* mark 2 = frame 5 milestone */
}
