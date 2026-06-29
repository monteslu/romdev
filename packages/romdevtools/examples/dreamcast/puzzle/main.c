/* Dreamcast PUZZLE demo — a falling-block (Tetris-like) board that fills + clears
 * rows on a loop. Self-animating (no input). Renders on the PowerVR2 framebuffer. */
#include "dc.h"

#define COLS 10
#define ROWS 16
#define CELL 24

static unsigned char board[ROWS][COLS];
static unsigned int rng = 0xACE1u;
static unsigned int rnd(void){ rng ^= rng << 7; rng ^= rng >> 9; rng ^= rng << 8; return rng; }

static const u16 PAL[7] = { 0, 0xF800, 0x07E0, 0x001F, 0xFFE0, 0xF81F, 0x07FF };

void main(void){
    int frame = 0, px = COLS/2, py = 0, col = 1, i, r, c;
    dc_video_init();
    for (;;){
        int ox = (DC_W - COLS*CELL)/2, oy = (DC_H - ROWS*CELL)/2;

        if ((frame % 8) == 0){
            /* drop the active block one row; lock + respawn at the bottom */
            if (py+1 >= ROWS || board[py+1][px]){
                board[py][px] = col;
                /* clear full-ish rows occasionally to keep it moving */
                for (r = 0; r < ROWS; r++){ int full=1; for (c=0;c<COLS;c++) if(!board[r][c]) full=0;
                    if (full){ for(c=0;c<COLS;c++) board[r][c]=0; } }
                py = 0; px = rnd()%COLS; col = 1 + rnd()%6;
                if (board[0][px]){ for(r=0;r<ROWS;r++)for(c=0;c<COLS;c++) board[r][c]=0; } /* reset if buried */
            } else py++;
        }
        dc_clear(dc_rgb(18, 18, 30));
        /* board frame */
        dc_rect(ox-4, oy-4, COLS*CELL+8, ROWS*CELL+8, dc_rgb(90,90,120));
        dc_rect(ox, oy, COLS*CELL, ROWS*CELL, dc_rgb(10,10,18));
        /* settled cells */
        for (r = 0; r < ROWS; r++) for (c = 0; c < COLS; c++) if (board[r][c])
            dc_rect(ox + c*CELL+1, oy + r*CELL+1, CELL-2, CELL-2, PAL[board[r][c]]);
        /* active block */
        dc_rect(ox + px*CELL+1, oy + py*CELL+1, CELL-2, CELL-2, PAL[col]);
        frame++;
        (void)i;
    }
}
