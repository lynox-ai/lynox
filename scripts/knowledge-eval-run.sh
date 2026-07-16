#!/usr/bin/env bash
# Canonical wrapper for the DK.0 knowledge-substrate gate eval (tests/eval/
# knowledge-substrate-eval.test.ts). Exists so the operator can allow-list ONE
# auditable invocation shape instead of ad-hoc env-var command lines.
#
#   bash scripts/knowledge-eval-run.sh <gold.jsonl|gold.json> [runs=1] [timeout_ms=7200000] [logfile] [provider] [model]
#
# The eval self-gates (LYNOX_EVAL + an API key from env/~/.lynox/config.json)
# and resolves the provider itself (Anthropic if a key is present, else
# Mistral EU pinned to the stable dated tag; `proxy` = the local CLIProxyAPI
# on 127.0.0.1:8317 backed by the operator's Claude subscription). Gold
# corpora live OUTSIDE the repo (~/.lynox/knowledge-gold/) and are never
# committed.
set -euo pipefail
cd "$(dirname "$0")/.."

GOLD="${1:?usage: knowledge-eval-run.sh <gold-file> [runs] [timeout_ms] [logfile] [provider] [model]}"
RUNS="${2:-1}"
TIMEOUT_MS="${3:-7200000}"
LOG="${4:-}"
PROVIDER="${5:-}"
MODEL="${6:-}"

[ -f "$GOLD" ] || { echo "gold file not found: $GOLD" >&2; exit 1; }
[ -n "$PROVIDER" ] && export LYNOX_KNOWLEDGE_PROVIDER="$PROVIDER"
[ -n "$MODEL" ] && export LYNOX_KNOWLEDGE_MODEL="$MODEL"

if [ -n "$LOG" ]; then
  LYNOX_EVAL=1 LYNOX_KNOWLEDGE_RUNS="$RUNS" LYNOX_KNOWLEDGE_TIMEOUT_MS="$TIMEOUT_MS" LYNOX_KNOWLEDGE_GOLD="$GOLD" \
    npx vitest run tests/eval/knowledge-substrate-eval.test.ts 2>&1 | tee "$LOG"
else
  LYNOX_EVAL=1 LYNOX_KNOWLEDGE_RUNS="$RUNS" LYNOX_KNOWLEDGE_TIMEOUT_MS="$TIMEOUT_MS" LYNOX_KNOWLEDGE_GOLD="$GOLD" \
    npx vitest run tests/eval/knowledge-substrate-eval.test.ts
fi
