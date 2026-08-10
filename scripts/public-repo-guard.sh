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

# HARD, third class — names of customers and other real third parties.
#
# Unlike the two classes above, the pattern is NOT in this file. Writing the names
# here would be the leak it exists to prevent, and SELF_EXCLUDE would not help: the
# names would sit in a public file either way. It comes from outside the repo
# instead — `LYNOX_PRIVATE_NAMES_RE`, from a GitHub secret in CI and from a file
# under the operator's home directory locally. A reader of this repo learns that
# the class exists, never who is on the list.
#
# Three properties this class does not share with the others, all deliberate:
#
#  1. It never prints the matching line — only `file:lineno`. Actions logs on a
#     public repo are public, and here the match IS the name, so echoing the line
#     would publish exactly what the guard exists to keep out. GitHub's secret
#     masking does not save it: that masks the pattern's value, not the name the
#     pattern found. Path hits print no path either — there the name is the path.
#  2. A missing pattern FAILS by default; skipping is something a caller has to
#     ASK for (`--allow-missing-names`). The safe direction belongs in the default
#     so that dropping the flag somewhere can only ever make a caller louder, never
#     quieter.
#
#     Where it actually runs today, and this is a deliberate stage rather than an
#     oversight: the class is enforced at PRE-PUSH, and both CI callers pass the
#     opt-out, because the secret holding the pattern is not set yet. So CI checks
#     the four other classes and annotates this one as inactive on every run — an
#     opt-out nobody can see would rot into the permanent state. Setting the
#     secret arms it with no change to this file or the workflow, since the flag
#     only decides what happens when the pattern is ABSENT.
#  3. It scans commit messages and PR text too, via the `check-meta` subcommand.
#     That is where this particular leak has actually happened; a merged commit
#     message is also the one surface that cannot be edited afterwards.
#
# Word boundaries belong IN the pattern, not here. A bare surname matches inside
# unrelated words, while a coined company name usually SHOULD match as a substring
# — only whoever writes the list knows which is which, so `-w` is not imposed on
# it. `scripts/no-ai-attribution.sh` documents what the careless version costs:
# its first pattern matched a line of prose that was explaining the rule.
# Two ways in, because a variable alone would have made this class dead locally:
# the pre-push hook passes no environment, so nobody would ever have exported it
# and the guard would have skipped itself on every push — worse than not having
# the class at all. So the file is the ordinary local path and needs no setup
# beyond existing; the variable is what CI injects and takes precedence.
# `<VAR>_FILE` mirrors LYNOX_KNOWLEDGE_PROXY_KEY_FILE, the same shape this repo
# already uses for operator-private material.
PRIVATE_NAMES_FILE="${LYNOX_PRIVATE_NAMES_RE_FILE:-${HOME:-}/.lynox/private-names.re}"
PRIVATE_NAMES_RE="${LYNOX_PRIVATE_NAMES_RE:-}"
if [ -z "$PRIVATE_NAMES_RE" ] && [ -r "$PRIVATE_NAMES_FILE" ]; then
  # One pattern per line, `#` comments and blanks dropped, surrounding whitespace
  # and a stray CR trimmed, joined into an alternation — a list is easier to
  # maintain and review than one long regex.
  #
  # The trim is not cosmetic. Untrimmed, ONE leading space (what happens the first
  # time somebody indents the list) or a CRLF file leaves the entry syntactically
  # valid and semantically dead: it silently matches nothing, the guard prints
  # `clean ✓`, and the name it was supposed to stop walks into the public repo.
  PRIVATE_NAMES_RE="$(
    sed -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$PRIVATE_NAMES_FILE" \
      | grep -vE '^(#|$)' \
      | paste -sd'|' - || true
  )"
fi

