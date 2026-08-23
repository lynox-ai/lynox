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
# Exit 0 = clean, exit 1 = a leak marker was found, exit 2 = the guard could not
# run (its file listing failed). The third code exists so "the tree is dirty" and
# "the gate never looked" stop being the same signal — see scripts/lib/guard-file-list.sh.
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

GUARD_NAME='public-repo-guard'
# shellcheck source=scripts/lib/guard-file-list.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/guard-file-list.sh"

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
# Spaces ARE allowed in the body, because one of the 17 was free text rather than a
# slug — a slug-only class let that exact form back in, which is what review caught.
# What the body class excludes is punctuation like a comma or a quote, which is why
# `new Map([[k, v]])` does not match. It does NOT separate refs from every nested
# array: a bare `[[42]]` or `[[key]]` matches, and cannot be told from a ref by shape.
# That is what limit 2 below is about, and why the pragma exists.
#
# Two honest limits, both asserted in tests/public-repo-guard.test.ts, where every
# marker lives and is assembled at runtime. SELF_EXCLUDE stays load-bearing for the
# HARD classes above, which this file necessarily spells out; for the reference
# class it covers only the worked examples in the prose below — the pattern
# definitions themselves do not match, since the backslashes break the brackets.
#
#  1. A line-based grep cannot see a link SPLIT ACROSS LINES, and one of the 17 was.
#     REF_OPENER catches the opening line of that form; it has zero hits on the tree
#     today, so it costs nothing. A link whose opener sits at a line end with no
#     slug-ish text after it is still invisible — accepted, not solved.
#  2. Legal TypeScript wears the same brackets — a nested-array destructure or a
#     nested numeric literal — and no pattern that catches free-text bodies can tell
#     them apart. So BOTH reference patterns, unlike the two HARD classes above,
#     honour the inline pragma. Without that escape a legitimate line would hard-block
#     a commit and the only way past would be a hook bypass, which is worse than what
#     is guarded. There are zero such lines today; the pragma is for the one that
#     comes — and one round of this review proved how easily it gets removed.
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
#
# NUL-separated, because the textual default is a silent hole: git QUOTES any
# path holding a non-ASCII byte (`docs/Übersicht.md` comes out as
# `"docs/\303\234bersicht.md"`, quotes included). The `[ -f "./$f" ]` test below
# then fails on that literal, the loop `continue`s, and the file is skipped by
# EVERY class — including the HARD ones — while the guard reports a clean tree.
# Measured: a tracked file with an umlaut in its name and `control-staging…` in
# its body scanned as clean, exit 0.
#
# `-z` alone is the fix, and that is worth stating because the first version also
# passed `-c core.quotePath=false`: a mutation showed the suite green without it,
# and `git ls-files -z` does emit raw bytes regardless of that setting. The extra
# option only suggested it was load-bearing. `-z` additionally covers a newline
# in a filename, which the line-based read could not.

# Materialise the listing ONCE, via the shared helper, which checks the producer's
# status. The old shape was `done < <(list_files)`, and a process substitution
# hides its producer's exit status from `set -e` — see scripts/lib/guard-file-list.sh
# for the full reasoning and for why the assertion is on the STATUS, not on the
# count. The two scans below then read from a plain file, which cannot swallow one.
FILE_LIST="$(mktemp)"
trap 'rm -f "$FILE_LIST"' EXIT
if $mode_staged; then
  guard_list_staged_or_die "$FILE_LIST"
else
  guard_list_files_or_die "$FILE_LIST"
fi

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
while IFS= read -r -d '' f; do
  [ -n "$f" ] || continue
  is_excluded "$f" && continue
  if printf '%s' "$f" | grep -qEi -- "$HARD_LOCAL_TOOLING"; then
    echo "❌ HARD leak marker (operator-local tooling) in PATH: $f"
    violations=$((violations + 1))
  fi
done < "$FILE_LIST"

