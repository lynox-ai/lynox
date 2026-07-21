#!/usr/bin/env bash
#
# drift-guard.sh — catch the MECHANIZABLE slices of documentation/code drift
# that gitleaks + public-repo-guard don't (those are for secrets/infra leaks).
#
# Drift is mostly semantic and can't be fully guarded, but five classes are
# deterministic and high-value:
#   A. Merge-conflict markers committed by accident (caught the v1.8.2
#      `lynox --help` garble that shipped to npm).
#   B. Removed features (Telegram / WhatsApp / MCP server) reappearing as LIVE
#      docs — i.e. outside docs/**/archive/.
#   C. Dead doc-path references — backtick `src/…` paths in CLAUDE.md / docs /
#      READMEs that point at files which no longer exist.
#   D. README provider-verification matrix vs `verification:` in the
#      OPENAI_COMPAT_PRESETS of src/core/llm/catalog.ts (a preset promoted to
#      'verified' MUST be claimed verified in README; an 'experimental' preset
#      must never be presented as verified).
#   E. README test-count badge ("tests-<N>%2B" + "<N>+ tests" prose) vs the
#      real it()/test() call-site count.
#
# Semantic drift (a doc claim that contradicts code) is NOT covered here — the
# doc<->code coupling vitest tests (tests/doc-drift.test.ts) cover the specific
# high-churn surfaces, and a periodic audit covers the rest.
#
# Enforcement: pre-push (lefthook) + CI (.github/workflows/drift-guard.yml).
#
# Usage: scripts/drift-guard.sh        # scan whole tracked tree
#
# Escape hatch (class B/C only — A is never exempt): put the pragma
# `drift-guard:allow <reason>` anywhere on the offending line.

set -euo pipefail

PRAGMA='drift-guard:allow'
SELF_EXCLUDE='scripts/drift-guard.sh .github/workflows/drift-guard.yml'

# B: removed features that must not appear in LIVE docs (archive/ is exempt).
REMOVED='[Tt]elegram|[Ww]hats[Aa]pp|MCP[ -]server'

# C: backtick path prefixes treated as real repo paths to verify.
PATH_RE='`(src|packages|scripts|tests|docs)/[A-Za-z0-9_./-]+`'

is_excluded() {
  local f="$1"
  for x in $SELF_EXCLUDE; do [ "$f" = "$x" ] && return 0; done
  return 1
}

# A doc path is "alive" if it exists relative to the repo root OR as a suffix
# of any tracked path — docs legitimately use package-relative paths
# (e.g. `src/lib/...` meaning packages/web-ui/src/lib/...).
ALL_TRACKED="$(git ls-files)"
exists_path() {
  local p="${1%/}"
  [ -e "$p" ] && return 0
  local esc
  esc="$(printf '%s' "$p" | sed 's/[.[\*^$/]/\\&/g')"
  # Here-string, not `printf | grep -q`: under `set -o pipefail`, grep -q closing
  # the pipe early on a match sends SIGPIPE to printf (exit 141), which pipefail
  # then propagates as the pipeline's status — so `&& return 0` would not fire and
  # an existing path would be falsely reported dead (intermittent, list-size/timing
  # dependent). A here-string has no producer process, so no SIGPIPE.
  grep -qE "(^|/)${esc}(/|\$)" <<< "$ALL_TRACKED" && return 0
  return 1
}

violations=0

# ── A. Merge-conflict markers (every tracked text file) ──────────────────
# Match only the unambiguous git markers (<<<<<<< and >>>>>>> at col 0); the
# ======= separator is skipped to avoid clashing with markdown setext rules.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  is_excluded "$f" && continue
  grep -Iq . "$f" 2>/dev/null || continue
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "❌ A/merge-conflict marker in $f:"
    echo "     ${line}"
    violations=$((violations + 1))
  done < <(grep -nE '^(<<<<<<<|>>>>>>>)' "$f" 2>/dev/null || true)
done < <(git ls-files)

