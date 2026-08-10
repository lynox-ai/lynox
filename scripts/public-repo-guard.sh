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
# Enforcement:
#   - pre-push hook   — scans the whole tracked tree, fast local feedback
#   - CI on PRs       — the same tree scan (cannot be bypassed with --no-verify)
#   - pre-push, again — `check-meta` over the commits being pushed, for the
#                       private-name class only. That class has NO CI twin; see
#                       its comment below for why, and what it therefore misses.
#
# Usage:
#   scripts/public-repo-guard.sh                    # whole tracked tree
#   scripts/public-repo-guard.sh --staged           # staged files only — MANUAL
#   scripts/public-repo-guard.sh check-meta A B     # commit messages in A..B
#
# Exit 0 = clean, exit 1 = a marker was found, exit 2 = bad usage.
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

# The fifth class — names of customers and other real third parties. It scans
# COMMIT MESSAGES, via the `check-meta` subcommand, and nothing else.
#
# That narrowness was arrived at the expensive way, over five review rounds. The
# first version also scanned the tree, and every defect it had lived in that
# half: it withheld matching lines so a public Actions log would not print a
# name, then had to withhold file paths for the same reason, and the withholding
# used the same grep as the detection, so it was blind wherever the detection
# was. The tree carried zero occurrences of any known name throughout. It is gone.
#
# What it does NOT cover, stated plainly because the code used to imply otherwise:
# PR titles and bodies. A CI half could read those, but this class has no CI half
# — its pattern is operator-private and a GitHub secret is a textarea, which
# turned out to cost more than it bought. The trade is defensible on its own
# terms: a PR body is editable after the fact, and in the incident that prompted
# this class it WAS edited. A commit message, once squashed onto main of a public
# repo, is not. So the surface left covered is the one that cannot be repaired.
#
# ONE source, and it is a file outside every repo: ~/.lynox/private-names.re,
# one regex per line. There used to be an environment variable too, for a GitHub
# secret in CI. It is gone, and so is a third of this class's defect count with
# it — the secret was a textarea, so a pasted list arrived with line breaks that
# GNU and BSD grep read differently, which needed its own check; two sources
# needed a precedence rule; and the CI half was never armed anyway. What is left
# is enforced at pre-push and nowhere else, which is what that half was already
# doing in practice.
PRIVATE_NAMES_FILE="${LYNOX_PRIVATE_NAMES_RE_FILE:-${HOME:-}/.lynox/private-names.re}"
PRIVATE_NAMES_RE=""
if [ -r "$PRIVATE_NAMES_FILE" ]; then
  # `#` comments and blanks dropped, surrounding whitespace and a stray CR
  # trimmed, the rest joined into one alternation.
  #
  # The trim is not cosmetic. Untrimmed, ONE leading space — what happens the
  # first time somebody indents the list — leaves the entry syntactically valid
  # and semantically dead: it matches nothing, the guard prints `clean`, and the
  # name it was meant to stop walks into the public repo. Trim BEFORE filtering,
  # or an indented `#` survives as a literal entry.
  PRIVATE_NAMES_RE="$(
    sed -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$PRIVATE_NAMES_FILE" \
      | grep -vE '^(#|$)' \
      | paste -sd'|' - || true
  )"
fi

