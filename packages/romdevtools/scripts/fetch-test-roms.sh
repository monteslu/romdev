#!/usr/bin/env bash
# Fetch public-domain test ROMs used by the integration tests.
# Not redistributed by our package — these go in test/roms/ which is gitignored.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROMS_DIR="$PROJECT_DIR/test/roms"

mkdir -p "$ROMS_DIR"

# nestest.nes — kevtris's NES CPU verification ROM. Public domain.
if [ ! -f "$ROMS_DIR/nestest.nes" ]; then
  echo "Fetching nestest.nes..."
  curl -sL 'http://nickmass.com/images/nestest.nes' -o "$ROMS_DIR/nestest.nes"
fi

echo "Test ROMs at $ROMS_DIR"
ls -la "$ROMS_DIR"
