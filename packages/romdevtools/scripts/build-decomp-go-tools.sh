#!/usr/bin/env bash
# Build the Go command-line tools a PS1 decomp project runs in its setup to
# WASM (GOOS=wasip1 GOARCH=wasm), run by romdev's worker under node:wasi with
# the project directory preopened:
#
#   psx-disk     CD image (cue/bin) extractor: `psx-disk extract <cue> <dir>`
#                (the project's tools/<name>-disk)
#   psx-assets   asset extractor/builder: `extract-assets` / `build-assets
#                <config/assets.<ver>.yaml>` (the project's tools/<name>-assets;
#                its wrapper script is `go run ./tools/<name>-assets "$@"`)
#
# Both come from the project tree at the commit pinned in versions.json
# (toolchains.psx_decomp_tools), with the module versions its go.sum locks,
# built from a rewritten copy (src/decomp-go-wasip1/gen-source.mjs). The Go toolchain itself is a build-time
# dependency (toolchains.go_toolchain, the official linux-amd64 tarball,
# sha256-pinned), unpacked under build/.
#
# wasip1 has no processes; the commands romdev runs (extract, extract-assets,
# build-assets) never start one. The project's orchestration commands
# (`psx-assets build`, `format`, dependency download) exec git/ninja and the project interpreter
# and fail cleanly with ENOSYS under WASI; romdev runs those steps itself.
#
# Ships in packages/romdev-toolchain-decomp-gcc/wasm/tools/<name>.wasm.
# Host deps (build time only): curl, tar, git.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd curl
require_cmd git

ROOT="$BUILD_DIR/decomp-go"
PKG_OUT="$PROJECT_DIR/../romdev-toolchain-decomp-gcc/wasm/tools"
mkdir -p "$ROOT" "$PKG_OUT"

GOVER="$(pin_version toolchains.go_toolchain)"
GOROOT_DIR="$ROOT/go-$GOVER"
if [ ! -x "$GOROOT_DIR/bin/go" ]; then
  fetch_pinned_tarball toolchains.go_toolchain "$ROOT/go-$GOVER.tar.gz"
  rm -rf "$ROOT/go-extract" && mkdir -p "$ROOT/go-extract"
  tar -C "$ROOT/go-extract" -xzf "$ROOT/go-$GOVER.tar.gz"
  mv "$ROOT/go-extract/go" "$GOROOT_DIR"
  rm -rf "$ROOT/go-extract" "$ROOT/go-$GOVER.tar.gz"
fi
GO="$GOROOT_DIR/bin/go"
# Everything Go writes stays under build/: module cache, build cache, no
# toolchain switching (the pinned toolchain is the one that builds).
export GOROOT="$GOROOT_DIR" GOPATH="$ROOT/gopath" GOCACHE="$ROOT/gocache" GOMODCACHE="$ROOT/gopath/pkg/mod"
export GOTOOLCHAIN=local GOFLAGS=-mod=readonly GOENV=off GOTELEMETRY=off CGO_ENABLED=0

SRC="$ROOT/psx_decomp_tools"
fetch_pinned "toolchains.psx_decomp_tools" "$SRC"

# The tools are built from a copy of the two modules that gen-source.mjs
# rewrites under build/ (the pinned tree is not edited):
# - wasip1 support: bindiff.go (tcell has no WASI backend), deps/exec_unix.go
#   (no Setsid on wasip1), and the enum reader's `cpp` child, handed to the
#   host through romdev_exec_wasip1.go (the `romdev` imports wasi-run.js
#   provides, which run romdev's WASM preprocessor).
# - no game text: neutral module and package names; the project's name in
#   paths, env vars and messages, the stage/boss/character tables and the disc
#   identifiers are read at run time from the project and its original disc.
GEN="$ROOT/src"
node "$SCRIPT_DIR/src/decomp-go-wasip1/gen-source.mjs" "$SRC" "$SCRIPT_DIR/src/decomp-go-wasip1" "$GEN"
GAME_PKG="$(cat "$GEN/.game-package")" # upstream name of the renamed package dir

build_tool() { # <dir under tools/ in $GEN> <out name>
  ( cd "$GEN/tools/$1" && GOOS=wasip1 GOARCH=wasm "$GO" build -trimpath -ldflags="-s -w -buildid=" -o "$PKG_OUT/$2.wasm" . )
  # The shipped binaries carry none of the project's name (see gen-source.mjs).
  if grep -qai -- "$GAME_PKG" "$PKG_OUT/$2.wasm"; then echo "FATAL: $2.wasm contains the project's name" >&2; exit 1; fi
  echo "built $2.wasm ($(stat -c %s "$PKG_OUT/$2.wasm") bytes)"
}
build_tool psx-disk psx-disk
build_tool psx-assets psx-assets

# The tools' own Go tests, built for wasip1 from the same source and run the
# way romdev runs the tools (src/decomp/wasi-run.js). Several read the
# project's extracted disc, so they run only against a checkout of the pinned
# commit that has one: DECOMP_GO_TEST_TREE=<checkout> (disks/us extracted).
# Each binary is named after its package's upstream directory, where it runs.
rm -rf "$ROOT/tests" && mkdir -p "$ROOT/tests"
for p in . ./assets/cutsceneevents ./assets/enemydefs ./assets/graphics ./assets/itemdefs ./assets/layer ./assets/layout ./assets/spritebanks ./datarange ./psxgame ./util ./util/png; do
  n="$(echo "$p" | sed "s|^\./psxgame|./$GAME_PKG|; s|^\./||; s|^\.$|main|; s|/|_|g")"
  ( cd "$GEN/tools/psx-assets" && GOOS=wasip1 GOARCH=wasm "$GO" test -c -o "$ROOT/tests/$n.test.wasm" "$p" )
done
if [ -n "${DECOMP_GO_TEST_TREE:-}" ]; then
  [ "$(git -C "$DECOMP_GO_TEST_TREE" rev-parse HEAD)" = "$(pin_commit toolchains.psx_decomp_tools)" ] || { echo "FATAL: $DECOMP_GO_TEST_TREE is not at the pinned commit" >&2; exit 1; }
  mkdir -p "$ROOT/test-tmp"
  node --no-warnings "$SCRIPT_DIR/src/decomp-go-wasip1/run-go-tests.mjs" "$ROOT/tests" "$DECOMP_GO_TEST_TREE/tools/$GAME_PKG-assets" "$ROOT/test-tmp"
  rm -rf "$ROOT/test-tmp"
else
  echo "Go tests built under $ROOT/tests; set DECOMP_GO_TEST_TREE=<checkout with disks/us> to run them"
fi

echo "decomp Go tools -> $PKG_OUT"
echo "Refresh the binary manifest: node scripts/binary-manifest.mjs --write"
