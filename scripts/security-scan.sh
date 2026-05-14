#!/bin/sh
# Quick security pattern scan for lynox source code.
# Run: ./scripts/security-scan.sh

set -e
ERRORS=0
SRC="src"

echo "🔒 lynox security scan"
echo ""

# Check for dangerous code execution patterns — actual calls, not mentions in comments/regex/strings
if grep -rn -E '[^a-zA-Z_]eval\s*\(' "$SRC" --include='*.ts' | grep -v '.test.ts' | grep -v 'no-eval' | grep -v '// eslint' | grep -v 'pattern:' | grep -v "'eval" | grep -v '"eval' | grep -v 'Retrieval'; then
  echo "❌ Found dangerous code execution pattern in source files"
  ERRORS=$((ERRORS + 1))
else
  echo "✓ No dangerous code execution patterns found"
fi

# Check for hardcoded secrets
if grep -rn 'sk-ant-api' "$SRC" --include='*.ts' | grep -v '.test.ts'; then
  echo "❌ Found hardcoded API key"
  ERRORS=$((ERRORS + 1))
else
  echo "✓ No hardcoded secrets"
fi

# Check external tools wrap untrusted content. Either helper qualifies:
# wrapUntrustedData (single-string) or wrapChannelMessage (structured
# multi-field). Both produce the same <untrusted_data> boundary.
WRAP_OK=true
for file in src/tools/builtin/http.ts src/integrations/search/web-search-tool.ts src/integrations/google/google-gmail.ts src/integrations/google/google-sheets.ts src/integrations/google/google-drive.ts src/integrations/google/google-calendar.ts src/integrations/google/google-docs.ts; do
  if [ -f "$file" ] && ! grep -qE 'wrapUntrustedData|wrapChannelMessage' "$file"; then
    echo "❌ $file missing wrapUntrustedData or wrapChannelMessage"
    WRAP_OK=false
    ERRORS=$((ERRORS + 1))
  fi
done
if [ "$WRAP_OK" = true ]; then
  echo "✓ External tools wrap untrusted content"
fi

# Check SSRF protection on worker watch
if ! grep -q '127.0.0.1' src/core/worker-loop.ts; then
  echo "❌ worker-loop.ts missing SSRF protection"
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Watch task has SSRF protection"
fi

# Check spawn injection scanning in permission guard
if ! grep -q 'detectInjectionAttempt' src/tools/permission-guard.ts; then
  echo "❌ permission-guard.ts missing spawn injection detection"
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Permission guard scans spawn context"
fi

# Check debug subscriber masks tokens
if ! grep -q 'maskTokenPatterns' src/core/debug-subscriber.ts; then
  echo "❌ debug-subscriber.ts missing token masking"
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Debug subscriber masks token patterns"
fi

# Check HTTP redirect protection in worker-loop (SSRF via redirect)
if ! grep -q "redirect.*error" src/core/worker-loop.ts; then
  echo "❌ worker-loop.ts missing redirect protection on fetch (SSRF via redirect)"
  ERRORS=$((ERRORS + 1))
else
  echo "✓ Watch task fetch blocks redirects"
fi

# Check pipeline template resolution is single-pass (no recursive re-interpretation)
if grep -q 'resolveTaskTemplate' src/orchestrator/context.ts && grep -q '\.replace(' src/orchestrator/context.ts; then
  echo "✓ Pipeline template resolution uses single-pass replace"
else
  echo "❌ orchestrator/context.ts may use unsafe recursive template resolution"
  ERRORS=$((ERRORS + 1))
fi

# Dependency audit — check for known CVEs in production dependencies
echo ""
echo "Running dependency audit..."
if pnpm audit --prod > /dev/null 2>&1; then
  echo "✓ No known vulnerabilities in production dependencies"
else
  echo "⚠ Dependency audit found vulnerabilities (review with: pnpm audit --prod)"
  # Don't increment ERRORS — advisory only, may have false positives or unfixable issues
fi

echo ""
if [ $ERRORS -gt 0 ]; then
  echo "❌ Security scan failed with $ERRORS issues"
  exit 1
else
  echo "✓ Security scan passed"
fi
