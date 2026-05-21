# Agent-Efficiency Measurement Protocol

Phase 0 of [`PRD-AGENT-EFFICIENCY.md`](../../../pro/docs/internal/PRD-AGENT-EFFICIENCY.md)
§6 — the **staging-`usage` protocol** (resolution O10).

> **Why this exists.** The existing Set-Bench (`scripts/set-bench/`,
> `scripts/bench-models/`) benchmarks *models* against a static prompt.
> It does **not** run the lynox engine loop (Engine + Session + Agent),
> so it cannot gate the cost work in PRD Phases 2-5. This protocol drives
> the real engine over its HTTP API and reads the per-turn `usage` the
> engine itself persists — a trustworthy, engine-loop cost signal.
>
> **Phase 0 is a HARD BLOCKER:** nothing in PRD Phases 2-5 merges until a
> committed baseline artifact exists and `--compare` works as the D3 gate.

## What it measures

The 6 evidence scenarios from PRD §2, encoded in [`scenarios.ts`](./scenarios.ts):

| id | Thread | Reproduces |
|----|--------|-----------|
| `weather-simple` | `weather` | §2 row 1 — simple weather question |
| `weather-hourly` | `weather` | §2 row 2 — hourly follow-up (same thread) |
| `build-api-workflow` | `workflow` | §2 row 3 — build+run an API workflow |
| `cost-qa` | `workflow` | §2 row 4 — "why did that cost X?" follow-up |
| `limits-qa` | `workflow` | §2 row 5 — "HEAD request limits?" follow-up |
| `promote-attempt` | `promote` | §2 row 6 — capture + promote (known-broken) |

Scenarios sharing a `threadKey` run **sequentially in one engine thread**,
so a follow-up turn inherits the prior turn's context and cache state —
the whole point of measuring the loop rather than isolated model calls.

Per turn it records: cost USD, `tokensIn` / `tokensOut` / `tokensCacheRead`
/ `tokensCacheWrite`, cache-hit ratio, wall time, and the assistant's
final text (for a quality judgement). Each scenario is repeated **n
times** (default 3) and the artifact reports mean ± sample-stddev.

### How the per-turn signal is read

The engine stamps each run's token/cost rollup onto that run's **final
assistant message** (`thread_messages.usage_json`, migration v30 in
`src/core/run-history.ts`; surfaced by `projectMessages` in
`src/core/render-projection.ts`). `setMessageUsage` self-targets the
highest-`seq` assistant row. The protocol snapshots the highest `seq`
*before* a turn and reads the new highest-`seq` assistant message
*after* — isolating exactly the turn that just ran. This is a **per-turn**
signal, not the aggregate `GET /api/usage/current` rollup.

## Running it

```bash
# 1. Mint a staging session cookie (canonical helper — never improvise SSH).
#    The cookie authenticates the engine HTTP API. NEVER write it to a file.
export AE_COOKIE="$(scripts/mint-staging-cookie.sh)"

# 2. Capture a baseline (n=3) against staging.
npx tsx scripts/agent-efficiency/measure.ts

# Useful flags:
npx tsx scripts/agent-efficiency/measure.ts --list                 # list scenarios
npx tsx scripts/agent-efficiency/measure.ts --n 5                   # 5 repeats
npx tsx scripts/agent-efficiency/measure.ts --scenario weather-simple
npx tsx scripts/agent-efficiency/measure.ts --target https://engine.lynox.cloud

# 3. When done, drop the cookie from the shell:
unset AE_COOKIE
```

**Cost:** a full n=3 run spends a few dollars of real LLM cost on the
target engine. That is the explicit, authorized Phase-0 deliverable.

**Auth:** pass the cookie via `AE_COOKIE` (preferred — keeps the secret
out of `argv` / process listings) or `--cookie <value>`. The cookie is a
30-day staging credential: never commit it, never write it into a file.
Only the `baselines/*.json` + `baselines/*.md` artifacts are committed.

## Artifacts

Written to [`baselines/`](./baselines/):

- `baseline-<ISO>.json` — machine-readable, the source of truth for `--compare`.
- `baseline-<ISO>.md` — human-readable summary table (mean ± spread) plus
  a per-scenario quality-judgement section. The **quality verdict line is
  filled in by a human** reviewing the sample answer against the rubric.

## The D3 cost gate — how Phases 2-5 use `--compare`

PRD decision **D3**: every merged PR must hold *pass-rate ≥ baseline AND
measured cost < baseline*, re-baselined per phase.

