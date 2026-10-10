#!/usr/bin/env bash
# Build armips (Kingcom) to WASM for the decomp domain: N64 decomp projects
# assemble their RSP microcode from source with it. Ships as
# packages/romdev-toolchain-mips-gcc/wasm/armips.{mjs,wasm} beside the mips-linux-gnu
# binutils; romdev runs it in its WASM worker over the project's real tree
# (NODERAWFS), so `.create`/`.incbin` paths resolve exactly as natively.
#
# Pin: versions.json toolchains.armips. std::filesystem is used
# (ARMIPS_USE_STD_FILESYSTEM), so the ext/filesystem submodule is not needed.
# Host deps (build time only): emcc (emsdk 4.0.18), cmake.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd emcmake
require_cmd cmake

SRC="$BUILD_DIR/armips/src"
BLD="$BUILD_DIR/armips/build-wasm"
PKG_OUT="$PROJECT_DIR/../romdev-toolchain-mips-gcc/wasm"
NCPU="$(nproc)"

fetch_pinned toolchains.armips "$SRC"
cd "$SRC"
require_git_toplevel
PATCH="$(pin_get toolchains.armips patch)"
if [ -n "$PATCH" ]; then
  if patch_already_applied "$PROJECT_DIR/$PATCH"; then
    echo "armips: romdev patch already applied"
  else
    git checkout -- .
    git apply "$PROJECT_DIR/$PATCH"
  fi
fi

LINK="-O2 -g0 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node -sNODERAWFS=1 -sWASM_ASYNC_COMPILATION=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=8388608 -sEXIT_RUNTIME=1 -sINVOKE_RUN=0 -sEXPORTED_RUNTIME_METHODS=callMain,FS,ENV -sEXPORT_NAME=createArmips"
emcmake cmake -S "$SRC" -B "$BLD" -DCMAKE_BUILD_TYPE=Release -DARMIPS_USE_STD_FILESYSTEM=ON \
  -DCMAKE_CXX_FLAGS="-O2 -ffile-prefix-map=$SRC=/src" \
  -DCMAKE_EXE_LINKER_FLAGS="$LINK"
cmake --build "$BLD" -j"$NCPU" --target armips-bin

mkdir -p "$PKG_OUT"
cp "$BLD/armips.js" "$PKG_OUT/armips.mjs"
cp "$BLD/armips.wasm" "$PKG_OUT/armips.wasm"
# Synchronous instantiation (see build-ido.sh sync_glue): no top-level await.
sed -i 's/const{createRequire}=await import("module");var require=createRequire(import.meta.url)/var require=process.getBuiltinModule("module").createRequire(import.meta.url)/' "$PKG_OUT/armips.mjs"
if grep -q 'await import("module")' "$PKG_OUT/armips.mjs"; then
  echo "FATAL: armips glue prologue changed; the synchronous-glue rewrite did not apply" >&2
  exit 1
fi
rm -rf "$BLD"
echo "armips -> $PKG_OUT/armips.{mjs,wasm}"
echo "Refresh the binary manifest: node scripts/binary-manifest.mjs --write"
