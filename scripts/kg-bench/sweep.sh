#!/usr/bin/env bash
# Calibration sweep: vary one parameter while holding others at the candidate
# operating point, record recall@5 / recall@10 / MRR per value.
#
# Output: scripts/kg-bench/results/calib/sweep-<param>.csv
#
# Usage: scripts/kg-bench/sweep.sh

set -euo pipefail

cd "$(dirname "$0")/../.."

OUT_DIR="scripts/kg-bench/results/calib"
mkdir -p "$OUT_DIR"

# Operating point (current committed defaults)
DEFAULT_RECENCY=0.95
DEFAULT_CONFIRM=1.00
DEFAULT_MMR=0.85

run_one() {
  local recency=$1 confirm=$2 mmr=$3 label=$4
  local logfile="$OUT_DIR/run-${label}.md"
  LYNOX_RETRIEVAL_RECENCY_FLOOR=$recency \
  LYNOX_RETRIEVAL_CONFIRM_FLOOR=$confirm \
  LYNOX_RETRIEVAL_MMR_LAMBDA=$mmr \
    npx tsx scripts/kg-bench/run.ts --quick > "$logfile" 2>&1 || true
  local r5 r10 mrr bleed verdict
  r5=$(grep -E '^\| recall@5 ' "$logfile" | awk -F'|' '{gsub(/ /,"",$3); print $3}' || echo "n/a")
  r10=$(grep -E '^\| recall@10 ' "$logfile" | awk -F'|' '{gsub(/ /,"",$3); print $3}' || echo "n/a")
  mrr=$(grep -E '^\| MRR ' "$logfile" | awk -F'|' '{gsub(/ /,"",$3); print $3}' || echo "n/a")
  bleed=$(grep -E 'Scope-bleed-rate' "$logfile" | head -1 | awk -F'=' '{print $2}' | awk -F'%' '{print $1"%"}' || echo "n/a")
  verdict=$(grep -E '^\[kg-bench\] verdict:' "$logfile" | awk '{print $3}' || echo "?")
  echo "$recency,$confirm,$mmr,$r5,$r10,$mrr,$bleed,$verdict"
}

echo "=== Sweep RECENCY_FLOOR (CONFIRM=$DEFAULT_CONFIRM, MMR=$DEFAULT_MMR) ==="
{
  echo "recency,confirm,mmr,recall@5,recall@10,MRR,bleed,verdict"
  for r in 0.70 0.80 0.85 0.90 0.95 1.00; do
    label="recency-r${r}-c${DEFAULT_CONFIRM}-m${DEFAULT_MMR}"
    run_one "$r" "$DEFAULT_CONFIRM" "$DEFAULT_MMR" "$label"
  done
} | tee "$OUT_DIR/sweep-recency.csv"

echo ""
echo "=== Sweep CONFIRM_FLOOR (RECENCY=$DEFAULT_RECENCY, MMR=$DEFAULT_MMR) ==="
{
  echo "recency,confirm,mmr,recall@5,recall@10,MRR,bleed,verdict"
  for c in 0.70 0.80 0.85 0.90 0.95 1.00; do
    label="confirm-r${DEFAULT_RECENCY}-c${c}-m${DEFAULT_MMR}"
    run_one "$DEFAULT_RECENCY" "$c" "$DEFAULT_MMR" "$label"
  done
} | tee "$OUT_DIR/sweep-confirm.csv"

echo ""
echo "=== Sweep MMR_LAMBDA (RECENCY=$DEFAULT_RECENCY, CONFIRM=$DEFAULT_CONFIRM) ==="
{
  echo "recency,confirm,mmr,recall@5,recall@10,MRR,bleed,verdict"
  for m in 0.65 0.75 0.80 0.85 0.90 0.95; do
    label="mmr-r${DEFAULT_RECENCY}-c${DEFAULT_CONFIRM}-m${m}"
    run_one "$DEFAULT_RECENCY" "$DEFAULT_CONFIRM" "$m" "$label"
  done
} | tee "$OUT_DIR/sweep-mmr.csv"

echo ""
echo "=== Done. Output: $OUT_DIR/sweep-*.csv ==="
