#!/bin/sh
# A lefthook SCRIPT, not a command: lefthook skips pre-push commands when the pushed tree equals the
# tree of origin/HEAD (measured, 2.1.5 + 2.1.8) and exits 0. See push-lands-guard.mjs.
# $1 = remote name, $2 = remote URL; the ref lines arrive on stdin (`use_stdin: true`) and pass
# through to node.
#
# The push goes through ONLY on the script's own "verdict: 0" line. A run that ends without one —
# node exiting 0 before reaching main(), a wrong path — is refused, not passed.
out=$(node "$(git rev-parse --show-toplevel)/scripts/push-lands-guard.mjs" hook "$1" "$2" 2>&1)
rc=$?
printf '%s\n' "$out"
case "$out" in
  *"push-lands-guard verdict: $rc"*) exit "$rc" ;;
esac
echo "⛔ push-lands-guard: the check ended without its verdict line (exit $rc) — refusing the push." >&2
exit 2
