#ifdef __cplusplus
extern "C" {
#endif

extern int dkwb_fp_mix(int, int, int, int);

int dkwb_fp_allocation(int a, int b, int c, int d)
{
    int first = (a + b) ^ c;
    int second = (b + c) ^ d;
    int third = (c + d) ^ a;
    return dkwb_fp_mix(first, second, third, first + third);
}

#ifdef __cplusplus
}
#endif
