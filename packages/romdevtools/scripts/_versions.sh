#!/usr/bin/env bash
# Reads scripts/versions.json — the single source of truth for every upstream
# pin. Build scripts source this instead of hardcoding URLs/refs/versions.
#
# Uses `node` (guaranteed in the emsdk build image AND on the dev box) so the
# loader behaves identically locally and in Docker — no jq dependency.
#
# Helpers (all take a dotted path into versions.json, e.g. cores.fceumm):
#   pin_url <path>      -> upstream url
#   pin_ref <path>      -> human ref label (tag/branch)
#   pin_commit <path>   -> exact commit pin (git kinds)
#   pin_version <path>  -> version string (tarball kinds)
#   pin_sha <path>      -> sha256 (tarball kinds; may be UNVERIFIED-*)
#   pin_get <path> <k>  -> any field by key
#
# Plus:
#   fetch_pinned <path> <dest>          — shallow-fetch a git upstream at its
#                                         exact pinned commit (reproducible).
#   fetch_pinned_tarball <path> <dest>  — download a pinned tarball URL and
#                                         verify its sha256 (for kind:"tarball").

_VERSIONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSIONS_JSON="$_VERSIONS_DIR/versions.json"

if [ ! -f "$VERSIONS_JSON" ]; then
  echo "Error: $VERSIONS_JSON not found." >&2
  exit 1
fi

# pin_get <dotted.path> <key>  ->  prints the value (empty if missing)
pin_get() {
  node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const node = process.argv[2].split(".").reduce((o, k) => (o ?? {})[k], data);
    const v = node == null ? "" : (process.argv[3] ? node[process.argv[3]] : node);
    process.stdout.write(v == null ? "" : String(v));
  ' "$VERSIONS_JSON" "$1" "${2:-}"
}

pin_url()     { pin_get "$1" url; }
pin_ref()     { pin_get "$1" ref; }
pin_commit()  { pin_get "$1" commit; }
pin_version() { pin_get "$1" version; }
pin_sha()     { pin_get "$1" sha256; }

# fetch_pinned <dotted.path> <dest-dir>
# Clones the upstream to <dest-dir> pinned to its EXACT commit, shallow.
# Reproducible (commit, not branch) and small (no full history). Re-running
# with an existing checkout leaves it alone (build scripts re-apply patches).
fetch_pinned() {
  local keypath="$1" dst="$2"
  local url commit
  url="$(pin_url "$keypath")"
  commit="$(pin_commit "$keypath")"
  if [ -z "$url" ] || [ -z "$commit" ]; then
    echo "Error: no url/commit pin for '$keypath' in versions.json" >&2
    exit 1
  fi
  if [ -d "$dst" ]; then
    echo "Using existing checkout at $dst (pinned $keypath @ $commit)"
    return 0
  fi
  case "$commit" in
    UNVERIFIED-*)
      echo "Error: '$keypath' commit is '$commit' — resolve a real pin in versions.json before building." >&2
      exit 1 ;;
  esac
  echo "Fetching $url @ $commit -> $dst"
  mkdir -p "$dst"
  git -C "$dst" init -q
  git -C "$dst" remote add origin "$url"
  # Shallow fetch of just the pinned commit when the server allows it; fall
  # back to a shallow branch fetch + checkout for servers without uploadpack
  # allowReachableSHA1InWant (some mirrors).
  if git -C "$dst" fetch -q --depth 1 origin "$commit" 2>/dev/null; then
    git -C "$dst" checkout -q FETCH_HEAD
  else
    local ref; ref="$(pin_ref "$keypath")"
    echo "  (direct-commit fetch unsupported; shallow-fetching '$ref' then checking out $commit)"
    git -C "$dst" fetch -q --depth 50 origin "$ref"
    git -C "$dst" checkout -q "$commit"
  fi
}

# fetch_pinned_tarball <dotted.path> <dest-tarball>
# Downloads the pinned tarball URL to <dest-tarball> and verifies its sha256
# against versions.json. For upstreams that only serve a rolling "latest"
# tarball (no versioned URL), the sha256 IS the pin — a mismatch means upstream
# moved and must be reviewed as a deliberate bump. First build records the sha
# (prints it so it can be pasted into versions.json) instead of failing.
# Use for kind:"tarball" entries; fetch_pinned (git) is for kind:"git".
fetch_pinned_tarball() {
  local keypath="$1" dst="$2"
  local url want got
  url="$(pin_url "$keypath")"
  want="$(pin_sha "$keypath")"
  if [ -z "$url" ]; then
    echo "Error: no url pin for '$keypath' in versions.json" >&2
    exit 1
  fi
  if [ ! -f "$dst" ]; then
    echo "Fetching tarball $url -> $dst"
    curl -sL "$url" -o "$dst"
  fi
  got="$(sha256sum "$dst" | awk '{print $1}')"
  case "$want" in
    ""|UNVERIFIED-*)
      echo "NOTE: '$keypath' sha256 is unpinned. Recording observed sha256:" >&2
      echo "  $got" >&2
      echo "  → paste this into versions.json ($keypath.sha256) to lock the pin." >&2 ;;
    "$got")
      echo "sha256 OK for '$keypath' ($got)" ;;
    *)
      echo "Error: sha256 mismatch for '$keypath'." >&2
      echo "  expected: $want" >&2
      echo "  got:      $got" >&2
      echo "  Upstream moved. Review the change, then update versions.json deliberately." >&2
      exit 1 ;;
  esac
}
