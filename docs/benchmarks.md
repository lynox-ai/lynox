# Performance Benchmarks

## Overview

Vitest bench-based performance benchmarks for tracking regressions and establishing baselines across releases. Two tiers: offline (no API key, CI-safe) and online (real API calls).

## Quick Start

```bash
pnpm bench              # all offline benchmarks (~30s)
pnpm bench:online       # online benchmarks (requires API key, ~$0.02)
```

## Configuration

- **Config file:** `vitest.bench.config.ts`
- **Output:** `tests/performance/results.json` (gitignored, regenerated on each run)
- **Baselines:** `tests/performance/baselines/` (committed, versioned)

## Offline Benchmarks

No API key needed. Safe for CI. Located in `tests/performance/`.

| File | Module | What it measures |
|------|--------|-----------------|
| `embedding.bench.ts` | `core/embedding.ts` | ONNX cold/warm start, LocalProvider throughput, cosine similarity, blob serialization |
| `data-store.bench.ts` | `core/data-store.ts` | SQLite collection creation, single/batch insert, query with filters/sort/aggregation |
| `entity-extractor.bench.ts` | `core/entity-extractor.ts` | Regex Tier 1 extraction on short/medium/large/plain text |
| `security.bench.ts` | `core/data-boundary.ts`, `core/output-guard.ts` | Injection detection, write content scanning, tool result scanning, data wrapping |
| `memory.bench.ts` | `core/memory.ts` | Flat-file save/load/append/delete/render, loadAll |
| `knowledge-graph.bench.ts` | `core/knowledge-graph.ts` | LadybugDB init, entity/memory/mention creation, Cypher queries (parameterized, 1-hop, scalar) |
| `history-truncation.bench.ts` | `core/agent.ts` | Message count gate, token budget truncation, content block truncation |

## Online Benchmarks

Require API key via `~/.nodyn/config.json` or `ANTHROPIC_API_KEY`. Auto-skip without key. Located in `tests/performance/online/`.

| File | Module | What it measures | Cost |
|------|--------|-----------------|------|
| `agent-loop.bench.ts` | `core/agent.ts` | send() round-trip, streaming, multi-turn, tool dispatch | ~$0.005 |
| `retrieval-pipeline.bench.ts` | `core/retrieval-engine.ts` | Full pipeline: embed → vector → graph → MMR, with/without HyDE | ~$0.01 |
| `dag-planner.bench.ts` | `core/dag-planner.ts` | Haiku DAG decomposition (simple/medium/complex goals) | ~$0.005 |

## Interpreting Results

Key metrics per benchmark:
- **hz**: Operations per second (higher = better)
- **mean**: Average time per operation in milliseconds (lower = better)
- **p99**: 99th percentile latency — the "worst realistic case"
- **rme**: Relative margin of error — below ±5% is stable

### What to watch for

| Signal | Meaning |
|--------|---------|
| hz drops >20% vs baseline | Performance regression |
| p99 spikes >3x mean | Jitter/GC pressure |
| rme >10% | Unstable benchmark — results unreliable |
| ONNX cold start >2s | Model cache issue or download |
| KG init >200ms | Database migration or disk I/O issue |
| Security scan <1K ops/s on 50KB | Regex backtracking |

## Saving Baselines

After a release or significant change:

```bash
pnpm bench
cp tests/performance/results.json tests/performance/baselines/v1.0.0.json
```

## Adding New Benchmarks

1. Create `tests/performance/<module>.bench.ts`
2. Import helpers from `./setup.ts`
3. Use `describe` + `bench` from vitest
4. For online benchmarks: place in `tests/performance/online/`, use `describe.skipIf(!hasApiKey())`

## Debug Mode

Run with debug output to correlate benchmark timing with internal events:

```bash
NODYN_DEBUG=1 pnpm bench 2>bench-debug.log
```

Debug channels observed during benchmarks:
- `nodyn:tool:start/end` — tool timing
- `nodyn:knowledge:graph` — KG operations
- `nodyn:datastore:insert` — DataStore writes
- `nodyn:memory:store` — memory operations
- `nodyn:security:*` — security scan events
