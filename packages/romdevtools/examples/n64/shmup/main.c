/*
 * shmup/main.c — STARFALL 64: a 3D Nintendo 64 vertical shooter.
 *
 * The N64 twin of the PS1 STARFALL — same software 3D engine, N64 backend. The
 * playfield recedes into the screen; enemy cubes fly in from the far distance and
 * grow under perspective. Shoot them with bullets that fly into Z. Title -> play ->
 * game-over, score + lives, AABB collision, xorshift wave spawner, starfield.
 *
 * Build: build({ platform:"n64", language:"c" }) → a self-booting .z64. Controls:
 * d-pad/stick move, A fires, START begins/restarts. Renders through the software
 * rasterizer + angrylion VI scanout (no GL).
 */
#include "n64.h"

#define MAX_E 8
#define MAX_B 6
enum { TITLE, PLAY, OVER };
typedef struct { int alive; fix x, y, z; } Ent;

static Ent enemy[MAX_E];
static Ent bullet[MAX_B];
static fix px, py;
static int state, score, lives, hi;
static unsigned int prev_pad;

static void draw_cube(fix s, unsigned short col)
{
    Vec3 v[8]; int i;
    static const int sx[8]={-1,1,1,-1,-1,1,1,-1},sy[8]={-1,-1,1,1,-1,-1,1,1},sz[8]={-1,-1,-1,-1,1,1,1,1};
    for(i=0;i<8;i++){v[i].x=sx[i]*s;v[i].y=sy[i]*s;v[i].z=sz[i]*s;}
    n64_quad3d(v[0],v[1],v[2],v[3],col); n64_quad3d(v[5],v[4],v[7],v[6],col);
    n64_quad3d(v[4],v[0],v[3],v[7],col); n64_quad3d(v[1],v[5],v[6],v[2],col);
    n64_quad3d(v[4],v[5],v[1],v[0],col); n64_quad3d(v[3],v[2],v[6],v[7],col);
}

static void reset_game(void)
{
    int i;
    for(i=0;i<MAX_E;i++) enemy[i].alive=0;
    for(i=0;i<MAX_B;i++) bullet[i].alive=0;
    px=0; py=FIXF(-1.5f); score=0; lives=3;
}
static void spawn_enemy(void)
{
    int i;
    for(i=0;i<MAX_E;i++) if(!enemy[i].alive){
        enemy[i].alive=1;
        enemy[i].x=(fix)((n64_rand()%7)-3)<<16;
        enemy[i].y=(fix)((n64_rand()%5)-1)<<16;
        enemy[i].z=FIX(40); return;
    }
}
static void fire(void)
{
    int i;
    for(i=0;i<MAX_B;i++) if(!bullet[i].alive){ bullet[i].alive=1; bullet[i].x=px; bullet[i].y=py; bullet[i].z=FIX(4); return; }
}
static int hit(fix ax,fix ay,fix bx,fix by,fix r)
{ fix dx=ax-bx,dy=ay-by; if(dx<0)dx=-dx; if(dy<0)dy=-dy; return dx<r&&dy<r; }

static void update(void)
{
    unsigned int pad = n64_pad();
    int i,j;
    if(pad&PAD_LEFT)  px-=FIXF(0.18f);
    if(pad&PAD_RIGHT) px+=FIXF(0.18f);
    if(pad&PAD_UP)    py+=FIXF(0.14f);
    if(pad&PAD_DOWN)  py-=FIXF(0.14f);
    if(px<FIX(-4))px=FIX(-4); if(px>FIX(4))px=FIX(4);
    if(py<FIX(-3))py=FIX(-3); if(py>FIX(2))py=FIX(2);
    if((pad&PAD_A)&&!(prev_pad&PAD_A)) fire();
    for(i=0;i<MAX_B;i++) if(bullet[i].alive){ bullet[i].z+=FIX(2); if(bullet[i].z>FIX(45)) bullet[i].alive=0; }
    if((n64_rand()&31)==0) spawn_enemy();
    for(i=0;i<MAX_E;i++) if(enemy[i].alive){
        enemy[i].z-=FIXF(0.5f);
        if(enemy[i].z<FIX(3)){ enemy[i].alive=0; if(--lives<=0){ if(score>hi)hi=score; state=OVER; } }
        for(j=0;j<MAX_B;j++) if(bullet[j].alive){
            fix dz=enemy[i].z-bullet[j].z; if(dz<0)dz=-dz;
            if(dz<FIX(2)&&hit(enemy[i].x,enemy[i].y,bullet[j].x,bullet[j].y,FIX(1))){ enemy[i].alive=0; bullet[j].alive=0; score+=10; }
        }
    }
    prev_pad=pad;
}

static void render(void)
{
    int i;
    n64_clear(RGB(6,8,24));
    for(i=0;i<12;i++){ fix sx=(fix)(((i*53)%9)-4)<<16, sy=(fix)(((i*37)%7)-3)<<16; n64_model(sx,sy,FIX(50),0); draw_cube(FIXF(0.15f),RGB(40,40,70)); }
    for(i=0;i<MAX_E;i++) if(enemy[i].alive){ n64_model(enemy[i].x,enemy[i].y,enemy[i].z,enemy[i].z<<2); draw_cube(FIXF(0.7f),RGB(230,60,60)); }
    for(i=0;i<MAX_B;i++) if(bullet[i].alive){ n64_model(bullet[i].x,bullet[i].y,bullet[i].z,0); draw_cube(FIXF(0.18f),RGB(255,240,80)); }
    n64_model(px,py,FIX(3),0); draw_cube(FIXF(0.5f),RGB(80,200,255));
    n64_number(8,6,(unsigned)score,RGB(255,255,255));
    for(i=0;i<lives;i++) n64_rect(290-i*10,8,6,6,RGB(80,200,255));
}

int main(void)
{
    static fix t;
    n64_init();
    n64_srand(0xC0FFEE);
    n64_camera(0,0,FIX(-2),0,FIXF(-0.08f));
    state=TITLE; prev_pad=0;
    for(;;){
        unsigned int pad = n64_pad();
        if(state==TITLE){
            n64_clear(RGB(10,10,40));
            t+=FIX(2); n64_model(0,0,FIX(6),t); draw_cube(FIX(1),RGB(80,200,255));
            if((pad&PAD_START)&&!(prev_pad&PAD_START)){ reset_game(); state=PLAY; }
            prev_pad=pad;
        } else if(state==PLAY){ update(); render(); }
        else {
            n64_clear(RGB(40,8,8));
            n64_number(110,100,(unsigned)score,RGB(255,80,80));
            n64_number(120,130,(unsigned)hi,RGB(255,255,120));
            if((pad&PAD_START)&&!(prev_pad&PAD_START)){ reset_game(); state=PLAY; }
            prev_pad=pad;
        }
        n64_flip();
    }
    return 0;
}
