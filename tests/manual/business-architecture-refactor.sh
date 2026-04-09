#!/usr/bin/env bash
# Manual verification tests for the Business Architecture Refactor
# Run from lynox repo root: bash tests/manual/business-architecture-refactor.sh
# Requires: ANTHROPIC_API_KEY set (for live agent tests)
#
# Tests: LynoxContext, 3-scope model, context_id in SQL, workspace isolation,
#        heuristic classifier, feature flags, project detection, system prompt

set -uo pipefail
PASS=0; FAIL=0

check() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "✅ $label"; PASS=$((PASS + 1))
  else
    echo "❌ $label"; FAIL=$((FAIL + 1))
  fi
}

check_output() {
  local label="$1"; local expected="$2"; shift 2
  local out
  out=$("$@" 2>&1) || true
  if echo "$out" | grep -q "$expected"; then
    echo "✅ $label"; PASS=$((PASS + 1))
  else
    echo "❌ $label (expected '$expected', got: $(echo "$out" | head -1))"; FAIL=$((FAIL + 1))
  fi
}

echo "=== 1. CONTEXT RESOLUTION ==="

check_output "CLI resolves source=cli" "cli" \
  node --import tsx -e "
    import { resolveContext } from './src/core/context.js';
    console.log(resolveContext({}).source);
  "

check_output "CLI has localDir" "true" \
  node --import tsx -e "
    import { resolveContext } from './src/core/context.js';
    console.log(!!resolveContext({}).localDir);
  "

check_output "CLI has 16-char hash ID" "true" \
  node --import tsx -e "
    import { resolveContext } from './src/core/context.js';
    const c = resolveContext({});
    console.log(c.id.length === 16 && /^[a-f0-9]+$/.test(c.id));
  "

check_output "Telegram uses explicit context" "telegram" \
  node --import tsx -e "
    import { resolveContext } from './src/core/context.js';
    console.log(resolveContext({ context: { id: 'c1', source: 'telegram', workspaceDir: '/tmp/x' } }).source);
  "

check_output "Empty workspaceDir auto-generates path" "true" \
  node --import tsx -e "
    import { resolveContext } from './src/core/context.js';
    const c = resolveContext({ context: { id: 'test', source: 'slack', workspaceDir: '' } });
    console.log(c.workspaceDir.includes('test'));
  "

echo ""
echo "=== 2. SCOPE MODEL (3-TIER) ==="

check_output "SCOPE_ORDER has 3 entries" "3" \
  node --import tsx -e "
    import { SCOPE_ORDER } from './src/core/scope-resolver.js';
    console.log(SCOPE_ORDER.length);
  "

check_output "resolveActiveScopes: global + context + user" '3' \
  node --import tsx -e "
    import { resolveActiveScopes } from './src/core/scope-resolver.js';
    console.log(resolveActiveScopes({ contextId: 'x', userId: 'u' }).length);
  "

check_output "resolveActiveScopes: empty → global only" '1' \
  node --import tsx -e "
    import { resolveActiveScopes } from './src/core/scope-resolver.js';
    console.log(resolveActiveScopes({}).length);
  "

check_output "scopeToDir: context → bare ID" "abc123" \
  node --import tsx -e "
    import { scopeToDir } from './src/core/scope-resolver.js';
    console.log(scopeToDir({ type: 'context', id: 'abc123' }));
  "

check_output "scopeToDir: user → user-prefixed" "user-rafael" \
  node --import tsx -e "
    import { scopeToDir } from './src/core/scope-resolver.js';
    console.log(scopeToDir({ type: 'user', id: 'rafael' }));
  "

echo ""
echo "=== 3. SCOPE BACKWARD COMPAT ==="

check_output "parseScopeString: project:abc → context:abc" '"context"' \
  node --import tsx -e "
    import { parseScopeString } from './src/core/scope-resolver.js';
    console.log(JSON.stringify(parseScopeString('project:abc')?.type));
  "

check_output "parseScopeString: context:abc → context:abc" '"context"' \
  node --import tsx -e "
    import { parseScopeString } from './src/core/scope-resolver.js';
    console.log(JSON.stringify(parseScopeString('context:abc')?.type));
  "

check_output "parseScopeString: organization:x → undefined" 'undefined' \
  node --import tsx -e "
    import { parseScopeString } from './src/core/scope-resolver.js';
    console.log(parseScopeString('organization:x'));
  "

check_output "parseScopeString: client:y → undefined" 'undefined' \
  node --import tsx -e "
    import { parseScopeString } from './src/core/scope-resolver.js';
    console.log(parseScopeString('client:y'));
  "

