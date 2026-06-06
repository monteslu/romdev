#!/usr/bin/env bash
# Build dasm assembler → WASM. Outputs to src/toolchains/dasm/wasm/.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd git

# Upstream pin lives in scripts/versions.json (toolchains.dasm), not here.
DASM_DIR="$BUILD_DIR/dasm/src"
OUT="$PROJECT_DIR/src/toolchains/dasm/wasm"

fetch_pinned toolchains.dasm "$DASM_DIR"

cd "$DASM_DIR/src"
emcc \
  main.c ops.c globals.c exp.c symbols.c \
  mne6303.c mne6502.c mne65c02.c mne68705.c mne6811.c mnef8.c mne68908.c \
  "${EM_CLI_FLAGS[@]}" \
  -s EXPORT_NAME=createDasm \
  -o dasm.js

mkdir -p "$OUT"
cp dasm.js dasm.wasm "$OUT/"
echo "dasm.wasm staged at $OUT"
