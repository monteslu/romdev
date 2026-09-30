#ifdef __cplusplus
extern "C" {
#endif

extern int dkwb_fp_call(int *, int);

int dkwb_fp_stack_home(int value)
{
    int first = value + 1;
    int second = value + 2;
    int third = first * second;
    return dkwb_fp_call(&second, third) + first;
}

#ifdef __cplusplus
}
#endif
