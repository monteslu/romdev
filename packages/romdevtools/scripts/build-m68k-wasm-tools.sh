#!/usr/bin/env bash
# STAGE 2 of the Genesis C tier-1 pipeline: compile the m68k-elf gcc
# toolchain components (cc1, m68k-elf-as, m68k-elf-ld, m68k-elf-objcopy)
# to WASM via emcc.
#
# Prereq: stage 1 (build-m68k-toolchain.sh) must have completed — this
# script reuses the same upstream gcc/binutils source trees plus the
# native build artifacts (xgcc, target libs) that gcc's build system
# needs to bootstrap.
#
# What this stage produces:
#   src/toolchains/m68k-elf-gcc/wasm/cc1.{js,wasm}
#   src/toolchains/m68k-elf-gcc/wasm/m68k-elf-as.{js,wasm}
#   src/toolchains/m68k-elf-gcc/wasm/m68k-elf-ld.{js,wasm}
#   src/toolchains/m68k-elf-gcc/wasm/m68k-elf-objcopy.{js,wasm}
#
# Total WASM tool size: ~30-50 MB compressed (cc1 dominates at ~25 MB).
#
# Build flow:
#   1. Build WASM versions of gcc's prereq libs (GMP, MPFR, MPC, ISL) via emconfigure.
#   2. Configure gcc with --host=wasm32-unknown-emscripten + our WASM prereqs.
#   3. emmake make all-gcc — produces cc1 as WASM.
#   4. Configure binutils with --host=wasm32-unknown-emscripten.
#   5. emmake make — produces as.wasm, ld.wasm, objcopy.wasm.
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
NATIVE_PREFIX="$ROOT/install"
OUT="$PROJECT_DIR/src/toolchains/m68k-elf-gcc/wasm"
NCPU="$(nproc)"

if [ ! -x "$NATIVE_PREFIX/bin/m68k-elf-gcc" ]; then
  echo "Stage 1 not done — run build-m68k-toolchain.sh first." >&2
  exit 1
fi

# Pinned dep versions matching what gcc-14.2.0's download_prerequisites uses.
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
    wget -q "$tarball"
  fi
done
[ ! -d "gmp-$GMP_VER" ]   && tar xf "gmp-$GMP_VER.tar.xz"
[ ! -d "mpfr-$MPFR_VER" ] && tar xf "mpfr-$MPFR_VER.tar.xz"
[ ! -d "mpc-$MPC_VER" ]   && tar xf "mpc-$MPC_VER.tar.gz"
[ ! -d "isl-$ISL_VER" ]   && tar xf "isl-$ISL_VER.tar.bz2"

# ── 2. Build each prereq to WASM ────────────────────────────────────
# GMP — base arbitrary-precision integer math. No deps.
if [ ! -f "$WASM_PREFIX/lib/libgmp.a" ]; then
  cd "$ROOT"; mkdir -p build-wasm-gmp; cd build-wasm-gmp
  emconfigure "../src/gmp-$GMP_VER/configure" \
    --prefix="$WASM_PREFIX" \
    --disable-shared --enable-static \
    --disable-assembly \
    --host=none-none-none
  emmake make -j"$NCPU"
  emmake make install
fi

# MPFR — depends on GMP.
if [ ! -f "$WASM_PREFIX/lib/libmpfr.a" ]; then
  cd "$ROOT"; mkdir -p build-wasm-mpfr; cd build-wasm-mpfr
  emconfigure "../src/mpfr-$MPFR_VER/configure" \
    --prefix="$WASM_PREFIX" \
    --with-gmp="$WASM_PREFIX" \
    --disable-shared --enable-static \
    --host=none-none-none
  emmake make -j"$NCPU"
  emmake make install
fi

# MPC — depends on GMP + MPFR.
if [ ! -f "$WASM_PREFIX/lib/libmpc.a" ]; then
  cd "$ROOT"; mkdir -p build-wasm-mpc; cd build-wasm-mpc
  emconfigure "../src/mpc-$MPC_VER/configure" \
    --prefix="$WASM_PREFIX" \
    --with-gmp="$WASM_PREFIX" --with-mpfr="$WASM_PREFIX" \
    --disable-shared --enable-static \
    --host=none-none-none
  emmake make -j"$NCPU"
  emmake make install
fi