# PREFLIGHT — the pattern is operator-supplied and therefore the likeliest thing
# in this file to be wrong. Every failure mode below used to end in `clean ✓`,
# because every grep in the class swallows stderr and drops its exit code:
#
#   - an unbalanced parenthesis (`Nordberg AG (CH`) — grep exits 2, the loop never
#     runs, nothing is printed, CI is green and the name stays in the repo
#   - an empty alternative (`a||b`, from one trailing `|` in the list) — GNU grep
#     accepts it and matches EVERY line, so CI goes red on the whole tree while
#     BSD grep locally calls it an error and stays green. Diagnosing that from a
#     CI log is nobody's good afternoon, and the obvious way out is to disable
#     the class.
#
# So validate once, up front, and fail LOUDLY. Note what is not printed: the
# pattern itself. It is the list of names — an error message quoting it would be
# the leak. grep's own diagnostic is dropped for the same reason (busybox grep
# echoes the pattern back).
preflight_names_re() {
  case "$PRIVATE_NAMES_RE" in
    '|'*|*'|') echo "❌ public-repo-guard: private-name pattern has an empty alternative (leading or trailing '|')." >&2; return 1 ;;
    *'||'*)    echo "❌ public-repo-guard: private-name pattern has an empty alternative ('||')." >&2; return 1 ;;
  esac
  # grep exits 1 on "no match" — expected against empty input — and >=2 on a bad
  # regex. Only the latter is a problem. The status has to be captured on the
  # command itself: read inside an `if` body it would be the condition's status,
  # and left bare it would trip `set -e` on the perfectly normal no-match.
  local rc=0
  printf '' | grep -qE "$PRIVATE_NAMES_RE" 2>/dev/null || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "❌ public-repo-guard: private-name pattern is not a valid extended regex." >&2
    return 1
  fi

  # The catch-all, and the only one of these checks that is hard to fool: a
  # pattern that matches an EMPTY LINE matches every line there is.
  #
  # The `case` above only sees an empty alternative at the top level. One
  # parenthesis deep — `(name|)` — it passes, and GNU grep then flags the entire
  # tree while BSD grep locally calls it an error, so the failure looks like a
  # platform mystery instead of a typo. The likeliest source of it is not even a
  # typo: LYNOX_PRIVATE_NAMES_RE is pasted into a GitHub secret textarea, and a
  # blank line in the middle of that paste produces exactly the same thing.
  #
  # `a*`, `a?` and `()` are caught by the same test, which is why it is worth
  # more than the three special cases it subsumes.
  rc=0
  printf '\n' | grep -qE "$PRIVATE_NAMES_RE" 2>/dev/null || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "❌ public-repo-guard: private-name pattern matches an empty line, so it" >&2
    echo "   would match every line in the repo. Check for a blank entry, a stray" >&2
    echo "   '|', or an optional-everything form like (name|) or name*." >&2
    return 1
  fi
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
  echo "usage: public-repo-guard.sh [--staged] [--allow-missing-names]" >&2
  echo "       public-repo-guard.sh check-meta <base-ref> <head-ref>" >&2
  exit 2
}

mode_staged=false
mode_meta=false
allow_missing_names=false
meta_base=''
meta_head=''

while [ $# -gt 0 ]; do
  case "$1" in
    --staged)              mode_staged=true ;;
    --allow-missing-names) allow_missing_names=true ;;
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

# Resolve the private-name pattern. Fails closed unless the caller opted out —
# see property 2 in the class comment above for why that direction, not the other.
names_active=false
if [ -n "$PRIVATE_NAMES_RE" ]; then
  preflight_names_re || exit 1
  names_active=true
elif $allow_missing_names; then
  echo "⚠️  public-repo-guard: private-name class SKIPPED — no pattern configured."
  echo "    Every other class still ran. To arm it, put one regex per line in"
  echo "    ~/.lynox/private-names.re (or export LYNOX_PRIVATE_NAMES_RE)."
else
  echo "❌ public-repo-guard: LYNOX_PRIVATE_NAMES_RE is unset or empty." >&2
  echo "   Refusing to report a clean run for a scan that did not happen." >&2
  echo "   In CI: set the secret of that name — for Actions AND for Dependabot," >&2
  echo "   which has its own secret store and would otherwise land here." >&2
  echo "   Locally: pass --allow-missing-names, as the pre-push hook does." >&2
  exit 1
fi

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
      # match. git refuses NUL in a commit message, but PR text is not git's.
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
    # Title and body arrive through the environment, never interpolated into a
    # command line — the same shape no-ai-attribution.yml uses for its SHAs.
    if [ -n "${PR_TITLE:-}" ] && grep -qEi "$PRIVATE_NAMES_RE" <<<"$PR_TITLE"; then
      echo "❌ private name in the pull-request TITLE"
      meta_hits=$((meta_hits + 1))
    fi
    if [ -n "${PR_BODY:-}" ] && grep -qEi "$PRIVATE_NAMES_RE" <<<"$PR_BODY"; then
      echo "❌ private name in the pull-request BODY"
      meta_hits=$((meta_hits + 1))
    fi
  fi

  if [ "$meta_hits" -gt 0 ]; then
    cat >&2 <<'EOF'

A customer or third-party name reached a commit message or the pull request text.
This is the PUBLIC repo. Describe the case neutrally instead — "a prod thread",
"a managed instance" — and keep the name in the private repo or in your notes.

Title and body are editable and should be edited now. A commit message is not,
once merged, so rewrite it while the branch is still yours:

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

