void demo(Object *obj) {
    f32 sp4B8;
    f32 sp4A0;
    s32 i;

    if (obj->flags) {
        sp4B8 = obj->x * obj->x;
        sp4A0 = angle(sp4B8);
        if (obj->near) {
            sp4B8 += obj->y * obj->y;
            sp4A0 = angle(sp4B8);
        }
        limit(sp4B8);
        for (i = 0; i < 4; i++) {
            step(sp4B8);
        }
    }
    tail(sp4A0);
}