# PREFLIGHT — the pattern is operator-supplied and is therefore the likeliest
# thing here to be wrong. Three checks, one per direction it can be wrong: it
# cannot compile, it matches everything, or it matches nothing. The third had
# been missed by three review rounds, because every earlier check asked only
# about the second.
#
# Note what is never printed: the pattern. It is the list of names, so an error
# quoting it would be the leak. grep's own diagnostic is dropped for the same
# reason — busybox grep echoes the pattern back.
preflight_names_re() {
  local rc=0

  # VALIDITY, judged by the grep that will actually run the scan.
  #
  # This was briefly dropped as a false positive, because BSD grep rejects
  # `Name( AG| GmbH|)` while GNU accepts it. Dropping it was wrong: on BSD that
  # pattern IS invalid, so the scan there would fail on every file into a
  # swallowed stderr and report a clean tree. The refusal is correct; only the
  # message was, claiming a universal verdict for a local one.
  printf '' | grep -qE "$PRIVATE_NAMES_RE" 2>/dev/null || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "❌ public-repo-guard: the grep on THIS machine cannot compile the" >&2
    echo "   private-name pattern, so the scan here would find nothing." >&2
    echo "   BSD grep (macOS) and GNU grep (CI) disagree on some forms — an empty" >&2
    echo "   trailing alternative like 'Name( X| Y|)' is one. Prefer a form both" >&2
    echo "   accept: 'Name( X| Y)?'." >&2
    return 1
  fi

  # OVER-matching. A pattern that matches an EMPTY LINE matches every line there
  # is. A trailing `|` does it, and so does one parenthesis deeper — `(name|)` —
  # which a check for a top-level empty alternative cannot see. The likeliest
  # source is not a typo at all: the value is pasted into a GitHub secret
  # textarea, and a blank line in that paste produces exactly this. `a*`, `a?`
  # and `()` fall out of the same test, which is why it replaced three special
  # cases rather than joining them.
  # rc MUST be reset here. `|| rc=$?` only fires when grep FAILS, so on a match it
  # leaves whatever the validity probe above put there — which is always 1, since
  # grep on empty input cannot match. Dropping this line while rewriting the block
  # made the whole check unreachable, silently, and only a mutation caught it.
  rc=0
  printf '\n' | grep -qE "$PRIVATE_NAMES_RE" 2>/dev/null || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "❌ public-repo-guard: private-name pattern matches an empty line, so it" >&2
    echo "   would match every line in the repo. Check for a blank entry, a stray" >&2
    echo "   '|', or an optional-everything form like (name|) or name*." >&2
    return 1
  fi

  # UNDER-matching, which is the direction that fails silently and was missed by
  # three review rounds. Every check before this one asked "does the pattern match
  # too much?". None asked "does it match anything at all?".
  #
  # The concrete way it goes wrong: `(?i)Name` is the most common PCRE habit
  # there is. GNU grep accepts it as a valid ERE and it then matches NOTHING —
  # the class is dead, and it reports `clean ✓` for every run. BSD grep matches
  # it, so it works locally and dies in CI. These constructs mean something else
  # in ERE or nothing at all, so refusing them is refusing a mistake, not a style.
  # Matched on the concrete PCRE openers rather than a bare `(?`: an escaped
  # literal paren followed by a quantifier — `Acme \(?AG\)?`, a perfectly good
  # way to write a name with an optional bracket — contains `(?` too, and the
  # broad form rejected it.
  case "$PRIVATE_NAMES_RE" in
    *'(?i'*|*'(?:'*|*'(?='*|*'(?!'*|*'(?<'*|*'(?P'*|*'(?#'*)
      echo "❌ public-repo-guard: private-name pattern uses a PCRE group like (?i) or (?:)." >&2
      echo "   This is an EXTENDED regex (grep -E). GNU grep accepts those and then" >&2
      echo "   matches nothing at all, which reads as a clean scan. For case, rely on" >&2
      echo "   the guard's own -i; for grouping use a plain ( )." >&2
      return 1
      ;;
  esac
  return 0
}

# Fourth class — internal cross-reference slugs in the doubled-bracket link form.
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
# NOT covered here, and NOT covered by the private-name class above either: the
# OPERATOR's own name used as a deployment identifier ("canary <name>", "<name>
# prod"). The header of this class used to estimate ~16 such mentions; measured
# against the tree on 2026-08-10 it is 32 in that phrasing, out of 251 mentions of
# the name overall. Adding the pattern would paint the guard permanently red,
# which teaches bypassing rather than fixing, so that cleanup is tracked
# separately. The name is legitimately public in its own right (LICENSE,
# TRADEMARK.md, README, package.json) — what does not belong here is a customer's,
# and that is what the class above covers.
SOFT='engine\.lynox\.cloud|control\.lynox\.cloud'

usage() {
  echo "usage: public-repo-guard.sh [--staged]" >&2
  echo "       public-repo-guard.sh check-meta <base-ref> <head-ref>" >&2
  exit 2
}

mode_staged=false
mode_meta=false
meta_base=''
meta_head=''

while [ $# -gt 0 ]; do
  case "$1" in
    --staged)              mode_staged=true ;;
    check-meta)
      mode_meta=true
      meta_base="${2:-}"
      meta_head="${3:-}"
      [ -n "$meta_base" ] && [ -n "$meta_head" ] || usage
      # A flag where a ref belongs means the caller got the argument order wrong.
      # Taken literally it becomes an unresolvable ref, and an unresolvable ref
      # used to read as an empty range, i.e. as "clean".
      # Checked separately: concatenating them would only ever see the first one's
      # leading character, so a flag in the HEAD position would slip through.
      case "$meta_base" in -*) usage ;; esac
      case "$meta_head" in -*) usage ;; esac
      shift 2
      ;;
    *) usage ;;
  esac
  shift
done

# The PREFLIGHT runs inside the check-meta path below, not out here. The tree scan
# never touches the name list, so letting a malformed ~/.lynox/private-names.re
# block it would be a hard stop caused by a file with no bearing on what was being
# checked — the same "unpushable hook teaches --no-verify" failure this script
# warns about elsewhere, and it was live for one round.
#
# Absent file, absent pattern: the class stands down with a visible warning rather
# than failing. There is no CI half to fail closed FOR — this runs at pre-push,
# where refusing to run is refusing to push.

