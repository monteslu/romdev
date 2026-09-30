#!/usr/bin/env bash
# Build the rabbitizer MIPS instruction decoder (Decompollaborate/rabbitizer,
# MIT) from its C library to WASM, one module per pinned version:
#
#   1.16.2  (spimdisasm 1.42.4)   versions.json toolchains.rabbitizer_1_16_2
#   1.14.3  (spimdisasm 1.39.3)   versions.json toolchains.rabbitizer_1_14_3
#   1.13.0  (spimdisasm 1.35.0)   versions.json toolchains.rabbitizer_1_13_0
#
# Each module is the library's src/**/*.c plus romdev-rabbitizer's flat export
# layer (csrc/rabbitizer_wasm.c), linked as a standalone reactor (--no-entry)
# with no emscripten JS glue, so src/index.js instantiates it synchronously.
# The library is compiled the way the Python wheel compiles it (-std=c11,
# NDEBUG, no RAB_SANITY_CHECKS).
#
# Ships in packages/romdev-rabbitizer/wasm/rabbitizer-<version>.wasm.
#
# --test additionally builds and runs, against the same library objects:
#   - the upstream C checks (tests/run_*_checks.sh list) under node, and
#   - dumps every upstream instruction_checks test_entries table to
#     build/rabbitizer/<ver>/entries/*.jsonl and runs them through the JS
#     binding (packages/romdev-rabbitizer/test/upstream-entries.mjs).
# Host deps (build time only): emcc (emsdk 4.0.18), node.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"
require_cmd emcc
require_cmd node

RUN_TESTS=0
[ "${1:-}" = "--test" ] && RUN_TESTS=1

PKG="$PROJECT_DIR/../romdev-rabbitizer"
PKG_OUT="$PKG/wasm"
ROOT="$BUILD_DIR/rabbitizer"
mkdir -p "$ROOT" "$PKG_OUT"

CFLAGS=(-O2 -std=c11 -DNDEBUG -g0 -Wall -Wno-unknown-warning-option)
LINK=(--no-entry -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=1048576
      -sSTACK_SIZE=65536 -sERROR_ON_UNDEFINED_SYMBOLS=1 "-sEXPORTED_FUNCTIONS=[]" -g0)

build_version() { # <version>
  local ver="$1" key src obj
  key="rabbitizer_${ver//./_}"
  src="$ROOT/${ver//./_}"
  obj="$src/wasm-build"
  fetch_pinned "toolchains.$key" "$src"
  git -C "$src" checkout -q -- .
  rm -rf "$obj"; mkdir -p "$obj"

  local inc=(-I "$src/include" -I "$src/tables")
  local c objs=()
  while IFS= read -r c; do
    local o="$obj/$(echo "${c#"$src"/}" | tr '/' '_').o"
    emcc "${CFLAGS[@]}" "${inc[@]}" -c "$c" -o "$o"
    objs+=("$o")
  done < <(find "$src/src" -name '*.c' | sort)
  emar rcs "$obj/librabbitizer.a" "${objs[@]}"

  emcc "${CFLAGS[@]}" "${inc[@]}" "$PKG/csrc/rabbitizer_wasm.c" "$obj/librabbitizer.a" \
    "${LINK[@]}" -o "$PKG_OUT/rabbitizer-$ver.wasm"
  echo "rabbitizer $ver -> $PKG_OUT/rabbitizer-$ver.wasm ($(stat -c %s "$PKG_OUT/rabbitizer-$ver.wasm") bytes)"

  if [ "$RUN_TESTS" = 1 ]; then
    test_version "$ver" "$src" "$obj"
  fi
  git -C "$src" checkout -q -- .
}

test_version() { # <version> <src> <obj>
  local ver="$1" src="$2" obj="$3" t name fails=0
  local inc=(-I "$src/include" -I "$src/tables")
  # The upstream checks assert(), so they build without NDEBUG; the library
  # objects stay the shipped ones.
  local tflags=(-O2 -std=c11 -g0 -Wno-override-init "${inc[@]}")
  local tlink=(-sNODERAWFS=1 -sENVIRONMENT=node -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576)
  mkdir -p "$obj/tests" "$src/entries"
  rm -f "$src/entries/"*.jsonl

  echo "== rabbitizer $ver: upstream C checks (WASM, node)"
  for t in $(cat "$src"/tests/run_*_checks.sh | grep '^\./build/' | sed 's|^\./build/||; s|\.elf$|.c|'); do
    name="$(basename "$t" .c)"
    emcc "${tflags[@]}" "$src/$t" "$obj/librabbitizer.a" "${tlink[@]}" -o "$obj/tests/$name.cjs"
    if (cd "$src" && node "$obj/tests/$name.cjs" > "$obj/tests/$name.out" 2>&1); then
      echo "  PASS $t  $(grep -o '[0-9]* errors out of [0-9]* entries' "$obj/tests/$name.out" | head -1)"
    else
      echo "  FAIL $t"; sed 's/^/    /' "$obj/tests/$name.out" | tail -20
      fails=$((fails + 1))
    fi
  done

  echo "== rabbitizer $ver: upstream test_entries through the JS binding"
  for t in "$src"/tests/c/instruction_checks/*.c; do
    grep -q '^const TestEntry test_entries\[\]' "$t" || continue
    name="$(basename "$t" .c)"
    emcc "${tflags[@]}" -DAVOID_DEF_MAIN -include "$t" -I "$src/tests/c/instruction_checks" \
      "$PKG/csrc/dump_test_entries.c" "$obj/librabbitizer.a" "${tlink[@]}" -o "$obj/tests/dump_$name.cjs"
    node "$obj/tests/dump_$name.cjs" > "$src/entries/$name.jsonl"
  done
  node "$PKG/test/upstream-entries.mjs" "$ver" "$src/entries" || fails=$((fails + 1))

  if [ "$fails" -ne 0 ]; then
    echo "FATAL: rabbitizer $ver: $fails check group(s) failed" >&2
    exit 1
  fi
}

for v in 1.16.2 1.14.3 1.13.0; do
  build_version "$v"
done

echo "Refresh the binary manifest: node scripts/binary-manifest.mjs --write"
