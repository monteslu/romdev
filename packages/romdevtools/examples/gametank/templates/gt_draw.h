/* ── gt_draw.h — GameTank drawing for the romdev examples (SDK draw-queue) ─────
 *
 * Thin wrappers over the GameTank SDK's draw QUEUE — the ONLY correct way to drive
 * the blitter. You enqueue rects (queue_draw_box); the blit-done IRQ pulls them off
 * the queue one at a time and triggers each blit when the previous one finishes
 * (interrupt.s _irq_int → next_draw_queue). await_draw_queue() blocks until the
 * queue has fully drained, then you wait one VBLANK and flip the double buffer.
 *
 * WHY NOT fire blits synchronously: a blit takes WIDTH*HEIGHT CPU cycles to run
 * (the core schedules its done-IRQ that many cycles ahead; instant_mode is off).
 * Triggering the next blit before the current one finishes calls ClearIRQ and
 * reschedules — stomping the in-flight blit. Firing ~30 rects back-to-back that
 * way both corrupts the framebuffer (static) and piles scheduled cycles against
 * await_vsync (≈2 fps). The queue exists precisely to serialize blits correctly;
 * use it.
 *
 * Frame pattern:
 *   gt_clear(bg);  ...gt_rect(...) for everything... ;  gt_present();
 * where gt_present() = await_draw_queue() + await_vsync(1) + flip_pages().
 *
 * ── TWO BLITTER FOOTGUNS (cost many hours each — heed them) ──
 *  1. A box whose WIDTH or HEIGHT is exactly 128 (the full screen dimension) is
 *     SILENTLY DROPPED — it never draws. A full-width ground/background/HUD slab at
 *     width 128 just vanishes, leaving whatever was under it. ALWAYS clamp to 127.
 *     (The bottom row / right column is TV overscan anyway, so 127 loses nothing.)
 *  2. A box's TOP scanline flickers between the two double-buffer pages — only
 *     gt_clear's border-clear path can paint the screen's edge rows (0-6 top, the
 *     bottom overscan, the side columns) cleanly. If your frame draws sprites or
 *     full-height rects near the top, finish it with `queue_clear_border(topColor)`
 *     as the LAST draw so the border scanlines stay solid (no stray flickering line).
 *     If you also want HUD text up at the very top (rows 0-6), draw it AFTER the
 *     border-clear (the clear would otherwise erase it).
 *
 * Colors are palette indices — see gt_palette.h for VERIFIED vibrant ones.
 * Audio (gt_sound.h) runs on the ACP independently. Random: use rnd8() (below), NOT
 * the SDK rnd() — rnd() corrupts game state on this single-bank build.
 */
#ifndef GT_DRAW_H
#define GT_DRAW_H
#include "gametank.h"
#include "draw_queue.h"   /* queue_draw_box, queue_clear_screen, queue_clear_border, await_draw_queue */
#include "gfx_sys.h"      /* await_vsync, flip_pages, init_graphics */

#define SCREEN_W 128
#define SCREEN_H 128

/* Tiny xorshift byte PRNG. USE THIS, NOT the SDK's rnd() — rnd() (feature/random/
 * random.c) corrupts game state on the EEPROM32K single-bank build (it broke enemy
 * spawning in the shooter for a long time). rnd8() needs no init and never zero-locks. */
static unsigned char gt_rng_state = 0x5A;
static unsigned char rnd8(void) {
  gt_rng_state ^= (unsigned char)(gt_rng_state << 1);
  gt_rng_state ^= (unsigned char)(gt_rng_state >> 1);
  gt_rng_state ^= (unsigned char)(gt_rng_state << 2);
  return gt_rng_state;
}

/* enqueue one filled rectangle (drawn by the blit-done IRQ, in order). */
#define gt_rect(x, y, w, h, color) queue_draw_box((x), (y), (w), (h), (color))

/* clear the whole frame: fill the play area + the border (queue_clear_screen
 * leaves a border uncleared — without queue_clear_border it shows VRAM static). */
static void gt_clear(unsigned char color) {
  queue_clear_screen(color);
  queue_clear_border(color);
}

/* present the frame: drain the draw queue (wait for every enqueued blit to
 * finish), wait one VBLANK, then flip the double buffer. Once per frame, after
 * all your gt_rect()s. This is the SDK's canonical end-of-frame sequence. */
static void gt_present(void) {
  await_draw_queue();
  await_vsync(1);
  flip_pages();
}

/* "press to start" gate. Returns 1 once the START or A button has been HELD for a
 * couple of frames. A short settle counter at the top of each title screen ignores
 * the first few frames (so a button still held from the previous screen / boot can't
 * auto-skip), then any held press starts. Level-triggered → can't miss a tap, and
 * doesn't depend on ever reading a clean all-zero input frame. Call once per
 * title-loop iteration AFTER update_inputs(). (Needs <input.h>.) */
static unsigned char gt_start_settle;
#define GT_START_MASK (INPUT_MASK_START | INPUT_MASK_A)
static void gt_start_reset(void) { gt_start_settle = 0; }   /* call before each title loop */
static unsigned char gt_start_pressed(void) {
  if (gt_start_settle < 12) { gt_start_settle++; return 0; }  /* ignore first ~12 frames */
  return (player1_buttons & GT_START_MASK) ? 1 : 0;
}

#endif /* GT_DRAW_H */
