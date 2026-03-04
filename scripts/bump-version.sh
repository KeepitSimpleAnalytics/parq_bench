#!/usr/bin/env bash
# bump-version.sh — update the version string in all config files at once
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <new-version>"
  echo "Example: $0 0.6.0"
  exit 1
fi

NEW_VERSION="$1"

# Basic semver validation
if ! echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "ERROR: '$NEW_VERSION' is not a valid semver (expected X.Y.Z)"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Bumping version to $NEW_VERSION ..."

# --- package.json ---
pkg="$REPO_ROOT/app/package.json"
sed -i "s/\"version\" *: *\"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$pkg"
echo "  Updated package.json"

# --- tauri.conf.json ---
tauri="$REPO_ROOT/app/src-tauri/tauri.conf.json"
sed -i "s/\"version\" *: *\"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$tauri"
echo "  Updated tauri.conf.json"

# --- Cargo.toml ---
cargo="$REPO_ROOT/app/src-tauri/Cargo.toml"
sed -i "s/^version = \".*\"/version = \"$NEW_VERSION\"/" "$cargo"
echo "  Updated Cargo.toml"

# --- Verify ---
echo ""
"$SCRIPT_DIR/check-version-sync.sh"

echo ""
echo "Next steps:"
echo "  git add -A && git commit -m \"chore: bump version to $NEW_VERSION\""
echo "  git tag v$NEW_VERSION"
echo "  git push origin main --tags"