# ── B. Removed feature in a LIVE doc (outside archive/) ───────────────────
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  case "$f" in */archive/*) continue ;; esac
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in *"$PRAGMA"*) continue ;; esac
    echo "⚠️  B/removed-feature in LIVE doc $f (move to archive/ or add '${PRAGMA}'):"
    echo "     ${line}"
    violations=$((violations + 1))
  done < <(grep -nIE "$REMOVED" "$f" 2>/dev/null || true)
done < <(git ls-files 'docs/src/content/docs/*')

# ── C. Dead doc-path references in CLAUDE.md / docs / READMEs ─────────────
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  is_excluded "$f" && continue
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    lineno="${hit%%:*}"
    rest="${hit#*:}"
    case "$rest" in *"$PRAGMA"*) continue ;; esac
    # Extract each backtick path on the line and verify existence.
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      path="${p//\`/}"
      # Skip globs / placeholders.
      case "$path" in *'<'*|*'>'*|*'*'*|*'{'*|*'…'*|*' '*) continue ;; esac
      if ! exists_path "$path"; then
        echo "⚠️  C/dead-path ref in $f:$lineno — \`$path\` does not exist (add '${PRAGMA}' if intentional):"
        violations=$((violations + 1))
      fi
    done < <(printf '%s\n' "$rest" | grep -oE "$PATH_RE" || true)
  done < <(grep -nE "$PATH_RE" "$f" 2>/dev/null || true)
done < <(git ls-files '*CLAUDE.md' '*README.md' 'docs/src/content/docs/*')

# ── D. README provider-verification matrix vs the LLM catalog ─────────────
# The public README claims which OpenAI-compat presets are "verified"; the
# source of truth is `verification:` in OPENAI_COMPAT_PRESETS. Heuristic —
# deliberately the simplest robust variant (clause-scoped co-occurrence, not
# sentence parsing):
#   * README is split into CLAUSES on `.` `;` and `—` (em-dash). That keeps
#     "presets cover Ollama, LM Studio, … — Ollama and Fireworks are verified"
#     from tying the experimental list to the "verified" claim.
#   * Every 'verified' preset must appear in >=1 clause that also contains the
#     word "verified" (not "unverified") — a preset promoted to 'verified'
#     without a README mention is the actual drift case and must FAIL.
#   * No 'experimental' preset may appear in a clause containing "verified",
#     unless that clause also says "experimental" (so "X is experimental, not
#     yet verified" stays legal but "X is verified" fails).
#   * Short names: display_name minus " (…)" suffix, minus trailing " AI"
#     ("Ollama (local)" → "Ollama", "Fireworks AI" → "Fireworks").
#   * Extraction yielding 0 presets or 0 verified presets FAILS — a guard that
#     silently passes when its source moves is worse than no guard.
CATALOG='src/core/llm/catalog.ts'
README_MAIN='README.md'

# "display_name<TAB>verification" per preset, in source order.
preset_pairs="$(
  awk '/const OPENAI_COMPAT_PRESETS/{f=1} f && /^\];/{exit} f{print}' "$CATALOG" \
    | grep -E "^[[:space:]]*(display_name|verification):" \
    | sed -E "s/^[[:space:]]*(display_name|verification): '([^']*)'.*/\1=\2/" \
    | awk -F= '/^display_name=/{n=$2} /^verification=/{if (n != "") {printf "%s\t%s\n", n, $2; n=""}}' \
    || true
)"

readme_clauses="$(awk '{ gsub(/[.;]/, "\n"); gsub(/—/, "\n"); print }' "$README_MAIN")"

if [ -z "$preset_pairs" ]; then
  echo "❌ D/provider-matrix: extracted 0 presets from $CATALOG — array/field shape changed; fix the extraction (this check must not pass silently)."
  violations=$((violations + 1))
