#!/usr/bin/env bash
# check-version-sync.sh — verify that version strings are consistent across all config files
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- Read versions (use sed for portability across Windows/Git Bash) ---
pkg_version=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$REPO_ROOT/app/package.json" | head -1)
tauri_version=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$REPO_ROOT/app/src-tauri/tauri.conf.json" | head -1)
cargo_version=$(sed -n 's/^version *= *"\([^"]*\)"/\1/p' "$REPO_ROOT/app/src-tauri/Cargo.toml" | head -1)

echo "Versions found:"
echo "  package.json        : $pkg_version"
echo "  tauri.conf.json     : $tauri_version"
echo "  Cargo.toml          : $cargo_version"

errors=0

# --- Compare versions ---
if [[ "$pkg_version" != "$tauri_version" ]]; then
  echo "ERROR: package.json ($pkg_version) != tauri.conf.json ($tauri_version)"
  errors=$((errors + 1))
fi

if [[ "$pkg_version" != "$cargo_version" ]]; then
  echo "ERROR: package.json ($pkg_version) != Cargo.toml ($cargo_version)"
  errors=$((errors + 1))
fi

# --- Safety net: ensure no hardcoded version strings remain in UI source ---
for file in "$REPO_ROOT/app/src/App.tsx" "$REPO_ROOT/app/src/components/AboutModal.tsx"; do
  if grep -qE 'v[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null; then
    echo "ERROR: $file still contains a hardcoded version string"
    errors=$((errors + 1))
  fi
done

if [[ $errors -gt 0 ]]; then
  echo ""
  echo "Version sync check FAILED ($errors error(s))"
  exit 1
fi

echo ""
echo "All versions in sync: $pkg_version"
