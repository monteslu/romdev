/*
 * dbghello — the hello 2D cart with the wasmcart debug ABI opted in:
 * WC_DEBUG_FIELDS(player_x, player_y, red_color) + WC_FLAG_DEBUG.
 * The REAL-cart fixture for input + named-debug-state tests (the mock hosts
 * in regression.test.js cover edge cases; this covers the actual ABI).
 *
 * Rebuild (needs emcc + the wasmcart repo checkout for the headers):
 *   emcc dbghello.c -O2 -msimd128 -I<wasmcart>/include \
 *     -s STANDALONE_WASM=1 --no-entry \
 *     -s EXPORTED_FUNCTIONS='["_wc_init","_wc_render","_wc_get_info","_wc_debug_state"]' \
 *     -s ERROR_ON_UNDEFINED_SYMBOLS=0 -o dbghello.wasm
 *   npx wasmcart-pack --wasm dbghello.wasm --name dbghello -o dbghello.wasc
 * (wasmcart.h comes from the wasmcart examples' vendored copy.)
 *
 * Movement contract the tests rely on: d-pad moves the white box 2px/frame,
 * clamped to [0, 280]; initial player_x=140, player_y=100.
 */
#include "wasmcart.h"
#include "wc_cart.h"

#define WIDTH  320
#define HEIGHT 240
#define AUDIO_CAP 4096  // stereo frames

// Framebuffer (XRGB8888)
static uint32_t framebuffer[WIDTH * HEIGHT];

// Audio ring buffer (F32 stereo)
static float audio_ring[AUDIO_CAP * 2];
static uint32_t audio_write_cursor;

// Input pads
static wc_pad_t pads[4];

// Time
static wc_time_t time_info;

// Save blob (64 bytes — just a play counter)
#define SAVE_SIZE 64
static uint8_t save_data[SAVE_SIZE];

// Info struct
static wc_info_t info;
static wc_host_info_t host_info;

// Game state
static int rect_x = 140;
static int rect_y = 100;
static int red_x = 60;
static int red_y = 60;
static uint32_t red_color = 0x00FF4444;
static float tone_phase = 0.0f;

WC_DEBUG_FIELDS(
    WC_DBG("player_x", rect_x, WC_DBG_I32),
    WC_DBG("player_y", rect_y, WC_DBG_I32),
    WC_DBG("red_color", red_color, WC_DBG_U32)
)

// --- ABI exports ---

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
    info.save_ptr = (uint32_t)save_data;
    info.save_size = SAVE_SIZE;
    info.time_ptr = (uint32_t)&time_info;
    info.host_info_ptr = (uint32_t)&host_info;
    info.flags = WC_FLAG_AUDIO_F32 | WC_FLAG_DEBUG;
    return &info;
}

// Save layout: [0-3] play_count, [4] has_save, [5-6] white_x, [7-8] white_y,
//              [9-10] red_x, [11-12] red_y, [13-16] red_color

static void save_state(void) {
    save_data[4] = 1;  // has_save flag
    *(int16_t*)&save_data[5] = (int16_t)rect_x;
    *(int16_t*)&save_data[7] = (int16_t)rect_y;
    *(int16_t*)&save_data[9] = (int16_t)red_x;
    *(int16_t*)&save_data[11] = (int16_t)red_y;
    *(uint32_t*)&save_data[13] = red_color;
}

static void load_state(void) {
    if (save_data[4] != 1) return;  // no save
    rect_x = *(int16_t*)&save_data[5];
    rect_y = *(int16_t*)&save_data[7];
    red_x = *(int16_t*)&save_data[9];
    red_y = *(int16_t*)&save_data[11];
    red_color = *(uint32_t*)&save_data[13];
}

__attribute__((export_name("wc_init")))
void wc_init(void) {
    // Increment play counter in save data (u32 at offset 0)
    uint32_t* play_count = (uint32_t*)save_data;
    (*play_count)++;

    // Restore game state from save if it exists
    load_state();

    audio_write_cursor = 0;
    WC_LOG("hello cart initialized");
}

static void draw_rect(int x, int y, int w, int h, uint32_t color) {
    for (int row = y; row < y + h && row < HEIGHT; row++) {
        if (row < 0) continue;
        for (int col = x; col < x + w && col < WIDTH; col++) {
            if (col < 0) continue;
            framebuffer[row * WIDTH + col] = color;
        }
    }
}