# Print an offending line — the only place any class is allowed to do so.
#
# The private-name class withholds its own matches, but that alone was worth
# nothing: the four older classes each echoed their line verbatim, and one line
# can trip two classes at once. "Customer X runs on <service host>" is the SOFT
# class's whole reason to exist, and it would have published the name into a
# public Actions log while the private-name class dutifully printed a bare line
# number for the very same line. A guard that leaks what it guards is worse than
# no guard, so the withholding belongs at the single exit, not in one class.
emit_line() {
  local line="$1"
  if $names_active && printf '%s' "$line" | grep -qEi "$PRIVATE_NAMES_RE" 2>/dev/null; then
    echo "     [line withheld — it contains a private name; see the private-name hit above]"
    return
  fi
  echo "     ${line}"
}

# The same restraint for a PATH. Withholding the line while printing the file it
# came from closed only half the hole: a name lands in a FILENAME just as easily,
# and then every class that names its file publishes it — including the
# private-name class itself, whose own comment promises the opposite. The line
# and the path are two axes of one leak, so they get one treatment.
safe_path() {
  local p="$1"
  if $names_active && printf '%s' "$p" | grep -qEi "$PRIVATE_NAMES_RE" 2>/dev/null; then
    echo "[path withheld — it contains a private name]"
    return
  fi
  echo "$p"
}

violations=0
name_path_hits=0

# PATHS — the content greps below never see file NAMES. A vendored tooling
# directory could therefore be committed (and enter the Docker build context)
# while every content scan stays clean. Check the tracked paths themselves.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  is_excluded "$f" && continue
  if printf '%s' "$f" | grep -qEi "$HARD_LOCAL_TOOLING"; then
    echo "❌ HARD leak marker (operator-local tooling) in PATH: $(safe_path "$f")"
    violations=$((violations + 1))
  fi
  # Counted, not named: printing the path would print the name that is in it.
  if $names_active && printf '%s' "$f" | grep -qEi "$PRIVATE_NAMES_RE"; then
    name_path_hits=$((name_path_hits + 1))
    violations=$((violations + 1))
  fi
done < <(list_files)

if [ "$name_path_hits" -gt 0 ]; then
  echo "❌ HARD leak marker (private name) in ${name_path_hits} tracked PATH(s)."
  echo "   Paths withheld — the name IS the path here, so naming them would leak it."
  echo "   To locate: git ls-files | grep -Ei \"\$LYNOX_PRIVATE_NAMES_RE\" on your machine."
fi

while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  is_excluded "$f" && continue
  # Skip binaries.
  if grep -Iq . "$f" 2>/dev/null; then :; else continue; fi

  # HARD — no exemptions.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "❌ HARD leak marker in $(safe_path "$f"):"
    emit_line "$line"
    violations=$((violations + 1))
  done < <(grep -nIE "$HARD" "$f" 2>/dev/null || true)

  # HARD (operator-local tooling) — case-INSENSITIVE (the -i below), so the
  # pattern stays short without spelling out the vendor name it keeps out.
  # Deliberately a separate grep from the main HARD run:
  # folding -i into the main HARD run makes `lynox[_-]managed` match every
  # legitimate LYNOX_MANAGED_* env var (164 false positives when tried).
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "❌ HARD leak marker (operator-local tooling) in $(safe_path "$f"):"
    emit_line "$line"
    violations=$((violations + 1))
  done < <(grep -nIEi "$HARD_LOCAL_TOOLING" "$f" 2>/dev/null || true)

  # HARD (private names) — `cut` keeps the line NUMBER and drops the line, which is
  # the whole point: the matched text is the name. Sits above the whole-file allow
  # with the other HARD classes, so no file can exempt itself from it.
  if $names_active; then
    while IFS= read -r n; do
      [ -n "$n" ] || continue
      echo "❌ HARD leak marker (private name) at $(safe_path "$f"):$n"
      violations=$((violations + 1))
    done < <(grep -nIEi "$PRIVATE_NAMES_RE" "$f" 2>/dev/null | cut -d: -f1 || true)
  fi

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
    echo "❌ internal cross-reference in $(safe_path "$f") (state the reason inline instead):"
    emit_line "$line"
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
    echo "❌ internal cross-reference opened in $(safe_path "$f") and continued on the next line:"
    emit_line "$line"
    violations=$((violations + 1))
  done < <(grep -nIE "$REF_OPENER" "$f" 2>/dev/null || true)

  # SOFT — exempt if the line carries the pragma. Whole-file allow already
  # returned above, so it needs no second check here.
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      *"$PRAGMA"*) continue ;;  # inline-allowed
    esac
    echo "⚠️  internal hostname in $(safe_path "$f") (add '${PRAGMA}' with a reason if intentional):"
    emit_line "$line"
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
