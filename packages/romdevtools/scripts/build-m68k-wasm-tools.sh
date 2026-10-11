#!/usr/bin/env bash
# STAGE 2 of the Genesis C tier-1 pipeline: compile the m68k-elf gcc
# toolchain components (cc1, m68k-elf-as, m68k-elf-ld, m68k-elf-objcopy)
# to WASM via emcc.
#
# Shares build/m68k-toolchain/src with stage 1 (build-m68k-toolchain.sh) and
# fetches the gcc/binutils sources itself when stage 1 has not run. It does
# not need the native toolchain: cc1 and binutils build from source with
# native generator tools (CC_FOR_BUILD).
#
# What this stage produces:
#   romdev-toolchain-m68k-gcc/wasm/cc1-m68k.{mjs,wasm}
#   romdev-toolchain-m68k-gcc/wasm/m68k-elf-{as,ld,objcopy,objdump}.{mjs,wasm}
#   (copied to src/toolchains/m68k-elf-gcc/wasm/ as well)
#
# Total WASM tool size: ~30-50 MB compressed (cc1 dominates at ~25 MB).
#
# Build flow:
#   1. Build WASM versions of gcc's prereq libs (GMP, MPFR, MPC, ISL) via emconfigure.
#   2. Configure gcc with --host=wasm32-unknown-emscripten + our WASM prereqs.
#   3. emmake make cc1 (host libs + native generators first) - cc1 as WASM.
#   4. Configure binutils with --host=wasm32-unknown-emscripten.
#   5. emmake make - produces as.wasm, ld.wasm, objcopy.wasm.
#   6. Wrap each WASM binary in our standard MODULARIZE / EXPORT_NAME emcc shell.
#   7. Stage final artifacts to src/toolchains/m68k-elf-gcc/wasm/.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc

if [ -z "${EMSDK:-}" ]; then
  echo "EMSDK environment variable not set. Source emsdk_env.sh first." >&2
  exit 1
fi
source "$EMSDK/emsdk_env.sh" > /dev/null 2>&1

ROOT="$BUILD_DIR/m68k-toolchain"
SRC_DIR="$ROOT/src"
WASM_PREFIX="$ROOT/wasm-deps"
# Builder paths reach the binaries through __FILE__ (gcc/binutils/gmp/mpfr/isl
# assertions) and through the configured prefix (default search dirs, ld's
# SEARCH_DIRs). Map the whole tree to /romdev and configure the tools with
# --prefix=/romdev so neither carries this machine's paths. The prefix is never
# installed to: the tools are relinked from the build dirs, and romdev passes
# every include and library path.
MAP="-ffile-prefix-map=$ROOT=/romdev"
OUT="$PROJECT_DIR/src/toolchains/m68k-elf-gcc/wasm"
NCPU="${JOBS:-$(nproc)}"


# Pinned dep versions matching what gcc-14.2.0's download_prerequisites uses.
GMP_VER=6.3.0
MPFR_VER=4.2.1
MPC_VER=1.3.1
ISL_VER=0.24
GCC_VER=14.2.0
BINUTILS_VER=2.42

mkdir -p "$SRC_DIR" "$WASM_PREFIX" "$OUT"
cd "$SRC_DIR"

# gcc/binutils sources (stage 1 extracts the same trees here).
for tarball in \
  "https://ftp.gnu.org/gnu/binutils/binutils-$BINUTILS_VER.tar.xz" \
  "https://ftp.gnu.org/gnu/gcc/gcc-$GCC_VER/gcc-$GCC_VER.tar.xz" \
; do
  fn="${tarball##*/}"
  [ -f "$fn" ] || wget -q "$tarball"
done
[ -d "binutils-$BINUTILS_VER" ] || tar xf "binutils-$BINUTILS_VER.tar.xz"
[ -d "gcc-$GCC_VER" ] || tar xf "gcc-$GCC_VER.tar.xz"

