#!/usr/bin/env bash
# Run a romdev WASM build inside the pinned Emscripten container — no local
# emcc/bison/flex needed, reproducible anywhere Docker runs.
#
# Usage:
#   build-image/build-wasm.sh build-dasm.sh          # run one build script
#   build-image/build-wasm.sh build-fceumm.sh
#   build-image/build-wasm.sh                        # interactive shell in the image
#
# The script that runs is one of the build-*.sh scripts (today they live in
# packages/romdev/scripts/ — wherever the build recipes end up, point
# SCRIPTS_DIR at them). The repo is bind-mounted at /work; build outputs land
# back on the host exactly as a local build would.
set -euo pipefail

IMAGE="romdev/wasm-builder:emscripten-4.0.18"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Build the image if it's not present yet.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo ">> building $IMAGE (first run)…"
  docker build -t "$IMAGE" "$REPO_ROOT/build-image"
fi

# Where the build scripts live (the build recipes). Adjust as recipes move
# into their packages.
WORKDIR_IN_REPO="${ROMDEV_BUILD_CWD:-packages/romdev}"

if [ "$#" -eq 0 ]; then
  echo ">> interactive shell in $IMAGE (repo at /work)"
  exec docker run --rm -it -v "$REPO_ROOT:/work" -w "/work/$WORKDIR_IN_REPO" "$IMAGE" bash
fi

# Run the requested build script (e.g. build-dasm.sh) from the scripts dir.
SCRIPT="$1"; shift
echo ">> running scripts/$SCRIPT in $IMAGE…"
exec docker run --rm -v "$REPO_ROOT:/work" -w "/work/$WORKDIR_IN_REPO" "$IMAGE" \
  bash "scripts/$SCRIPT" "$@"
