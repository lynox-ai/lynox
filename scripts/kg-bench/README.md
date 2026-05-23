# KG-Recall Bench (Phase 1 Verification Harness)

Deterministic retrieval-quality bench for the `memory_recall` → `KnowledgeLayer.retrieve()` contract change shipped in core PR #529 (+ scope-dedup PR #534).

Unit tests prove the wiring is in place. This bench proves the **retrieval quality** on a realistic seeded corpus:

- Does top-k actually contain the gold-set memory for specific-fact queries?
- Does an `acme`-scoped query ever leak `beta`-scoped rows? (T2-M regression guard)
- Does the no-query path return memories in `created_at DESC`?
- Is `KG_RECALL_THRESHOLD=0.3` (the production constant) actually calibrated?

## Run

```bash
# from repo root
cd scripts/kg-bench
npx tsx run.ts > results/kg-bench-$(date +%Y-%m-%d-%H%M%S).md

# quick (skip warm pass)
npx tsx run.ts --quick > results/quick.md

# threshold calibration sweep
npx tsx run.ts --threshold 0.55 > results/sweep-0.55.md
npx tsx run.ts --threshold 0.20 > results/sweep-0.20.md
```

First run downloads the `Xenova/multilingual-e5-small` ONNX model (~120 MB to `~/.cache/huggingface`). Subsequent runs reuse the cache.

## What it does

1. Creates a tmp SQLite DB and a fresh `KnowledgeLayer` with `OnnxProvider`.
2. Seeds 200 memories (acme 80 + beta 80 + personal 40) via `layer.store()`.
3. Backdates `created_at` on each row to the `createdDaysAgo` from the fixture (via a second sqlite handle — the production `store()` API doesn't expose backdating, intentionally).
4. Runs all 50+ queries through `layer.retrieve()` with the **same options memory_recall uses in prod** (`topK=10, threshold=0.3, useGraphExpansion=true`).
5. Scores recall@5, recall@10, MRR, scope-bleed, latency. Bleed is the hard contract — any cross-scope leak fails the bench.
6. Optionally runs a second pass for cold-vs-warm latency comparison.

## Files

- `corpus/acme.jsonl` — 80 memories about fake company "Acme" (Postgres-heavy)
- `corpus/beta.jsonl` — 80 memories about fake company "Beta Inc" (Mongo/BigQuery)
- `corpus/personal.jsonl` — 40 user-scope personal notes
- `queries/catalog.jsonl` — 50+ queries with expected fixture-ids + min recall@5
- `run.ts` — runner (seed → query → score → markdown report)
- `results/` — output reports (gitignored except `.gitkeep`)
- `results/_last-mapping.json` — fixture-id → live memory-id from the last run (debug aid)

## Pass bars

- `recall@5 >= 0.80`
- `recall@10 >= 0.85`
- `MRR >= 0.60`
- `scope-bleed-rate == 0` (hard)
- Per-query `min_recall_at_5` enforced (each query declares its own bar)

If any bar fails, exit code is 1 — CI-friendly.

## Adding queries / extending corpus

Each corpus JSONL line:

```json
{
  "fixtureId": "acme-mem-081",
  "namespace": "knowledge|methods|status|learnings",
  "text": "...",
  "scope": {"type": "context|user|global", "id": "acme|beta|me|..."},
  "createdDaysAgo": 7
}
```

Each query JSONL line:

```json
{
  "id": "q-acme-postgres-stack",
  "kind": "specific|multi-fact|scope-isolation|no-query|no-match",
  "namespace": "knowledge",
  "scope": {"type": "context", "id": "acme"},
  "query": "...",
  "expected_topK_ids": ["acme-mem-001", "acme-mem-007"],
  "min_recall_at_5": 0.5,
  "must_not_contain_ids": ["beta-mem-002"]
}
```

`expected_topK_ids` and `must_not_contain_ids` reference **fixture-ids** (your-side identifiers), not the live UUIDs. The runner maps them automatically.

Honesty check: if your MRR ends up `>0.95` on every query, your corpus is too easy. Mix paraphrase, generic-noun overlap with the other corpora, and entity ambiguity to keep the bench grounded.

## Interpreting the report

- **recall@k**: `|gold ∩ top-k| / |gold|`. Multi-fact queries cap at 1.0 only if every gold item appears in the top-k.
- **MRR**: `mean(1 / first-correct-rank)`. 1.0 = always rank 1; 0.5 = avg rank 2; 0.0 = no query found any gold result.
- **Scope-bleed-rate**: fraction of queries where ANY id in `must_not_contain_ids` appeared in the top-k. **Must be 0.**
- **Per-query findings**: only queries with partial-recall or failures are listed — the report stays terse on green runs.
