#ifdef __cplusplus
extern "C" {
#endif

extern int dkwb_fp_case_0(int);
extern int dkwb_fp_case_1(int);
extern int dkwb_fp_case_2(int);
extern int dkwb_fp_case_3(int);
extern int dkwb_fp_case_4(int);

volatile int dkwb_fp_dispatch_sink;

int dkwb_fp_dense_switch_5(int value)
{
    int result = -1;

    switch (value) {
    case 0:
        result = dkwb_fp_case_0(value);
        break;
    case 1:
        result = dkwb_fp_case_1(value);
        break;
    case 2:
        result = dkwb_fp_case_2(value);
        break;
    case 3:
        result = dkwb_fp_case_3(value);
        break;
    case 4:
        result = dkwb_fp_case_4(value);
        break;
    }
    dkwb_fp_dispatch_sink = result;
    return result;
}

#ifdef __cplusplus
}
#endif
