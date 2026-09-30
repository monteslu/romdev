#!/usr/bin/env bash
# Build the diagnostic IDO 5.3 uopt that traces allocator (globalcolor)
# decisions, as WASM, beside the stock modules:
#   packages/romdev-toolchain-ido/wasm/5.3/uopt-globalcolor.{mjs,wasm}
#
# The generated uopt.c is instrumented by the workbench's pinned profile
# (`instrument globalcolor`, src/decomp/workbench/instrument-uopt.js), which
# refuses any source whose hash is not the pinned static-recomp output, then
# compiled exactly like the stock uopt module. Tracing is opt-in at run time
# (CDX_LOG / CDX_DETAIL_WEB); with those unset the module must emit objects
# identical to stock uopt, and the decomp domain checks that on every capture
# (src/decomp/globalcolor-trace.js) before any trace is trusted.
#
# Requires the checkout scripts/build-ido.sh prepares (fetched, patched,
# recomp.elf built). Host deps (build time only): emcc (emsdk 4.0.18), make.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd make

SRC="$BUILD_DIR/ido-static-recomp/src"
OUT="$PROJECT_DIR/../romdev-toolchain-ido/wasm/5.3"
[ -x "$SRC/build/recomp.elf" ] || { echo "run scripts/build-ido.sh first (no recomp generator at $SRC)" >&2; exit 1; }
[ -s "$OUT/uopt.wasm" ] || { echo "stock IDO 5.3 modules missing under $OUT (scripts/build-ido.sh)" >&2; exit 1; }

cd "$SRC"
gen=build/5.3
mkdir -p "$gen/wasm"
make -j1 VERSION=5.3 RELEASE=1 "$gen/uopt.c" >/dev/null
node "$PROJECT_DIR/scripts/workbench.mjs" instrument globalcolor "$gen/uopt.c" "$gen/uopt-globalcolor.c"
sed 's/^v0 = wrapper_fork(mem);$/ROMDEV_FORK(v0);/' "$gen/uopt-globalcolor.c" > "$gen/wasm/uopt-globalcolor.c"
if grep -q 'wrapper_fork(' "$gen/wasm/uopt-globalcolor.c"; then
  echo "FATAL: uopt-globalcolor.c has a fork site the ROMDEV_FORK rewrite did not match" >&2
  exit 1
fi

# Same flags as the stock modules (scripts/build-ido.sh EMFLAGS).
emcc -O2 -std=c11 -fno-strict-aliasing -Wno-everything -I. \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=node -s NODERAWFS=1 \
  -s WASM_ASYNC_COMPILATION=0 -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=4GB \
  -s INITIAL_MEMORY=33554432 -s STACK_SIZE=8388608 -s EXIT_RUNTIME=1 -s INVOKE_RUN=0 \
  -s 'EXPORTED_RUNTIME_METHODS=["callMain","FS","ENV"]' -g0 \
  -DIDO53 \
  -DPACKAGE_VERSION="\"$(pin_commit toolchains.ido_static_recomp | cut -c1-12)-romdev\"" \
  -DDATETIME="\"reproducible\"" \
  -s EXPORT_NAME=ido_uopt \
  "$gen/wasm/uopt-globalcolor.c" libc_impl.c version_info.c \
  -o "$OUT/uopt-globalcolor.mjs"

# Synchronous glue prologue, as scripts/build-ido.sh does for every pass.
f="$OUT/uopt-globalcolor.mjs"
sed -i 's/const{createRequire}=await import("module");var require=createRequire(import.meta.url)/var require=process.getBuiltinModule("module").createRequire(import.meta.url)/' "$f"
if grep -q 'await import("module")' "$f" || ! grep -q 'process.getBuiltinModule("module")' "$f"; then
  echo "FATAL: $f: emscripten glue prologue changed; the sync rewrite did not apply" >&2
  exit 1
fi
rm -f "$gen/uopt.c" "$gen/uopt-globalcolor.c" "$gen/wasm/uopt-globalcolor.c"
echo "IDO 5.3 globalcolor uopt -> $OUT/uopt-globalcolor.{mjs,wasm}"
