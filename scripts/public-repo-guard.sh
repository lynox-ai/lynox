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
# Exit 0 = clean, exit 1 = a leak marker was found, exit 2 = the guard reached no
# verdict — its file listing failed, or it was invoked with arguments it cannot
# act on. The third code exists so "the tree is dirty" and "the gate never
# looked" stop being the same signal — see scripts/lib/guard-file-list.sh. A
# usage error belongs to the same category and shares the code deliberately: it
# is another way of having looked at nothing.
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
# Whether the operator ever SET THIS UP, which is a different question from whether
# it currently works — and the two used to give the same answer.
#
# PRESENCE is `-e || -L`, deliberately NOT `-r`. Reading decides whether the list
# WORKS; it must not also decide whether the list EXISTS, or every unreadable one
# reports as never configured — mode 000, root-owned after a sudo edit, a dangling
# symlink. That is the same conflation this file exists to close, in its worst
# form: a list with real names in it, silently unscanned, green tick. `-L` is
# there because a dangling symlink is not `-e`, and somebody who symlinked the
# path plainly configured it.
PRIVATE_NAMES_FILE_PRESENT=false
if [ -e "$PRIVATE_NAMES_FILE" ] || [ -L "$PRIVATE_NAMES_FILE" ]; then
  PRIVATE_NAMES_FILE_PRESENT=true
fi
# An unresolvable path is its own state: with neither the override nor HOME set
# the string collapses to `/.lynox/private-names.re`, which is not the operator's
# list and whose absence says nothing about whether they armed the class. Standing
# down there is a guess, and the guess fails open.
PRIVATE_NAMES_PATH_UNRESOLVED=false
if [ -z "${LYNOX_PRIVATE_NAMES_RE_FILE:-}" ] && [ -z "${HOME:-}" ]; then
  PRIVATE_NAMES_PATH_UNRESOLVED=true
fi
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

  # CASE-FOLDING, which is locale-dependent for everything outside ASCII and is
  # the fourth direction this pattern can be wrong in. `grep -i` folds `Ö` to `ö`
  # only when the locale has a character map that knows they are the same letter.
  # Measured on a commit whose subject read `Fix for ZÖRBLATT Industries` against
  # the pattern `Zörblatt`:
  #
  #     LC_ALL=en_US.UTF-8   exit 1   caught
  #     LC_ALL=C             exit 0   clean ✓
  #     LC_ALL / LANG unset  exit 0   clean ✓
  #
  # An unset locale is not exotic: a hook launched from a GUI git client, or any
  # `env -i` context, has none. So an ASCII locale plus a non-ASCII name is a
  # scan that cannot match, and it says `clean ✓` while it happens. Refuse
  # instead — the same direction as every other check in this function.
  #
  # Only when the pattern actually contains a non-ASCII byte: an ASCII-only list
  # folds identically everywhere, and a guard that refuses correct input is a
  # guard that gets bypassed.
  # NOTE: `rc` above is NOT reset at this point and carries the validity probe's
  # leftover, so this check returns directly rather than going through it.
  # `LC_ALL=C` on the probe itself, so `[^ -~]` is a plain BYTE range (outside
  # 0x20..0x7e) rather than something the ambient locale gets to reinterpret —
  # the detector for a locale problem must not depend on the locale.
  if printf '%s' "$PRIVATE_NAMES_RE" | LC_ALL=C grep -q '[^ -~]'; then
      case "$(locale charmap 2>/dev/null || echo unknown)" in
        UTF-8|utf-8|UTF8|utf8) : ;;
        *)
          echo "❌ public-repo-guard: the private-name pattern contains non-ASCII" >&2
          echo "   characters, but this shell's locale charmap is" >&2
          echo "   '$(locale charmap 2>/dev/null || echo unknown)' — grep -i cannot fold" >&2
          echo "   them there, so the scan would silently under-match." >&2
          echo "   Run with a UTF-8 locale (e.g. LC_ALL=en_US.UTF-8), or keep the" >&2
          echo "   list ASCII-only." >&2
          return 1
          ;;
      esac
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
# prod"). It is spread over enough of the tree that adding the pattern would paint
# the guard permanently red. A count used to stand here; it was dated 2026-08-10
# and had already drifted by the time this branch reached main, and nothing keeps
# it fresh — so the argument is stated without it. Re-derive it before acting on
# this note rather than trusting a number in a comment. A permanently red guard
# teaches bypassing rather than fixing, so that cleanup is tracked separately.
# The name is legitimately public in its own right (LICENSE,
# TRADEMARK.md, README, package.json) — what does not belong here is a customer's,
# and that is what the class above covers.
SOFT='engine\.lynox\.cloud|control\.lynox\.cloud'