check_output "resolveActiveScopes: legacy projectId works" '"context"' \
  node --import tsx -e "
    import { resolveActiveScopes } from './src/core/scope-resolver.js';
    console.log(JSON.stringify(resolveActiveScopes({ projectId: 'abc' })[1]?.type));
  "

check_output "resolveActiveScopes: contextId takes precedence" '"new"' \
  node --import tsx -e "
    import { resolveActiveScopes } from './src/core/scope-resolver.js';
    console.log(JSON.stringify(resolveActiveScopes({ contextId: 'new', projectId: 'old' })[1]?.id));
  "

echo ""
echo "=== 4. HEURISTIC SCOPE CLASSIFIER ==="

SCOPES='[{"type":"global","id":"global"},{"type":"context","id":"ctx1"},{"type":"user","id":"u1"}]'

for pattern in "I prefer tabs" "My workflow is" "I always use" "Personally I" "My setup runs"; do
  check_output "User pattern: '$pattern'" '"user"' \
    node --import tsx -e "
      import { classifyScope } from './src/core/scope-classifier.js';
      const s = $SCOPES;
      console.log(JSON.stringify(classifyScope('$pattern over spaces', 'facts', s).scope.type));
    "
done

for pattern in "Best practice:" "Always use" "Never use" "anti-pattern" "Performance tip"; do
  check_output "Global pattern: '$pattern'" '"global"' \
    node --import tsx -e "
      import { classifyScope } from './src/core/scope-classifier.js';
      const s = $SCOPES;
      console.log(JSON.stringify(classifyScope('$pattern for validation', 'facts', s).scope.type));
    "
done

check_output "Default → context" '"context"' \
  node --import tsx -e "
    import { classifyScope } from './src/core/scope-classifier.js';
    const s = $SCOPES;
    console.log(JSON.stringify(classifyScope('The API runs on port 3042', 'facts', s).scope.type));
  "

check_output "Single scope → confidence 1.0" '1' \
  node --import tsx -e "
    import { classifyScope } from './src/core/scope-classifier.js';
    console.log(classifyScope('anything', 'facts', [{ type: 'context', id: 'x' }]).confidence);
  "

check_output "Synchronous (not Promise)" 'false' \
  node --import tsx -e "
    import { classifyScope } from './src/core/scope-classifier.js';
    const r = classifyScope('x', 'facts', [{ type: 'context', id: 'x' }]);
    console.log(r instanceof Promise);
  "

echo ""
echo "=== 5. WORKSPACE ISOLATION ==="

check_output "ensureContextWorkspace creates dir" "true" \
  node --import tsx -e "
    import { ensureContextWorkspace } from './src/core/workspace.js';
    import { existsSync, rmSync } from 'fs';
    const d = ensureContextWorkspace({ id: 'ws-test', source: 'mcp', workspaceDir: '/tmp/lynox-ws-verify' });
    console.log(existsSync(d));
    rmSync(d, { recursive: true });
  "

echo ""
echo "=== 6. FEATURE FLAGS ==="

check_output "triggers default ON" "true" \
  node --import tsx -e "
    import { isFeatureEnabled } from './src/core/features.js';
    console.log(isFeatureEnabled('triggers'));
  "

check_output "plugins default ON" "true" \
  node --import tsx -e "
    import { isFeatureEnabled } from './src/core/features.js';
    console.log(isFeatureEnabled('plugins'));
  "

check_output "worker-pool default OFF" "false" \
  node --import tsx -e "
    import { isFeatureEnabled } from './src/core/features.js';
    console.log(isFeatureEnabled('worker-pool'));
  "

echo ""
echo "=== 7. PROJECT DETECTION ==="

check_output "package.json detected" "true" \
  node --import tsx -e "
    import { detectProjectRoot } from './src/core/project.js';
    import { mkdirSync, writeFileSync, rmSync } from 'fs';
    import { join } from 'path';
    import { tmpdir } from 'os';
    const d = join(tmpdir(), 'pd-' + Date.now());
    mkdirSync(d);
    writeFileSync(join(d, 'package.json'), '{}');
    console.log(detectProjectRoot(d)?.root === d);
    rmSync(d, { recursive: true });
  "

check_output "Cargo.toml NOT detected" "true" \
  node --import tsx -e "
    import { detectProjectRoot } from './src/core/project.js';
    import { mkdirSync, writeFileSync, rmSync } from 'fs';
    import { join } from 'path';
    import { tmpdir } from 'os';
    const d = join(tmpdir(), 'pd-' + Date.now());
    mkdirSync(d);
    writeFileSync(join(d, 'Cargo.toml'), '');
    console.log(detectProjectRoot(d) === null);
    rmSync(d, { recursive: true });
  "

