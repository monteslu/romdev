/* zlib-stream: a vanilla zlib deflate/crc32 library build for WASM, used by
   romdev-splat to write PNG IDAT streams byte-identical to CPython's zlib
   module (zlib.compressobj(level, DEFLATED, wbits, memLevel, strategy),
   .compress(data) and .flush()). Node's own zlib is Chromium's fork and
   produces different streams.

   API (all sizes in bytes, pointers into WASM memory):
     zs_new(level, wbits, memlevel, strategy) -> handle (0 on failure)
     zs_compress(h, in, n, flush)            -> 0 ok, <0 zlib error
     zs_out_ptr(h), zs_out_len(h)             -> output produced by the last call
     zs_free(h)
     zs_crc32(crc, buf, n)                    -> updated crc
   Built by packages/romdev-splat/scripts/build-zlib-wasm.sh. */
#include <stdlib.h>
#include <string.h>
#include <zlib.h>
#include <emscripten/emscripten.h>

typedef struct {
  z_stream s;
  unsigned char *out;
  size_t out_len;
  size_t out_cap;
} zs_t;

EMSCRIPTEN_KEEPALIVE void *zs_malloc(size_t n) { return malloc(n ? n : 1); }
EMSCRIPTEN_KEEPALIVE void zs_mfree(void *p) { free(p); }

EMSCRIPTEN_KEEPALIVE zs_t *zs_new(int level, int wbits, int memlevel, int strategy) {
  zs_t *z = calloc(1, sizeof(zs_t));
  if (!z) return 0;
  if (deflateInit2(&z->s, level, Z_DEFLATED, wbits, memlevel, strategy) != Z_OK) {
    free(z);
    return 0;
  }
  return z;
}

static int grow(zs_t *z, size_t need) {
  if (z->out_cap >= need) return 1;
  size_t cap = z->out_cap ? z->out_cap : 16384;
  while (cap < need) cap *= 2;
  unsigned char *p = realloc(z->out, cap);
  if (!p) return 0;
  z->out = p;
  z->out_cap = cap;
  return 1;
}

/* Mirrors CPython's zlib_Compress_compress_impl / zlib_Compress_flush_impl:
   deflate() is called until the input is consumed (NO_FLUSH) or until it
   stops filling the output buffer (other flush modes). */
EMSCRIPTEN_KEEPALIVE int zs_compress(zs_t *z, const unsigned char *in, size_t n, int flush) {
  z->out_len = 0;
  z->s.next_in = (unsigned char *)in;
  z->s.avail_in = (uInt)n;
  int err;
  do {
    if (!grow(z, z->out_len + 16384)) return -100;
    z->s.next_out = z->out + z->out_len;
    z->s.avail_out = (uInt)(z->out_cap - z->out_len);
    uInt before = z->s.avail_out;
    err = deflate(&z->s, flush);
    if (err == Z_STREAM_ERROR) return err;
    z->out_len += before - z->s.avail_out;
  } while (z->s.avail_out == 0 || (flush == Z_NO_FLUSH && z->s.avail_in != 0));
  if (flush == Z_FINISH && err != Z_STREAM_END) return err < 0 ? err : -101;
  return 0;
}

EMSCRIPTEN_KEEPALIVE unsigned char *zs_out_ptr(zs_t *z) { return z->out; }
EMSCRIPTEN_KEEPALIVE size_t zs_out_len(zs_t *z) { return z->out_len; }

EMSCRIPTEN_KEEPALIVE void zs_free(zs_t *z) {
  if (!z) return;
  deflateEnd(&z->s);
  free(z->out);
  free(z);
}

EMSCRIPTEN_KEEPALIVE unsigned long zs_crc32(unsigned long crc, const unsigned char *buf, size_t n) {
  return crc32(crc, buf, (uInt)n);
}
