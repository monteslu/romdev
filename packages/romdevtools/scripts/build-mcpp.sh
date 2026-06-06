#!/usr/bin/env bash
# Build mcpp (Matsui's C preprocessor) to WASM. Used as SDCC's preprocessor
# because:
#   1. SDCC ships `sdcpp` as a shell wrapper around the system `cpp`,
#      which isn't bundleable.
#   2. sdcc.wasm internally fork+exec's its preprocessor, and Emscripten
#      can't fork. Our wrapper runs mcpp.wasm first, feeds the .i to sdcc.
# mcpp is BSD-licensed, ~200 KB compiled, supports C99 + GCC extensions.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd curl
require_cmd tar
require_cmd make

MCPP_VERSION="2.7.2"
MCPP_TARBALL="mcpp-${MCPP_VERSION}.tar.gz"
MCPP_URL="https://downloads.sourceforge.net/project/mcpp/mcpp/V.${MCPP_VERSION}/${MCPP_TARBALL}"
MCPP_BUILD_DIR="$BUILD_DIR/mcpp"
MCPP_SRC_DIR="$MCPP_BUILD_DIR/mcpp-${MCPP_VERSION}"
OUT="$PROJECT_DIR/src/toolchains/sdcc/wasm"

mkdir -p "$MCPP_BUILD_DIR"
if [ ! -f "$MCPP_BUILD_DIR/$MCPP_TARBALL" ]; then
  echo "Downloading $MCPP_TARBALL ..."
  curl -L -o "$MCPP_BUILD_DIR/$MCPP_TARBALL" "$MCPP_URL"
fi
if [ ! -d "$MCPP_SRC_DIR" ]; then
  echo "Extracting $MCPP_TARBALL ..."
  tar -xzf "$MCPP_BUILD_DIR/$MCPP_TARBALL" -C "$MCPP_BUILD_DIR"
fi

cd "$MCPP_SRC_DIR"

# Configure for "standalone-mode" build: a normal CLI binary. Disable
# library mode (--enable-mcpplib) — we want a callMain-able executable.
# Use the i686 host trick from the sdcc build to satisfy autoconf cross-
# compile detection without running probe binaries.
echo "Configuring mcpp under emconfigure ..."
emconfigure ./configure \
  --host=i686-pc-linux-gnu \
  --build=x86_64-pc-linux-gnu \
  --disable-shared \
  CFLAGS="-O2 -Wno-implicit-function-declaration -Wno-implicit-int -Wno-return-type -Wno-incompatible-pointer-types -Wno-int-conversion"

# mcpp's Makefile builds against $(CC). emconfigure already set CC=emcc.
# We want a callMain-able WASM, so override LDFLAGS with our EM_CLI_FLAGS
# and EXPORT_NAME=createMcpp.
echo "Building mcpp via emmake ..."
emmake make -j"$(nproc)" \
  CC=emcc \
  LDFLAGS="${EM_CLI_FLAGS[*]} -s EXPORT_NAME=createMcpp"

# mcpp's Makefile may have written the output as `src/mcpp` (no extension)
# + `src/mcpp.wasm`. Locate it.
MCPP_BIN=""
for cand in src/mcpp src/.libs/mcpp mcpp; do
  if [ -f "$cand" ] && [ -f "${cand}.wasm" ]; then
    MCPP_BIN="$cand"
    break
  fi
done

if [ -z "$MCPP_BIN" ]; then
  echo "FATAL: mcpp binary not produced. Looked in src/mcpp, src/.libs/mcpp, ./mcpp" >&2
  find . -name "mcpp" -o -name "mcpp.wasm" 2>/dev/null | head -20
  exit 1
fi

mkdir -p "$OUT"
cp "$MCPP_BIN" "$OUT/mcpp.js"
cp "${MCPP_BIN}.wasm" "$OUT/mcpp.wasm"
echo "mcpp staged at $OUT/mcpp.{js,wasm}"
ls -lh "$OUT/mcpp."{js,wasm}
