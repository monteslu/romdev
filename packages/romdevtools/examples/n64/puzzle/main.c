/*
 * puzzle/main.c — DROP GRID 64: a 3D Nintendo 64 falling-block puzzle.
 *
 * Unlike the PS1 puzzle (flat 2D), this is rendered in 3D — the N64 was a 3D-first
 * machine, so the well is a perspective box and the blocks are shaded cubes you
 * watch fall in depth. Same falling-block logic (move, drop, clear full rows, ramp
 * speed, stack-out = game over) but presented through the 3D pipeline at an angle.
 *
 * Build: build({ platform:"n64", language:"c" }). Controls: LEFT/RIGHT move the
 * falling block, DOWN soft-drop, START begin/restart.
 *
 * 3D technique: each grid cell is a cube at (col, -row, 0) in world space; a tilted
 * camera looks into the well so you see depth. The board logic is plain integers.
 */
#include "n64.h"

#define GW 6
#define GH 10
enum { TITLE, PLAY, OVER };

static unsigned char grid[GH][GW];
static int fx, fy, fc;
static int tick, fall_period;
static int state, score, hi;
static unsigned int prev_pad;

static const unsigned short PAL[5] = {
    0, RGB(230,60,60), RGB(60,200,90), RGB(80,150,255), RGB(240,200,60)
};

static void cube_at(fix x, fix y, fix z, fix s, unsigned short col)
{
    Vec3 v[8]; int i;
    static const int sx[8]={-1,1,1,-1,-1,1,1,-1},sy[8]={-1,-1,1,1,-1,-1,1,1},sz[8]={-1,-1,-1,-1,1,1,1,1};
    n64_model(x,y,z,0);
    for(i=0;i<8;i++){v[i].x=sx[i]*s;v[i].y=sy[i]*s;v[i].z=sz[i]*s;}
    n64_quad3d(v[0],v[1],v[2],v[3],col); n64_quad3d(v[5],v[4],v[7],v[6],col);
    n64_quad3d(v[4],v[0],v[3],v[7],col); n64_quad3d(v[1],v[5],v[6],v[2],col);
    n64_quad3d(v[4],v[5],v[1],v[0],col); n64_quad3d(v[3],v[2],v[6],v[7],col);
}

/* grid cell (c,r) → world position (centered, y up). */
static fix cellx(int c) { return (fix)(c - GW/2) << 16; }
static fix celly(int r) { return (fix)((GH/2) - r) << 16; }

static void new_block(void)
{ fx=GW/2; fy=0; fc=1+(n64_rand()%4); if(grid[0][fx]){ if(score>hi)hi=score; state=OVER; } }

static void reset_game(void)
{ int r,c; for(r=0;r<GH;r++)for(c=0;c<GW;c++)grid[r][c]=0; score=0; tick=0; fall_period=30; new_block(); }

static int blocked(int x,int y){ return x<0||x>=GW||y>=GH||(y>=0&&grid[y][x]); }

static void lock_and_clear(void)
{
    int r,c,rr;
    grid[fy][fx]=fc;
    for(r=GH-1;r>=0;r--){
        int full=1; for(c=0;c<GW;c++) if(!grid[r][c]){ full=0; break; }
        if(full){ for(rr=r;rr>0;rr--)for(c=0;c<GW;c++)grid[rr][c]=grid[rr-1][c]; for(c=0;c<GW;c++)grid[0][c]=0; score+=100; if(fall_period>8)fall_period--; r++; }
    }
    new_block();
}
static void step_fall(void){ if(!blocked(fx,fy+1)) fy++; else lock_and_clear(); }

static void update(void)
{
    unsigned int pad = n64_pad();
    if((pad&PAD_LEFT)&&!(prev_pad&PAD_LEFT)&&!blocked(fx-1,fy)) fx--;
    if((pad&PAD_RIGHT)&&!(prev_pad&PAD_RIGHT)&&!blocked(fx+1,fy)) fx++;
    if(pad&PAD_DOWN){ step_fall(); tick=0; }
    if(++tick>=fall_period){ step_fall(); tick=0; }
    prev_pad=pad;
}

static void render(void)
{
    int r,c;
    n64_clear(RGB(12,12,24));
    n64_camera(0,0,FIX(-12),0,FIXF(-0.05f));   /* look into the well */
    /* settled blocks */
    for(r=0;r<GH;r++) for(c=0;c<GW;c++) if(grid[r][c])
        cube_at(cellx(c), celly(r), 0, FIXF(0.45f), PAL[grid[r][c]]);
    /* falling block */
    if(fy>=0) cube_at(cellx(fx), celly(fy), 0, FIXF(0.45f), PAL[fc]);
    /* well floor + walls as dim cubes for depth cue */
    for(c=-1;c<=GW;c++){ cube_at(cellx(c), celly(GH), 0, FIXF(0.45f), RGB(50,50,70)); }
    for(r=0;r<=GH;r++){ cube_at(cellx(-1), celly(r), 0, FIXF(0.45f), RGB(40,40,60)); cube_at(cellx(GW), celly(r), 0, FIXF(0.45f), RGB(40,40,60)); }
    n64_number(8,6,(unsigned)score,RGB(255,255,255));
}

int main(void)
{
    n64_init();
    n64_srand(0xD0D0);
    state=TITLE; prev_pad=0;
    for(;;){
        unsigned int pad = n64_pad();
        if(state==TITLE){
            static fix t; t+=FIX(3);
            n64_clear(RGB(20,12,30));
            n64_camera(0,0,FIX(-6),0,0);
            n64_model(0,0,0,t); cube_at(0,0,0,FIX(1),RGB(80,150,255));
            if((pad&PAD_START)&&!(prev_pad&PAD_START)){ reset_game(); state=PLAY; }
            prev_pad=pad;
        } else if(state==PLAY){ update(); render(); }
        else {
            n64_clear(RGB(30,8,8));
            n64_number(110,100,(unsigned)score,RGB(255,120,120));
            n64_number(120,130,(unsigned)hi,RGB(255,255,120));
            if((pad&PAD_START)&&!(prev_pad&PAD_START)){ reset_game(); state=PLAY; }
            prev_pad=pad;
        }
        n64_flip();
    }
    return 0;
}
