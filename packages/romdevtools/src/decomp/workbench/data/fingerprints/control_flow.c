#ifdef __cplusplus
extern "C" {
#endif

volatile int dkwb_fp_sink;

int dkwb_fp_control_flow(int value)
{
    int result = 0;
    if (value < 0) {
        result = -value;
    } else if (value == 4) {
        result = value << 2;
    } else {
        result = value + 3;
    }
    dkwb_fp_sink = result;
    return result;
}

#ifdef __cplusplus
}
#endif
