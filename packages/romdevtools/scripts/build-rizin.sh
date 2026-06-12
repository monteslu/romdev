#!/usr/bin/env bash
# Build Rizin (RE analysis engine: CFG / xrefs / function detection) → WASM,
# Node target. Single-threaded, static arch plugins, MODULARIZE glue driven
# one-shot via callMain ("rizin -q -c '<cmds>' rom") by the worker pool.
#
# Recipe derived from rzwasi (https://github.com/IndAlok/rzwasi, LGPL-3.0) —
# thread stubs, libzip/sys/cons emscripten fixes — adapted for Node/ESM and
# frozen into two committed patches (see scripts/patches/README.md):
#   rizin-romdev-emscripten.patch  — rizin tree (threads, cons, sys, meson.build)
#   rizin-libzip-emscripten.patch  — libzip meson subproject (applied post-download)
#
# Known-good output (rizin v0.8.2, emcc 4.0.18): rizin.wasm ~30MB. Verified:
# iNES autodetect, full analysis (aaa → 210 fns on a real NES ROM), axtj, agf
# json, arch plugins 6502/z80/gb/arm/m68k/snes(65816)/spc700. NOTE: plugin-LISTING
# commands (`La`, `e asm.arch=??`) trap on a fn-pointer signature mismatch —
# do not use them from the JS wrapper; everything on the analysis path works.
#
# Output: staged at src/analysis/wasm/rizin.{js,wasm}, shipped via
# packages/romdev-analysis/wasm/.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git
require_cmd python3
require_cmd ninja

DIR="$BUILD_DIR/rizin"
WASM_BUILD="$DIR/build-wasm"
RIZIN_PATCH="$PROJECT_DIR/$(pin_get analysis.rizin patch)"
LIBZIP_PATCH="$PROJECT_DIR/$(pin_get analysis.rizin libzipPatch)"
STAGE="$PROJECT_DIR/src/analysis/wasm"
OUT="$PROJECT_DIR/../romdev-analysis/wasm"

# meson: use a system meson if present, else run the pinned standalone tarball
# (meson is pure python — no install step needed).
if command -v meson >/dev/null 2>&1; then
  MESON=(meson)
else
  MESON_TGZ="$BUILD_DIR/meson/meson.tar.gz"
  MESON_SRC="$BUILD_DIR/meson/src"
  if [ ! -f "$MESON_SRC/meson.py" ]; then
    mkdir -p "$MESON_SRC"
    fetch_pinned_tarball analysis.meson "$MESON_TGZ"
    tar xzf "$MESON_TGZ" -C "$MESON_SRC" --strip-components=1
  fi
  MESON=(python3 "$MESON_SRC/meson.py")
fi

fetch_pinned analysis.rizin "$DIR"
cd "$DIR"

# --- our emscripten patch (idempotent: sentinel = the stubs header include) --
if grep -q 'rz_emscripten_thread_stubs' librz/util/thread.h 2>/dev/null; then
  echo "rizin emscripten patch already present; skipping apply."
else
  git apply "$RIZIN_PATCH"
  echo "Applied $RIZIN_PATCH"
fi