else
  verified_seen=0
  while IFS=$'\t' read -r name verif; do
    [ -n "$name" ] || continue
    short="$(printf '%s' "$name" | sed -E 's/ \([^)]*\)$//; s/ AI$//')"
    name_clauses="$(grep -F -- "$short" <<< "$readme_clauses" || true)"
    verified_claims="$(grep -E '(^|[^A-Za-z])[Vv]erified' <<< "$name_clauses" || true)"
    case "$verif" in
      verified)
        verified_seen=$((verified_seen + 1))
        if [ -z "$verified_claims" ]; then
          echo "❌ D/provider-matrix: '$name' is verification:'verified' in $CATALOG but no $README_MAIN clause names '$short' as verified — add it to the verified claim in the README."
          violations=$((violations + 1))
        fi
        ;;
      experimental)
        bad="$(grep -Ev '(^|[^A-Za-z])[Ee]xperimental' <<< "$verified_claims" || true)"
        if [ -n "$bad" ]; then
          echo "❌ D/provider-matrix: '$name' is verification:'experimental' in $CATALOG but a $README_MAIN clause presents '$short' as verified:"
          echo "     $(printf '%s\n' "$bad" | head -1)"
          violations=$((violations + 1))
        fi
        ;;
    esac
  done <<< "$preset_pairs"
  if [ "$verified_seen" -eq 0 ]; then
    echo "❌ D/provider-matrix: extracted presets but 0 with verification:'verified' from $CATALOG — extraction is likely broken (Ollama/Fireworks are expected); fix it rather than let the check no-op."
    violations=$((violations + 1))
  fi
fi

# ── E. README test-count badge vs the real test count ─────────────────────
# README states "<N>+ tests" twice: shields badge (tests-<N>%2B) and prose.
# Both must agree, and N must stay honest against the real it()/test()
# call-site count:
#   * N > real count       → overclaim → FAIL.
#   * real count > N * 1.5 → FAIL. "N+" makes understating technically true,
#     but once reality is >50% above the claim the badge is stale enough to
#     read as unmaintained. 1.5 leaves roughly a year of test growth of
#     headroom so the badge does not need touching every release.
# sed capture, not a bare digit-grep — the %2B in the badge contains a digit.
badge_ns="$(grep -oE 'tests-[0-9]+%2B' "$README_MAIN" | sed -E 's/^tests-([0-9]+)%2B$/\1/' | sort -u || true)"
text_ns="$(grep -oE '[0-9]+\+ tests' "$README_MAIN" | sed -E 's/^([0-9]+)\+ tests$/\1/' | sort -u || true)"

if [ -z "$badge_ns" ] || [ -z "$text_ns" ]; then
  echo "❌ E/test-count: could not find the tests-<N>%2B badge and/or the '<N>+ tests' prose line in $README_MAIN — restore them or update this check."
  violations=$((violations + 1))
elif [ "$(wc -l <<< "$badge_ns" | tr -d '[:space:]')" != "1" ] \
  || [ "$(wc -l <<< "$text_ns" | tr -d '[:space:]')" != "1" ] \
  || [ "$badge_ns" != "$text_ns" ]; then
  echo "❌ E/test-count: badge says 'tests-$(tr '\n' ',' <<< "$badge_ns" | sed 's/,$//')' but prose says '$(tr '\n' ',' <<< "$text_ns" | sed 's/,$//')+ tests' — the two claims in $README_MAIN must be a single agreeing number."
  violations=$((violations + 1))
else
  claimed_n="$badge_ns"
  actual_tests="$(grep -rE '^[[:space:]]*(it|test)(\.each)?\(' src tests packages/web-ui/src --include='*.test.ts' 2>/dev/null | wc -l | tr -d '[:space:]' || true)"
  if [ -z "$actual_tests" ] || [ "$actual_tests" -eq 0 ]; then
    echo "❌ E/test-count: counted 0 it()/test() call sites — test tree moved or grep went blind; fix the count (this check must not pass silently)."
    violations=$((violations + 1))
  elif [ "$claimed_n" -gt "$actual_tests" ]; then
    echo "❌ E/test-count: $README_MAIN claims '${claimed_n}+ tests' but only $actual_tests it()/test() call sites exist — overclaim; lower the badge + prose."
    violations=$((violations + 1))
  elif [ $((actual_tests * 2)) -gt $((claimed_n * 3)) ]; then
    echo "❌ E/test-count: $README_MAIN claims '${claimed_n}+ tests' but $actual_tests exist (>1.5x) — badge is stale; raise it to match reality."
    violations=$((violations + 1))
  fi
fi

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "drift-guard: ${violations} drift marker(s) found."
  echo "A (merge markers) is never exempt — resolve the conflict."
  echo "B/C can be annotated with '${PRAGMA}: <reason>' on the line if intentional."
  echo "D/E (README vs code facts) have no pragma — fix README.md or the source it drifted from."
  exit 1
fi

echo "drift-guard: clean ✓"