# ── 1. Fetch + extract prereqs ──────────────────────────────────────
for tarball in \
  "https://ftp.gnu.org/gnu/gmp/gmp-$GMP_VER.tar.xz" \
  "https://ftp.gnu.org/gnu/mpfr/mpfr-$MPFR_VER.tar.xz" \
  "https://gcc.gnu.org/pub/gcc/infrastructure/mpc-$MPC_VER.tar.gz" \
  "https://gcc.gnu.org/pub/gcc/infrastructure/isl-$ISL_VER.tar.bz2" \
; do
  fn="${tarball##*/}"
  if [ ! -f "$fn" ]; then
    wget -q "$tarball"
  fi
done
[ ! -d "gmp-$GMP_VER" ]   && tar xf "gmp-$GMP_VER.tar.xz"
[ ! -d "mpfr-$MPFR_VER" ] && tar xf "mpfr-$MPFR_VER.tar.xz"
[ ! -d "mpc-$MPC_VER" ]   && tar xf "mpc-$MPC_VER.tar.gz"
[ ! -d "isl-$ISL_VER" ]   && tar xf "isl-$ISL_VER.tar.bz2"

# ── 2. Build each prereq to WASM ────────────────────────────────────
# GMP - base arbitrary-precision integer math. No deps.
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

# MPC - depends on GMP + MPFR.
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

# ISL - depends on GMP. Used by gcc's loop optimizer.
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
# Same sequence as build-arm-wasm-tools.sh: configure with a WASM host, build
# the host support libs and the native generator tools explicitly, then make
# only cc1 (all-gcc also builds driver/aux tools emscripten cannot link).
# The TARGET stays m68k-elf - the WASM binary still produces m68k code.
if [ ! -f "$ROOT/build-wasm-gcc/gcc/cc1" ]; then
  cd "$ROOT"; mkdir -p build-wasm-gcc; cd build-wasm-gcc
  if [ ! -f Makefile ]; then
    emconfigure "$SRC_DIR/gcc-$GCC_VER/configure" \
      CFLAGS="-O2 $MAP" CXXFLAGS="-O2 $MAP" \
      --target=m68k-elf \
      --prefix=/romdev \
      --host=wasm32-unknown-emscripten \
      --build="$(gcc -dumpmachine)" \
      --enable-languages=c \
      --disable-nls --disable-multilib \
      --disable-shared --disable-threads \
      --disable-libssp --disable-libstdcxx \
      --disable-bootstrap \
      --without-headers --with-newlib \
      --with-cpu=m68000 \
      --with-gmp="$WASM_PREFIX" \
      --with-mpfr="$WASM_PREFIX" \
      --with-mpc="$WASM_PREFIX" \
      --with-isl="$WASM_PREFIX" \
      --with-system-zlib
  fi
  emmake make -j"$NCPU" configure-build-libiberty configure-libiberty
  # emscripten's libc provides psignal; tell libiberty so it does not
  # redefine it with a conflicting prototype.
  for cfg in libiberty/config.h libiberty/pic/config.h libiberty/noasan/config.h; do
    if [ -f "$cfg" ] && ! grep -q "^#define HAVE_PSIGNAL 1" "$cfg"; then
      echo "#define HAVE_PSIGNAL 1" >> "$cfg"
    fi
  done
  emmake make -j"$NCPU" CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ \
    all-build all-libiberty all-libcpp all-libcody all-libdecnumber \
    all-libbacktrace all-zlib configure-gcc
  # configargs.h records the configure command line (CFLAGS with the prefix map,
  # --with-gmp=...); keep the builder's paths out of it as the prefix map does
  # for sources.
  sed -i "s|$ROOT|/romdev|g" gcc/configargs.h
  if grep -q "$ROOT" gcc/configargs.h; then echo "FATAL: builder path left in configargs.h" >&2; exit 1; fi
  # gcc/'s own Makefile drops -O2 from CFLAGS/CXXFLAGS (the top-level make passes
  # them back in); building cc1 from gcc/ directly needs them named here.
  ( cd gcc && emmake make -j"$NCPU" CFLAGS="-O2 $MAP" CXXFLAGS="-O2 $MAP" \
      CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ cc1 )
