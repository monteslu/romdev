#!/usr/bin/env bash
# Build the Go command-line tools a PS1 decomp project runs in its setup to
# WASM (GOOS=wasip1 GOARCH=wasm), run by romdev's worker under node:wasi with
# the project directory preopened:
#
#   sotn-disk    CD image (cue/bin) extractor: `sotn-disk extract <cue> <dir>`
#   sotn-assets  asset extractor/builder: `extract-assets` / `build-assets
#                <config/assets.<ver>.yaml>` (the project's ./sotn.sh is
#                `go run ./tools/sotn-assets "$@"`)
#
# Both come from the project tree at the commit pinned in versions.json
# (toolchains.sotn_decomp_tools), built through its go.work with the module
# versions its go.sum locks. The Go toolchain itself is a build-time
# dependency (toolchains.go_toolchain, the official linux-amd64 tarball,
# sha256-pinned), unpacked under build/.
#
# wasip1 has no processes; the commands romdev runs (extract, extract-assets,
# build-assets) never start one. The project's orchestration commands
# (`sotn-assets build`, `format`, dependency download) exec git/ninja and the project interpreter
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

SRC="$ROOT/sotn_decomp_tools"
fetch_pinned "toolchains.sotn_decomp_tools" "$SRC"

# wasip1 build overlay (go build -overlay; the pinned tree is not edited):
# - bindiff.go: an interactive tcell terminal viewer; tcell has no WASI
#   backend, so the command reports that instead.
# - deps/exec_unix.go: syscall.SysProcAttr.Setsid does not exist on wasip1.
# - sotn/enum.go: reading an enum out of a header runs `cpp`; under WASI
#   that child is handed to the host (romdev_exec_wasip1.go, the `romdev`
#   imports wasi-run.js provides), which runs romdev's WASM preprocessor.
#   enum.go itself is the pinned file with exactly two calls redirected.
OVL="$ROOT/overlay.json"
OVLDIR="$SCRIPT_DIR/src/decomp-go-wasip1"
mkdir -p "$ROOT/overlay"
node -e '
  const fs = require("fs");
  const [src, ovl, gen, out] = process.argv.slice(1);
  let e = fs.readFileSync(src + "/tools/sotn-assets/sotn/enum.go", "utf8");
  for (const [a, b] of [["exec.LookPath(\"cpp\")", "romdevLookPath(\"cpp\")"], ["cmd.Output()", "romdevOutput(cmd)"]]) {
    if (e.split(a).length !== 2) { console.error("FATAL: enum.go: expected exactly one " + a); process.exit(1); }
    e = e.replace(a, b);
  }
  fs.writeFileSync(gen + "/enum.go", e);
  fs.writeFileSync(out, JSON.stringify({ Replace: {
    [src + "/tools/sotn-assets/bindiff.go"]: ovl + "/bindiff.go",
    [src + "/tools/sotn-assets/deps/exec_unix.go"]: ovl + "/exec_unix.go",
    [src + "/tools/sotn-assets/sotn/enum.go"]: gen + "/enum.go",
    [src + "/tools/sotn-assets/sotn/romdev_exec_wasip1.go"]: ovl + "/romdev_exec_wasip1.go",
  } }, null, 1));
' "$SRC" "$OVLDIR" "$ROOT/overlay" "$OVL"

build_tool() { # <dir under tools/> <out name>
  ( cd "$SRC/tools/$1" && GOOS=wasip1 GOARCH=wasm "$GO" build -overlay "$OVL" -trimpath -ldflags="-s -w -buildid=" -o "$PKG_OUT/$2.wasm" . )
  echo "built $2.wasm ($(stat -c %s "$PKG_OUT/$2.wasm") bytes)"
}
build_tool sotn-disk sotn-disk
build_tool sotn-assets sotn-assets

# The tools' own Go tests, built for wasip1 with the same overlay and run the
# way romdev runs the tools (src/decomp/wasi-run.js). Several read the
# project's extracted disc, so they run only against a checkout of the pinned
# commit that has one: DECOMP_GO_TEST_TREE=<checkout> (disks/us extracted).
rm -rf "$ROOT/tests" && mkdir -p "$ROOT/tests"
for p in . ./assets/cutsceneevents ./assets/enemydefs ./assets/graphics ./assets/itemdefs ./assets/layer ./assets/layout ./assets/spritebanks ./datarange ./sotn ./util ./util/png; do
  n="$(echo "$p" | sed 's|^\./||; s|^\.$|main|; s|/|_|g')"
  ( cd "$SRC/tools/sotn-assets" && GOOS=wasip1 GOARCH=wasm "$GO" test -overlay "$OVL" -c -o "$ROOT/tests/$n.test.wasm" "$p" )
done
if [ -n "${DECOMP_GO_TEST_TREE:-}" ]; then
  [ "$(git -C "$DECOMP_GO_TEST_TREE" rev-parse HEAD)" = "$(pin_commit toolchains.sotn_decomp_tools)" ] || { echo "FATAL: $DECOMP_GO_TEST_TREE is not at the pinned commit" >&2; exit 1; }
  mkdir -p "$ROOT/test-tmp"
  node --no-warnings "$SCRIPT_DIR/src/decomp-go-wasip1/run-go-tests.mjs" "$ROOT/tests" "$DECOMP_GO_TEST_TREE/tools/sotn-assets" "$ROOT/test-tmp"
  rm -rf "$ROOT/test-tmp"
else
  echo "Go tests built under $ROOT/tests; set DECOMP_GO_TEST_TREE=<checkout with disks/us> to run them"
fi

echo "decomp Go tools -> $PKG_OUT"
echo "Refresh the binary manifest: node scripts/binary-manifest.mjs --write"
