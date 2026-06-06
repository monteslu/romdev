#!/usr/bin/env bash
# Build bison 3.8.2 into build/bison/install. Only needed if your distro lacks bison.
set -euo pipefail
. "$(dirname "$0")/_lib.sh"

BISON_VERSION="3.8.2"
mkdir -p "$BUILD_DIR/bison"
cd "$BUILD_DIR/bison"

if [ -x "install/bin/bison" ]; then
  echo "bison already built at $BISON_DIR/bin/bison"
  exit 0
fi

if [ ! -f "bison-${BISON_VERSION}.tar.gz" ]; then
  curl -sL "https://ftp.gnu.org/gnu/bison/bison-${BISON_VERSION}.tar.gz" -o "bison-${BISON_VERSION}.tar.gz"
fi
if [ ! -d "bison-${BISON_VERSION}" ]; then
  tar xzf "bison-${BISON_VERSION}.tar.gz"
fi
cd "bison-${BISON_VERSION}"
./configure --prefix="$BISON_DIR"
make -j"$(nproc)"
make install
echo "bison installed at $BISON_DIR/bin/bison"
