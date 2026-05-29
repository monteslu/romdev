#!/usr/bin/env bash
# Build flex 2.6.4 into build/flex/install. Only needed if your distro lacks flex.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"

FLEX_VERSION="2.6.4"
mkdir -p "$BUILD_DIR/flex"
cd "$BUILD_DIR/flex"

if [ -x "install/bin/flex" ]; then
  echo "flex already built at $FLEX_DIR/bin/flex"
  exit 0
fi

if [ ! -f "flex-${FLEX_VERSION}.tar.gz" ]; then
  curl -sL "https://github.com/westes/flex/releases/download/v${FLEX_VERSION}/flex-${FLEX_VERSION}.tar.gz" -o "flex-${FLEX_VERSION}.tar.gz"
fi
if [ ! -d "flex-${FLEX_VERSION}" ]; then
  tar xzf "flex-${FLEX_VERSION}.tar.gz"
fi
cd "flex-${FLEX_VERSION}"
./configure --prefix="$FLEX_DIR"
make -j"$(nproc)"
make install
echo "flex installed at $FLEX_DIR/bin/flex"
