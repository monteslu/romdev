#!/usr/bin/env bash
# Build gcc for target mips-linux-gnu (the driver, cpp and cc1) to WASM.
#
# N64 decomp projects that are mostly built with an old compiler (KMC gcc
# 2.7.2, EGCS, IDO) still compile their data-only translation units, preprocess
# their .s files (`gcc -x assembler-with-cpp -E`) and their linker scripts
# (`mips-linux-gnu-cpp -P`) with a modern distro cross gcc,
# `mips-linux-gnu-gcc` (Debian/Ubuntu's gcc-mips-linux-gnu). This is that
# compiler, configured the way Debian configures it (gcc-14-cross-mipsen,
# 14.2.0-13cross1, trixie), with Debian's distro specs, so its built-in
# macros, default ABI and section choices are the target's own. Like Debian's
# cross cpp it pre-includes glibc's stdc-predef.h (TARGET_C_PREINCLUDE, skipped
# under -nostdinc, -ffreestanding or preprocessed input): the header is taken
# from Debian's libc6-dev-mips-cross and shipped at mips-linux-gnu/include/,
# which is where the driver's relocated tool include dir points when romdev
# runs it with GCC_EXEC_PREFIX=<this dir>/lib/gcc/ (toolchain.js).
#
# The driver runs cc1 and the assembler as sibling modules in romdev's WASM
# worker: libiberty's pex-unix exec/wait go through a JS spawn hook
# (patches/gcc-14-driver-wasm-spawn.patch). `as` resolves to
# mips-linux-gnu-as from romdev-toolchain-mips-gcc.
#
# Ships in packages/romdev-toolchain-decomp-gcc/wasm/mips-linux-gnu-14.2/:
#   gcc (the driver, xgcc), cpp (the cpp driver), cc1,
#   mips-linux-gnu/include/stdc-predef.h
# Pins: versions.json heavy_toolchains.gcc_mips_linux (+ its distro_patch),
# heavy_toolchains.libc6_dev_mips_cross. GMP/MPFR/MPC/ISL are
# built to WASM first, at the versions build-mips-wasm-tools.sh uses.
# Host deps (build time only): emcc, make, gcc (the build-machine generators),
# ar and tar (unpacking the .deb).
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd make
require_cmd gcc

KEY=heavy_toolchains.gcc_mips_linux
VER="$(pin_version $KEY)"
ROOT="$BUILD_DIR/mips-linux-gcc"
SRC="$ROOT/gcc-$VER"
BLD="$ROOT/build-wasm"
DEPS="$ROOT/wasm-deps"
PKG_OUT="$PROJECT_DIR/../romdev-toolchain-decomp-gcc/wasm/mips-linux-gnu-$(echo "$VER" | cut -d. -f1,2)"
NCPU="$(nproc)"
mkdir -p "$ROOT" "$PKG_OUT"

GMP_VER=6.3.0; MPFR_VER=4.2.1; MPC_VER=1.3.1; ISL_VER=0.24
dep() { # <name> <version> <url> <configure args...>
  local name="$1" ver="$2" url="$3"; shift 3
  [ -f "$DEPS/lib/lib$name.a" ] && return 0
  local f="$ROOT/${url##*/}"
  [ -f "$f" ] || curl -sL "$url" -o "$f"
  [ -d "$ROOT/$name-$ver" ] || tar -C "$ROOT" -xf "$f"
  rm -rf "$ROOT/build-wasm-$name"; mkdir -p "$ROOT/build-wasm-$name"
  # -ffile-prefix-map: keep the builder's path out of __FILE__ (assertions).
  ( cd "$ROOT/build-wasm-$name" && emconfigure "$ROOT/$name-$ver/configure" --prefix="$DEPS" \
      CPPFLAGS="-ffile-prefix-map=$ROOT=/build" \
      --disable-shared --enable-static --host=none-none-none "$@" && emmake make -j"$NCPU" && emmake make install )
  rm -rf "$ROOT/build-wasm-$name"
}
dep gmp  $GMP_VER  "https://ftp.gnu.org/gnu/gmp/gmp-$GMP_VER.tar.xz"
dep mpfr $MPFR_VER "https://ftp.gnu.org/gnu/mpfr/mpfr-$MPFR_VER.tar.xz" --with-gmp="$DEPS"
dep mpc  $MPC_VER  "https://gcc.gnu.org/pub/gcc/infrastructure/mpc-$MPC_VER.tar.gz" --with-gmp="$DEPS" --with-mpfr="$DEPS"
dep isl  $ISL_VER  "https://gcc.gnu.org/pub/gcc/infrastructure/isl-$ISL_VER.tar.bz2" --with-gmp-prefix="$DEPS"