fi

# ── 4. Build binutils as WASM (as, ld, objcopy, objdump) ────────────
if [ ! -f "$ROOT/build-wasm-binutils/gas/as-new" ]; then
  cd "$ROOT"; mkdir -p build-wasm-binutils; cd build-wasm-binutils
  if [ ! -f Makefile ]; then
    emconfigure "$SRC_DIR/binutils-$BINUTILS_VER/configure" \
      CFLAGS="-O2 $MAP" CXXFLAGS="-O2 $MAP" \
      --target=m68k-elf \
      --prefix=/romdev \
      --host=wasm32-unknown-emscripten \
      --build="$(gcc -dumpmachine)" \
      --disable-nls --disable-werror \
      --disable-multilib --with-cpu=m68000
  fi
  emmake make -j"$NCPU" CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ \
    configure-build-libiberty configure-libiberty
  for cfg in libiberty/config.h libiberty/pic/config.h libiberty/noasan/config.h; do
    if [ -f "$cfg" ] && ! grep -q "^#define HAVE_PSIGNAL 1" "$cfg"; then
      echo "#define HAVE_PSIGNAL 1" >> "$cfg"
    fi
  done
  emmake make -j"$NCPU" CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++
fi

# ── 5. Wrap + stage the artifacts ───────────────────────────────────
# Each tool is re-linked through emcc with our standard MODULARIZE /
# EXPORT_ES6 knobs into a callable factory (.mjs + .wasm), then staged into
# the romdev-toolchain-m68k-gcc package's wasm/ dir.
#
# objdump is the m68k DISASSEMBLER (`-D -b binary -m m68k`). It replaces the
# old hand-rolled JS m68kdasm - binutils decodes the full ISA with correct
# instruction lengths (the JS one dropped move-sr/mul/div and desynced).
PKG_OUT="$PROJECT_DIR/../romdev-toolchain-m68k-gcc/wasm"
mkdir -p "$PKG_OUT"

wrap_tool() {
  local dir="$1"         # build dir holding the make target
  local target="$2"      # make target (e.g. cc1, as-new, objdump)
  local out_name="$3"    # staged basename
  local export_name="$4" # createXxx - the JS factory name
  echo "  wrapping $target -> $out_name.{mjs,wasm}"
  ( cd "$dir" && rm -f "$target" "$target.wasm" && \
    emmake make "$target" \
      LDFLAGS="-O2 -g0 -s MODULARIZE=1 -s EXPORT_NAME=$export_name -s EXPORT_ES6=1 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=134217728 -s EXIT_RUNTIME=1 -s INVOKE_RUN=0 -s ENVIRONMENT=node -s EXPORTED_RUNTIME_METHODS=[\"callMain\",\"FS\"]" )
  # The glue embeds one literal "<target>.wasm" reference - rename it to the
  # staged basename so locateFile resolves next to the .mjs.
  sed "s/${target}\.wasm/${out_name}.wasm/g" "$dir/$target" > "$PKG_OUT/$out_name.mjs"
  cp "$dir/$target.wasm" "$PKG_OUT/$out_name.wasm"
  cp "$PKG_OUT/$out_name.mjs" "$PKG_OUT/$out_name.wasm" "$OUT/"
}

wrap_tool "$ROOT/build-wasm-gcc/gcc"         cc1     cc1-m68k          createCc1m68k
wrap_tool "$ROOT/build-wasm-binutils/gas"    as-new  m68k-elf-as       createM68kAs
wrap_tool "$ROOT/build-wasm-binutils/ld"     ld-new  m68k-elf-ld       createM68kLd
wrap_tool "$ROOT/build-wasm-binutils/binutils" objcopy m68k-elf-objcopy createM68kObjcopy
wrap_tool "$ROOT/build-wasm-binutils/binutils" objdump m68k-elf-objdump createM68kObjdump

echo "Stage 2 complete. m68k-elf cc1/as/ld/objcopy/objdump staged into $PKG_OUT/."
