#!/usr/bin/env bash
# STAGE 2 of the GBA C tier-1 pipeline (R24): compile the arm-none-eabi
# gcc toolchain components (cc1, arm-none-eabi-as, arm-none-eabi-ld,
# arm-none-eabi-objcopy) to WASM via emcc.
#
# Prereq: stage 1 (build-arm-toolchain.sh) must have completed - this
# script reuses the same upstream gcc/binutils source trees plus the
# stage-1 native artifacts that gcc's build needs to bootstrap.
#
# Pattern is identical to build-m68k-wasm-tools.sh (R20 stage 2). Only
# the target triple, CPU flags, and the output paths change. The R20
# meta-knowledge (libiberty psignal HAVE_PSIGNAL=1, gcov-tool ftw
# workaround via `make cc1`, MODULARIZE+EXPORT_ES6+ALLOW_MEMORY_GROWTH
# +INITIAL_MEMORY=128MB) applies the same way here.
#
# What this stage produces:
#   src/toolchains/arm-none-eabi-gcc/wasm/cc1-arm.{mjs,wasm}
#   src/toolchains/arm-none-eabi-gcc/wasm/arm-none-eabi-as.{mjs,wasm}
#   src/toolchains/arm-none-eabi-gcc/wasm/arm-none-eabi-ld.{mjs,wasm}
#   src/toolchains/arm-none-eabi-gcc/wasm/arm-none-eabi-objcopy.{mjs,wasm}
#
# Build flow:
#   1. Build WASM versions of gcc's prereq libs (GMP, MPFR, MPC, ISL) via emconfigure.
#      These are SHARED with the m68k WASM build - same versions, same prefix
#      conceptually, but we keep them under the arm-toolchain tree to be self-contained.
#   2. Configure gcc with --host=wasm32-unknown-emscripten + our WASM prereqs.
#   3. Patch libiberty/config.h to set HAVE_PSIGNAL=1 (same as m68k R20 fix).
#   4. emmake make cc1 (NOT all-gcc - gcov-tool needs ftw() which
#      emscripten libc lacks; building cc1 directly skips it).
#   5. emmake make for binutils → as.wasm, ld.wasm, objcopy.wasm.
#   6. emcc-wrap each WASM binary with MODULARIZE / EXPORT_NAME /
#      EXPORT_ES6 / ALLOW_MEMORY_GROWTH / INITIAL_MEMORY=128MB.
#   7. Stage final artifacts under src/toolchains/arm-none-eabi-gcc/wasm/.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc

if [ -z "${EMSDK:-}" ]; then
  echo "EMSDK environment variable not set. Source emsdk_env.sh first." >&2
  exit 1
fi
source "$EMSDK/emsdk_env.sh" > /dev/null 2>&1

ROOT="$BUILD_DIR/arm-toolchain"
SRC_DIR="$ROOT/src"
WASM_PREFIX="$ROOT/wasm-deps"
# Builder paths reach the binaries through __FILE__ (gcc/binutils/gmp/mpfr/isl
# assertions) and through the configured prefix (default search dirs, ld's
# SEARCH_DIRs). Map the whole tree to /romdev and configure the tools with
# --prefix=/romdev so neither carries this machine's paths. The prefix is never
# installed to: the tools are relinked from the build dirs, and romdev passes
# every include and library path.
MAP="-ffile-prefix-map=$ROOT=/romdev"
NATIVE_PREFIX="$ROOT/install"
OUT="$PROJECT_DIR/src/toolchains/arm-none-eabi-gcc/wasm"
NCPU="${JOBS:-$(nproc)}"
TARGET=arm-none-eabi

if [ ! -x "$NATIVE_PREFIX/bin/$TARGET-gcc" ]; then
  echo "Stage 1 not done - run build-arm-toolchain.sh first." >&2
  exit 1
fi

# Pinned dep versions matching gcc-14.2.0's download_prerequisites.
GMP_VER=6.3.0
MPFR_VER=4.2.1
MPC_VER=1.3.1
ISL_VER=0.24

mkdir -p "$WASM_PREFIX" "$OUT"
cd "$SRC_DIR"