fetch_pinned_tarball $KEY "$ROOT/gcc-$VER.tar.xz"
[ -d "$SRC" ] || tar -C "$ROOT" -xf "$ROOT/gcc-$VER.tar.xz"

# The tarball tree sits inside romdev's own checkout (build/ is ignored), where
# git apply would resolve paths against romdev's top level and skip every
# file; --git-dir=/dev/null makes it treat the tree as plain files.
PATCH="$PROJECT_DIR/$(pin_get $KEY patch)"
if (cd "$SRC" && git --git-dir=/dev/null apply --reverse --check "$PATCH" 2>/dev/null); then echo "gcc: romdev patch already applied"
else (cd "$SRC" && git --git-dir=/dev/null apply "$PATCH"); fi
grep -q "romdev: WASM host" "$SRC/libiberty/pex-unix.c" || { echo "FATAL: romdev patch not applied to $SRC" >&2; exit 1; }
# Debian's distro specs (gcc-distro-specs.diff and the distro-defaults.h its
# build generates for this target: -D_TIME_BITS=64 -D_FILE_OFFSET_BITS=64).
DPATCH="$PROJECT_DIR/$(pin_get $KEY distro_patch)"
if (cd "$SRC" && git --git-dir=/dev/null apply --reverse --check "$DPATCH" 2>/dev/null); then echo "gcc: distro specs already applied"
else (cd "$SRC" && git --git-dir=/dev/null apply "$DPATCH"); fi
grep -q "distro_defaults_cpp" "$SRC/gcc/gcc.cc" || { echo "FATAL: distro specs patch not applied to $SRC" >&2; exit 1; }
# emscripten's libc declares psignal; libiberty would redefine it.
if ! grep -q "romdev: emscripten libc provides psignal" "$SRC/libiberty/strsignal.c"; then
  sed -i 's/#ifndef HAVE_PSIGNAL/#if 0 \/* romdev: emscripten libc provides psignal *\//' "$SRC/libiberty/strsignal.c"
fi

# gcc's configure probes the target assembler and linker for the features
# that decide what cc1 emits (explicit relocs, .module, .gnu_attribute, ...).
# It finds them as mips-linux-gnu-{as,ld,objdump} on PATH: shims running
# romdev's own WASM binutils (build-mips-linux-binutils-wasm.sh).
BINUTILS_WASM="$PROJECT_DIR/../romdev-toolchain-mips-gcc/wasm"
SHIMS="$ROOT/target-shims"
mkdir -p "$SHIMS"
for t in as ld objdump; do
  [ -f "$BINUTILS_WASM/mips-linux-gnu-$t.wasm" ] || { echo "Error: $BINUTILS_WASM/mips-linux-gnu-$t.wasm missing; run build-mips-linux-binutils-wasm.sh first." >&2; exit 1; }
  printf '#!/bin/sh\nexec node "%s" "%s" "$@"\n' "$SCRIPT_DIR/wasm-tool-shim.mjs" "$BINUTILS_WASM/mips-linux-gnu-$t.mjs" > "$SHIMS/mips-linux-gnu-$t"
  chmod +x "$SHIMS/mips-linux-gnu-$t"
done
export PATH="$SHIMS:$PATH"

