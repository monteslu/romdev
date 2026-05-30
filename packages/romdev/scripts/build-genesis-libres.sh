#!/usr/bin/env bash
# Regenerate SGDK's libres (the default font + logo + stop_xgm) from source.
#
# `libres.h` + `libres.s` are GENERATED ARTIFACTS produced by SGDK's resource
# compiler (rescomp) from libres.res + its source PNGs/bin. They're vendored
# (committed) because rescomp is a Java tool — porting it to WASM is out of
# scope — but they are fully reproducible from the visible source here:
#
#   res/libres.res            the resource manifest
#   res/image/font_default.png  the 8x8 system font
#   res/image/sgdk_logo.png     the SGDK logo bitmap
#   res/sound/stop_xgm.bin      the XGM stop command blob
#
# This is the same model as the SNES apu_blob: a generated blob with its source
# + the exact tool recipe shipped, so anyone can rebuild and byte-compare.
#
# To regenerate (needs Java 17+ and SGDK's rescomp.jar from the pinned SGDK):
#   ./scripts/build-genesis-libres.sh /path/to/SGDK/bin/rescomp.jar
set -euo pipefail

RESCOMP_JAR="${1:?usage: build-genesis-libres.sh <path-to-rescomp.jar>}"
RES_DIR="$(cd "$(dirname "$0")/.." && pwd)/src/platforms/genesis/lib/sgdk/res"

cd "$RES_DIR"
java -jar "$RESCOMP_JAR" libres.res libres.s
echo "regenerated $RES_DIR/libres.s + libres.h"
echo "diff against the committed versions to verify reproducibility."