# ── 1. Fetch + extract prereqs ──────────────────────────────────────
for tarball in \
  "https://ftp.gnu.org/gnu/gmp/gmp-$GMP_VER.tar.xz" \
  "https://ftp.gnu.org/gnu/mpfr/mpfr-$MPFR_VER.tar.xz" \
  "https://gcc.gnu.org/pub/gcc/infrastructure/mpc-$MPC_VER.tar.gz" \
  "https://gcc.gnu.org/pub/gcc/infrastructure/isl-$ISL_VER.tar.bz2" \
; do
  fn="${tarball##*/}"
  if [ ! -f "$fn" ]; then
    # Reuse the m68k-toolchain's already-downloaded tarballs if present
    # (they're identical files - same upstream URLs).
    M68K_SHARED="$BUILD_DIR/m68k-toolchain/src/$fn"
    if [ -f "$M68K_SHARED" ]; then
      ln -sf "$M68K_SHARED" "$fn"
    else
      wget -q "$tarball"
    fi
  fi
done
[ ! -d "gmp-$GMP_VER" ]   && tar xf "gmp-$GMP_VER.tar.xz"
[ ! -d "mpfr-$MPFR_VER" ] && tar xf "mpfr-$MPFR_VER.tar.xz"
[ ! -d "mpc-$MPC_VER" ]   && tar xf "mpc-$MPC_VER.tar.gz"
[ ! -d "isl-$ISL_VER" ]   && tar xf "isl-$ISL_VER.tar.bz2"

# ── 2. Build each prereq to WASM ────────────────────────────────────
# GMP - base arbitrary-precision integer math.
if [ ! -f "$WASM_PREFIX/lib/libgmp.a" ]; then
  cd "$ROOT"; mkdir -p build-wasm-gmp; cd build-wasm-gmp
  emconfigure "../src/gmp-$GMP_VER/configure" \
    --prefix="$WASM_PREFIX" \
    CPPFLAGS="$MAP" \
    --disable-shared --enable-static \
    --disable-assembly \
    --host=none-none-none
  emmake make -j"$NCPU"
  emmake make install
fi

# MPFR - depends on GMP.
if [ ! -f "$WASM_PREFIX/lib/libmpfr.a" ]; then
  cd "$ROOT"; mkdir -p build-wasm-mpfr; cd build-wasm-mpfr
  emconfigure "../src/mpfr-$MPFR_VER/configure" \
    --prefix="$WASM_PREFIX" \
    CPPFLAGS="$MAP" \
    --with-gmp="$WASM_PREFIX" \
    --disable-shared --enable-static \
    --host=none-none-none
  emmake make -j"$NCPU"
  emmake make install
fi

# MPC.
if [ ! -f "$WASM_PREFIX/lib/libmpc.a" ]; then
  cd "$ROOT"; mkdir -p build-wasm-mpc; cd build-wasm-mpc
  emconfigure "../src/mpc-$MPC_VER/configure" \
    --prefix="$WASM_PREFIX" \
    CPPFLAGS="$MAP" \
    --with-gmp="$WASM_PREFIX" --with-mpfr="$WASM_PREFIX" \
    --disable-shared --enable-static \
    --host=none-none-none
  emmake make -j"$NCPU"
  emmake make install
fi

# ISL.
if [ ! -f "$WASM_PREFIX/lib/libisl.a" ]; then
  cd "$ROOT"; mkdir -p build-wasm-isl; cd build-wasm-isl
  emconfigure "../src/isl-$ISL_VER/configure" \
    --prefix="$WASM_PREFIX" \
    CPPFLAGS="$MAP" \
    --with-gmp-prefix="$WASM_PREFIX" \
    --disable-shared --enable-static \
    --host=none-none-none
  emmake make -j"$NCPU"
  emmake make install
fi