check_output "go.mod NOT detected" "true" \
  node --import tsx -e "
    import { detectProjectRoot } from './src/core/project.js';
    import { mkdirSync, writeFileSync, rmSync } from 'fs';
    import { join } from 'path';
    import { tmpdir } from 'os';
    const d = join(tmpdir(), 'pd-' + Date.now());
    mkdirSync(d);
    writeFileSync(join(d, 'go.mod'), '');
    console.log(detectProjectRoot(d) === null);
    rmSync(d, { recursive: true });
  "

echo ""
echo "=== 8. SYSTEM PROMPT ==="

check_output "Contains business safety rules" "Never send emails" \
  node --import tsx -e "
    import { SYSTEM_PROMPT } from './src/core/orchestrator.js';
    console.log(SYSTEM_PROMPT);
  "

check_output "Contains 3-scope docs" "3 scopes: global > context" \
  node --import tsx -e "
    import { SYSTEM_PROMPT } from './src/core/orchestrator.js';
    console.log(SYSTEM_PROMPT);
  "

check_output "No old 5-scope docs" "true" \
  node --import tsx -e "
    import { SYSTEM_PROMPT } from './src/core/orchestrator.js';
    console.log(!SYSTEM_PROMPT.includes('5 scopes'));
  "

echo ""
echo "=== 9. RUN HISTORY (context_id) ==="

check_output "RunRecord has context_id" "true" \
  node --import tsx -e "
    import { RunHistory } from './src/core/run-history.js';
    import { mkdirSync, rmSync } from 'fs';
    import { join } from 'path';
    import { tmpdir } from 'os';
    const d = join(tmpdir(), 'rh-' + Date.now());
    mkdirSync(d);
    const h = new RunHistory(join(d, 'test.db'));
    const id = h.insertRun({ taskText: 't', modelTier: 'haiku', modelId: 'h', contextId: 'ctx1' });
    const r = h.getRun(id);
    console.log('context_id' in r && r.context_id === 'ctx1');
    h.close();
    rmSync(d, { recursive: true });
  "

check_output "Scopes CHECK rejects 'project' via direct SQL" "CHECK constraint" \
  node --import tsx -e "
    import { RunHistory } from './src/core/run-history.js';
    import Database from 'better-sqlite3';
    import { mkdirSync, rmSync } from 'fs';
    import { join } from 'path';
    import { tmpdir } from 'os';
    const d = join(tmpdir(), 'rh-' + Date.now());
    mkdirSync(d);
    const dbPath = join(d, 'test.db');
    const h = new RunHistory(dbPath);
    const db = new Database(dbPath);
    try { db.prepare(\"INSERT INTO scopes (id, type, name) VALUES ('x', 'project', 'X')\").run(); console.log('NO ERROR'); }
    catch(e) { console.log(e.message); }
    db.close(); h.close();
    rmSync(d, { recursive: true });
  "

check_output "Scopes CHECK accepts 'context'" "true" \
  node --import tsx -e "
    import { RunHistory } from './src/core/run-history.js';
    import { mkdirSync, rmSync } from 'fs';
    import { join } from 'path';
    import { tmpdir } from 'os';
    const d = join(tmpdir(), 'rh-' + Date.now());
    mkdirSync(d);
    const h = new RunHistory(join(d, 'test.db'));
    h.insertScope('test-ctx', 'context', 'Test');
    const s = h.getScope('test-ctx');
    console.log(s?.type === 'context');
    h.close();
    rmSync(d, { recursive: true });
  "

echo ""
echo "=== 10. CONFIG ==="

check_output "agents_dir excluded from safe keys" "true" \
  node --import tsx -e "
    import { loadConfig, reloadConfig } from './src/core/config.js';
    import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
    import { join } from 'path';
    const d = join(process.cwd(), '.lynox');
    const existed = existsSync(d);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'config.json'), JSON.stringify({ agents_dir: '/x', default_tier: 'haiku' }));
    reloadConfig();
    const c = loadConfig();
    rmSync(join(d, 'config.json'));
    if (!existed) rmSync(d, { recursive: true });
    reloadConfig();
    console.log(c.agents_dir === undefined && c.default_tier === 'haiku');
  "

echo ""
echo "==============================="
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "🎉 ALL TESTS PASSED" || echo "⚠ SOME TESTS FAILED"
exit "$FAIL"