while IFS= read -r -d '' f; do
  [ -n "$f" ] || continue
  # SYMLINKS carry their payload in the BLOB, not in the file they point at. git
  # stores a symlink as a blob whose CONTENT is the target path, so
  # `ln -s /opt/lynox-managed/secret link.ts` commits that string into this public
  # repo verbatim. The content scan below never sees it: `[ -f ]` follows the link,
  # so a live link is scanned for the TARGET's content (the wrong bytes, and the
  # target is usually outside the repo) and a dangling one fails the test and is
  # skipped entirely — silently, the same way this guard used to skip quoted and
  # dash-leading paths. Scan the target STRING against the two HARD classes here;
  # the SOFT and cross-reference classes are about prose and do not apply to a path.
  if [ -L "./$f" ]; then
    is_excluded "$f" && continue
    # `readlink` is a producer like any other, so its failure is checked rather
    # than swallowed. An earlier draft of this very branch wrote `|| true`, which
    # turned an unreadable link into an empty target, no match, and a silent skip
    # — the exact failure this file exists to remove, reintroduced inside the fix.
    #
    # NOT covered by a test, and the reason is worth writing down rather than
    # leaving as a gap: this branch only runs when `[ -L ]` was already true, and
    # every state that makes `readlink` fail (not a symlink; parent unreadable)
    # makes `[ -L ]` false first — measured. What remains is the TOCTOU window
    # where the link disappears between the two, which no deterministic test can
    # open. So the check guards a race, cannot be exercised, and must not be
    # counted as covered.
    if ! _target="$(readlink -- "./$f")"; then
      echo "❌ could not read SYMLINK $f — refusing to treat an unreadable link as clean"
      violations=$((violations + 1))
      continue
    fi
    if printf '%s' "$_target" | grep -qE -- "$HARD"; then
      echo "❌ HARD leak marker in SYMLINK TARGET of $f -> $_target"
      violations=$((violations + 1))
    fi
    if printf '%s' "$_target" | grep -qEi -- "$HARD_LOCAL_TOOLING"; then
      echo "❌ HARD leak marker (operator-local tooling) in SYMLINK TARGET of $f -> $_target"
      violations=$((violations + 1))
    fi
    # The whole-file allow applies here exactly as it does below, so a doc that is
    # permitted to name the managed service keeps that permission if it is a link.
    is_allow_file "$f" && continue
    # A first draft asserted that the SOFT and cross-reference classes "do not
    # apply to a path". Measured false: a link target is an arbitrary committed
    # byte string, and both a dual-use hostname and a doubled-bracket slug rode
    # through it at exit 0 while being blocked in every other file. They are
    # checked here too — as HARD blocks, because the inline pragma has nowhere to
    # live on a symlink. There are zero such links today; if a legitimate one ever
    # appears, ALLOW_FILES above is its escape hatch.
    if printf '%s' "$_target" | grep -qE -- "$INTERNAL_REF"; then
      echo "❌ internal cross-reference in SYMLINK TARGET of $f -> $_target"
      violations=$((violations + 1))
    fi
    if printf '%s' "$_target" | grep -qE -- "$SOFT"; then
      echo "⚠️  internal hostname in SYMLINK TARGET of $f -> $_target (no inline pragma is possible on a link; allow-list the path instead)"
      violations=$((violations + 1))
    fi
    continue
  fi
  [ -f "./$f" ] || continue
  is_excluded "$f" && continue
  # Skip binaries. Every file operand below is prefixed `./` so a repo-root path
  # that begins with '-' (or is literally `-`) is an unambiguous filename: not a
  # grep option, and — the sharper trap — not the stdin `-`, which would make grep
  # drain THIS loop's own file listing and blind the guard for every later file.
  # `--` additionally guards the pattern side. Same silent blind-skip class as the
  # non-ASCII fix; `git ls-files` paths are always repo-relative, so `./` is safe.
  if grep -Iq -- . "./$f" 2>/dev/null; then :; else continue; fi

  # HARD — no exemptions.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "❌ HARD leak marker in $f:"
    echo "     ${line}"
    violations=$((violations + 1))
  done < <(grep -nIE -- "$HARD" "./$f" 2>/dev/null || true)

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
  done < <(grep -nIEi -- "$HARD_LOCAL_TOOLING" "./$f" 2>/dev/null || true)

  # Whole-file allow applies from here down. It sits ABOVE the reference loops on
  # purpose: those match a bracket shape that legal content can produce, and an
  # allow-listed file may have no comment syntax to hang a pragma on — a JSON
  # document with a nested array had no way past at all while this check came
  # after. The HARD classes above stay outside it, as their comment says.
  is_allow_file "$f" && continue

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
  done < <(grep -nIE -- "$INTERNAL_REF" "./$f" 2>/dev/null || true)

  # The opening line of a link split across lines. Reported separately so the
  # message can say why it looks incomplete.
  #
  # The pragma check is load-bearing here, and a round of this review removed it on
  # the theory that it was unreachable — the pragma carries a colon, the body class
  # excludes one, so an annotated line cannot match. That holds only when the pragma
  # sits AFTER the opener. Put it BEFORE, which the header explicitly permits, and
  # the opener still ends the line and still matches. Removing the branch turned a
  # working escape into a hard block, and the error text below tells the reader to
  # use exactly the escape that had stopped working.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      *"$PRAGMA"*) continue ;;
    esac
    echo "❌ internal cross-reference opened in $f and continued on the next line:"
    echo "     ${line}"
    violations=$((violations + 1))
  done < <(grep -nIE -- "$REF_OPENER" "./$f" 2>/dev/null || true)

  # SOFT — exempt if the line carries the pragma. Whole-file allow already
  # returned above, so it needs no second check here.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      *"$PRAGMA"*) continue ;;  # inline-allowed
    esac
    echo "⚠️  internal hostname in $f (add '${PRAGMA}' with a reason if intentional):"
    echo "     ${line}"
    violations=$((violations + 1))
  done < <(grep -nIE -- "$SOFT" "./$f" 2>/dev/null || true)
done < "$FILE_LIST"

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