# ISL — depends on GMP. Used by gcc's loop optimizer.
if [ ! -f "$WASM_PREFIX/lib/libisl.a" ]; then
  cd "$ROOT"; mkdir -p build-wasm-isl; cd build-wasm-isl
  emconfigure "../src/isl-$ISL_VER/configure" \
    --prefix="$WASM_PREFIX" \
    --with-gmp-prefix="$WASM_PREFIX" \
    --disable-shared --enable-static \
    --host=none-none-none
  emmake make -j"$NCPU"
  emmake make install
fi

# ── 3. Build cc1 as WASM ────────────────────────────────────────────
# Reuse stage 1's gcc-14.2.0 source tree. Configure with WASM host so
# the resulting cc1 runs as a WASM module instead of a native binary.
# The TARGET stays m68k-elf — the WASM binary still produces m68k code.
if [ ! -f "$ROOT/build-wasm-gcc/gcc/cc1.wasm" ]; then
  cd "$ROOT"; mkdir -p build-wasm-gcc; cd build-wasm-gcc
  if [ ! -f Makefile ]; then
    emconfigure "$SRC_DIR/gcc-14.2.0/configure" \
      --target=m68k-elf \
      --prefix="$WASM_PREFIX/gcc-wasm" \
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
  emmake make -j"$NCPU" all-gcc
fi

# ── 4. Build binutils as WASM (as, ld, objcopy) ─────────────────────
if [ ! -f "$ROOT/build-wasm-binutils/gas/as-new.wasm" ]; then
  cd "$ROOT"; mkdir -p build-wasm-binutils; cd build-wasm-binutils
  if [ ! -f Makefile ]; then
    emconfigure "$SRC_DIR/binutils-2.42/configure" \
      --target=m68k-elf \
      --prefix="$WASM_PREFIX/binutils-wasm" \
      --host=wasm32-unknown-emscripten \
      --build="$(gcc -dumpmachine)" \
      --disable-nls --disable-werror \
      --disable-multilib --with-cpu=m68000
  fi
  emmake make -j"$NCPU"
fi

# ── 5. Wrap + stage the artifacts ───────────────────────────────────
# Each binutils program is re-linked through emcc with our standard
# MODULARIZE / EXPORT_ES6 knobs into a callable factory (.mjs + .wasm),
# then staged into the romdev-toolchain-m68k-gcc package's wasm/ dir.
#
# objdump is the m68k DISASSEMBLER (`-D -b binary -m m68k`). It replaces the
# old hand-rolled JS m68kdasm — binutils decodes the full ISA with correct
# instruction lengths (the JS one dropped move-sr/mul/div and desynced).
BINUTILS_WASM="$ROOT/build-wasm-binutils/binutils"
PKG_OUT="$PROJECT_DIR/../romdev-toolchain-m68k-gcc/wasm"

wrap_tool() {
  local target="$1"      # make target inside binutils/ (e.g. objdump, objcopy)
  local out_name="$2"    # m68k-elf-<tool>
  local export_name="$3" # createM68k<Tool>
  echo "  wrapping $target → $out_name.{mjs,wasm}"
  ( cd "$BINUTILS_WASM" && rm -f "$target" "$target.wasm" && \
    emmake make "$target" \
      LDFLAGS="-O2 -g0 -s MODULARIZE=1 -s EXPORT_NAME=$export_name -s EXPORT_ES6=1 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=134217728 -s EXIT_RUNTIME=1 -s INVOKE_RUN=0 -s ENVIRONMENT=node -s EXPORTED_RUNTIME_METHODS=[\"callMain\",\"FS\"]" )
  # The glue embeds one literal "<target>.wasm" reference — rename it to the
  # staged basename so locateFile resolves next to the .mjs.
  sed "s/${target}\.wasm/${out_name}.wasm/g" "$BINUTILS_WASM/$target" > "$PKG_OUT/$out_name.mjs"
  cp "$BINUTILS_WASM/$target.wasm" "$PKG_OUT/$out_name.wasm"
}

wrap_tool objdump m68k-elf-objdump createM68kObjdump
# (as/ld/objcopy/cc1 were staged by the original ad-hoc wrap; re-add here if
#  regenerating the whole package.)

echo "Stage 2 complete. m68k-elf-objdump staged into $PKG_OUT/."
