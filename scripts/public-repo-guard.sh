#!/usr/bin/env bash
#
# public-repo-guard.sh — block internal infra / control-plane / ops leaks, and
# doubled-bracket cross-references, from landing in this PUBLIC repo.
#
# gitleaks + the pattern-scan catch classic *secrets* (API keys, private
# keys). They do NOT catch internal infrastructure topology, control-plane
# DB schema, SSH-as-root ops chains or staging hostnames — none of which are
# "secrets" in the regex sense, yet all of which belong only in the private
# repo. This guard fills that gap.
#
# Scope note, so the header is not read as a promise it does not keep: the
# cross-reference class below matches ONE form — the doubled-bracket link. Plain
# prose citing a path inside the private repo still passes, deliberately, because
# some of those citations are load-bearing (the release script coordinates both
# repos and would be worse without them). Triaging the rest is tracked separately.
#
# Two enforcement points (see lefthook.yml pre-push + the CI workflow):
#   - pre-push hook   — scans the whole tracked tree, fast local feedback
#   - CI on PRs       — scans the whole tracked tree (cannot be bypassed
#                       with `git push --no-verify`)
#
# Usage:
#   scripts/public-repo-guard.sh           # scan whole tracked tree (both of the above)
#   scripts/public-repo-guard.sh --staged  # scan staged files only — MANUAL use;
#                                          # lefthook.yml:23 invokes the guard with
#                                          # no argument, so the hook does NOT take
#                                          # this path.
#
# Exit 0 = clean, exit 1 = a leak marker was found.
#
# ── Escape hatches (for legitimately public mentions) ──────────────────
#   1. Whole-file allow: add the path to ALLOW_FILES below (only for docs
#      that describe the public managed service by design).
#   2. Inline allow: put the pragma `public-repo-guard:allow` anywhere on
#      the offending line, ideally with a short reason. Use sparingly.
#      Accepted for the SOFT (dual-use hostname) class and for the
#      cross-reference class, whose shape legal code can also produce —
#      HARD markers are never exempt.

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
# Separator-tolerant on purpose: a hyphen-only pattern let through the
# underscore, all-caps, space-separated and org-name spellings — each verified
# to slip past before, blocked after. The examples are NOT written out here:
# one of them is the product's own env-var name, i.e. exactly the kind of
# uniquely-searchable string this class exists to keep out. See
# tests/public-repo-guard.test.ts for the concrete cases, assembled at runtime.
#
# The default port is matched in its two loopback spellings (127.0.0.1: and
# localhost:). A bare port number is deliberately NOT matched — it is too
# common to block on its own, so `PORT = <n>` or a non-loopback host will pass.
#
# The org and port fragments are CONCATENATED rather than written out. That is
# not obfuscation against a reader — anyone reading this file sees them. It
# exists so a full-text search for the vendor's name does not surface this repo,
# which is the actual leak vector. Otherwise the pattern would re-plant verbatim
# what it exists to keep out.
_org='router'"-for-"'me'
_port='83'"17"
HARD_LOCAL_TOOLING="cli[-_. ]?proxy|local[-_. ]?eval[-_. ]?key|${_org}|127\.0\.0\.1:${_port}|localhost:${_port}"

# Third class — internal cross-reference slugs in the doubled-bracket link form.
# The private repo and the maintainer's own notes address items by slug that way.
# Such an id resolves to nothing a reader of THIS repo can open, and the slug names
# themselves expose how private material is filed — so they are noise here at best.
# 17 instances across 12 files predated this pattern; all were removed in the same
# commit, which is why it can start at zero rather than permanently red.
#
# The body must be slug-shaped: a comma is what keeps the pattern off a nested array
# literal, which is otherwise the same bracket pair. Spaces ARE allowed in the body,
# because one of the 17 was free text rather than a slug — a slug-only class let that
# exact form back in, which is what the review caught.
#
# Two honest limits, both asserted in tests/public-repo-guard.test.ts. Every marker
# lives THERE, assembled at runtime; this file names none, which is why SELF_EXCLUDE
# is a convenience here and not the thing holding the guard up.
#
#  1. A line-based grep cannot see a link SPLIT ACROSS LINES, and one of the 17 was.
#     REF_OPENER catches the opening line of that form; it has zero hits on the tree
#     today, so it costs nothing. A link whose opener sits at a line end with no
#     slug-ish text after it is still invisible — accepted, not solved.
#  2. Legal TypeScript wears the same brackets — a nested-array destructure or a
#     nested numeric literal — and no pattern that catches free-text bodies can tell
#     them apart. So INTERNAL_REF, unlike the two HARD classes above, honours the
#     inline pragma. Without that escape a legitimate line would hard-block a commit
#     and the only way past would be a hook bypass, which is worse than what is
#     guarded. There are zero such lines today; the pragma is for the one that comes.
#     REF_OPENER needs no pragma branch of its own — see the loop below.
REF_SLUG_BODY='[A-Za-z0-9_][A-Za-z0-9_. /#|-]*'
INTERNAL_REF="\\[\\[${REF_SLUG_BODY}\\]\\]"
# The trailing anchor is `\$` — ONE backslash. In double quotes that yields a bare
# `$`, which grep -E reads as end-of-line. Writing `\\$` yields a literal `\$`,
# i.e. a dollar CHARACTER, and the pattern silently stops anchoring. Tried it while
# tidying the quoting; the split-line test caught it, which is the point of having it.
REF_OPENER="\\[\\[${REF_SLUG_BODY}\$"

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

  # Internal cross-reference slug — case-SENSITIVE and a separate grep: the pattern
  # is anchored on bracket shape, so the -i of the run above would buy nothing and
  # only widen it. Honours the inline pragma (see the class comment for why).
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      *"$PRAGMA"*) continue ;;
    esac
    echo "❌ internal cross-reference in $f (state the reason inline instead):"
    echo "     ${line}"
    violations=$((violations + 1))
  done < <(grep -nIE "$INTERNAL_REF" "$f" 2>/dev/null || true)

  # The opening line of a link split across lines. Reported separately so the
  # message can say why it looks incomplete.
  #
  # No pragma check here, unlike the loop above, and that is not an oversight: this
  # pattern anchors to END OF LINE, and the pragma contains a colon, which the body
  # class excludes. Annotating such a line therefore stops it matching at all — the
  # escape works, it just works one step earlier. A pragma branch here would be
  # unreachable, and the test asserting it would pass no matter what the branch did.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "❌ internal cross-reference opened in $f and continued on the next line:"
    echo "     ${line}"
    violations=$((violations + 1))
  done < <(grep -nIE "$REF_OPENER" "$f" 2>/dev/null || true)

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
  echo "public-repo-guard: ${violations} marker(s) found — this is the PUBLIC repo."
  echo "Move the offending content to the private pro repo; for a cross-reference,"
  echo "state the reason inline instead of citing an id. If the mention is genuinely"
  echo "public-safe, annotate the line with '${PRAGMA}: <reason>' — accepted for the"
  echo "hostname and cross-reference classes, never for a HARD leak marker."
  exit 1
fi

echo "public-repo-guard: clean ✓"