# --- meson cross file (build config, not a source patch) ---------------------
CROSS_FILE="$DIR/wasm32-emscripten.txt"
cat > "$CROSS_FILE" <<'EOF'
[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
strip = 'emstrip'
ranlib = 'emranlib'

[built-in options]
c_args = ['-O2', '-DHAVE_PTY=0', '-DHAVE_FORK=0', '-D__EMSCRIPTEN__=1']
c_link_args = ['-sENVIRONMENT=node', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=67108864', '-sSTACK_SIZE=8388608', '-sERROR_ON_UNDEFINED_SYMBOLS=0', '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORTED_RUNTIME_METHODS=FS,callMain', '-sEXPORTED_FUNCTIONS=_main,_malloc,_free', '-sINVOKE_RUN=0', '-sFORCE_FILESYSTEM=1', '-sEXIT_RUNTIME=0', '-sASSERTIONS=0']

[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'
EOF

echo "==> meson subprojects download"
"${MESON[@]}" subprojects download || true

# --- libzip subproject patch (post-download; idempotent sentinel) ------------
LIBZIP_DIR=$(find subprojects -maxdepth 1 -name 'libzip-*' -type d | head -1)
[ -z "$LIBZIP_DIR" ] && { echo "FATAL: libzip subproject missing after download." >&2; exit 1; }
if grep -q 'romdev emscripten compat' "$LIBZIP_DIR/lib/zipint.h" 2>/dev/null; then
  echo "libzip emscripten patch already present; skipping apply."
else
  patch -p1 -d "$LIBZIP_DIR" < "$LIBZIP_PATCH"
  echo "Applied $LIBZIP_PATCH to $LIBZIP_DIR"
fi

# --- configure ----------------------------------------------------------------
echo "==> meson setup"
rm -rf "$WASM_BUILD"
"${MESON[@]}" setup "$WASM_BUILD" \
    --cross-file "$CROSS_FILE" \
    --default-library=static \
    --prefer-static \
    -Dstatic_runtime=true \
    -Duse_sys_capstone=disabled \
    -Duse_sys_magic=disabled \
    -Duse_sys_libzip=disabled \
    -Duse_sys_zlib=disabled \
    -Duse_sys_lz4=disabled \
    -Duse_sys_xxhash=disabled \
    -Duse_sys_openssl=disabled \
    -Duse_sys_tree_sitter=disabled \
    -Duse_sys_pcre2=disabled \
    -Duse_sys_lzma=disabled \
    -Duse_sys_libzstd=disabled \
    -Duse_lzma=false \
    -Duse_zlib=false \
    -Denable_tests=false \
    -Denable_rz_test=false \
    -Dcli=enabled \
    -Dportable=true \
    -Ddebugger=false

# meson injects -pthread/shared-memory for emscripten; we build single-threaded
# (thread stubs from the patch). Strip the flags from the generated ninja.
echo "==> strip pthread flags"
find "$WASM_BUILD" -name '*.ninja' -type f -exec sed -i \
  -e 's/ -pthread//g' \
  -e 's/ -sPTHREAD_POOL_SIZE=[0-9]*//g' \
  -e 's/ --shared-memory//g' \
  -e 's/ --import-memory//g' {} +

# Force off the capabilities emscripten can't deliver (configure probes the
# host headers and gets these wrong under a cross build).
echo "==> patch rz_userconf.h"
sed -i \
  -e 's/#define HAVE_FORK.*1/#define HAVE_FORK 0/g' \
  -e 's/#define HAVE_PTHREAD.*1/#define HAVE_PTHREAD 0/g' \
  -e 's/#define HAVE_OPENPTY.*1/#define HAVE_OPENPTY 0/g' \
  -e 's/#define HAVE_FORKPTY.*1/#define HAVE_FORKPTY 0/g' \
  -e 's/#define HAVE_LOGIN_TTY.*1/#define HAVE_LOGIN_TTY 0/g' \
  -e 's/#define HAVE_JEMALLOC.*1/#define HAVE_JEMALLOC 0/g' \
  "$WASM_BUILD/rz_userconf.h"

echo "==> ninja"
ninja -C "$WASM_BUILD" -j"$(nproc)"

# --- stage ---------------------------------------------------------------------
# Only the main `rizin` binary ships: rz-asm/rz-bin/etc. are the same 30MB of
# librz each, and rizin's command surface covers them (pa/pad, iIj, ...).
for f in rizin.js rizin.wasm; do
  [ -f "$WASM_BUILD/binrz/rizin/$f" ] || { echo "FATAL: missing $f" >&2; exit 1; }
done
mkdir -p "$STAGE" "$OUT"
cp "$WASM_BUILD/binrz/rizin/rizin.js" "$WASM_BUILD/binrz/rizin/rizin.wasm" "$STAGE/"
cp "$WASM_BUILD/binrz/rizin/rizin.js" "$WASM_BUILD/binrz/rizin/rizin.wasm" "$OUT/"
ls -la "$OUT"
echo "build-rizin.sh: OK"
