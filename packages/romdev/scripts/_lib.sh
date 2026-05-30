#!/usr/bin/env bash
# Shared helpers for the build scripts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_DIR/build"

# Centralized upstream pins (versions.json) + pin_*/fetch_pinned helpers.
# shellcheck source=/dev/null
. "$SCRIPT_DIR/_versions.sh"

BISON_DIR="$BUILD_DIR/bison/install"
FLEX_DIR="$BUILD_DIR/flex/install"

# Add local bison/flex to PATH if available.
if [ -d "$BISON_DIR/bin" ]; then export PATH="$BISON_DIR/bin:$PATH"; fi
if [ -d "$FLEX_DIR/bin" ]; then export PATH="$FLEX_DIR/bin:$PATH"; fi

# Source emsdk if EMSDK is exported.
if [ -n "${EMSDK:-}" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
  # shellcheck source=/dev/null
  source "$EMSDK/emsdk_env.sh" > /dev/null 2>&1
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: '$1' is required but not on PATH." >&2
    exit 1
  fi
}

# Common Emscripten link flags for a tool that's invoked as a CLI via callMain.
EM_CLI_FLAGS=(
  -O2
  -s WASM=1
  -s MODULARIZE=1
  -s EXPORT_ES6=1
  -s ENVIRONMENT=node
  -s ALLOW_MEMORY_GROWTH=1
  -s INITIAL_MEMORY=67108864
  -s STACK_SIZE=8388608
  -s FORCE_FILESYSTEM=1
  -s EXIT_RUNTIME=0
  -s "EXPORTED_RUNTIME_METHODS=[\"FS\",\"callMain\"]"
  -s INVOKE_RUN=0
)

# Flags for RE-LINKING an already-emcc-built tool binary (the gcc-family
# stage-2 wasm wrap: cc1, as, ld, objcopy). DISTINCT from EM_CLI_FLAGS:
# these tools need a much larger initial heap (cc1 OOMs at 64MB on real
# input) and EXIT_RUNTIME=1 so callMain returns cleanly per invocation.
# The per-tool EXPORT_NAME stays inline at the call site. Used by the
# arm/m68k *-wasm-tools.sh wrap_tool helpers.
EM_WRAP_FLAGS=(
  -s MODULARIZE=1
  -s EXPORT_ES6=1
  -s ENVIRONMENT=node
  -s ALLOW_MEMORY_GROWTH=1
  -s INITIAL_MEMORY=134217728
  -s EXIT_RUNTIME=1
  -s INVOKE_RUN=0
  -s "EXPORTED_RUNTIME_METHODS=[\"callMain\",\"FS\"]"
  # Strip DWARF debug info from the relinked wasm. emcc defaults to -O0, which
  # PRESERVES the debug sections carried in the input bitcode — for cc1 that's
  # ~95MB of .debug_*/name (the artifact ballooned to 136MB). -g0 drops it,
  # taking cc1-arm.wasm to ~38MB (code+data only). A shipped compiler doesn't
  # need DWARF; the source is available for anyone who wants to debug a build.
  -g0
)