usage() {
  echo "usage: public-repo-guard.sh [--staged]" >&2
  echo "       public-repo-guard.sh check-meta  <base-ref> <head-ref>" >&2
  echo "       public-repo-guard.sh check-files <base-ref> <head-ref>" >&2
  exit 2
}

mode_staged=false
mode_meta=false
mode_files=false
meta_base=''
meta_head=''

while [ $# -gt 0 ]; do
  case "$1" in
    --staged)              mode_staged=true ;;
    check-meta|check-files)
      case "$1" in
        check-meta)  mode_meta=true ;;
        check-files) mode_files=true ;;
      esac
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

# Both subcommands are ONE class over two surfaces, so they must not be given at
# once: they share `meta_base`/`meta_head`, and a second occurrence silently
# overwrites the first one's refs. Refusing is the same category as any other
# usage error — a way of having looked at something other than what was asked.
if $mode_meta && $mode_files; then
  echo "public-repo-guard: give check-meta OR check-files, not both — they share" >&2
  echo "   one pair of refs and the second would overwrite the first." >&2
  usage
fi

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
if $mode_meta || $mode_files; then
  meta_hits=0
  meta_commits=0
  file_hits=0
  files_scanned=0
  # The label is chosen ONCE, from the mode, rather than written into each
  # message: two subcommands sharing this block is exactly the shape where a
  # copied string ends up naming the other one.
  if $mode_meta; then class_label='check-meta'; else class_label='check-files'; fi
  names_active=false
  if [ -n "$PRIVATE_NAMES_RE" ]; then
    # exit 2, not 1: a preflight refusal is "the gate never looked", which is
    # exactly the distinction the third code exists for (see the header). It used
    # to exit 1, and that made a refusal indistinguishable from a hit by exit code
    # alone — which let a mutation survive a case that asserted only the code.
    preflight_names_re || exit 2
    names_active=true
  elif $PRIVATE_NAMES_FILE_PRESENT; then
    # THE FILE IS THERE AND YIELDS NOTHING. That is not "never set up", it is
    # "set up and broken", and until now the two printed the same line and both
    # exited 0 — so a list that had been commented out, indented, or emptied read
    # exactly like a machine that had never been armed.
    #
    # It is not hypothetical: on 2026-09-04 this file held 34 lines of which 33
    # were comments, the alternation came out 0 characters long, and the class had
    # been reporting a green tick on every push for as long as that was true.
    #
    # And there was no visible tell at all, which is worse than a missed one.
    # The 23s sibling is the TREE scan — a different job that runs whatever this
    # list contains, so its duration cannot separate the two states. The only
    # comparison that could is this class armed against this class dead, over the
    # same range, and it does not: measured 2026-09-05, three runs each, dead
    # 0.029-0.033s against armed 0.049-0.061s. Hundredths apart, and both read as
    # instant on a green line.
    #
    # exit 2, the preflight code: "the gate never looked", distinct from 1 = "the
    # gate found something". A missing file still exits 0 below, because standing
    # down for someone who never configured the class is the documented behaviour
    # and blocking their push would only teach --no-verify.
    echo "❌ public-repo-guard: private-name list is CONFIGURED BUT UNUSABLE." >&2
    echo "   ${PRIVATE_NAMES_FILE} is there and yields no pattern." >&2
    # The cause is NOT asserted here. An earlier draft said "every line is a
    # comment, blank, or whitespace-only", which is one of three ways to get an
    # empty result — the read can also fail (unreadable file, a directory at the
    # path), and the message then named a cause it had not checked.
    if [ ! -r "$PRIVATE_NAMES_FILE" ]; then
      echo "   It cannot be READ — check the mode and the owner." >&2
    else
      echo "   Every line is a comment, blank, or whitespace-only." >&2
    fi
    echo "   The class would otherwise report a clean scan on every commit while" >&2
    echo "   checking nothing." >&2
    echo "   Fix: put one regex per line." >&2
    echo "   Deleting the file also clears this — that stands the class down for" >&2
    echo "   good, so do it deliberately, not to unblock a push." >&2
    exit 2
  elif $PRIVATE_NAMES_PATH_UNRESOLVED; then
    echo "❌ public-repo-guard: private-name list path is UNRESOLVABLE." >&2
    echo "   Neither LYNOX_PRIVATE_NAMES_RE_FILE nor HOME is set, so the path is" >&2
    echo "   \`${PRIVATE_NAMES_FILE}\` — not the operator's list. Whether the class" >&2
    echo "   is armed cannot be decided here, and guessing fails open." >&2
    echo "   Fix: set HOME, or point LYNOX_PRIVATE_NAMES_RE_FILE at the list." >&2
    exit 2
  else
    echo "⚠️  public-repo-guard: private-name class SKIPPED — no pattern configured."
    echo "    To arm it, put one regex per line in ${PRIVATE_NAMES_FILE}."
  fi

  if $names_active && $mode_meta; then
    # The range is resolved FIRST, and a failure to resolve it is fatal.
    #
    # Written as `for sha in $(git rev-list … 2>/dev/null)` this could not fail:
    # a base that is not in the clone (force-push, GC, an odd fork shape) made
    # rev-list exit non-zero into a swallowed stderr, `set -e` does not fire on a
    # command substitution inside a for-list, and the empty result read exactly
    # like "no commits carry a name". Green, for a scan that never ran.
    meta_revs=''
    if ! meta_revs="$(git --no-replace-objects rev-list "${meta_base}..${meta_head}" 2>/dev/null)"; then
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
      # RAW OBJECT, not `git show --format=%B`. This runs at pre-push with the
      # DEVELOPER's ~/.gitconfig, and every rendering path git offers goes through
      # a re-encoding layer that config can steer. Measured, all four producing
      # `clean ✓ (1 commit(s) scanned)` and exit 0 on a commit whose subject
      # plainly carried the name:
      #
      #   · `i18n.logOutputEncoding = UTF-16` — output re-encoded, grep matches
      #     nothing. ISO-8859-1 does the same to an umlaut.
      #   · `i18n.commitEncoding = ISO-8859-1` — WORSE, because it needs no
      #     hostile config at SCAN time: it writes an `encoding ISO-8859-1`
      #     header into the object while the bytes are UTF-8, so every later
      #     read re-encodes from a declared encoding that was never true. The
      #     lie is baked into the object and survives rebase, cherry-pick and
      #     clone. Pinning the OUTPUT encoding does not touch it — that was the
      #     first version of this fix, and a delta round measured it still open.
      #
      # `--encoding=none` and `i18n.logOutputEncoding=none` were both tried and
      # mangle identically. `cat-file` is the only read that hands back the bytes
      # as stored — with one exception, hence `--no-replace-objects` here and on
      # the rev-list above: a `refs/replace` entry swaps a sanitised twin in front
      # of the real object for every read, is local repo state that is NOT pushed
      # by default, and defeats the range walk as well (measured: 2 commits become
      # 1, and the counter that exists to make an unwalked range visible reports
      # the smaller number without complaint). It takes a deliberate `git replace`,
      # so it is not the accidental path this class is built for — but the flag
      # costs nothing and the sentence would otherwise be false.
      #
      # The `sed` is load-bearing, not cosmetic: it drops the object header, so
      # the scan reads the MESSAGE and not the `author`/`committer` lines. Without
      # it a pattern that ever contains the operator's own name would fire on
      # every commit they wrote.
      msg="$(git --no-replace-objects cat-file commit "$sha" | sed '1,/^$/d')"
      if grep -qEi "$PRIVATE_NAMES_RE" <<<"$msg"; then
        echo "❌ private name in the message of commit ${sha:0:9}"
        meta_hits=$((meta_hits + 1))
      fi
    done
  fi

  # check-files — the PATHS and CONTENT of the files this range adds or changes.
  #
  # WHY THIS EXISTS. Until now the class scanned commit messages "and nothing
  # else", so a file named after a customer, or holding their name in its body,
  # reached this PUBLIC repo untouched as long as the message stayed neutral. The
  # name then sits in a path and in a blob, which is the same permanence problem
  # the message half was built for and a wider surface.
  #
  # ⛔ WHY IT MUST NEVER GET A CI TWIN, and this is load-bearing rather than a
  # preference. An earlier version of this class DID scan the tree, in CI, and
  # every defect it had came from that: a public Actions log must not print a
  # name, so it withheld the matching line, then had to withhold the path too,
  # and the withholding used the same grep as the detection — so it was blind
  # exactly where the detection was blind. It was removed for that.
  #
  # This one reports the path and says which surface matched, because it runs at
  # PRE-PUSH on the operator's own machine, where the list is already theirs. That
  # is the whole reason the withholding machinery is absent, and it is only true
  # while no workflow invokes this subcommand. `tests/public-repo-guard.test.ts`
  # asserts that none does; keep it that way, or reintroduce the withholding and
  # every defect that came with it.
  if $names_active && $mode_files; then
    # PER COMMIT, not base-against-head — and that is the difference between
    # scanning what SHIPS and scanning what SURVIVES.
    #
    # `git diff base head` compares two TREES, so a file added early in the range
    # and deleted later is absent from both ends and never listed. Its blob is
    # still in the range and still gets pushed: measured on a three-commit branch
    # (seed / add / remove), `git diff --name-only base head` returns one path
    # while `git rev-list --objects base..head` still finds the deleted file's
    # blob. A tree diff would have reported that branch clean and pushed the name.
    #
    # So every commit is walked and every blob it introduces is scanned. A file
    # touched three times is scanned three times, which is right: those are three
    # distinct blobs, and all three ship.
    #
    # ACMR: a file the range only DELETES is not scanned. Its content is leaving,
    # and firing there would block the very commit that removes a name.
    # THE RANGE, and why it is not `--not --remotes=origin`.
    #
    # A two-base (criss-cross) merge can make `git merge-base` pick the base that
    # re-includes a commit already on origin/main, and this half has no escape
    # hatch — the pragma and the allow-list belong to the tree scan below. The
    # obvious repair is to take the commits that are on no remote at all. It was
    # measured rather than adopted, and the measurement says no:
    #
    #   ordinary branch, origin present   identical commit set — buys nothing
    #   origin refs absent                merge-base form: 0 commits
    #                                     --not --remotes: the ENTIRE history
    #   tracking ref stale                scans more than the push contains
    #
    # The second row is the disqualifying one. A repo with no fetched origin refs
    # — a fresh worktree before its first fetch, a differently named remote — would
    # scan every commit that ever existed on every push: minutes in the hook, and
    # any name anywhere in history blocks every push permanently. That is the
    # "unpushable hook teaches --no-verify" failure this file warns about, traded
    # for a case that could not be reproduced here (one criss-cross construction
    # was attempted; merge-base landed on the name-carrying commit itself, so both
    # forms excluded it — the adversarial report of it stands unmatched, not
    # refuted).
    #
    # If the false positive is ever OBSERVED, the guarded form is one line away:
    # use `--not --remotes=origin` only when that exclusion set is non-empty, and
    # fall back to the merge-base range when it is not.
    files_revs=''
    if ! files_revs="$(git --no-replace-objects rev-list "${meta_base}..${meta_head}" 2>/dev/null)"; then
      echo "❌ public-repo-guard: cannot resolve ${meta_base}..${meta_head}." >&2
      echo "   Refusing to report a clean range that was never walked. In CI this" >&2
      echo "   usually means the checkout is too shallow — it needs fetch-depth: 0." >&2
      exit 1
    fi
    blob="$(mktemp)"
    file_list="$(mktemp)"
    for sha in $files_revs; do
      # -z because git QUOTES any path holding a non-ASCII byte, which is how a
      # path-based check silently skips the file it was written for (the tree scan
      # further down carries the same note, and the same measurement).
      #
      # The listing goes to a FILE, never through `$( )`. Command substitution
      # strips NUL bytes — bash discards them outright — so `-z` output captured
      # into a variable arrives as one run-on string, the `read -d ''` loop sees a
      # single "path", and every real path after the first is skipped while the
      # count still says 1. Choosing `-z` forces choosing a file.
      #
      # `--root` so a range that includes an initial commit is scanned rather
      # than silently empty: diff-tree against no parent prints nothing without it.
      #
      # `--cc` for the same reason one commit further along: diff-tree against a
      # MERGE prints NOTHING without it, and the guard then reports `clean ✓
      # (N file(s) scanned)` with N quietly omitting the merge — no starvation
      # warning either, because the sibling commits supplied the count. Measured:
      # a conflict resolved by typing a name into the merge commit listed 0 files,
      # and `--cc` lists it. That is not an exotic path; resolving a conflict by
      # hand is the single most ordinary way a real name gets typed into a repo.
      # `--cc` lists what the merge itself introduced — the files that differ from
      # EVERY parent — so an ordinary merge does not re-scan the branch it merges
      # (those commits are in the range on their own, or are already public).
      # On a non-merge it behaves like a plain diff; measured, not assumed.
      #
      # `T` in the filter, because a TYPE CHANGE is neither A nor M. A regular
      # file replaced by a symlink whose TARGET names a customer — or a symlink
      # replaced by a regular file full of prose — is status `T`, listed nowhere,
      # and both shipped clean before this. `D` stays out: a deleted file's
      # content is leaving.
      git --no-replace-objects diff-tree --no-commit-id --root --cc -r --name-only \
        --diff-filter=ACMRT -z "$sha" > "$file_list" 2>/dev/null || true
      while IFS= read -r -d '' f; do
        [ -n "$f" ] || continue
        files_scanned=$((files_scanned + 1))
        # PATH FIRST, and it is not a nicety: no content grep ever sees a file
        # NAME, so `<customer>-businessplan.html` full of neutral prose is
        # invisible to a content-only scan. That shape is what prompted this half.
        if printf '%s' "$f" | grep -qEi "$PRIVATE_NAMES_RE"; then
          echo "❌ private name in the PATH: ${f}  (commit ${sha:0:9})"
          file_hits=$((file_hits + 1))
          continue
        fi
        # CONTENT, read from the COMMIT that introduced this version rather than
        # from HEAD or the working copy. At HEAD the file may no longer exist —
        # which is the add-then-delete case above — and the worktree is not
        # necessarily what is being pushed.
        #
        # Written to a file rather than piped into grep. `git cat-file blob … |
        # grep -q` looks equivalent and is not: grep exits at the first match, git
        # keeps writing, and past the pipe buffer it dies of SIGPIPE — with
        # `pipefail` the pipeline then reports 141 and the `if` reads it as NO
        # MATCH. That is measured on the commit-message half of this same class,
        # where a large message with the name in its first line was missed on
        # every run. A large file is the same shape.
        if git --no-replace-objects cat-file -e "${sha}:${f}" 2>/dev/null; then
          git --no-replace-objects cat-file blob "${sha}:${f}" > "$blob" 2>/dev/null || true
          # No -I, so a name sitting in raw bytes is still found. That is worth
          # having and it is NOT the coverage an earlier version of this comment
          # claimed: it named "a PDF, a spreadsheet, an image with the name in its
          # metadata", and PDF text streams and every OOXML part are DEFLATE
          # compressed, so a literal grep finds nothing in them. Measured — a PDF
          # and a .gz carrying the name both passed clean, while an uncompressed
          # store in a zip was caught. What this covers is uncompressed binary;
          # a compressed carrier is out of reach of any lexical scan and is
          # stated here rather than implied away.
          if grep -qEi "$PRIVATE_NAMES_RE" "$blob"; then
            echo "❌ private name in the CONTENT of: ${f}  (commit ${sha:0:9})"
            file_hits=$((file_hits + 1))
          fi
        fi
      done < "$file_list"
    done
    rm -f "$blob" "$file_list"
  fi

  if [ "$file_hits" -gt 0 ]; then
    cat >&2 <<'EOF'

