/* raw-deflate LEVEL IN OUT: IN as a raw deflate stream (windowBits -15,
   memLevel 8, default strategy) written to OUT, with vanilla zlib - the
   stream Python's zlib.compressobj(LEVEL, wbits=-15) produces. romdev's decomp
   domain uses it for ROM compressors that call zlib (Node's own zlib is
   Chromium's fork, whose streams differ).  */
#include <stdio.h>
#include <stdlib.h>
#include <zlib.h>

int main(int argc, char **argv) {
  if (argc != 4) { fprintf(stderr, "usage: raw-deflate level in out\n"); return 2; }
  int level = atoi(argv[1]);
  FILE *f = fopen(argv[2], "rb");
  if (!f) { perror(argv[2]); return 1; }
  fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
  unsigned char *in = malloc(n ? n : 1);
  if (n && fread(in, 1, n, f) != (size_t)n) { perror(argv[2]); return 1; }
  fclose(f);
  z_stream s = {0};
  if (deflateInit2(&s, level, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY) != Z_OK) { fprintf(stderr, "deflateInit2 failed\n"); return 1; }
  uLong cap = deflateBound(&s, n);
  unsigned char *out = malloc(cap);
  s.next_in = in; s.avail_in = n; s.next_out = out; s.avail_out = cap;
  if (deflate(&s, Z_FINISH) != Z_STREAM_END) { fprintf(stderr, "deflate failed\n"); return 1; }
  FILE *o = fopen(argv[3], "wb");
  if (!o || fwrite(out, 1, s.total_out, o) != s.total_out || fclose(o)) { perror(argv[3]); return 1; }
  deflateEnd(&s);
  return 0;
}