# check-meta — commit messages in base..head, plus the PR title/body when the
# caller exports them. Mirrors scripts/no-ai-attribution.sh: only the commits a PR
# ADDS are scanned, never the whole history, so a name already merged (there are
# none today) could not turn every future PR red.
#
# As everywhere in this class, no matched text is printed: a commit is named by
# its short SHA alone, never by its subject line.
if $mode_meta; then
  meta_hits=0
  meta_commits=0
  names_active=false
  if [ -n "$PRIVATE_NAMES_RE" ]; then
    preflight_names_re || exit 1
    names_active=true
  else
    echo "⚠️  public-repo-guard: private-name class SKIPPED — no pattern configured."
    echo "    To arm it, put one regex per line in ${PRIVATE_NAMES_FILE}."
  fi

  if $names_active; then
    # The range is resolved FIRST, and a failure to resolve it is fatal.
    #
    # Written as `for sha in $(git rev-list … 2>/dev/null)` this could not fail:
    # a base that is not in the clone (force-push, GC, an odd fork shape) made
    # rev-list exit non-zero into a swallowed stderr, `set -e` does not fire on a
    # command substitution inside a for-list, and the empty result read exactly
    # like "no commits carry a name". Green, for a scan that never ran.
    meta_revs=''
    if ! meta_revs="$(git rev-list "${meta_base}..${meta_head}" 2>/dev/null)"; then
      echo "❌ public-repo-guard: cannot resolve ${meta_base}..${meta_head}." >&2
      echo "   Refusing to report a clean range that was never walked. In CI this" >&2
      echo "   usually means the checkout is too shallow — it needs fetch-depth: 0." >&2
      exit 1
    fi

    for sha in $meta_revs; do
      meta_commits=$((meta_commits + 1))
      # No -I here (nor below): these greps read a PIPE, where -I cannot do its
      # job of skipping binary FILES and only adds a way to be silently skipped —
      # one NUL byte ahead of the name and the input counts as binary, i.e. as no
      # match. git refuses NUL in a commit message, so this is belt-and-braces —
      # but the flag bought nothing here and could only ever cost.
      # The message is read into a variable FIRST, rather than piped into grep.
      #
      # `git show … | grep -q` looks equivalent and is not: grep exits at the
      # first match, git show keeps writing, and past the pipe buffer it dies of
      # SIGPIPE. With `pipefail` (set at the top) the pipeline then reports 141
      # and the `if` reads it as NO MATCH. Measured: a ~2 MB commit message with
      # the name in its first line was missed on every run, and the clean line
      # cheerfully certified "1 commit(s) scanned" — the counter added to make
      # an unwalked range visible, attesting a walk that found nothing because
      # it was killed. Small messages were unaffected, which is what makes this
      # the kind of bug that ships.
      msg="$(git show -s --format='%B' "$sha")"
      if grep -qEi "$PRIVATE_NAMES_RE" <<<"$msg"; then
        echo "❌ private name in the message of commit $(git show -s --format='%h' "$sha")"
        meta_hits=$((meta_hits + 1))
      fi
    done
  fi

  if [ "$meta_hits" -gt 0 ]; then
    cat >&2 <<'EOF'

A customer or third-party name reached a commit message. This is the PUBLIC repo.
Describe the case neutrally instead — "a prod thread", "a managed instance" — and
keep the name in the private repo or in your notes.

Rewrite the message while the branch is still yours; once merged it is permanent:

    git rebase -i <base>          # mark the commits above as `reword`
    git commit --amend            # for the last commit only

Do NOT bypass this check.
EOF
    exit 1
  fi

  # The count is the point, not decoration: it is the one visible difference
  # between "walked N commits, found nothing" and "walked nothing at all".
  # no-ai-attribution.sh:104 prints it for the same reason. And "0 scanned"
  # must not be able to mean two different things, so the inactive case says so
  # rather than reporting a count it never had a chance to reach.
  if $names_active; then
    # Zero is the one count that means two things: a genuinely empty range (base
    # == head, or a force-push rollback that leaves `before` ahead of `after`)
    # looks exactly like a range nothing was read from. The status check above
    # catches an UNRESOLVABLE range, not an empty one, so say it out loud rather
    # than let "clean ✓" imply a walk.
    if [ "$meta_commits" -eq 0 ]; then
      echo "⚠️  public-repo-guard (check-meta): the range held NO commits — nothing was"
      echo "    scanned. Check that ${meta_base}..${meta_head} is the range you meant."
    fi
    echo "public-repo-guard (check-meta): clean ✓ (${meta_commits} commit(s) scanned)"
  else
    echo "public-repo-guard (check-meta): class inactive — nothing scanned."
  fi
  exit 0
fi

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
  done < <(grep -nIE "$INTERNAL_REF" "$f" 2>/dev/null || true)

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
  done < <(grep -nIE "$REF_OPENER" "$f" 2>/dev/null || true)

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
  done < <(grep -nIE "$SOFT" "$f" 2>/dev/null || true)
done < <(list_files)

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "public-repo-guard: ${violations} marker(s) found — this is the PUBLIC repo."
  echo "Move the offending content to the private pro repo; for a cross-reference,"
  echo "state the reason inline instead of citing an id. If the mention is genuinely"
  echo "public-safe, annotate the line with '${PRAGMA}: <reason>' — accepted for the"
  echo "hostname and cross-reference classes, never for a HARD leak marker."
  echo ""
  echo "For a private-name hit: describe the case neutrally — 'a prod thread', 'a"
  echo "managed instance' — and keep the name in the private repo or your notes."
  echo "Fixtures and examples take an unmistakably fictional name, not a plausible one."
  exit 1
fi

echo "public-repo-guard: clean ✓"
