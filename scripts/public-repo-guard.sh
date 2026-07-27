#!/usr/bin/env bash
#
# public-repo-guard.sh — block internal infra / control-plane / ops leaks
# from landing in this PUBLIC, source-available repo.
#
# gitleaks + the pattern-scan catch classic *secrets* (API keys, private
# keys). They do NOT catch internal infrastructure topology, control-plane
# DB schema, SSH-as-root ops chains or staging hostnames — none of which
# are "secrets" in the regex sense, yet all of which belong only in the
# private pro repo. This guard fills that gap.
#
# Two enforcement points (see lefthook.yml pre-push + the CI workflow):
#   - pre-push hook   — scans staged changes, fast local feedback
#   - CI on PRs       — scans the whole tracked tree (cannot be bypassed
#                       with `git push --no-verify`)
#
# Usage:
#   scripts/public-repo-guard.sh           # scan whole tracked tree (CI)
#   scripts/public-repo-guard.sh --staged  # scan staged files only (hook)
#
# Exit 0 = clean, exit 1 = a leak marker was found.
#
# ── Escape hatches (for legitimately public mentions) ──────────────────
#   1. Whole-file allow: add the path to ALLOW_FILES below (only for docs
#      that describe the public managed service by design).
#   2. Inline allow: put the pragma `public-repo-guard:allow` anywhere on
#      the offending line, ideally with a short reason. Use sparingly and
#      only for the SOFT (dual-use hostname) patterns — HARD markers are
#      never exempt.

set -euo pipefail

PRAGMA='public-repo-guard:allow'

# Files allowed to mention the public managed-service hostnames wholesale —
# they document the service on purpose. HARD markers are still rejected here.
ALLOW_FILES='SECURITY.md SUBPROCESSORS.md CHANGELOG.md'

# This guard + its CI workflow necessarily contain the patterns themselves.
SELF_EXCLUDE='scripts/public-repo-guard.sh .github/workflows/public-repo-guard.yml'

# HARD — unambiguous internal control-plane / ops markers. NEVER legitimate
# in the public repo; no escape hatch. Each is a recipe or schema detail
# that only exists inside lynox's managed-hosting infrastructure.
HARD='control-staging\.lynox\.cloud|root@control|managed_tenant_hosts|ssh_private_key|hetzner_server_ip|instance_secret|/opt/lynox-(managed|pilot)|MANAGED_ADMIN_TOKEN|:4000/admin|control-plane-staging|greenmail-staging-allowlist|managed_instances|restic_password|backup_repo_password|host-staging|staging-admin-curl|46\.224\.229\.143|\.lynox/admin-token|lynox[_-]managed'

# HARD, second class — the OPERATOR's own local tooling. An eval/replay run may
# be pointed at a self-managed model host so shared API credits stay free, but
# WHICH product that is, where its credential lives, and what backs it are all
# operator-private. This leaked once (2026-07-27) in the DK eval harness, which
# named the vendor, linked its repo and documented the key path — merged and
# public before anyone looked. Configure such a host ONLY through the env-var
# indirection (LYNOX_KNOWLEDGE_PROXY_URL / _KEY / _KEY_FILE); a vendor name
# never has to appear in this repo.
#
# Separator-tolerant on purpose: a plain `cli-?proxy|local-eval-key` let through
# cli_proxy, CLI_PROXY_API_KEY, local_eval_key, "cli proxy" and the vendor's
# GitHub org — all verified to slip past it. The default port is matched too: it
# is a unique fingerprint on its own (searching it names the product).
#
# The org and port fragments are CONCATENATED rather than written out. That is
# not obfuscation against a reader — anyone reading this file sees them. It
# exists so a full-text search for the vendor's name does not surface this repo,
# which is the actual leak vector. Otherwise the pattern would re-plant verbatim
# what it exists to keep out.
_org='router'"-for-"'me'
_port='83'"17"
HARD_LOCAL_TOOLING="cli[-_. ]?proxy|local[-_. ]?eval[-_. ]?key|${_org}|127\.0\.0\.1:${_port}|localhost:${_port}"

# SOFT — dual-use service hostnames. Legitimate in a few documented spots
# (allow-file or inline pragma), but flagged everywhere else to catch the
# recurring "hardcode the staging host as a script/test default" mistake.
#
# NOT covered here: the operator's name used as a deployment identifier
# ("canary rafael", "rafael prod"). ~16 such mentions predate this guard in
# code comments documenting real incidents; adding the pattern would paint the
# guard permanently red, which teaches bypassing rather than fixing. Track that
# cleanup separately — the name itself is legitimately public (LICENSE, README).
SOFT='engine\.lynox\.cloud|control\.lynox\.cloud'

mode_staged=false
[ "${1:-}" = "--staged" ] && mode_staged=true

# Candidate files (tracked text files only). Kept as a function + while-read
# loop rather than `mapfile` so it runs on macOS's stock bash 3.2 too.
list_files() {
  if $mode_staged; then
    git diff --cached --name-only --diff-filter=ACM
  else
    git ls-files
  fi
}

is_excluded() {
  local f="$1"
  for x in $SELF_EXCLUDE; do [ "$f" = "$x" ] && return 0; done
  return 1
}

is_allow_file() {
  local f="$1"
  for a in $ALLOW_FILES; do [ "$f" = "$a" ] && return 0; done
  return 1
}

violations=0

# PATHS — the content greps below never see file NAMES. A vendored tooling
# directory could therefore be committed (and enter the Docker build context)
# while every content scan stays clean. Check the tracked paths themselves.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  is_excluded "$f" && continue
  if printf '%s' "$f" | grep -qEi "$HARD_LOCAL_TOOLING"; then
    echo "❌ HARD leak marker (operator-local tooling) in PATH: $f"
    violations=$((violations + 1))
  fi
done < <(list_files)

while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  is_excluded "$f" && continue
  # Skip binaries.
  if grep -Iq . "$f" 2>/dev/null; then :; else continue; fi

  # HARD — no exemptions.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "❌ HARD leak marker in $f:"
    echo "     ${line}"
    violations=$((violations + 1))
  done < <(grep -nIE "$HARD" "$f" 2>/dev/null || true)

  # HARD (operator-local tooling) — case-INSENSITIVE (the -i below), so the
  # pattern stays short without spelling out the vendor name it keeps out.
  # Deliberately a separate grep from the main HARD run:
  # folding -i into the main HARD run makes `lynox[_-]managed` match every
  # legitimate LYNOX_MANAGED_* env var (164 false positives when tried).
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "❌ HARD leak marker (operator-local tooling) in $f:"
    echo "     ${line}"
    violations=$((violations + 1))
  done < <(grep -nIEi "$HARD_LOCAL_TOOLING" "$f" 2>/dev/null || true)

  # SOFT — exempt if whole-file allowed or line carries the pragma.
  is_allow_file "$f" && continue
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      *"$PRAGMA"*) continue ;;  # inline-allowed
    esac
    echo "⚠️  internal hostname in $f (add '${PRAGMA}' with a reason if intentional):"
    echo "     ${line}"
    violations=$((violations + 1))
  done < <(grep -nIE "$SOFT" "$f" 2>/dev/null || true)
done < <(list_files)

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "public-repo-guard: ${violations} leak marker(s) found — this is the PUBLIC repo."
  echo "Move the offending content to the private pro repo, or (SOFT only) annotate"
  echo "the line with '${PRAGMA}: <reason>' if the mention is genuinely public-safe."
  exit 1
fi

echo "public-repo-guard: clean ✓"
