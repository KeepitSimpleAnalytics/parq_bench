#!/usr/bin/env bash
# bump-version.sh — set the app version in every file that carries it
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <new-version>"
  echo "Example: $0 0.9.0"
  exit 1
fi

NEW_VERSION="$1"

if ! echo "$NEW_VERSION" | grep -qE '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  echo "ERROR: '$NEW_VERSION' is not a valid semver (expected X.Y.Z)"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

FILES=(app/package.json app/package-lock.json app/src-tauri/tauri.conf.json app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock)

# Put every file back if any step fails, so the tree is never left half-bumped.
BACKUP="$(mktemp -d)"
for f in "${FILES[@]}"; do mkdir -p "$BACKUP/$(dirname "$f")"; cp "$f" "$BACKUP/$f"; done
finished=0
# On any exit before the end (error, Ctrl-C, kill), put the files back.
on_exit() {
  if [[ $finished -ne 1 ]]; then
    echo "ERROR: bump did not finish; restoring the version files." >&2
    for f in "${FILES[@]}"; do cp "$BACKUP/$f" "$f"; done
  fi
  rm -rf "$BACKUP"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

echo "Bumping version to $NEW_VERSION ..."

# --- Cargo.toml (only the [package] version) + Cargo.lock ---
NEW_VERSION="$NEW_VERSION" node -e '
  const fs = require("fs"), p = "app/src-tauri/Cargo.toml";
  // Line by line, so only `version` inside the [package] section changes.
  const lines = fs.readFileSync(p, "utf8").split("\n");
  let section = "", done = false;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].match(/^\s*\[([^\]]+)\]/);
    if (header) { section = header[1].trim(); continue; }
    if (section === "package" && !done && /^version\s*=/.test(lines[i])) {
      lines[i] = lines[i].replace(/"[^"]*"/, `"${process.env.NEW_VERSION}"`);
      done = true;
    }
  }
  if (!done) { console.error("ERROR: no version in the [package] section of Cargo.toml"); process.exit(1); }
  fs.writeFileSync(p, lines.join("\n"));'
# Rewrites only this crate's entry in Cargo.lock; dependencies stay locked.
(cd app/src-tauri && cargo update --workspace --quiet)
echo "  Updated Cargo.toml, Cargo.lock"

# --- package.json + package-lock.json (npm writes both; no scripts, no git) ---
(cd app && npm version "$NEW_VERSION" --no-git-tag-version --allow-same-version --ignore-scripts >/dev/null)
echo "  Updated package.json, package-lock.json"

# --- tauri.conf.json ---
NEW_VERSION="$NEW_VERSION" node -e '
  const fs = require("fs"), p = "app/src-tauri/tauri.conf.json";
  const s = fs.readFileSync(p, "utf8");
  const out = s.replace(/("version"\s*:\s*")[^"]*(")/, `$1${process.env.NEW_VERSION}$2`);
  fs.writeFileSync(p, out);'
echo "  Updated tauri.conf.json"

# --- Verify ---
echo ""
bash scripts/check-version-sync.sh
finished=1

echo ""
echo "Next: commit on your branch, e.g."
echo "  git commit -am \"chore: bump version to $NEW_VERSION\""
echo "Merging the PR into main publishes v$NEW_VERSION automatically."
