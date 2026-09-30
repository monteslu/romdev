/* The runtime computes no transcendental functions on the console: the tables
   gpgx builds with them at init are generated at build time instead (see
   rd_tables.c). Only what the remaining code needs is declared. */
#ifndef _RD_MATH_H
#define _RD_MATH_H
#define M_PI 3.1415926535897932385
static inline double fabs(double x) { return x < 0 ? -x : x; }
double floor(double x);
double ceil(double x);
#endif
