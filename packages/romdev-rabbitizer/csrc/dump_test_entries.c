/* SPDX-License-Identifier: MIT */
/*
 * Build-time helper (never shipped): compiled together with one of the
 * upstream tests/c/instruction_checks C files (built with AVOID_DEF_MAIN)
 * to print that file's test_entries table as JSON lines, so the JS binding
 * can be checked against every upstream expected disassembly string.
 * Usage (see build-rabbitizer.sh): emcc -DAVOID_DEF_MAIN -include <test.c> dump_test_entries.c ...
 */

#include <stdio.h>

static void print_json_string(const char *s) {
    if (s == NULL) {
        fputs("null", stdout);
        return;
    }
    putchar('"');
    for (; *s != '\0'; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') {
            printf("\\%c", c);
        } else if (c < 0x20) {
            printf("\\u%04x", c);
        } else {
            putchar(c);
        }
    }
    putchar('"');
}

int main(void) {
    for (size_t i = 0; i < test_entries_len; i++) {
        const TestEntry *e = &test_entries[i];

        printf("{\"category\":%d,\"word\":%u,\"immOverride\":", (int)e->category, (unsigned)e->word);
        print_json_string(e->immOverride);
        fputs(",\"expected\":", stdout);
        print_json_string(e->expectedStr);
        printf(",\"gnuMode\":%s}\n", e->gnuMode ? "true" : "false");
    }
    return 0;
}
