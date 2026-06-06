#!/usr/bin/env bash
# Build a NATIVE debuggable sdcc + sdasgb + sdld so we can run them
# under gdb to investigate codegen bugs.
#
# Use when: you're trying to identify which SDCC source line emits a
# NULL value that crashes the WASM build. The WASM is built with
# -sASSERTIONS=1 + Emscripten can't surface useful stack traces;
# native gdb can.
#
# Produces: build/sdcc-debug/{sdcc, sdasgb, sdld} compiled with -O0 -g.
# Does NOT touch src/toolchains/sdcc/wasm/ (that's the production WASM
# the MCP server uses).
#
# Typical workflow:
#
#   ./scripts/build-sdcc-native-debug.sh
#
#   # 1. Reproduce a crashing C source through our preprocessor
#   cd build/sdcc-debug
#   ./bin/sdcpp -P -I./include /path/to/crash.c > /tmp/crash.i
#
#   # 2. Run sdcc under gdb with breakpoint on dbuf_append_str assert
#   gdb --args ./src/sdcc -msm83 --c1mode -o /tmp/crash.asm
#   (gdb) break dbuf_append_str
#   (gdb) commands
#   > if str == 0
#   >   bt
#   >   c
#   > end
#   > c
#   > end
#   (gdb) run < /tmp/crash.i
#
#   # 3. The backtrace tells you which SDCC source function passed NULL.
#       That's the codegen bug to fix.

set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd gcc
require_cmd make

SDCC_VERSION="4.4.0"
SRC_DIR="$BUILD_DIR/sdcc/sdcc-${SDCC_VERSION}"
DEBUG_BUILD_DIR="$BUILD_DIR/sdcc-debug"
TARBALL="$BUILD_DIR/sdcc/sdcc-src-${SDCC_VERSION}.tar.bz2"

if [ ! -f "$TARBALL" ]; then
  echo "ERROR: need the production sdcc build to have run first (so the tarball is cached at $TARBALL)" >&2
  echo "       run scripts/build-sdcc.sh once, then retry." >&2
  exit 1
fi

if [ ! -d "$DEBUG_BUILD_DIR" ]; then
  mkdir -p "$DEBUG_BUILD_DIR"
  echo "Extracting fresh SDCC source into $DEBUG_BUILD_DIR ..."
  tar -xjf "$TARBALL" -C "$DEBUG_BUILD_DIR"
  if [ -d "$DEBUG_BUILD_DIR/sdcc" ] && [ ! -d "$DEBUG_BUILD_DIR/sdcc-${SDCC_VERSION}" ]; then
    mv "$DEBUG_BUILD_DIR/sdcc" "$DEBUG_BUILD_DIR/sdcc-${SDCC_VERSION}"
  fi
fi

cd "$DEBUG_BUILD_DIR/sdcc-${SDCC_VERSION}"

# Same elf() shim the production build needs on modern gcc.
sed -i 's/^\(extern[[:space:]]*VOID[[:space:]]*\)elf();/\1elf(int);/' \
  sdas/linksrc/aslink.h 2>/dev/null || true

if [ ! -f .debug-configured ]; then
  echo "Configuring sdcc for debug build (-O0 -g, sm83 + z80 + ez80_z80 only)..."
  CFLAGS="-O0 -g3 -ggdb" CXXFLAGS="-O0 -g3 -ggdb" \
    ./configure \
      --enable-z80-port \
      --enable-gbz80-port \
      --enable-ez80_z80-port \
      --disable-mcs51-port \
      --disable-r2k-port \
      --disable-r3ka-port \
      --disable-tlcs90-port \
      --disable-ds390-port \
      --disable-ds400-port \
      --disable-pic14-port \
      --disable-pic16-port \
      --disable-hc08-port \
      --disable-s08-port \
      --disable-stm8-port \
      --disable-pdk13-port \
      --disable-pdk14-port \
      --disable-pdk15-port \
      --disable-pdk16-port \
      --disable-mos6502-port \
      --disable-doc \
      --disable-libgc \
      --disable-ucsim \
      --disable-z180-port
  touch .debug-configured
fi

echo "Building (this takes ~5-10 min with -O0)..."
make -j"$(nproc)" 2>&1 | tail -10

echo ""
echo "Debug sdcc ready: $DEBUG_BUILD_DIR/sdcc-${SDCC_VERSION}/src/sdcc"
echo ""
echo "Run under gdb:"
echo "  gdb --args $DEBUG_BUILD_DIR/sdcc-${SDCC_VERSION}/src/sdcc -msm83 --c1mode -o /tmp/out.asm"
echo "  (gdb) break dbuf_append_str if str == 0"
echo "  (gdb) run < /tmp/preprocessed.i"
echo "  # When it hits, 'bt' shows which SDCC source path emitted the NULL."
