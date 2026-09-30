#!/usr/bin/env bash
# Build Rizin (RE analysis engine: CFG / xrefs / function detection) → WASM,
# Node target. Single-threaded, static arch plugins, MODULARIZE glue driven
# one-shot via callMain ("rizin -q -c '<cmds>' rom") by the worker pool.
#
# Recipe derived from rzwasi (https://github.com/IndAlok/rzwasi, LGPL-3.0) -
# thread stubs, libzip/sys/cons emscripten fixes - adapted for Node/ESM and
# frozen into two committed patches (see scripts/patches/README.md):
#   rizin-romdev-emscripten.patch  - rizin tree (threads, cons, sys, meson.build)
#   rizin-libzip-emscripten.patch  - libzip subproject (applied post-download)
#
# NO MESON, NO PYTHON. rizin's upstream build is meson (a Python program) and
# its meson.build runs Python helpers too; romdev's build is JS + WASM only.
# scripts/rizin-wasm/build.mjs drives emcc directly from a frozen plan
# (scripts/rizin-wasm/plan.json: every compile/archive/link step with exact
# flags, plus the configure-time headers in scripts/rizin-wasm/configured/).
# The plan belongs to the pinned rizin commit: a rizin bump means a new plan
# (see scripts/rizin-wasm/extract-plan.mjs). The meson.build hunk in the rizin
# patch is inert under this build and kept only so the patch stays upstream-
# shaped. The plan reproduces the meson build byte-for-byte: rizin.wasm
# sha256 d3f3b2a1... (binary-manifest.json) came out identical.
#
# Known-good output (rizin v0.8.2, emcc 4.0.18): rizin.wasm ~30MB. Verified:
# iNES autodetect, full analysis (aaa → 210 fns on a real NES ROM), axtj, agf
# json, arch plugins 6502/z80/gb/arm/m68k/snes(65816)/spc700. NOTE: plugin-LISTING
# commands (`La`, `e asm.arch=??`) trap on a fn-pointer signature mismatch -
# do not use them from the JS wrapper; everything on the analysis path works.
#
# Output: staged at src/analysis/wasm/rizin.{js,wasm}, shipped via
# packages/romdev-analysis/wasm/. After a rebuild that changes bytes, refresh
# the manifest: node scripts/binary-manifest.mjs --write
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd emar
require_cmd git
require_cmd node
require_cmd curl
require_cmd tar
require_cmd patch

DIR="$BUILD_DIR/rizin"
WASM_BUILD="$DIR/build-wasm"
RIZIN_PATCH="$PROJECT_DIR/$(pin_get analysis.rizin patch)"
LIBZIP_PATCH="$PROJECT_DIR/$(pin_get analysis.rizin libzipPatch)"
DRIVER="$PROJECT_DIR/scripts/rizin-wasm/build.mjs"
STAGE="$PROJECT_DIR/src/analysis/wasm"
OUT="$PROJECT_DIR/../romdev-analysis/wasm"

fetch_pinned analysis.rizin "$DIR"
cd "$DIR"
require_git_toplevel

# --- romdev emscripten patch (reset the files it touches, then re-apply) ------
if patch_already_applied "$RIZIN_PATCH"; then
  echo "rizin emscripten patch already present (reverse-applies cleanly); skipping."
else
  git reset -q --hard HEAD
  git apply --recount "$RIZIN_PATCH"
  echo "Applied $RIZIN_PATCH"
fi

# --- wrap subprojects (git revisions / sha256-pinned tarballs from the .wrap
# files in the pinned tree) --------------------------------------------------
echo "==> subprojects"
node "$DRIVER" subprojects "$DIR"

# --- libzip subproject patch (post-download; tarball tree, so patch(1)) -------
LIBZIP_DIR=$(find subprojects -maxdepth 1 -name 'libzip-*' -type d | head -1)
[ -z "$LIBZIP_DIR" ] && { echo "FATAL: libzip subproject missing after download." >&2; exit 1; }
if patch -p1 -R --dry-run -s -f -d "$LIBZIP_DIR" < "$LIBZIP_PATCH" >/dev/null 2>&1; then
  echo "libzip emscripten patch already present; skipping apply."
else
  patch -p1 -d "$LIBZIP_DIR" < "$LIBZIP_PATCH"
  echo "Applied $LIBZIP_PATCH to $LIBZIP_DIR"
fi

# --- compile / archive / link (fresh build dir every run) ---------------------
echo "==> build"
node "$DRIVER" build "$DIR" "$(basename "$WASM_BUILD")"

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
node "$PROJECT_DIR/scripts/binary-manifest.mjs" >/dev/null 2>&1 \
  && echo "binary-manifest: every shipped binary (rizin included) matches" \
  || echo "NOTE: shipped binaries differ from binary-manifest.json; if this rebuild is intended, run: node scripts/binary-manifest.mjs --write"
echo "build-rizin.sh: OK"