__attribute__((export_name("wc_render")))
void wc_render(void) {
    // Read pad 0
    wc_pad_t* pad = &pads[0];
    int speed = 2;

    // D-pad moves white box
    if (pad->buttons & WC_BTN_UP)    rect_y -= speed;
    if (pad->buttons & WC_BTN_DOWN)  rect_y += speed;
    if (pad->buttons & WC_BTN_LEFT)  rect_x -= speed;
    if (pad->buttons & WC_BTN_RIGHT) rect_x += speed;

    // Left analog stick also moves white box (deadzone ~4000)
    if (pad->left_x > 4000 || pad->left_x < -4000)
        rect_x += (pad->left_x * speed * 2) / 32767;
    if (pad->left_y > 4000 || pad->left_y < -4000)
        rect_y += (pad->left_y * speed * 2) / 32767;

    // Right analog stick moves red box
    if (pad->right_x > 4000 || pad->right_x < -4000)
        red_x += (pad->right_x * speed * 2) / 32767;
    if (pad->right_y > 4000 || pad->right_y < -4000)
        red_y += (pad->right_y * speed * 2) / 32767;

    // A button cycles red box color
    static uint8_t a_was_pressed = 0;
    if ((pad->buttons & WC_BTN_A) && !a_was_pressed) {
        // Cycle through some colors
        if (red_color == 0x00FF4444)      red_color = 0x0044FF44;  // green
        else if (red_color == 0x0044FF44)  red_color = 0x004444FF;  // blue
        else if (red_color == 0x004444FF)  red_color = 0x00FFFF44;  // yellow
        else if (red_color == 0x00FFFF44)  red_color = 0x00FF44FF;  // magenta
        else                               red_color = 0x00FF4444;  // back to red
    }
    a_was_pressed = (pad->buttons & WC_BTN_A) ? 1 : 0;

    // R button saves game state
    static uint8_t r_was_pressed = 0;
    if ((pad->buttons & WC_BTN_R) && !r_was_pressed) {
        save_state();
    }
    r_was_pressed = (pad->buttons & WC_BTN_R) ? 1 : 0;

    // Clamp white box
    if (rect_x < 0) rect_x = 0;
    if (rect_y < 0) rect_y = 0;
    if (rect_x > WIDTH - 40) rect_x = WIDTH - 40;
    if (rect_y > HEIGHT - 40) rect_y = HEIGHT - 40;

    // Clamp red box
    if (red_x < 0) red_x = 0;
    if (red_y < 0) red_y = 0;
    if (red_x > WIDTH - 40) red_x = WIDTH - 40;
    if (red_y > HEIGHT - 40) red_y = HEIGHT - 40;

    // Clear with gradient background
    for (int y = 0; y < HEIGHT; y++) {
        uint32_t shade = (y * 128 / HEIGHT) & 0xFF;
        uint32_t bg = (shade << 16) | (shade / 2);  // purple-ish gradient
        for (int x = 0; x < WIDTH; x++) {
            framebuffer[y * WIDTH + x] = bg;
        }
    }

    // Draw red box (right stick controlled)
    draw_rect(red_x, red_y, 40, 40, red_color);

    // Draw white rect (d-pad / left stick controlled)
    draw_rect(rect_x, rect_y, 40, 40, 0x00FFFFFF);

    // Draw play count indicator (small dots in top-left)
    uint32_t play_count = *(uint32_t*)save_data;
    for (uint32_t i = 0; i < play_count && i < 10; i++) {
        draw_rect(4 + i * 8, 4, 4, 4, 0x00AAAAAA);
    }

    // Generate simple sine tone (~440 Hz)
    int samples_per_frame = 48000 / 60;  // 800 samples at 60fps
    float freq = 440.0f;
    float sample_rate = 48000.0f;
    float volume = 0.12f;

    // Generate tone when B button is held
    if (pad->buttons & WC_BTN_B) {
        for (int i = 0; i < samples_per_frame; i++) {
            // Simple sine approximation using phase
            float s = tone_phase;
            if (s > 0.5f) s = 1.0f - s;
            s = (s - 0.25f) * 4.0f;  // triangle wave approximation
            float sample = s * volume;

            uint32_t idx = (audio_write_cursor % AUDIO_CAP) * 2;
            audio_ring[idx] = sample;      // left
            audio_ring[idx + 1] = sample;  // right
            audio_write_cursor++;

            tone_phase += freq / sample_rate;
            if (tone_phase >= 1.0f) tone_phase -= 1.0f;
        }
    }
}