A customer or third-party name reached a file in this PUBLIC repo — in its path,
its contents, or both.

⚠ Deleting the file in a NEW commit does not fix this. The scan walks every
commit in the range, so a blob that was added and later removed is still found —
because it is still pushed. The name has to come out of the HISTORY:

    git rebase -i <base>          # drop or edit the commit that added it
    git commit --amend            # if it was the last commit

Then rename the file or describe the case neutrally in it — "a prod thread", "a
managed instance" — and keep the material in the private repo.

Do NOT bypass this check.
EOF
    exit 1
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
    if $mode_meta; then
      if [ "$meta_commits" -eq 0 ]; then
        echo "⚠️  public-repo-guard (check-meta): the range held NO commits — nothing was"
        echo "    scanned. Check that ${meta_base}..${meta_head} is the range you meant."
      fi
      echo "public-repo-guard (check-meta): clean ✓ (${meta_commits} commit(s) scanned)"
    else
      # Same reason as the commit counter: zero files is a real state (a range
      # that only changes messages, or an empty range) and it must not be able to
      # look like a scan that ran.
      if [ "$files_scanned" -eq 0 ]; then
        echo "⚠️  public-repo-guard (check-files): the range added or changed NO files —"
        echo "    nothing was scanned. Check that ${meta_base}..${meta_head} is the range you meant."
      fi
      echo "public-repo-guard (check-files): clean ✓ (${files_scanned} file(s) scanned, path + content)"
    fi
  else
    echo "public-repo-guard (${class_label}): class inactive — nothing scanned."
  fi
  exit 0
fi

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
  echo ""
  echo "For a private-name hit: describe the case neutrally — 'a prod thread', 'a"
  echo "managed instance' — and keep the name in the private repo or your notes."
  echo "Fixtures and examples take an unmistakably fictional name, not a plausible one."
  exit 1
fi

echo "public-repo-guard: clean ✓"
