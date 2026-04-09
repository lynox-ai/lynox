#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ONLINE_SMOKE="${LYNOX_SMOKE_ONLINE:-0}"
MCP_PORT="${LYNOX_SMOKE_MCP_PORT:-3048}"
MCP_SECRET="${LYNOX_SMOKE_MCP_SECRET:-lynox-smoke-secret}"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lynox-smoke.XXXXXX")"
STATE_DIR="$TMP_ROOT/state"
SERVER_LOG="$TMP_ROOT/mcp-server.log"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

step() {
  printf '\n==> %s\n' "$1"
}

wait_for_health() {
  local attempts=30
  for _ in $(seq 1 "$attempts"); do
    if node --input-type=module -e "const res = await fetch('http://127.0.0.1:${MCP_PORT}/health').catch(() => null); process.exit(res?.ok ? 0 : 1);" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "MCP health check failed; server log:" >&2
  cat "$SERVER_LOG" >&2 || true
  return 1
}

check_api_key() {
  node --input-type=module -e "import { hasApiKey } from './dist/core/config.js'; process.exit(hasApiKey() ? 0 : 1);"
}

call_mcp_tools() {
  local online="$1"
  LYNOX_SMOKE_ONLINE="$online" \
  LYNOX_MCP_URL="http://127.0.0.1:${MCP_PORT}" \
  LYNOX_MCP_SECRET="$MCP_SECRET" \
  node --input-type=module <<'NODE'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function textFrom(result) {
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return '';
  const first = content[0];
  return first && typeof first === 'object' && 'text' in first && typeof first.text === 'string'
    ? first.text
    : '';
}

const online = process.env['LYNOX_SMOKE_ONLINE'] === '1';
const url = new URL(process.env['LYNOX_MCP_URL'] ?? 'http://127.0.0.1:3048');
const secret = process.env['LYNOX_MCP_SECRET'] ?? '';
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: {
    headers: secret ? { Authorization: `Bearer ${secret}` } : {},
  },
});
const client = new Client({ name: 'lynox-smoke', version: '1.0.0' }, { capabilities: {} });
try {
  await client.connect(transport);

  const memory = await client.callTool({ name: 'lynox_memory', arguments: { namespace: 'facts' } });
  const memoryText = textFrom(memory);
  if (typeof memoryText !== 'string') {
    throw new Error('lynox_memory returned no text payload');
  }

  const reset = await client.callTool({ name: 'lynox_reset', arguments: { session_id: 'smoke-session' } });
  if (!textFrom(reset).includes('smoke-session')) {
    throw new Error('lynox_reset did not mention the session');
  }

  const abort = await client.callTool({ name: 'lynox_abort', arguments: { session_id: 'smoke-session' } });
  const abortPayload = JSON.parse(textFrom(abort));
  if (typeof abortPayload.aborted !== 'boolean') {
    throw new Error('lynox_abort returned an invalid payload');
  }

  const reply = await client.callTool({ name: 'lynox_reply', arguments: { run_id: 'missing-run', answer: 'ok' } });
  const replyPayload = JSON.parse(textFrom(reply));
  if (typeof replyPayload.error !== 'string' || !replyPayload.error.includes('No pending input')) {
    throw new Error('lynox_reply missing-run path regressed');
  }

  if (online) {
    const started = await client.callTool({
      name: 'lynox_run_start',
      arguments: {
        task: 'Reply with the single word OK.',
        session_id: 'smoke-online',
      },
    });
    const startPayload = JSON.parse(textFrom(started));
    if (typeof startPayload.run_id !== 'string') {
      throw new Error('lynox_run_start did not return a run_id');
    }

    let finalPayload = null;
    for (let i = 0; i < 60; i++) {
      const poll = await client.callTool({ name: 'lynox_poll', arguments: { run_id: startPayload.run_id } });
      finalPayload = JSON.parse(textFrom(poll));
      if (finalPayload.done === true) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!finalPayload || finalPayload.done !== true) {
      throw new Error('online smoke run did not complete');
    }
    if (typeof finalPayload.text !== 'string' || !finalPayload.text.toUpperCase().includes('OK')) {
      throw new Error(`online smoke run returned unexpected text: ${String(finalPayload.text)}`);
    }
  }

  console.log(JSON.stringify({
    online,
    memory_ok: true,
    reset_ok: true,
    abort_ok: true,
    reply_ok: true,
    online_ok: online,
  }));
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
NODE
}

