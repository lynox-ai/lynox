#!/usr/bin/env bash
# pre-release-check.sh — verify NPM_TOKEN is valid before attempting publish.
#
# Runs in release.yml as a gate job before docker + npm publish. Protects
# against NPM_TOKEN drift: if the token value in the GitHub secret does not
# match a currently-valid token on npmjs.com, fail fast here rather than
# mid-release after docker images have already been pushed.
#
# History: v1.0.2, v1.0.3, v1.0.4 release attempts all failed with a
# disguised 404 from npm because NPM_TOKEN had drifted. v1.0.3 had to be
# published manually. This script makes the drift visible at the top of the
# release workflow.
#
# Runs `curl /-/whoami` against the npm registry with the token as Bearer
# auth — exactly the same auth path that `npm publish` takes. A 200 means
# the token is valid and not expired. Any other response exits non-zero
# with a clear error message and rotation instructions.
#
# Usage:
#   NPM_TOKEN=xxx ./scripts/pre-release-check.sh
#
# In CI: called from release.yml with `env: NPM_TOKEN: ${{ secrets.NPM_TOKEN }}`.

set -euo pipefail

if [[ -z "${NPM_TOKEN:-}" ]]; then
  echo "::error::NPM_TOKEN env var is not set"
  echo ""
  echo "In CI: make sure the step has"
  echo "    env:"
  echo "      NPM_TOKEN: \${{ secrets.NPM_TOKEN }}"
  exit 1
fi

echo "Verifying NPM_TOKEN against npmjs registry..."

# Capture status + body separately so we can report both on failure.
HTTP_RESPONSE=$(curl -sS -w '\n%{http_code}' \
  -H "Authorization: Bearer $NPM_TOKEN" \
  "https://registry.npmjs.org/-/whoami")
HTTP_CODE=$(printf '%s\n' "$HTTP_RESPONSE" | tail -n1)
BODY=$(printf '%s\n' "$HTTP_RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "::error::NPM_TOKEN rejected by registry (HTTP $HTTP_CODE)"
  echo ""
  echo "Response body:"
  echo "  $BODY"
  echo ""
  echo "Most likely causes:"
  echo "  1. Token expired on npmjs.com (granular tokens expire)"
  echo "  2. GH secret NPM_TOKEN drifted from the token on npmjs.com"
  echo "     (was rotated locally but not updated in the repo secret)"
  echo "  3. Token was revoked"
  echo ""
  echo "Fix:"
  echo "  a. Generate a new granular token at:"
  echo "       https://www.npmjs.com/settings/<user>/tokens/granular-access-tokens/new"
  echo "     Scope: read+write on @lynox-ai/core"
  echo "     2FA: bypass for automation"
  echo "     Expiry: 365 days"
  echo ""
  echo "  b. Update the repo secret:"
  echo "       gh secret set NPM_TOKEN -R lynox-ai/lynox --body=<new-token>"
  echo ""
  echo "  c. Re-run this workflow."
  exit 1
fi

# Extract username from {"username":"..."} response for the success log.
USERNAME=$(printf '%s' "$BODY" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
if [[ -z "$USERNAME" ]]; then
  USERNAME="(unknown — whoami returned 200 but no username field)"
fi

echo "✓ NPM_TOKEN valid — authenticated as: $USERNAME"
echo ""
echo "Note: whoami validates token existence and expiry but does NOT"
echo "verify publish scope. If the real publish later fails with a 404,"
echo "the token likely lacks read+write access on @lynox-ai/core."
