#!/usr/bin/env bash
# Fetch the pinned ares tree (scripts/versions.json cores.ares) into
# $BUILD_DIR/ares/src and apply scripts/patches/ares-romdev.patch (nall's
# platform detection learns WebAssembly). ares is never built as a core here:
# romdev compiles only its two firmware-coprocessor cores (uPD96050, ARM) and
# their Super Famicom driver files, into the recompiler's chip units
# (scripts/recompile-gen/ares-chips.mjs) and into the snes9x core
# (scripts/build-snes9x.sh). ares is ISC-licensed.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd git

ARES_DIR="$BUILD_DIR/ares/src"
ARES_PATCH="$PROJECT_DIR/scripts/patches/ares-romdev.patch"
fetch_pinned cores.ares "$ARES_DIR"
cd "$ARES_DIR"
require_git_toplevel
if patch_already_applied "$ARES_PATCH"; then
  echo "Patch already present (reverse-applies cleanly); keeping the tree."
else
  git checkout -- . 2>/dev/null || true
  git apply --recount "$ARES_PATCH"
  echo "Applied $ARES_PATCH"
fi