start_debug_server() {
  local debug_val="$1"
  local log="$2"
  local debug_file="${3:-}"
  mkdir -p "$STATE_DIR"
  SERVER_LOG="$log"
  if [[ -n "$debug_file" ]]; then
    LYNOX_DEBUG="$debug_val" \
    LYNOX_DEBUG_FILE="$debug_file" \
    LYNOX_MCP_PORT="$MCP_PORT" \
    LYNOX_MCP_SECRET="$MCP_SECRET" \
    LYNOX_MCP_STATE_DIR="$STATE_DIR" \
    node dist/index.js --mcp-server --transport sse </dev/null >"$log" 2>&1 &
  else
    LYNOX_DEBUG="$debug_val" \
    LYNOX_MCP_PORT="$MCP_PORT" \
    LYNOX_MCP_SECRET="$MCP_SECRET" \
    LYNOX_MCP_STATE_DIR="$STATE_DIR" \
    node dist/index.js --mcp-server --transport sse </dev/null >"$log" 2>&1 &
  fi
  SERVER_PID="$!"
  wait_for_health
}

stop_debug_server() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
  SERVER_LOG="$TMP_ROOT/mcp-server.log"
}

step "Typecheck"
npm run typecheck

step "Build"
npm run build

step "Vitest"
npx vitest run

step "CLI version"
node dist/index.js --version

step "Debug subscriber activation"
start_debug_server "tool,mode" "$TMP_ROOT/debug-server.log" "$TMP_ROOT/debug.log"
call_mcp_tools 0
stop_debug_server
grep -q '\[lynox:debug\]' "$TMP_ROOT/debug-server.log" \
  || { echo "FAIL: debug activation message not found in server log" >&2; exit 1; }
[[ -f "$TMP_ROOT/debug.log" ]] \
  || { echo "FAIL: LYNOX_DEBUG_FILE was not created" >&2; exit 1; }
for p in 'sk-ant-' 'xoxb-' 'xapp-'; do
  if grep -q "$p" "$TMP_ROOT/debug.log" "$TMP_ROOT/debug-server.log" 2>/dev/null; then
    echo "FAIL: sensitive pattern '$p' leaked in debug output" >&2; exit 1
  fi
done

step "Debug filter validation"
start_debug_server "secret" "$TMP_ROOT/debug-filter.log"
call_mcp_tools 0
stop_debug_server
grep -q '\[lynox:debug\] Active' "$TMP_ROOT/debug-filter.log" \
  || { echo "FAIL: debug activation not found for filtered run" >&2; exit 1; }
grep -q 'subscribed: secretAccess' "$TMP_ROOT/debug-filter.log" \
  || { echo "FAIL: secret channel not subscribed with LYNOX_DEBUG=secret" >&2; exit 1; }
if grep -q 'subscribed: toolStart' "$TMP_ROOT/debug-filter.log"; then
  echo "FAIL: tool channel subscribed despite LYNOX_DEBUG=secret filter" >&2; exit 1
fi

step "Start MCP server"
mkdir -p "$STATE_DIR"
LYNOX_MCP_PORT="$MCP_PORT" \
LYNOX_MCP_SECRET="$MCP_SECRET" \
LYNOX_MCP_STATE_DIR="$STATE_DIR" \
node dist/index.js --mcp-server --transport sse </dev/null >"$SERVER_LOG" 2>&1 &
SERVER_PID="$!"
wait_for_health

step "HTTP auth guard"
node --input-type=module -e "const res = await fetch('http://127.0.0.1:${MCP_PORT}/', { method: 'POST' }); if (res.status !== 401) { throw new Error('expected 401 without bearer token'); }"

step "Offline MCP smoke"
call_mcp_tools 0

if [[ "$ONLINE_SMOKE" == "1" ]]; then
  step "Online MCP smoke"
  if ! check_api_key; then
    echo "LYNOX_SMOKE_ONLINE=1 requires an API key in env or ~/.lynox/config.json" >&2
    exit 1
  fi
  call_mcp_tools 1
else
  step "Online MCP smoke skipped"
  echo "Set LYNOX_SMOKE_ONLINE=1 to run a real agent round-trip."
fi

step "Slack checklist"
cat <<'EOF'
Manual Slack follow-up:
1. Start the Slack bot with valid SLACK_BOT_TOKEN, SLACK_APP_TOKEN, LYNOX_MCP_URL, LYNOX_MCP_SECRET.
2. Post a thread message and confirm a single active run per thread.
3. Trigger ask_user and verify button reply plus free-text reply both resume the run.
4. Click Stop during a long run and verify the thread settles on "Stopped.".
5. Upload one text file and one voice note; verify attachment ingest/transcription paths.
EOF

step "Smoke pipeline passed"
