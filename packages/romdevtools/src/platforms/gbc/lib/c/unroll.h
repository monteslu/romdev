/* ── unroll.h — manual loop-unrolling macros for SDCC sm83 ──────────
 * Auto-staged into every gb/gbc C build.
 *
 * SDCC 4.4.0 sm83 crashes on a wide family of `for (i ...) { ... f(i,
 * ...); ... }` patterns (see SDCC_GOTCHAS.md #1-#9). The reliable
 * workaround is manual unrolling — write N explicit statements
 * instead of a loop. These macros automate that.
 *
 * Usage:
 *
 *   #define STORE_CELL(N) row_buf[N] = wall_at(room, N, ty);
 *   UNROLL_20(STORE_CELL)
 *
 * expands to:
 *   row_buf[0] = wall_at(room, 0, ty);
 *   row_buf[1] = wall_at(room, 1, ty);
 *   ... 18 more ...
 *   row_buf[19] = wall_at(room, 19, ty);
 *
 * No for-loop, so SDCC's register allocator can't crash. Each
 * statement is independent + the call returns before the next one
 * starts — register pressure is one call's worth at a time, never
 * accumulates across iterations.
 *
 * Common GB sizes covered: 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 18, 20,
 * 24, 32, 40, 64. Compose larger sizes from smaller ones (e.g.
 * UNROLL_40 = two UNROLL_20 blocks with index offset; not provided
 * to keep the file readable, but trivial to write).
 *
 * The macro M takes a single argument: the integer index.
 */
#ifndef UNROLL_H
#define UNROLL_H

#define UNROLL_2(M)  M(0) M(1)
#define UNROLL_3(M)  M(0) M(1) M(2)
#define UNROLL_4(M)  M(0) M(1) M(2) M(3)
#define UNROLL_5(M)  M(0) M(1) M(2) M(3) M(4)
#define UNROLL_6(M)  M(0) M(1) M(2) M(3) M(4) M(5)
#define UNROLL_7(M)  M(0) M(1) M(2) M(3) M(4) M(5) M(6)
#define UNROLL_8(M)  M(0) M(1) M(2) M(3) M(4) M(5) M(6) M(7)
#define UNROLL_10(M) M(0) M(1) M(2) M(3) M(4) M(5) M(6) M(7) M(8) M(9)
#define UNROLL_12(M) M(0) M(1) M(2) M(3) M(4) M(5) M(6) M(7) M(8) M(9) M(10) M(11)
#define UNROLL_16(M) M(0) M(1) M(2) M(3) M(4) M(5) M(6) M(7) M(8) M(9) M(10) M(11) M(12) M(13) M(14) M(15)
#define UNROLL_18(M) M(0) M(1) M(2) M(3) M(4) M(5) M(6) M(7) M(8) M(9) M(10) M(11) M(12) M(13) M(14) M(15) M(16) M(17)
#define UNROLL_20(M) M(0) M(1) M(2) M(3) M(4) M(5) M(6) M(7) M(8) M(9) M(10) M(11) M(12) M(13) M(14) M(15) M(16) M(17) M(18) M(19)
#define UNROLL_24(M) M(0) M(1) M(2) M(3) M(4) M(5) M(6) M(7) M(8) M(9) M(10) M(11) M(12) M(13) M(14) M(15) M(16) M(17) M(18) M(19) M(20) M(21) M(22) M(23)
#define UNROLL_32(M) M(0) M(1) M(2) M(3) M(4) M(5) M(6) M(7) M(8) M(9) M(10) M(11) M(12) M(13) M(14) M(15) M(16) M(17) M(18) M(19) M(20) M(21) M(22) M(23) M(24) M(25) M(26) M(27) M(28) M(29) M(30) M(31)
#define UNROLL_40(M) M(0) M(1) M(2) M(3) M(4) M(5) M(6) M(7) M(8) M(9) M(10) M(11) M(12) M(13) M(14) M(15) M(16) M(17) M(18) M(19) M(20) M(21) M(22) M(23) M(24) M(25) M(26) M(27) M(28) M(29) M(30) M(31) M(32) M(33) M(34) M(35) M(36) M(37) M(38) M(39)
#define UNROLL_64(M) UNROLL_32(M) M(32) M(33) M(34) M(35) M(36) M(37) M(38) M(39) M(40) M(41) M(42) M(43) M(44) M(45) M(46) M(47) M(48) M(49) M(50) M(51) M(52) M(53) M(54) M(55) M(56) M(57) M(58) M(59) M(60) M(61) M(62) M(63)

#endif /* UNROLL_H */
