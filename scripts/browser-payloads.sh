#!/usr/bin/env bash
# browser-payloads.sh - the wasm payloads romdev-browser builds from, as a GitHub release of this fork.
#
# The binary packages gitignore their wasm (see .gitignore). Upstream fills a clean checkout from the published
# npm tarballs (scripts/fetch-payloads.mjs), but this fork's recipes build different glue (node,web,worker) and
# patched tools (sdasgb 32-bit addresses), so the payloads of the packages romdev-browser uses come from a local
# recipe build instead, published as the release browser-payloads-<hash> (hash of the files' contents).
# browser-payloads.json names the release a commit goes with, so a clean checkout of any commit gets its own.
#
# Usage:
#   scripts/browser-payloads.sh publish   after rebuilding any of them (build-image/build-wasm.sh build-<x>.sh):
#                                         uploads the release from HEAD (pushed), writes browser-payloads.json;
#                                         commit that file
#   scripts/browser-payloads.sh fetch     fill a checkout's payloads from the release browser-payloads.json names
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="ssk-play/romdev"
MANIFEST="browser-payloads.json"
ASSET="browser-payloads.tar.gz"
PKGS=(romdev-core-fceumm romdev-core-gambatte romdev-core-host romdev-toolchain-cc65 romdev-toolchain-sdcc)

files() {
  for p in "${PKGS[@]}"; do
    if [ -d "packages/$p/wasm" ]; then find "packages/$p/wasm" -type f ! -name .DS_Store; fi
  done | LC_ALL=C sort
}
content_hash() { files | xargs shasum -a 256 | shasum -a 256 | cut -c1-12; }
manifest() { node -p "require('./$MANIFEST').$1"; }

case "${1:-}" in
  publish)
    [ -n "$(files)" ] || { echo "no payloads under packages/{${PKGS[*]// /,}}/wasm" >&2; exit 1; }
    git fetch -q origin
    [ -n "$(git branch -r --contains HEAD)" ] || { echo "push HEAD first: the release points at the commit it was built from" >&2; exit 1; }
    TAG="browser-payloads-$(content_hash)"
    TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
    if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
      echo "· $TAG already published"
      gh release download "$TAG" -R "$REPO" -p "$ASSET" -D "$TMP"
    else
      files | COPYFILE_DISABLE=1 tar -czf "$TMP/$ASSET" -T -
      gh release create "$TAG" "$TMP/$ASSET" -R "$REPO" --target "$(git rev-parse HEAD)" --title "$TAG" \
        --notes "WASM payloads of ${PKGS[*]}, built with this commit's recipes (build-image/build-wasm.sh). Fetched by scripts/browser-payloads.sh."
      echo "✓ published $TAG"
    fi
    SHA="$(shasum -a 256 "$TMP/$ASSET" | cut -d' ' -f1)"
    printf '{\n  "release": "%s",\n  "sha256": "%s"\n}\n' "$TAG" "$SHA" > "$MANIFEST"
    echo "✓ wrote $MANIFEST; commit it"
    ;;
  fetch)
    TAG="$(manifest release)"; SHA="$(manifest sha256)"
    if [ -n "$(files)" ] && [ "browser-payloads-$(content_hash)" = "$TAG" ]; then echo "· payloads already match $TAG"; exit 0; fi
    TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
    curl -fsSL "https://github.com/$REPO/releases/download/$TAG/$ASSET" -o "$TMP/$ASSET"
    [ "$(shasum -a 256 "$TMP/$ASSET" | cut -d' ' -f1)" = "$SHA" ] || { echo "$ASSET of $TAG does not match $MANIFEST" >&2; exit 1; }
    tar -xzf "$TMP/$ASSET"
    [ "browser-payloads-$(content_hash)" = "$TAG" ] || { echo "payloads after fetch do not match $TAG (stray files in packages/*/wasm?)" >&2; exit 1; }
    echo "✓ payloads from $TAG"
    ;;
  *) sed -n '2,15p' "$0" >&2; exit 2 ;;
esac
