# lynox Model Bench (legacy)

> **Legacy — single-model Claude Pareto harness.** For the current cross-provider,
> tool-using benchmark (the one behind the published bench page) use
> **`scripts/set-bench/`**, which is the canonical suite. `bench-models.ts` is kept
> for the Claude-only effort/thinking Pareto sweep and is not deleted.

Compare Claude models and configs across realistic scenarios to find
Pareto-optimal sweet spots. The matrix below documents the original Phase 1 slice;
the live `scenarios.ts`/`configs.ts` have since grown to ~14 scenarios across
Phases 1–3 and include Opus 4.7 configs — run `--list` for the current set.

## Running

```bash
# Smoke test (1 run, ~$0.001) — validates infra
npx tsx scripts/bench-models.ts --smoke

# Full Phase 1 matrix (60 runs, ~$15-25)
npx tsx scripts/bench-models.ts --phase1

# One scenario across all configs
npx tsx scripts/bench-models.ts --scenario code-review

# One config across all scenarios
npx tsx scripts/bench-models.ts --config opus-medium

# List scenarios and configs
npx tsx scripts/bench-models.ts --list
```

API key from `ANTHROPIC_API_KEY` env var or `~/.lynox/config.json`.

## Matrix

**Scenarios (5):**

| ID | Category | Tests |
|----|----------|-------|
| trivial-question | baseline | Overkill-Detektor — sollte Haiku reichen |
| crm-extraction | extraction | Strukturierte JSON-Extraktion aus E-Mail |
| code-review | analysis | SQL-Injection + Off-by-one erkennen |
| debugging | reasoning | Log + Migration → Root-Cause |
| summarization | summarization | Product-Brief → Bullet-Summary |

**Configs (6):**

| Label | Model | Effort | Thinking |
|-------|-------|--------|----------|
| haiku | claude-haiku-4-5 | — | disabled |
| sonnet-medium | claude-sonnet-4-6 | medium | adaptive |
| sonnet-high | claude-sonnet-4-6 | high | adaptive |
| opus-medium | claude-opus-4-6 | medium | adaptive |
| opus-high | claude-opus-4-6 | high | adaptive |
| opus-max | claude-opus-4-6 | max | adaptive |

**Total Phase 1:** 5 × 6 × 2 = 60 runs.

## Output

Results under `scripts/bench-models/results/<timestamp>.{json,md}`:

- **JSON** — raw run data (scenario, config, output, usage, cost, score)
- **Markdown** — Per-Config summary, Per-Scenario breakdown, Pareto frontier, individual runs

## LLM-as-Judge

Haiku judges each run against scenario-specific rubric (0–5 score). Judge cost
is small relative to run cost (~$0.001 per judge call).

For high-confidence decisions, spot-check 10% of runs manually against the
raw output in the Markdown report.

## Extending

**Add a scenario** → edit `scripts/bench-models/scenarios.ts`. Each scenario needs:
- `prompt` (what the agent sees)
- `judgeRubric` (bullet list of criteria for the judge)
- `referenceAnswer` (orientation for the judge, not exact match)

**Add a config** → edit `scripts/bench-models/configs.ts`.

**Phase 2 ideas:**
- Real tool use (web_search, web_fetch, memory)
- Long-context scenarios (30k+ tokens)
- Multi-turn conversations
- Mistral via OpenAI-adapter (Managed fallback validation)
- Context-window variation (200k / 500k / 1M) once the policy PRD lands
