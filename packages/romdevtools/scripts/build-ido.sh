#!/usr/bin/env bash
# Build IRIX IDO 5.3 + 7.1 (the N64 matching-decompilation C compilers) to WASM.
#
# ido-static-recomp statically recompiles each IRIX MIPS executable (cc, cfe,
# uopt, ugen, as1, ...) into one portable C file. Those C files are compiled
# here with emcc, one module per IRIX program, and ship in
# packages/romdev-toolchain-ido/wasm/<version>/. romdev runs `cc` in its WASM
# worker; cc's passes run as sibling modules through a JS spawn hook.
#
# Flow:
#   1. fetch the pinned ido-static-recomp (versions.json toolchains.ido_static_recomp)
#   2. apply scripts/patches/ido-static-recomp-wasm.patch (WASM memory model,
#      vfork-style fork emulation, spawn hook)
#   3. build rabbitizer + the recomp generator NATIVELY (a build-time code
#      generator only; nothing native ships)
#   4. recompile each IRIX program to C, rewrite its fork sites to ROMDEV_FORK
#   5. emcc every program + libc_impl.c into an ES-module glue + .wasm
#
# Byte identity: the objects these modules emit are compared against the native
# ido-static-recomp build by the decomp domain's verification (every TU of a
# real project, byte for byte); see src/decomp/ido.js.
#
# Host deps (build time only): g++, make, emcc (emsdk 4.0.18).
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd g++
require_cmd make

SRC="$BUILD_DIR/ido-static-recomp/src"
PATCH="$SCRIPT_DIR/patches/ido-static-recomp-wasm.patch"
PKG_OUT="$PROJECT_DIR/../romdev-toolchain-ido/wasm"
NCPU="$(nproc)"

# The IRIX programs `cc -c` can reach for C: the driver, the C front end,
# the preprocessors, the optimizer/code generator/assembler chain, and the
# ucode link/split/merge passes used by -O3 and -j. copt/upas/ld/strip and the
# C++ tools are not part of a C compile and are not built.
TOOLS_53="cc acpp cfe uopt ugen as0 as1 ujoin uld umerge usplit"
TOOLS_71="cc acpp cfe uopt ugen as0 as1 ujoin uld umerge usplit"

fetch_pinned toolchains.ido_static_recomp "$SRC"
cd "$SRC"
require_git_toplevel
if patch_already_applied "$PATCH"; then
  echo "ido-static-recomp: romdev patch already applied"
else
  git checkout -- .
  git apply "$PATCH"
fi

# -- native code generator (build time only) ---------------------------
if [ ! -x build/recomp.elf ]; then
  make -j"$NCPU" setup RELEASE=1
fi

EMFLAGS=(
  -O2
  -std=c11
  -fno-strict-aliasing
  -Wno-everything
  -I.
  -s MODULARIZE=1
  -s EXPORT_ES6=1
  -s ENVIRONMENT=node
  -s NODERAWFS=1
  -s WASM_ASYNC_COMPILATION=0
  -s ALLOW_MEMORY_GROWTH=1
  -s MAXIMUM_MEMORY=4GB
  -s INITIAL_MEMORY=33554432
  -s STACK_SIZE=8388608
  -s EXIT_RUNTIME=1
  -s INVOKE_RUN=0
  -s "EXPORTED_RUNTIME_METHODS=[\"callMain\",\"FS\",\"ENV\"]"
  -g0
)

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

build_version() {
  local ver="$1" define="$2" tools="$3"
  local gen="build/$ver" out="$PKG_OUT/$ver"
  mkdir -p "$gen/wasm" "$out"
  for t in $tools; do
    # Generate the recompiled C (the upstream Makefile knows each program's
    # IRIX path and per-program recomp flags, e.g. 5.3 ugen --conservative).
    make -j1 VERSION="$ver" RELEASE=1 "$gen/$t.c" >/dev/null
    # vfork emulation: every fork site becomes ROMDEV_FORK (header.h).
    sed 's/^v0 = wrapper_fork(mem);$/ROMDEV_FORK(v0);/' "$gen/$t.c" > "$gen/wasm/$t.c"
    if grep -q 'wrapper_fork(' "$gen/wasm/$t.c"; then
      echo "FATAL: $ver/$t.c has a fork site the ROMDEV_FORK rewrite did not match" >&2
      exit 1
    fi
  done
  local pids=()
  for t in $tools; do
    (
      emcc "${EMFLAGS[@]}" -D"$define" \
        -DPACKAGE_VERSION="\"$(pin_commit toolchains.ido_static_recomp | cut -c1-12)-romdev\"" \
        -DDATETIME="\"reproducible\"" \
        -s EXPORT_NAME="ido_${t}" \
        "$gen/wasm/$t.c" libc_impl.c version_info.c \
        -o "$out/$t.mjs"
    ) &
    pids+=($!)
    # Bound concurrency: uopt/cfe/as1 are 4-5MB of C each.
    if [ "${#pids[@]}" -ge 4 ]; then wait "${pids[0]}"; pids=("${pids[@]:1}"); fi
  done
  for p in "${pids[@]}"; do wait "$p"; done
  for t in $tools; do sync_glue "$out/$t.mjs"; done
  cp "ido/$ver/usr/lib/err.english.cc" "$out/err.english.cc"
  for t in $tools; do
    [ -s "$out/$t.wasm" ] || { echo "FATAL: $out/$t.wasm missing" >&2; exit 1; }
  done
  echo "IDO $ver: $(ls "$out"/*.wasm | wc -l) modules -> $out"
}

build_version 5.3 IDO53 "$TOOLS_53"
build_version 7.1 IDO71 "$TOOLS_71"

# Drop the generated C and objects (hundreds of MB); the checkout stays for re-runs.
rm -rf build/5.3 build/7.1
echo "done. Refresh the binary manifest: node scripts/binary-manifest.mjs --write"
