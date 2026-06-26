/* softint.c — the few libgcc helpers a fixed-point game needs, in plain C, so the
   build doesn't depend on an endian-specific libgcc.a. Compiled per-build with the
   target endian. Currently: 64-bit signed/unsigned divide + modulo (__divdi3 etc).
   MIPS has native 32x32->64 multiply, so __muldi3 isn't needed. */
typedef long long DItype;
typedef unsigned long long UDItype;

static UDItype udivmod64(UDItype num, UDItype den, UDItype *rem) {
  UDItype quot = 0, qbit = 1;
  if (den == 0) { if (rem) *rem = 0; return 0; }
  /* normalize: shift den up until > num or top bit set */
  while ((DItype)den >= 0) { den <<= 1; qbit <<= 1; }
  while (qbit) {
    if (den <= num) { num -= den; quot += qbit; }
    den >>= 1; qbit >>= 1;
  }
  if (rem) *rem = num;
  return quot;
}

UDItype __udivdi3(UDItype a, UDItype b) { return udivmod64(a, b, 0); }
UDItype __umoddi3(UDItype a, UDItype b) { UDItype r; udivmod64(a, b, &r); return r; }

DItype __divdi3(DItype a, DItype b) {
  int neg = 0; UDItype ua, ub, q;
  if (a < 0) { a = -a; neg ^= 1; } if (b < 0) { b = -b; neg ^= 1; }
  ua = (UDItype)a; ub = (UDItype)b;
  q = udivmod64(ua, ub, 0);
  return neg ? -(DItype)q : (DItype)q;
}
DItype __moddi3(DItype a, DItype b) {
  int neg = 0; UDItype ua, ub, r;
  if (a < 0) { a = -a; neg = 1; } if (b < 0) { b = -b; }
  ua = (UDItype)a; ub = (UDItype)b;
  udivmod64(ua, ub, &r);
  return neg ? -(DItype)r : (DItype)r;
}
