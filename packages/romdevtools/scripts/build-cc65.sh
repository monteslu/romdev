#!/usr/bin/env bash
# Build cc65 → ca65 → ld65 to WASM, plus stage lib/cfg/asminc/include/target.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git
require_cmd make

# Upstream pin lives in scripts/versions.json (toolchains.cc65). The pin is the
# post-V2.19 commit cc3c40c — that's the first commit to add the W65C02 CPU the
# GameTank SDK targets, so it (not the V2.19 tag) is what we build and ship.
CC65_DIR="$BUILD_DIR/cc65/src"
# The built WASM + share tree ship in the romdev-toolchain-cc65 binary package
# (romdevtools loads them from there via wasmDir()). That package is a sibling
# of this one under packages/.
CC65_PKG="$PROJECT_DIR/../romdev-toolchain-cc65"
OUT="$CC65_PKG/wasm"
SHARE="$CC65_PKG/share/cc65"
PATCH_FILE="$PROJECT_DIR/$(pin_get toolchains.cc65 patch)"

fetch_pinned toolchains.cc65 "$CC65_DIR" || true

cd "$CC65_DIR"

# Apply the reproducible-debug-info patch (deterministic object files: pinned
# mtimes + basenamed source paths + fixed OPT_DATETIME, so a native and a WASM
# build of the same input produce byte-identical .o — see the patch header and
# scripts/patches/README.md). Reset the touched files so a re-run re-applies
# cleanly; skip if the sentinel (GetSourceDateEpoch) is already present.
git checkout -- src/ca65/filetab.c src/ca65/main.c src/cc65/input.c \
                src/cc65/lineinfo.c src/common/filetime.c src/common/filetime.h 2>/dev/null || true
if ! git apply --recount --check "$PATCH_FILE" 2>/dev/null; then
  if grep -q "GetSourceDateEpoch" src/common/filetime.c; then
    echo "cc65 reproducible-debug-info patch already present; skipping."
  else
    echo "FATAL: cc65 patch failed to apply and sentinel not present." >&2
    exit 1
  fi
else
  git apply --recount "$PATCH_FILE"
  echo "Applied $PATCH_FILE"
fi

make clean -C src || true

echo "Building host tools with emcc..."
make -C src cc65 ca65 ld65 da65 ar65 CC=emcc AR=emar -j"$(nproc)"

echo "Relinking with MODULARIZE flags..."
# The cc65 src/Makefile writes objects to ../wrk and binaries to ../bin
# (relative to src/), i.e. wrk/ and bin/ under the repo root we're sitting in.
for prog in cc65 ca65 ld65 da65; do
  emcc \
    wrk/${prog}/*.o wrk/common/common.a \
    "${EM_CLI_FLAGS[@]}" \
    -lm \
    -s EXPORT_NAME="create${prog^}" \
    -o "bin/${prog}.js"
done

# Copy the relinked WASM out NOW, before the runtime-lib pass below runs
# `make clean` (which wipes bin/ and would delete these .js/.wasm). The share
# tree is staged after the libs are built, further down.
mkdir -p "$OUT"
for prog in cc65 ca65 ld65 da65; do
  cp "bin/${prog}.js" "bin/${prog}.wasm" "$OUT/"
done

echo "Building 6502 runtime libraries (native cc65 tools)..."
make clean -C src
make -j"$(nproc)"
# Build the runtime libs for ALL targets explicitly — a bare `make` builds the
# tools but does NOT reliably produce every target's lib (that's why an earlier
# build shipped only 5 of the ~25 target libs, breaking PCE + Atari 5200/8-bit
# at link). `make lib` walks libsrc/Makefile's full TARGETS list (incl. pce,
# atari, atari5200, atarixl).
make lib -j"$(nproc)"

mkdir -p "$SHARE/lib" "$SHARE/asminc" "$SHARE/include" "$SHARE/cfg" "$SHARE/target"
cp -r asminc/* "$SHARE/asminc/"
cp -r include/* "$SHARE/include/"
cp -r cfg/* "$SHARE/cfg/"
cp -r target/* "$SHARE/target/"
cp lib/*.lib lib/*.o "$SHARE/lib/"

# NOTE: The dual-build (emcc host tools, then native build for runtime libs)
# trips on object files in wrk/ being from the wrong toolchain. We work
# around it with the make clean in between. Building cc65 reliably requires
# this two-pass dance because the C runtime libs (lib/*.lib) are generated
# by running cc65/ca65/ld65 on the libsrc/ directory.

echo "cc65/ca65/ld65/da65 staged at $OUT and runtime libs at $SHARE"