# ── 3. Build cc1 as WASM ────────────────────────────────────────────
if [ ! -f "$ROOT/build-wasm-gcc/gcc/cc1" ]; then
  cd "$ROOT"; mkdir -p build-wasm-gcc; cd build-wasm-gcc
  if [ ! -f Makefile ]; then
    emconfigure "$SRC_DIR/gcc-14.2.0/configure" \
      CFLAGS="-O2 $MAP" CXXFLAGS="-O2 $MAP" \
      --target="$TARGET" \
      --prefix=/romdev \
      --host=wasm32-unknown-emscripten \
      --build="$(gcc -dumpmachine)" \
      --enable-languages=c \
      --disable-nls --disable-multilib \
      --disable-shared --disable-threads \
      --disable-libssp --disable-libstdcxx \
      --disable-bootstrap \
      --without-headers --with-newlib \
      --with-cpu=arm7tdmi \
      --with-mode=arm \
      --with-float=soft \
      --with-gmp="$WASM_PREFIX" \
      --with-mpfr="$WASM_PREFIX" \
      --with-mpc="$WASM_PREFIX" \
      --with-isl="$WASM_PREFIX" \
      --with-system-zlib
  fi

  # Run configure-libiberty FIRST so libiberty/config.h exists, then
  # apply the R20 psignal patch BEFORE building libiberty. Without
  # this order, all-build builds libiberty before the patch lands and
  # strsignal.c fails with "conflicting types for 'psignal'".
  emmake make -j"$NCPU" configure-build-libiberty configure-libiberty

  # R20 fix carries over: libiberty's psignal fallback signature
  # clashes with emscripten's signal.h. Patch libiberty/config.h -
  # plus the pic/ and noasan/ build variants since libiberty
  # rebuilds those separately.
  for cfg in libiberty/config.h libiberty/pic/config.h libiberty/noasan/config.h; do
    if [ -f "$cfg" ]; then
      if ! grep -q "^#define HAVE_PSIGNAL 1" "$cfg"; then
        echo "#define HAVE_PSIGNAL 1" >> "$cfg"
      fi
    fi
  done

  # Build the full all-gcc dependency chain, then ask gcc/ for cc1.
  #
  # CRITICAL: override CC_FOR_BUILD + CXX_FOR_BUILD to NATIVE gcc/g++.
  # Without this override the gcc/Makefile sets CC_FOR_BUILD = $(CC)
  # = emcc, then tries to link build-time tools (genmodes, genhooks)
  # with wasm-ld against the NATIVE libiberty.a - fails with
  # "undefined symbol: xmalloc" etc. because the native .o archive
  # isn't WASM-compatible.
  #
  # The right pattern: WASM toolchain for HOST (cc1 itself), NATIVE
  # toolchain for BUILD (the gen* generators that produce cc1's
  # internal tables). Same shape as a normal Canadian cross.
  emmake make -j"$NCPU" \
    CC_FOR_BUILD=gcc \
    CXX_FOR_BUILD=g++ \
    all-build \
    all-libiberty \
    all-libcpp \
    all-libcody \
    all-libdecnumber \
    all-libbacktrace \
    all-zlib \
    configure-gcc
  # configargs.h records the configure command line (CFLAGS with the prefix map,
  # --with-gmp=...); keep the builder's paths out of it as the prefix map does
  # for sources.
  sed -i "s|$ROOT|/romdev|g" gcc/configargs.h
  if grep -q "$ROOT" gcc/configargs.h; then echo "FATAL: builder path left in configargs.h" >&2; exit 1; fi
  cd gcc
  emmake make -j"$NCPU" \
    CC_FOR_BUILD=gcc \
    CXX_FOR_BUILD=g++ \
    cc1
  cd ..
fi

# ── 4. Build binutils as WASM ──────────────────────────────────────
if [ ! -f "$ROOT/build-wasm-binutils/gas/as-new" ]; then
  cd "$ROOT"; mkdir -p build-wasm-binutils; cd build-wasm-binutils
  if [ ! -f Makefile ]; then
    emconfigure "$SRC_DIR/binutils-2.42/configure" \
      CFLAGS="-O2 $MAP" CXXFLAGS="-O2 $MAP" \
      --target="$TARGET" \
      --prefix=/romdev \
      --host=wasm32-unknown-emscripten \
      --build="$(gcc -dumpmachine)" \
      --disable-nls --disable-werror \
      --disable-multilib --with-cpu=arm7tdmi
  fi

  # Same psignal patch - binutils has its own libiberty tree with
  # its own config.h. Run configure-libiberty first so config.h
  # exists, then patch, then full build. Patch all variant config.h
  # files (libiberty itself, plus pic/ and noasan/ if they exist).
  emmake make -j"$NCPU" CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ \
    configure-build-libiberty configure-libiberty
  for cfg in libiberty/config.h libiberty/pic/config.h libiberty/noasan/config.h; do
    if [ -f "$cfg" ]; then
      if ! grep -q "^#define HAVE_PSIGNAL 1" "$cfg"; then
        echo "#define HAVE_PSIGNAL 1" >> "$cfg"
      fi
    fi
  done

  # Now the full build. Same CC_FOR_BUILD override as the gcc build
  # so binutils' build-side tools (genscripts, etc.) compile natively.
  emmake make -j"$NCPU" CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++