```bash
export AE_COOKIE="$(scripts/mint-staging-cookie.sh)"
npx tsx scripts/agent-efficiency/measure.ts \
  --compare scripts/agent-efficiency/baselines/baseline-<ISO>.json
unset AE_COOKIE
```

`--compare` re-runs every scenario against the engine, diffs the means
vs the stored baseline, and prints a table with cost Δ%, token Δ, and a
per-scenario verdict:

- **pass** — current pass-rate ≥ baseline AND current mean cost < baseline.
- **fail** — gate violated. The process exits non-zero so a phase PR / CI
  job can hard-block on it.
- **n/a** — no comparable signal on one side; does not pass, does not fail.

The compare run is also saved to `baselines/compare-<ISO>.json` for audit.

**Workflow for a Phase 2-5 PR:** branch off `main` → implement → run
`--compare` against the current phase baseline → the PR may only merge if
the overall verdict is `pass`. After a phase merges, capture a fresh
baseline (drop the new `baseline-*.json`) so the next phase gates against
the improved numbers.

## Fidelity caveats — read before trusting the numbers

- **`build-api-workflow` is a best-effort substitute.** The original §2
  turn ($0.405 / 460,386 input tokens) hit **11 real, pre-configured API
  profiles**. Those profiles are not present on the staging tenant and
  cannot be faithfully reproduced here. This scenario instead exercises
  the *same cost path* — a tool-heavy, multi-step planning + execution
  turn against a handful of public APIs. Its **absolute** numbers will
  differ from §2; treat it as a **relative** baseline for Phases 2-3, not
  a §2 reproduction.
- **`promote-attempt` drives a known-broken path.** `capture_process` /
  `promote_process` currently fail (the bug PRD Phase 1.4 fixes —
  `capture_process` hits the zero-tool-calls branch). The baseline
  **intentionally** captures the broken-state cost. "OK" for this
  scenario means the *turn completed and a usage signal was read* — not
  that promotion succeeded. **Re-baseline `promote-attempt` after Phase
  1.4 lands.**
- A scenario that triggers `ask_user` will time out (this client never
  answers prompts) and be recorded as a failure — a real, honest signal.
- One bad turn never aborts the batch: a failed scenario is recorded as a
  failure and the run continues.
- The `build-api-workflow` prompt is **deliberately bounded** (3 fixed
  GETs, no workflow persistence, no clarifying questions). An earlier
  open-ended phrasing let the agent loop into multi-minute deep-planning
  that blew past the wall cap non-deterministically. The scenario still
  exercises a tool-heavy multi-step cost path; it is just made
  reproducible.

## Resilience to a mid-run engine redeploy

A managed engine can be redeployed (container swap) while the protocol
is running — observed during the Phase-0 capture, when staging was
redeployed mid-batch. The protocol handles this:

- Before each thread-group, `measure.ts` waits up to 180s for
  `/api/health` to report `status: ok` again, so a transient 404/502
  during a container swap does not cascade into false failures.
- A build-SHA drift between the captured baseline and the live engine is
  flagged with a loud `WARNING build drift` line — the numbers would
  otherwise silently mix two builds.
- After a turn that overruns its wall cap, the session is aborted (with a
  short grace window) so the next turn in a multi-turn thread is not
  blocked by a stale-run `409`.

## Exit ramp (PRD §6)

If **no scenario produces a trustworthy usage signal** (engine
unreachable, auth broken, or every turn fails), `measure.ts`:

1. writes **no** baseline artifact, and
2. exits **non-zero** with an explicit `EXIT RAMP` message.

Per PRD §6 this means **Phases 2-5 pause** until a trustworthy cost
signal can be produced. Phase 1 (agent-correctness cleanup) is
independent and unaffected.

## Files

| File | Purpose |
|------|---------|
| `measure.ts` | CLI entry point — runner, baseline writer, `--compare` gate. |
| `scenarios.ts` | The 6 PRD §2 evidence scenarios (typed). |
| `engine-client.ts` | Minimal lynox engine HTTP/SSE client. |
| `stats.ts` | Pure mean/spread/diff maths (unit-tested). |
| `report.ts` | Markdown rendering for both artifacts. |
| `types.ts` | Shared type contracts. |
| `baselines/` | Committed baseline + compare artifacts. |

Unit tests for `stats.ts` live in `tests/agent-efficiency-stats.test.ts`
and run in the normal vitest suite (no network, no API key).
