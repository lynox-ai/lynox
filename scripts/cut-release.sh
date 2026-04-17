#!/usr/bin/env bash
# cut-release.sh — one-command release cut across the lynox workspace.
#
# Usage:
#   ./scripts/cut-release.sh 1.2.3
#   ./scripts/cut-release.sh 1.2.3 --dry-run     # show what would happen, no mutations
#   ./scripts/cut-release.sh 1.2.3 --no-edit     # skip $EDITOR for CHANGELOG draft
#   ./scripts/cut-release.sh 1.2.3 --force       # bypass "tag exists" guard
#
# What it does:
#   1. Preflight: semver, gh auth, both repos clean on main, version not yet tagged
#   2. Create release/vX.Y.Z branch in core + pro
#   3. Lockstep bump all 4 package.json versions to X.Y.Z
#   4. Draft CHANGELOG entry in core/CHANGELOG.md (from git log), open $EDITOR
#   5. Run full tests in both repos (typecheck + lint + vitest)
#   6. Commit, push, open PRs in both repos with cross-links
#   7. Poll until both PRs merged (30s interval, 30min timeout)
#   8. Sync main, tag vX.Y.Z in core, push tag, create gh release
#
# Idempotent: re-running detects existing branches / commits / PRs / tags
# and resumes from the current state. Safe to Ctrl+C and restart.
#
# Tag push triggers release.yml (docker build + push + npm publish).
# Production rollout is a separate step — see pro/scripts/deploy-prod.sh (PR 9).

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# Paths + constants
# ─────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_ROOT="$(cd "$CORE_DIR/.." && pwd)"
PRO_DIR="$WORKSPACE_ROOT/pro"

CORE_REPO="lynox-ai/lynox"
PRO_REPO="lynox-ai/lynox-pro"

PACKAGES=(
  "core/package.json"
  "core/packages/web-ui/package.json"
  "pro/packages/managed/package.json"
  "pro/packages/web/package.json"
)

# ─────────────────────────────────────────────────────────────────────
# Args
# ─────────────────────────────────────────────────────────────────────

VERSION=""
DRY_RUN=false
NO_EDIT=false
FORCE=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --no-edit) NO_EDIT=true ;;
    --force)   FORCE=true ;;
    -h|--help)
      sed -n '2,24p' "$0" | sed -E 's/^# ?//'
      exit 0
      ;;
    -*) echo "error: unknown flag: $arg" >&2; exit 2 ;;
    *)
      if [[ -n "$VERSION" ]]; then
        echo "error: version already set to '$VERSION', got extra arg: $arg" >&2
        exit 2
      fi
      VERSION="$arg"
      ;;
  esac
done

# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