fi

# ── 5. Re-link each tool as a MODULARIZE + EXPORT_ES6 module ─────────
# The emcc link of each tool (cc1, as-new, ld-new, objcopy, objdump) writes a
# plain JS launcher + .wasm, which cannot be fed back into emcc. Re-run the
# tool's own link step from its build dir with our standard knobs instead
# (EM_WRAP_FLAGS in _lib.sh, plus a larger stack):
#   -s MODULARIZE=1            wrap in async factory function
#   -s EXPORT_NAME=...         JS-visible factory name
#   -s EXPORT_ES6=1            emit an ESM module
#   -s ALLOW_MEMORY_GROWTH=1   cc1 grows past 16 MB on real input
#   -s INITIAL_MEMORY=128MB    cc1 OOMs at the default 16 MB cap
#   -s EXIT_RUNTIME=1          let callMain return cleanly
#   -s INVOKE_RUN=0            romdev calls callMain itself
#   -s STACK_SIZE=8MB          cc1 is built at -O0 here and its frames overrun
#                              emscripten's 64KB default stack on real input
#   -g0                        no DWARF in the shipped modules
# Staged into src/toolchains/arm-none-eabi-gcc/wasm/ and romdev-platform-gba/wasm/.
PKG_OUT="$PROJECT_DIR/../romdev-platform-gba/wasm"
mkdir -p "$PKG_OUT"
WRAP_LDFLAGS="-O2 -g0 -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=134217728 -s STACK_SIZE=8388608 -s EXIT_RUNTIME=1 -s INVOKE_RUN=0 -s EXPORTED_RUNTIME_METHODS=callMain,FS"

wrap_tool() {
  local dir="$1"           # build dir holding the make target
  local target="$2"        # make target (cc1, as-new, ld-new, objcopy, objdump)
  local out_name="$3"      # logical name (staged .mjs/.wasm basename)
  local export_name="$4"   # createXxx - the JS factory name
  echo "Re-linking $dir/$target -> $out_name.{mjs,wasm}"
  ( cd "$dir" && rm -f "$target" "$target.wasm" && \
    emmake make "$target" LDFLAGS="$WRAP_LDFLAGS -s EXPORT_NAME=$export_name" )
  cp "$dir/$target" "$OUT/$out_name.mjs"
  cp "$dir/$target.wasm" "$OUT/$out_name.wasm"
  cp "$OUT/$out_name.mjs" "$OUT/$out_name.wasm" "$PKG_OUT/"
}

wrap_tool "$ROOT/build-wasm-gcc/gcc"           cc1     cc1-arm               createCc1arm
wrap_tool "$ROOT/build-wasm-binutils/gas"      as-new  arm-none-eabi-as      createArmAs
wrap_tool "$ROOT/build-wasm-binutils/ld"       ld-new  arm-none-eabi-ld      createArmLd
wrap_tool "$ROOT/build-wasm-binutils/binutils" objcopy arm-none-eabi-objcopy createArmObjcopy
# objdump = the ARM/Thumb DISASSEMBLER (`-D -b binary -m arm`, +`-M force-thumb`).
# Unlocks GBA disassembly (the platform was previously rejected for lack of an
# ARM disassembler). Ships in romdev-platform-gba alongside as/ld/objcopy.
wrap_tool "$ROOT/build-wasm-binutils/binutils" objdump arm-none-eabi-objdump createArmObjdump

echo ""
echo "Stage 2 complete. Artifacts:"
ls -la "$OUT/"