if [ ! -f "$BLD/gcc/cc1" ] || [ ! -f "$BLD/gcc/xgcc" ] || [ ! -f "$BLD/gcc/cpp" ]; then
  mkdir -p "$BLD"; cd "$BLD"
  # The target options are Debian's gcc-mips-linux-gnu configuration
  # (debian/rules2: default -march/-mfp, no indexed FP loads, default PIE;
  # --with-madd4=no is Debian's for mipsel, not mips); they set the defaults a
  # project's flags do not override. -ffile-prefix-map keeps
  # the builder's path out of the binaries (never scrub it afterwards: see
  # never-byte-edit-prebuilt-binaries).
  # The generators (genmodes, genhooks, ...) run on the build machine.
  [ -f Makefile ] || emconfigure "$SRC/configure" \
    CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ \
    CFLAGS="-O2 -ffile-prefix-map=$SRC=/src" \
    CXXFLAGS="-O2 -ffile-prefix-map=$SRC=/src" \
    --target=mips-linux-gnu --prefix=/usr --program-prefix=mips-linux-gnu- \
    --host=wasm32-unknown-emscripten --build="$(gcc -dumpmachine)" \
    --enable-languages=c --disable-nls --disable-multilib --disable-shared \
    --disable-threads --disable-bootstrap --disable-plugin --disable-lto \
    --disable-libssp --disable-libgomp --disable-libquadmath --disable-libatomic \
    --without-headers --with-system-zlib --without-zstd \
    --enable-default-pie --enable-gnu-unique-object --enable-linker-build-id \
    --with-arch-32=mips32r2 --with-fp-32=xx --with-lxc1-sxc1=no \
    --with-gmp="$DEPS" --with-mpfr="$DEPS" --with-mpc="$DEPS" --with-isl="$DEPS" \
    AS_FOR_TARGET=mips-linux-gnu-as LD_FOR_TARGET=mips-linux-gnu-ld OBJDUMP_FOR_TARGET=mips-linux-gnu-objdump
  emmake make -j"$NCPU" configure-gcc
  # configargs.h records the configure command line (printed by -v): keep the
  # builder's paths out of it as -ffile-prefix-map does for sources.
  sed -i "s|$ROOT|/build|g" gcc/configargs.h
  if grep -q "$ROOT" gcc/configargs.h; then echo "FATAL: builder path left in configargs.h" >&2; exit 1; fi
  emmake make -j"$NCPU" all-build-libiberty all-build-libcpp \
    all-libiberty all-libcpp all-libdecnumber all-libbacktrace all-libcody
  # The top-level make passes CC_FOR_BUILD down; building in gcc/ directly
  # must name it too, or the generators are compiled as WASM.
  ( cd gcc && emmake make -j"$NCPU" cc1 xgcc cpp CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++ )
fi

KNOBS="-O2 -g0 -s MODULARIZE=1 -s EXPORT_ES6=1 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=134217728 -s MAXIMUM_MEMORY=4GB -s STACK_SIZE=8388608 -s EXIT_RUNTIME=1 -s INVOKE_RUN=0 -s ENVIRONMENT=node -s NODERAWFS=1 -s WASM_ASYNC_COMPILATION=0 -s EXPORTED_RUNTIME_METHODS=callMain,FS,ENV"

# Emscripten's node ESM glue starts with `await import("module")`, which makes
# the factory return before the instance exists; romdev instantiates the passes
# synchronously from inside the running driver.
sync_glue() {
  local f="$1"
  sed -i 's/const{createRequire}=await import("module");var require=createRequire(import.meta.url)/var require=process.getBuiltinModule("module").createRequire(import.meta.url)/' "$f"
  if grep -q 'await import("module")' "$f" || ! grep -q 'process.getBuiltinModule("module")' "$f"; then
    echo "FATAL: $f: emscripten glue prologue changed; sync_glue did not apply" >&2
    exit 1
  fi
}

relink() { # <make-target> <out-name> <export-name>
  local tgt="$1" out="$2" exp="$3"
  echo "  re-linking + staging $out"
  ( cd "$BLD/gcc" && rm -f "$tgt" "$tgt.wasm" && \
    emmake make "$tgt" LDFLAGS="$KNOBS -s EXPORT_NAME=$exp" )
  cp "$BLD/gcc/$tgt"      "$PKG_OUT/$out.mjs"
  cp "$BLD/gcc/$tgt.wasm" "$PKG_OUT/$out.wasm"
  sync_glue "$PKG_OUT/$out.mjs"
}
relink cc1  cc1 createMipsLinuxCc1
relink xgcc gcc createMipsLinuxGcc
relink cpp  cpp createMipsLinuxCpp

# glibc's stdc-predef.h exactly as Debian ships it for the target.
DEB_KEY=heavy_toolchains.libc6_dev_mips_cross
DEB="$ROOT/$(basename "$(pin_url $DEB_KEY)")"
fetch_pinned_tarball $DEB_KEY "$DEB"
rm -rf "$ROOT/deb-x" && mkdir -p "$ROOT/deb-x"
( cd "$ROOT/deb-x" && ar x "$DEB" && tar -xf data.tar.* ./usr/mips-linux-gnu/include/stdc-predef.h )
mkdir -p "$PKG_OUT/mips-linux-gnu/include"
cp "$ROOT/deb-x/usr/mips-linux-gnu/include/stdc-predef.h" "$PKG_OUT/mips-linux-gnu/include/stdc-predef.h"
rm -rf "$ROOT/deb-x"

# The configure-time feature results cc1 was built with, for the record.
grep -E '^#define HAVE_AS_|^#define HAVE_GAS_' "$BLD/gcc/auto-host.h" > "$ROOT/as-features.txt" || true
echo "mips-linux-gnu gcc $VER (driver, cpp, cc1, stdc-predef.h) -> $PKG_OUT"
echo "Refresh the binary manifest: node scripts/binary-manifest.mjs --write"
