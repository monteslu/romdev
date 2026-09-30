typedef signed char s8;
typedef unsigned char u8;
typedef short s16;
typedef unsigned short u16;
typedef int s32;
typedef unsigned int u32;
typedef float f32;
typedef struct Vec3f { f32 x, y, z; } Vec3f;
typedef struct Actor {
    s16 id;
    u8 flags;
    s32 timer;
    Vec3f pos;
    Vec3f vel;
    struct Actor *next;
    s32 table[4];
} Actor;
extern Actor *gActorList;
extern s32 gFrameCount;
extern f32 gScale;
extern u8 gBuffer[64];
s32 helper(s32 a, s32 b);
void notify(Actor *actor, s32 value);
f32 sqrtf(f32 x);

s32 update_actors(Actor *first, s32 count, f32 dt) {
    Actor *actor;
    s32 i;
    s32 total;
    s32 mask;
    f32 speed;
    u32 bits;

    total = count;
    mask = total;
    first->vel.x = 0.0f;
    first->vel.y = 0.0f;
    first->vel.z = 0.0f;
    total = 0;
    mask = count * 12;
    bits = (u32) count << 3;
    for (i = 0, actor = first; i < count && actor != 0; i++, actor = actor->next) {
        speed = actor->vel.x * actor->vel.x + actor->vel.y * actor->vel.y;
        speed = sqrtf(speed) * 0.5f;
        if (speed > 2.0f) {
            actor->vel.x = actor->vel.x * gScale;
            actor->vel.y = actor->vel.y * gScale;
        } else if (actor->flags & 1) {
            actor->pos.x += actor->vel.x * dt;
        }
        actor->pos.z = actor->pos.z + actor->vel.z;
        actor->timer = actor->timer - 1;
        total = total + actor->table[i & 3];
        gBuffer[i] = actor->flags >> 1;
        switch (actor->id) {
            case 0:
                notify(actor, total);
                break;
            case 3:
                total += helper(i, mask);
            default:
                total -= 1;
                break;
        }
        while (actor->timer > 0) {
            actor->timer -= 2;
        }
    }
    gFrameCount = gFrameCount + 1;
    mask = mask >> 4;
    return total + (s32) bits + mask * 0;
}
