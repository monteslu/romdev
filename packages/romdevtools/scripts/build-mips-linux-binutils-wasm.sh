#!/usr/bin/env bash
# Build binutils for target mips-linux-gnu (as, ld, objcopy, objdump) to WASM.
#
# N64 matching-decompilation projects assemble, link and objcopy with
# mips-linux-gnu binutils. Their objects are bit-for-bit targets, and the
# mips-elf tools romdev already ships use the IRIX-compatible ELF vector
# (section-symbol names in .strtab, a different symbol order, IRIX .reginfo
# entsize), so an object they write differs from the project's own build even
# when the code is identical. These are the traditional-MIPS vectors.
#
# Unlike the MEMFS-marshalled mips-elf tools, these are linked with NODERAWFS:
# the decomp domain drives them over a project's real tree (hundreds of
# objects into one link), from inside romdev's WASM worker.
#
# Ships in packages/romdev-toolchain-mips-gcc/wasm/mips-linux-gnu-*.{mjs,wasm}.
# Host deps (build time only): emcc, make, gcc (for the --build triple only).
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd make

KEY=heavy_toolchains.binutils_mips_linux
VER="$(pin_version $KEY)"
ROOT="$BUILD_DIR/mips-linux-binutils"
SRC="$ROOT/binutils-$VER"
BLD="$ROOT/build-wasm"
PKG_OUT="$PROJECT_DIR/../romdev-toolchain-mips-gcc/wasm"
NCPU="${JOBS:-$(nproc)}"
mkdir -p "$ROOT" "$PKG_OUT"

fetch_pinned_tarball $KEY "$ROOT/binutils-$VER.tar.xz"
[ -d "$SRC" ] || tar -C "$ROOT" -xf "$ROOT/binutils-$VER.tar.xz"

# emscripten's libc declares psignal; libiberty would redefine it.
if ! grep -q "romdev: emscripten libc provides psignal" "$SRC/libiberty/strsignal.c"; then
  sed -i 's/#ifndef HAVE_PSIGNAL/#if 0 \/* romdev: emscripten libc provides psignal *\//' "$SRC/libiberty/strsignal.c"
fi

if [ ! -f "$BLD/gas/as-new" ] || [ ! -f "$BLD/ld/ld-new" ] || [ ! -f "$BLD/binutils/objcopy" ]; then
  mkdir -p "$BLD"; cd "$BLD"
  # -ffile-prefix-map keeps the builder's path out of the binaries (never
  # scrub it afterwards: see never-byte-edit-prebuilt-binaries). The prefix is
  # baked in too (ld's default SEARCH_DIRs, the bfd plugin dir) and is never
  # installed to, so it is a fixed /romdev rather than a dir on this machine.
  [ -f Makefile ] || emconfigure "$SRC/configure" \
    CFLAGS="-O2 -ffile-prefix-map=$SRC=/src" \
    CXXFLAGS="-O2 -ffile-prefix-map=$SRC=/src" \
    --target=mips-linux-gnu --prefix=/romdev \
    --host=wasm32-unknown-emscripten --build="$(gcc -dumpmachine)" \
    --disable-nls --disable-werror --disable-multilib --disable-gdb \
    --disable-gprofng --disable-sim --disable-plugins --without-zstd
  emmake make -j"$NCPU" all-libiberty all-bfd all-opcodes all-libsframe all-libctf
  emmake make -j"$NCPU" all-gas all-ld all-binutils
fi

KNOBS="-O2 -g0 -s MODULARIZE=1 -s EXPORT_ES6=1 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=134217728 -s MAXIMUM_MEMORY=4GB -s EXIT_RUNTIME=1 -s INVOKE_RUN=0 -s ENVIRONMENT=node -s NODERAWFS=1 -s WASM_ASYNC_COMPILATION=0 -s EXPORTED_RUNTIME_METHODS=callMain,FS,ENV"

# Emscripten's node ESM glue starts with `await import("module")`, which makes
# the factory return before the instance exists. romdev instantiates the passes
# synchronously from inside a running module (cc exec'ing cfe), so take
# createRequire from process.getBuiltinModule instead: same module, no await.
sync_glue() {
  local f="$1"
  sed -i 's/const{createRequire}=await import("module");var require=createRequire(import.meta.url)/var require=process.getBuiltinModule("module").createRequire(import.meta.url)/' "$f"
  if grep -q 'await import("module")' "$f" || ! grep -q 'process.getBuiltinModule("module")' "$f"; then
    echo "FATAL: $f: emscripten glue prologue changed; sync_glue did not apply" >&2
    exit 1
  fi
}

relink() { # <build-subdir> <make-target> <out-name> <export-name>
  local sub="$1" tgt="$2" out="$3" exp="$4"
  echo "  re-linking + staging $out"
  ( cd "$sub" && rm -f "$tgt" "$tgt.wasm" && \
    emmake make "$tgt" LDFLAGS="$KNOBS -s EXPORT_NAME=$exp" )
  cp "$sub/$tgt"      "$PKG_OUT/$out.mjs"
  cp "$sub/$tgt.wasm" "$PKG_OUT/$out.wasm"
  sync_glue "$PKG_OUT/$out.mjs"
}
relink "$BLD/gas"      as-new  mips-linux-gnu-as      createMipsLinuxAs
relink "$BLD/ld"       ld-new  mips-linux-gnu-ld      createMipsLinuxLd
relink "$BLD/binutils" objcopy mips-linux-gnu-objcopy createMipsLinuxObjcopy
relink "$BLD/binutils" objdump mips-linux-gnu-objdump createMipsLinuxObjdump

# The ld emulation scripts are compiled into ld-new (no runtime ldscripts dir
# is needed for -T builds). Drop the ~1GB build tree; keep the tarball.
rm -rf "$BLD" "$SRC"
echo "mips-linux-gnu binutils $VER -> $PKG_OUT"
echo "Refresh the binary manifest: node scripts/binary-manifest.mjs --write"
