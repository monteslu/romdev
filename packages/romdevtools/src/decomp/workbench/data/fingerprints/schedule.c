#ifdef __cplusplus
extern "C" {
#endif

volatile int dkwb_fp_left;
volatile int dkwb_fp_right;

int dkwb_fp_schedule(int value)
{
    int left = dkwb_fp_left + 45;
    int right = dkwb_fp_right + 10;
    return (left * value) + right;
}

#ifdef __cplusplus
}
#endif
