#!/usr/bin/env bash
# gitleaks-config-canary.sh — fail when the repository's gitleaks config has
# stopped detecting anything, or has changed without anyone deciding it should.
#
# WHY THIS EXISTS
#
# A `.gitleaks.toml` with no `[extend] useDefault = true` and no rules of its own
# REPLACES the built-in ruleset with nothing. gitleaks then scans every commit,
# finds nothing and exits 0, and nothing about that output looks wrong. The config
# here was in that state from the first commit on, so the CI scan and the
# pre-commit hook both passed on anything.
#
# WHAT IT DOES
#
# 1. Compares the whole config, comments and blank lines aside, with the content
#    reviewed here (EXPECTED below). An allowlist of any form — paths, commits,
#    regexes, stopwords — a disabled rule or a rule of its own all change what the
#    scan reports, and a planted value only catches the forms that happen to cover
#    it. A deliberate change updates EXPECTED in the same pull request.
# 2. Plants a freshly generated, token-shaped value in a scratch tree next to
#    copies of `.gitleaks.toml` and `.gitleaksignore`, runs gitleaks from inside
#    that tree so it finds the config and reports paths the way the real scan
#    does, and requires the plant to be reported — in an ordinary source file and
#    in a test file. The value is generated per run: there is never a committed
#    one to find.
#
# EXIT CODES
#
#   0  the config is the reviewed one and reports the plant in both files
#   1  it is not, or it does not
#   2  the canary could not run (no work tree, no config, no gitleaks, no report,
#      or an environment that points gitleaks at a different config). That is not
#      the same as clean, so it is not 0.
set -euo pipefail

EXPECTED='[extend]
useDefault = true'

refuse() {
  echo "gitleaks-config-canary: $1 — refusing to report the config as working" >&2
  exit 2
}

root="$(git rev-parse --show-toplevel 2>/dev/null)" || refuse "not inside a git work tree"
[[ -f "$root/.gitleaks.toml" ]] || refuse "no .gitleaks.toml at $root"
# GITLEAKS_CONFIG takes precedence over the file in every gitleaks version, the
# real scan included; GITLEAKS_CONFIG_TOML does from 8.30 on (8.21.2 ignores it).
# Refusing on both is deliberately the cautious side.
if [[ -n "${GITLEAKS_CONFIG:-}${GITLEAKS_CONFIG_TOML:-}" ]]; then
  refuse "GITLEAKS_CONFIG or GITLEAKS_CONFIG_TOML is set, so gitleaks would not read .gitleaks.toml"
fi
command -v gitleaks > /dev/null 2>&1 || refuse "gitleaks is not installed"

actual="$(grep -vE '^[[:space:]]*(#|$)' "$root/.gitleaks.toml" | sed -E 's/[[:space:]]+$//' || true)"
if [[ "$actual" != "$EXPECTED" ]]; then
  echo "::error::gitleaks-config-canary: .gitleaks.toml differs from the reviewed content (comments aside)." >&2
  echo "  Expected exactly:" >&2
  sed 's/^/    /' <<< "$EXPECTED" >&2
  echo "  Anything else — an allowlist, a disabled rule, a rule of its own — changes what" >&2
  echo "  the scan reports. If the change is deliberate, update EXPECTED in" >&2
  echo "  scripts/gitleaks-config-canary.sh in the same pull request." >&2
  exit 1
fi

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/tree/src"
cp "$root/.gitleaks.toml" "$scratch/tree/.gitleaks.toml"
if [[ -f "$root/.gitleaksignore" ]]; then
  cp "$root/.gitleaksignore" "$scratch/tree/.gitleaksignore"
fi

# `ghp_` + 36 hex characters: the shape of gitleaks' built-in `github-pat` rule.
body="$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')"
[[ ${#body} -eq 36 ]] || refuse "could not generate the planted value"
for f in src/leak.ts src/leak.test.ts; do
  printf 'export const token = "ghp_%s";\n' "$body" > "$scratch/tree/$f"
done

# From inside the tree with `--source .`, so findings carry the same relative
# paths (`src/leak.ts`) that the repository scan reports.
set +e
(cd "$scratch/tree" && gitleaks detect --no-git --source . --redact --no-banner \
  --report-format json --report-path "$scratch/report.json") > "$scratch/out.log" 2>&1
rc=$?
set -e

if [[ $rc -eq 0 ]]; then
  echo "::error::gitleaks-config-canary: gitleaks reported NOTHING for a planted github-pat value." >&2
  echo "  The installed gitleaks has no active rule for it under this config." >&2
  exit 1
fi
[[ $rc -eq 1 ]] || { sed 's/^/  /' "$scratch/out.log" >&2; refuse "gitleaks exited $rc"; }
[[ -s "$scratch/report.json" ]] || refuse "gitleaks wrote no report"

missing=0
for f in src/leak.ts src/leak.test.ts; do
  if ! grep -qE "\"File\": *\"(\\./)?${f//./\\.}\"" "$scratch/report.json"; then
    echo "::error::gitleaks-config-canary: the plant in ${f} was not reported." >&2
    missing=1
  fi
done
[[ $missing -eq 0 ]] || exit 1

echo "gitleaks-config-canary: ok ✓ (reviewed config; planted value reported in a source file and in a test file)"
