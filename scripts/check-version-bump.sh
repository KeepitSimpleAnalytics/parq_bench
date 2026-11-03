#!/usr/bin/env bash
# check-version-bump.sh — fail when the commits since <base> call for a version bump that wasn't made.
#
# Usage: scripts/check-version-bump.sh [base-ref] [head-ref]
#   base-ref defaults to origin/main. Without head-ref, checks HEAD's commits and the
#   working tree's version files; with it, checks that commit.
#   EXTRA_SUBJECTS (env, one per line) are judged like commit subjects; CI passes the PR
#   title, which becomes the commit subject when a PR is squash-merged.
#
# Rules, from the commit subjects in <base>..<head> (merge commits ignored):
#   feat: ...             -> the version must rise by at least a minor step (0.8.0 -> 0.9.0)
#   fix: ...              -> the version must rise by at least a patch step (0.8.0 -> 0.8.1)
#   type!: ... (breaking) -> major step from 1.0.0 on; before 1.0, a minor step
#   anything else         -> no bump needed (docs:, ci:, chore:, refactor:, test:, ...)
# A scope is allowed: feat(sql): ... The version may never go down.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
BASE="${1:-origin/main}"
HEAD_REF="${2:-}"

for ref in "$BASE" ${HEAD_REF:+"$HEAD_REF"}; do
  if ! git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    echo "ERROR: ref '$ref' not found. Fetch it first (git fetch origin main)."
    exit 1
  fi
done

# The files must agree with each other before comparing against the base.
if ! sync_out=$(bash "$REPO_ROOT/scripts/check-version-sync.sh" $HEAD_REF 2>&1); then
  echo "$sync_out"
  exit 1
fi

version_at() { git show "$1:app/package.json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))"; }
base_version=$(version_at "$BASE")
if [[ -n "$HEAD_REF" ]]; then
  head_version=$(version_at "$HEAD_REF")
else
  head_version=$(node -p "require('./app/package.json').version")
fi

SEMVER='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
for v in "$base_version" "$head_version"; do
  if ! [[ "$v" =~ $SEMVER ]]; then
    echo "ERROR: version '$v' is not X.Y.Z; can't compare."
    exit 1
  fi
done

# Compare X.Y.Z versions: prints -1, 0 or 1. 10#: no octal surprises.
semver_cmp() {
  local IFS=.
  local -a a=($1) b=($2)
  for i in 0 1 2; do
    if (( 10#${a[i]} > 10#${b[i]} )); then echo 1; return; fi
    if (( 10#${a[i]} < 10#${b[i]} )); then echo -1; return; fi
  done
  echo 0
}

IFS=. read -r bmaj bmin bpat <<<"$base_version"

subjects=$(git log --no-merges --format=%s "$BASE..${HEAD_REF:-HEAD}")
if [[ -n "${EXTRA_SUBJECTS:-}" ]]; then
  subjects="$subjects"$'\n'"$EXTRA_SUBJECTS"
fi
need="none"
reasons=()
while IFS= read -r subject; do
  [[ -z "$subject" ]] && continue
  if [[ "$subject" =~ ^[a-zA-Z]+(\([^\)]*\))?!: ]]; then
    if (( bmaj >= 1 )); then level="major"; else level="minor"; fi
  elif [[ "$subject" =~ ^feat(\([^\)]*\))?: ]]; then
    level="minor"
  elif [[ "$subject" =~ ^fix(\([^\)]*\))?: ]]; then
    level="patch"
  else
    continue
  fi
  reasons+=("  $level: $subject")
  case "$need:$level" in
    none:*|patch:minor|patch:major|minor:major) need="$level" ;;
  esac
done <<<"$subjects"

echo "Base ($BASE) version: $base_version"
echo "New version         : $head_version"
echo "Bump required       : $need"
if (( ${#reasons[@]} > 0 )); then
  echo "Because of:"
  printf '%s\n' "${reasons[@]}"
fi

if [[ "$(semver_cmp "$head_version" "$base_version")" == "-1" ]]; then
  echo ""
  echo "ERROR: version went down ($base_version -> $head_version)."
  exit 1
fi

case "$need" in
  none)  minimum="$base_version" ;;
  patch) minimum="$bmaj.$bmin.$((bpat + 1))" ;;
  minor) minimum="$bmaj.$((bmin + 1)).0" ;;
  major) minimum="$((bmaj + 1)).0.0" ;;
esac

if [[ "$(semver_cmp "$head_version" "$minimum")" == "-1" ]]; then
  echo ""
  echo "ERROR: these changes need a $need bump, to at least $minimum."
  echo "Run: scripts/bump-version.sh $minimum   (or higher), then commit."
  exit 1
fi

echo ""
echo "Version bump OK."
