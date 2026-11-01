#!/usr/bin/env bash
# check-version-sync.sh — verify that the app version is the same in every file that carries it
#
# Usage: scripts/check-version-sync.sh [ref]
#   Without a ref, checks the working tree. With one (e.g. a commit SHA), checks that commit.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
REF="${1:-}"

# File contents from the working tree or from $REF. tr: Windows checkouts may have CRLF.
read_file() {
  if [[ -n "$REF" ]]; then git show "$REF:$1"; else cat "$1"; fi | tr -d '\r'
}
json_field() { read_file "$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log($2)})"; }

pkg_version=$(json_field app/package.json "j.version")
pkglock_version=$(json_field app/package-lock.json "j.version")
pkglock_root_version=$(json_field app/package-lock.json "j.packages[''].version")
tauri_version=$(json_field app/src-tauri/tauri.conf.json "j.version")
# The first `version =` line is the [package] one.
cargo_version=$(read_file app/src-tauri/Cargo.toml | sed -n 's/^version *= *"\([^"]*\)".*/\1/p' | head -1)
# The [[package]] entry for this crate in Cargo.lock: the line after `name = "parq-bench"`.
cargolock_version=$(read_file app/src-tauri/Cargo.lock | sed -n '/^name = "parq-bench"$/{n;s/^version = "\([^"]*\)"$/\1/p;}' | head -1)

echo "Versions found${REF:+ at $REF}:"
echo "  package.json        : $pkg_version"
echo "  package-lock.json   : $pkglock_version / $pkglock_root_version"
echo "  tauri.conf.json     : $tauri_version"
echo "  Cargo.toml          : $cargo_version"
echo "  Cargo.lock          : $cargolock_version"

errors=0

if ! echo "$pkg_version" | grep -qE '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  echo "ERROR: package.json version '$pkg_version' is not X.Y.Z"
  errors=$((errors + 1))
fi

for pair in "package-lock.json:$pkglock_version" "package-lock.json (packages[\"\"]):$pkglock_root_version" \
            "tauri.conf.json:$tauri_version" "Cargo.toml:$cargo_version" "Cargo.lock:$cargolock_version"; do
  name="${pair%:*}"
  version="${pair##*:}"
  if [[ "$version" != "$pkg_version" ]]; then
    echo "ERROR: $name ($version) != package.json ($pkg_version)"
    errors=$((errors + 1))
  fi
done

# --- Safety net: ensure no hardcoded version strings remain in UI source ---
for file in app/src/App.tsx app/src/components/AboutModal.tsx; do
  if read_file "$file" 2>/dev/null | grep -qE 'v[0-9]+\.[0-9]+\.[0-9]+'; then
    echo "ERROR: $file still contains a hardcoded version string"
    errors=$((errors + 1))
  fi
done

if [[ $errors -gt 0 ]]; then
  echo ""
  echo "Version sync check FAILED ($errors error(s)). Fix with: scripts/bump-version.sh <version>"
  exit 1
fi

echo ""
echo "All versions in sync: $pkg_version"
