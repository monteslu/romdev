#!/usr/bin/env bash
# Build the Rust command-line tools N64 decomp projects run in their builds to
# WASM (target wasm32-unknown-emscripten, NODERAWFS, run in romdev's worker):
#
#   slinky-cli  linker-script generator (decompals/slinky)
#   pigment64   PNG <-> N64 texture converter (decompals/pigment64)
#   crunch64    N64 compression formats: gzip/yay0/yaz0/mio0 (decompals/crunch64)
#   raw-deflate vanilla zlib raw deflate (scripts/src/raw-deflate.c), for ROM
#               compressors that call Python's zlib; Node's zlib is Chromium's
#               fork and writes different streams
#
# Projects download these as prebuilt host binaries (tools/Makefile); romdev
# runs the same released sources, built here from their crates.io packages at
# the versions those projects pin, each with its own Cargo.lock (--locked);
# crunch64's CLI is built from its workspace at the release commit.
#
# Ships in packages/romdev-toolchain-decomp-gcc/wasm/tools/<name>.{mjs,wasm}.
# Pins: versions.json toolchains.slinky_cli / pigment64 / crunch64_cli.
# Host deps (build time only): cargo + rustup target wasm32-unknown-emscripten,
# emcc (emsdk 4.0.18).
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd cargo
require_cmd emcc

ROOT="$BUILD_DIR/decomp-rust"
PKG_OUT="$PROJECT_DIR/../romdev-toolchain-decomp-gcc/wasm/tools"
mkdir -p "$ROOT" "$PKG_OUT"
rustup target list --installed 2>/dev/null | grep -qx wasm32-unknown-emscripten || rustup target add wasm32-unknown-emscripten

sync_glue() {
  local f="$1"
  sed -i 's/const{createRequire}=await import("module");var require=createRequire(import.meta.url)/var require=process.getBuiltinModule("module").createRequire(import.meta.url)/' "$f"
  if grep -q 'await import("module")' "$f" || ! grep -q 'process.getBuiltinModule("module")' "$f"; then
    echo "FATAL: $f: emscripten glue prologue changed; sync_glue did not apply" >&2
    exit 1
  fi
}

LINK="-sMODULARIZE=1 -sEXPORT_ES6=1 -sNODERAWFS=1 -sENVIRONMENT=node -sEXIT_RUNTIME=1 -sINVOKE_RUN=0 -sWASM_ASYNC_COMPILATION=0 -sALLOW_MEMORY_GROWTH=1 -sEXPORTED_RUNTIME_METHODS=callMain,FS,ENV -g0"

# A library that also builds as a cdylib/staticlib cannot link for this target
# (emcc links a cdylib as a standalone module with no main); the command-line
# binary only needs the rlib.
rlib_only() { node -e 'const fs = require("fs"); const f = process.argv[1]; fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/crate-type = \[[^\]]*\]/g, "crate-type = [\"rlib\"]"))' "$1"; }

build_crate() { # <pin key> <bin name> <export name> [<subdir with the bin>]
  local key="$1" bin="$2" exp="$3" sub="${4:-}" kind dir
  kind="$(pin_get "toolchains.$key" kind)"
  if [ "$kind" = git ]; then
    # A workspace (library + CLI) pinned by commit, built with its own lock.
    dir="$ROOT/$key"
    fetch_pinned "toolchains.$key" "$dir"
    git -C "$dir" checkout -q -- .
    local t; for t in "$dir"/Cargo.toml "$dir"/*/Cargo.toml; do rlib_only "$t"; done
  else
    local crate ver
    crate="$(pin_get "toolchains.$key" crate)"
    ver="$(pin_version "toolchains.$key")"
    dir="$ROOT/$crate-$ver"
    fetch_pinned_tarball "toolchains.$key" "$ROOT/$crate-$ver.crate"
    rm -rf "$dir"; tar -C "$ROOT" -xzf "$ROOT/$crate-$ver.crate"
    rlib_only "$dir/Cargo.toml"
  fi
  local args=() a
  for a in $LINK "-sEXPORT_NAME=$exp"; do args+=(-C "link-arg=$a"); done
  ( cd "$dir/$sub" && CARGO_TARGET_DIR="$ROOT/target" cargo rustc --release --locked \
      --target wasm32-unknown-emscripten --bin "$bin" -- "${args[@]}" )
  local out="$ROOT/target/wasm32-unknown-emscripten/release"
  cp "$out/$bin.js" "$PKG_OUT/$bin.mjs"
  cp "$out/${bin//-/_}.wasm" "$PKG_OUT/$bin.wasm" 2>/dev/null || cp "$out/$bin.wasm" "$PKG_OUT/$bin.wasm"
  sync_glue "$PKG_OUT/$bin.mjs"
  [ "$kind" = git ] && git -C "$dir" checkout -q -- . || rm -rf "$dir"
}

build_crate slinky_cli   slinky-cli createSlinky
build_crate pigment64    pigment64  createPigment64
build_crate crunch64_cli crunch64   createCrunch64 cli
rm -rf "$ROOT/target"

# emscripten's zlib port is vanilla zlib (emsdk 4.0.18: zlib 1.3.1).
emcc -O2 -sUSE_ZLIB=1 $LINK -sEXPORT_NAME=createRawDeflate \
  "$SCRIPT_DIR/src/raw-deflate.c" -o "$ROOT/raw-deflate.js"
cp "$ROOT/raw-deflate.js" "$PKG_OUT/raw-deflate.mjs"
cp "$ROOT/raw-deflate.wasm" "$PKG_OUT/raw-deflate.wasm"
sync_glue "$PKG_OUT/raw-deflate.mjs"
rm -f "$ROOT/raw-deflate.js" "$ROOT/raw-deflate.wasm"

echo "decomp Rust tools -> $PKG_OUT"
echo "Refresh the binary manifest: node scripts/binary-manifest.mjs --write"
