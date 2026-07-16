#!/usr/bin/env bash
# sync-build-kit.sh — re-copy the shared build kit into the two packages that
# vendor it (romdev-platform-gba, romdev-toolchain-m68k-gcc).
#
# The GBA + Genesis C build drivers live in their binary packages (so a
# standalone SDK consumer deps ONE package), but the tool-running kit they
# share — common/{ar,c-build,sdk-cache,wasm-tool,gcc-toolchain}.js +
# _worker/{pool,run,wasm-worker}.js + parse-errors.js + the arch gcc.js
# wrappers — is CANONICAL here in romdevtools (12 other toolchains use it).
# The package copies must stay byte-identical; test/build-kit-parity.test.js
# fails the suite when they drift, and this script re-syncs them.
#
# Run after ANY edit to a kit file:  bash scripts/sync-build-kit.sh
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)/src/toolchains"
PKGS="$(cd "$(dirname "$0")/../.." && pwd)"

GBA="$PKGS/romdev-platform-gba/build"
M68K="$PKGS/romdev-toolchain-m68k-gcc/build"

for dest in "$GBA" "$M68K"; do
  mkdir -p "$dest/common" "$dest/_worker"
  for f in ar.js c-build.js sdk-cache.js wasm-tool.js gcc-toolchain.js io.js share-fs.js; do
    cp "$SRC/common/$f" "$dest/common/$f"
  done
  for f in pool.js run.js wasm-worker.js; do
    cp "$SRC/_worker/$f" "$dest/_worker/$f"
  done
  cp "$SRC/parse-errors.js" "$dest/parse-errors.js"
done
cp "$SRC/arm-none-eabi-gcc/gcc.js" "$GBA/arm-none-eabi-gcc/gcc.js"
cp "$SRC/m68k-elf-gcc/gcc.js"      "$M68K/m68k-elf-gcc/gcc.js"

echo "build kit synced → romdev-platform-gba/build + romdev-toolchain-m68k-gcc/build"
echo "(drivers gba-c.js / genesis-c.js / sjasm.js are canonical IN the packages — not synced)"
