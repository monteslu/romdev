#ifndef _RD_CTYPE_H
#define _RD_CTYPE_H
static inline int toupper(int c) { return (c >= 'a' && c <= 'z') ? c - 32 : c; }
static inline int tolower(int c) { return (c >= 'A' && c <= 'Z') ? c + 32 : c; }
static inline int isspace(int c) { return c == ' ' || (c >= 9 && c <= 13); }
static inline int isdigit(int c) { return c >= '0' && c <= '9'; }
static inline int isalpha(int c) { return (c | 32) >= 'a' && (c | 32) <= 'z'; }
static inline int isprint(int c) { return c >= 32 && c < 127; }
#endif