c_blue()   { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
c_red()    { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }

die() { c_red "error: $*"; exit 1; }

step() { printf '\n'; c_blue "=== $* ==="; }

# Wrap a command so it prints-but-skips in --dry-run
run() {
  if $DRY_RUN; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

pkg_version() {
  node -p "require('$WORKSPACE_ROOT/$1').version"
}

set_pkg_version() {
  local rel_path="$1" version="$2"
  local abs="$WORKSPACE_ROOT/$rel_path"
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$abs', 'utf8'));
    pkg.version = '$version';
    fs.writeFileSync('$abs', JSON.stringify(pkg, null, 2) + '\n');
  "
}

# ─────────────────────────────────────────────────────────────────────
# Globals set by steps
# ─────────────────────────────────────────────────────────────────────

TAG=""
BRANCH=""
CORE_PR_NUM=""
PRO_PR_NUM=""

# ─────────────────────────────────────────────────────────────────────
# Step 1 — Preflight
# ─────────────────────────────────────────────────────────────────────

preflight() {
  step "Preflight"

  [[ -n "$VERSION" ]] || die "missing version arg. Usage: cut-release.sh X.Y.Z [--dry-run|--no-edit|--force]"
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must match X.Y.Z (semver), got: $VERSION"

  TAG="v$VERSION"
  BRANCH="release/$TAG"

  echo "  version:     $VERSION"
  echo "  tag:         $TAG"
  echo "  branch:      $BRANCH"
  echo "  workspace:   $WORKSPACE_ROOT"
  echo "  dry-run:     $DRY_RUN"

  command -v gh   >/dev/null || die "gh (GitHub CLI) not installed"
  command -v node >/dev/null || die "node not installed"
  command -v pnpm >/dev/null || die "pnpm not installed"
  command -v awk  >/dev/null || die "awk not installed"

  gh auth status >/dev/null 2>&1 || die "gh not authenticated (run: gh auth login)"

  [[ -d "$CORE_DIR/.git" ]] || die "core repo not found at $CORE_DIR"
  [[ -d "$PRO_DIR/.git"  ]] || die "pro repo not found at $PRO_DIR"

  # Fetch latest from origin so all branch/tag/merge detection is accurate
  for repo in core pro; do
    git -C "$WORKSPACE_ROOT/$repo" fetch origin --quiet --prune
  done

  for repo in core pro; do
    local dir="$WORKSPACE_ROOT/$repo"
    local current
    current=$(git -C "$dir" rev-parse --abbrev-ref HEAD)

    if [[ "$current" != "main" && "$current" != "$BRANCH" ]]; then
      die "$repo: must be on 'main' or '$BRANCH', currently on '$current'. Switch branch or stash WIP."
    fi

    # Only assert clean worktree + origin-sync when on main. Already-on-release-branch
    # means we're resuming, dirty state may be intentional (pnpm-lock regen etc.).
    if [[ "$current" == "main" ]]; then
      if ! git -C "$dir" diff --quiet || ! git -C "$dir" diff --cached --quiet; then
        die "$repo: worktree not clean on main. Stash or commit WIP before running cut-release (git -C $repo stash)."
      fi
      local main_sha origin_sha
      main_sha=$(git -C "$dir" rev-parse main)
      origin_sha=$(git -C "$dir" rev-parse origin/main)
      [[ "$main_sha" == "$origin_sha" ]] || die "$repo: local main ($main_sha) not in sync with origin/main ($origin_sha)"
    fi
  done

  # Tag guard (core holds release tags)
  if git -C "$CORE_DIR" rev-parse "$TAG" >/dev/null 2>&1; then
    if $FORCE; then
      c_yellow "  tag $TAG already exists — continuing (--force)"
    else
      die "tag $TAG already exists in core. Pick a new version or delete the tag first (and use --force)."
    fi
  fi

  c_green "  preflight ok"
}

# ─────────────────────────────────────────────────────────────────────
# Step 2 — Ensure release branches
# ─────────────────────────────────────────────────────────────────────

ensure_branches() {
  step "Ensure release branches ($BRANCH)"

  for repo in core pro; do
    local dir="$WORKSPACE_ROOT/$repo"
    local current
    current=$(git -C "$dir" rev-parse --abbrev-ref HEAD)

    if [[ "$current" == "$BRANCH" ]]; then
      echo "  $repo: already on $BRANCH"
    elif git -C "$dir" show-ref --verify --quiet "refs/heads/$BRANCH"; then
      echo "  $repo: branch exists, checking out"
      run git -C "$dir" checkout "$BRANCH"
    else
      echo "  $repo: creating branch from main"
      run git -C "$dir" checkout -b "$BRANCH"
    fi
  done
}

# ─────────────────────────────────────────────────────────────────────
# Step 3 — Lockstep version bump
# ─────────────────────────────────────────────────────────────────────

bump_versions() {
  step "Bump versions to $VERSION"

  local bumped_any=false
  for pkg in "${PACKAGES[@]}"; do
    local current
    current=$(pkg_version "$pkg")
    if [[ "$current" == "$VERSION" ]]; then
      echo "  $pkg: already at $VERSION"
    else
      echo "  $pkg: $current → $VERSION"
      if $DRY_RUN; then
        continue
      fi
      set_pkg_version "$pkg" "$VERSION"
      bumped_any=true
    fi
  done

  if [[ "$bumped_any" == "true" ]]; then
    echo "  regenerating lockfiles..."
    (cd "$CORE_DIR" && pnpm install --silent >/dev/null)
    (cd "$PRO_DIR"  && pnpm install --silent >/dev/null)
  fi
}

# ─────────────────────────────────────────────────────────────────────
# Step 4 — Assert lockstep
# ─────────────────────────────────────────────────────────────────────

assert_lockstep() {
  step "Assert lockstep"

  if $DRY_RUN; then
    echo "  (skipped in dry-run — versions not actually written)"
    return
  fi

  for pkg in "${PACKAGES[@]}"; do
    local actual
    actual=$(pkg_version "$pkg")
    [[ "$actual" == "$VERSION" ]] || die "lockstep fail: $pkg is at $actual, expected $VERSION"
    echo "  $pkg @ $actual ✓"
  done
  c_green "  all 4 packages at $VERSION"
}

# ─────────────────────────────────────────────────────────────────────
# Step 5 — CHANGELOG
# ─────────────────────────────────────────────────────────────────────

update_changelog() {
  step "Update CHANGELOG"

  local changelog="$CORE_DIR/CHANGELOG.md"
  [[ -f "$changelog" ]] || die "CHANGELOG.md not found at $changelog"

  if grep -qE "^## v?\[?${VERSION//./\\.}[] \t\r—–-]" "$changelog"; then
    echo "  CHANGELOG already has $VERSION section — skipping draft"
    return
  fi

  local prev_tag=""
  if prev_tag=$(git -C "$CORE_DIR" describe --tags --abbrev=0 2>/dev/null); then
    :
  fi

  local core_commits="" pro_commits="" since_date=""
  if [[ -n "$prev_tag" ]]; then
    core_commits=$(git -C "$CORE_DIR" log "$prev_tag..HEAD" --no-merges --format='- %s' 2>/dev/null || echo "")
    since_date=$(git -C "$CORE_DIR" log -1 --format=%aI "$prev_tag" 2>/dev/null || echo "")
    if [[ -n "$since_date" ]]; then
      pro_commits=$(git -C "$PRO_DIR" log --since="$since_date" --no-merges --format='- %s' 2>/dev/null || echo "")
    fi
  else
    core_commits=$(git -C "$CORE_DIR" log --no-merges --format='- %s' -20)
    pro_commits=$(git -C "$PRO_DIR"  log --no-merges --format='- %s' -20)
  fi

  local today
  today=$(date +%Y-%m-%d)

  local draft
  draft=$(cat <<DRAFT
## $VERSION — $today

### Added

<!-- new features -->

### Changed

<!-- existing features touched -->

### Fixed

<!-- bug fixes -->

<!-- Reference — raw commits since ${prev_tag:-<first release>} (delete this block before saving):

Core:
$core_commits

Pro:
$pro_commits
-->

DRAFT
)

  if $DRY_RUN; then
    echo "  [dry-run] would prepend draft section to CHANGELOG.md:"
    printf '%s\n' "$draft" | sed 's/^/    /'
    return
  fi

  # Prepend draft after top "# Changelog" header.
  # We avoid awk -v because the draft may contain newlines and special chars
  # from commit messages that break "newline in string" parsing.
  local tmp draft_file
  tmp=$(mktemp)
  draft_file=$(mktemp)
  printf '%s\n' "$draft" > "$draft_file"
  {
    head -n 1 "$changelog"          # "# Changelog"
    echo ""
    cat "$draft_file"
    # Skip the first line (header) and any immediately following blank line
    tail -n +2 "$changelog" | awk 'NR == 1 && /^$/ { next } { print }'
  } > "$tmp"
  rm -f "$draft_file"
  mv "$tmp" "$changelog"

  if ! $NO_EDIT; then
    local editor="${EDITOR:-${VISUAL:-vi}}"
    echo "  opening $editor for CHANGELOG refinement (save+quit when done)..."
    "$editor" "$changelog"
  fi

  grep -qE "^## v?\[?${VERSION//./\\.}" "$changelog" || die "CHANGELOG no longer contains $VERSION section after edit (aborting)"

  c_green "  CHANGELOG updated"
}

# ─────────────────────────────────────────────────────────────────────
# Step 6 — Full tests
# ─────────────────────────────────────────────────────────────────────

run_tests() {
  step "Full test suite (both repos)"

  if $DRY_RUN; then
    echo "  [dry-run] skipping tests"
    return
  fi

  echo "  core: typecheck + lint + vitest"
  (cd "$CORE_DIR" && pnpm run typecheck && pnpm run lint && pnpm test) \
    || die "core tests failed — fix before re-running"

  echo "  core/packages/web-ui: typecheck"
  (cd "$CORE_DIR/packages/web-ui" && pnpm run typecheck) \
    || die "web-ui typecheck failed"

  echo "  pro: typecheck + test"
  (cd "$PRO_DIR" && pnpm run typecheck && pnpm test) \
    || die "pro tests failed"

  c_green "  all tests pass"
}

# ─────────────────────────────────────────────────────────────────────
# Step 7 — Commit + push + open PRs
# ─────────────────────────────────────────────────────────────────────

pr_body() {
  cat <<BODY
Lockstep release bump to **$VERSION** across all 4 workspace packages.

See \`core/CHANGELOG.md\` for full release notes.

## Companion PR

Both core + pro PRs carry the same title and must be merged to land this release. The sibling PR lives in the other repo.

## How this PR was created

Generated by \`./scripts/cut-release.sh $VERSION\` (Phase 4 release workflow sprint).

After both PRs merge, re-running \`cut-release.sh $VERSION\` is idempotent and will:
1. Sync main
2. Tag \`$TAG\` in core
3. Push tag (triggers \`release.yml\` → docker + npm publish)
4. Create GitHub release with CHANGELOG notes

## Test plan

- [x] Lockstep assertion across all 4 package.json files
- [x] Full typecheck + lint + vitest in core
- [x] svelte-check in web-ui
- [x] pnpm -r typecheck + test in pro

🤖 Generated with [cut-release.sh](https://github.com/lynox-ai/lynox/blob/main/scripts/cut-release.sh)
BODY
}

ensure_pr_for() {
  local label="$1" dir="$2" repo="$3" type="$4"

  echo "  --- $label ---"

  local has_unstaged_changes=false
  if ! git -C "$dir" diff --quiet || ! git -C "$dir" diff --cached --quiet; then
    has_unstaged_changes=true
  fi

  local has_release_commit=false
  if git -C "$dir" log origin/main..HEAD --format='%s' 2>/dev/null | grep -q "^chore(release): $TAG"; then
    has_release_commit=true
  fi

  if [[ "$has_unstaged_changes" == "true" ]]; then
    if $DRY_RUN; then
      echo "    [dry-run] would stage + commit release changes"
    else
      if [[ "$type" == "core" ]]; then
        git -C "$dir" add \
          package.json \
          packages/web-ui/package.json \
          CHANGELOG.md \
          pnpm-lock.yaml 2>/dev/null || true
      else
        git -C "$dir" add \
          packages/managed/package.json \
          packages/web/package.json \
          pnpm-lock.yaml 2>/dev/null || true
      fi

      # Guard: verify only release-relevant files are staged
      local unexpected
      unexpected=$(git -C "$dir" diff --cached --name-only | grep -vE '^(package\.json|packages/(web-ui|managed|web)/package\.json|CHANGELOG\.md|pnpm-lock\.yaml)$' || true)
      if [[ -n "$unexpected" ]]; then
        die "$label: unexpected files staged for release commit — refusing:
$unexpected"
      fi

      if ! git -C "$dir" diff --cached --quiet; then
        git -C "$dir" commit -m "$(cat <<EOF
chore(release): $TAG

Lockstep release bump to $VERSION across all workspace packages.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
        has_release_commit=true
      else
        echo "    nothing to commit after staging"
      fi
    fi
  elif [[ "$has_release_commit" == "true" ]]; then
    echo "    release commit already exists"
  else
    echo "    no changes to commit (versions already up-to-date + no commit yet)"
  fi

  # Push branch
  run git -C "$dir" push -u origin "$BRANCH"

  # Ensure PR
  local pr_num=""
  pr_num=$(gh pr list -R "$repo" --head "$BRANCH" --state open --json number --jq '.[0].number // empty' 2>/dev/null || echo "")

  if [[ -z "$pr_num" ]]; then
    # Maybe merged already? If so, skip silently.
    local merged_num
    merged_num=$(gh pr list -R "$repo" --head "$BRANCH" --state merged --json number --jq '.[0].number // empty' 2>/dev/null || echo "")
    if [[ -n "$merged_num" ]]; then
      echo "    PR #$merged_num already merged on $repo"
      pr_num="$merged_num"
    fi
  fi

  if [[ -z "$pr_num" ]]; then
    if $DRY_RUN; then
      echo "    [dry-run] would create PR on $repo"
      pr_num="(dry-run)"
    else
      gh pr create -R "$repo" \
        --title "chore(release): $TAG" \
        --body "$(pr_body)" \
        --head "$BRANCH" \
        --base main >/dev/null
      pr_num=$(gh pr list -R "$repo" --head "$BRANCH" --state open --json number --jq '.[0].number')
      echo "    PR #$pr_num created: https://github.com/$repo/pull/$pr_num"
    fi
  else
    echo "    PR #$pr_num already exists: https://github.com/$repo/pull/$pr_num"
  fi

  if [[ "$label" == "core" ]]; then
    CORE_PR_NUM="$pr_num"
  else
    PRO_PR_NUM="$pr_num"
  fi
}

commit_push_pr() {
  step "Commit + push + open PRs"
  ensure_pr_for core "$CORE_DIR" "$CORE_REPO" "core"
  ensure_pr_for pro  "$PRO_DIR"  "$PRO_REPO"  "pro"
}

# ─────────────────────────────────────────────────────────────────────
# Step 8 — Poll for merge
# ─────────────────────────────────────────────────────────────────────

poll_merge() {
  step "Poll for merge (both PRs)"

  if $DRY_RUN; then
    echo "  [dry-run] skipping poll"
    return
  fi

  [[ -n "$CORE_PR_NUM" && -n "$PRO_PR_NUM" ]] || die "internal error: PR numbers not set"

  local max_iters=60  # 60 × 30s = 30 min
  local i=0
  while (( i < max_iters )); do
    local core_merged pro_merged
    core_merged=$(gh pr view "$CORE_PR_NUM" -R "$CORE_REPO"  --json mergedAt --jq '.mergedAt // ""')
    pro_merged=$( gh pr view "$PRO_PR_NUM"  -R "$PRO_REPO"   --json mergedAt --jq '.mergedAt // ""')

    if [[ -n "$core_merged" && -n "$pro_merged" ]]; then
      printf '\n'
      c_green "  both merged (core @ $core_merged, pro @ $pro_merged)"
      return
    fi

    local core_status pro_status
    [[ -n "$core_merged" ]] && core_status="merged" || core_status="open"
    [[ -n "$pro_merged"  ]] && pro_status="merged"  || pro_status="open"
    printf '\r  [%02d/%02d] core:%-6s pro:%-6s  ' $((i+1)) $max_iters "$core_status" "$pro_status"

    sleep 30
    ((i++))
  done

  printf '\n'
  die "timeout: PRs not merged after 30min. Re-run cut-release.sh $VERSION to resume from this point."
}

# ─────────────────────────────────────────────────────────────────────
# Step 9 — Tag + gh release
# ─────────────────────────────────────────────────────────────────────

extract_changelog_section() {
  # Prints the CHANGELOG entry body for $VERSION (without the header line itself)
  awk -v v="$VERSION" '
    BEGIN { in_section = 0 }
    /^## / {
      if (in_section) exit
      if ($0 ~ "^## v?\\[?" v "([] \t\r—–-]|$)") { in_section = 1; next }
    }
    in_section { print }
  ' "$CORE_DIR/CHANGELOG.md"
}

tag_and_release() {
  step "Tag + GitHub release"

  for repo in core pro; do
    local dir="$WORKSPACE_ROOT/$repo"
    run git -C "$dir" checkout main
    run git -C "$dir" pull --ff-only
  done

  if $DRY_RUN; then
    echo "  [dry-run] skipping tag + release creation"
    return
  fi

  # Verify HEAD carries the release version. We check package.json instead of
  # the commit subject because GitHub merge commits have their own title
  # ("Merge pull request #N from ..."), not the original commit message.
  local head_version
  head_version=$(pkg_version "core/package.json")
  if [[ "$head_version" != "$VERSION" ]]; then
    local core_head_msg
    core_head_msg=$(git -C "$CORE_DIR" log -1 --format=%s)
    die "core HEAD does not carry version $VERSION (package.json has '$head_version', commit: '$core_head_msg'). Was the correct PR merged?"
  fi

  if git -C "$CORE_DIR" rev-parse "$TAG" >/dev/null 2>&1; then
    echo "  tag $TAG already exists locally — skipping create"
  else
    git -C "$CORE_DIR" tag -a "$TAG" -m "Release $TAG"
    echo "  tag $TAG created locally"
  fi

  # Push tag only if not already on origin
  if git -C "$CORE_DIR" ls-remote --tags origin "$TAG" | grep -q "$TAG"; then
    echo "  tag $TAG already on origin — skipping push"
  else
    git -C "$CORE_DIR" push origin "$TAG"
    echo "  tag $TAG pushed to origin (this triggers release.yml)"
  fi

  # Build gh release notes from CHANGELOG
  local notes
  notes=$(extract_changelog_section)
  if [[ -z "$notes" ]]; then
    c_yellow "  warning: CHANGELOG section for $VERSION not extractable — using placeholder"
    notes="Release $TAG"
  fi

  if gh release view "$TAG" -R "$CORE_REPO" >/dev/null 2>&1; then
    echo "  gh release $TAG already exists — skipping"
  else
    printf '%s\n' "$notes" | gh release create "$TAG" -R "$CORE_REPO" \
      --title "$TAG" \
      --notes-file -
    echo "  gh release $TAG created: https://github.com/$CORE_REPO/releases/tag/$TAG"
  fi
}

# ─────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────

main() {
  preflight
  ensure_branches
  bump_versions
  assert_lockstep
  update_changelog
  run_tests
  commit_push_pr
  poll_merge
  tag_and_release

  step "Release $TAG complete"
  echo ""
  echo "  What just happened:"
  echo "    - All 4 packages bumped to $VERSION"
  echo "    - PRs opened, merged, and tagged as $TAG"
  echo "    - Tag push triggers release.yml (docker + npm publish)"
  echo ""
  echo "  Next steps:"
  echo "    - Monitor release.yml:  gh run watch -R $CORE_REPO"
  echo "    - Production rollout:   ./pro/scripts/deploy-prod.sh $VERSION   (coming in PR 9)"
  echo ""
}

main "$@"
