/* A redistributable stand-in for a late-campaign working source: a few
   accumulated levers, a dead carrier, a copy, and several commutative pairs.
   Line numbers are load-bearing -- the sweep examples cite them. */
void demo(Object *obj) {
    f32 lead;
    f32 span;
    f32 reach;
    f32 carry;
    s32 i;

    lead = obj->x * obj->y;
    span = lead + obj->z;
    reach = obj->speed * (obj->scale + obj->trim);
    if (span != 0.0f);
    carry = reach;
    limit(carry * obj->radius);
    for (i = 0; i < 4; i++) {
        step(span);
    }
    tail(carry);
}
