# lynox model-fitness harness

A cheap, provider-agnostic **standard for measuring whether an LLM is fit for
lynox** — and **which model does which job (tier)**. Not a generic benchmark
rank: it scores a model on the specific capability-critical points lynox's OWN
tools + prompt discipline depend on (DEF-model-compat-harness).

## Run it

```bash
MISTRAL_API_KEY=… ANTHROPIC_API_KEY=… npx tsx scripts/model-fitness/run.ts [--repeats N] [--only <capId,…>]
```

Prints a **fitness matrix** (capability × model → pass-rate) and a per-tier
"which model is FIT for which job" read. Only candidates whose provider key is
present are run. Deterministic assertions; no LLM judge in v1.

**Cost:** ~(#capabilities × #candidates × repeats) SHORT calls. The default
(5 caps × 5-model fleet × 2 repeats ≈ 50 calls) is a few cents. Keep it small;
the full agentic bench (multi-step, below) is on-demand, not every run.

## What it measures (the capability map — `capabilities.ts`)

Each entry is a capability-critical point × a short triggering case × a
deterministic assertion, tagged with the tier(s) it gates. v1 high-value cut:

| id | point | gates |
|----|-------|-------|
| `vision` | sees + describes an uploaded image | balanced, deep |
| `terminal-tool` | fires `suggest_follow_ups` to end the turn | all |
| `tool-select-short` | picks the right tool from a SHORT description | all |
| `tool-call-reliability` | actually calls a tool when the turn needs one | all |
| `json-schema-fidelity` | emits schema-valid args (enum + required) | all |

Plus **discriminators** (harder points where models differ) — `recall-discipline`
(no reflexive recall on a greeting), `terminal-under-load` (fires the terminal
tool after a 2-tool turn), `injection-resistance` (ignores an instruction
injected via a tool result) — and **correctness cases** grounded in the actual
FAST-tier jobs (not "did it call the tool" but "did it get it right"):
`fast:entity-extraction-correctness` (surfaces all known entities),
`fast:classification-accuracy` (right inbox bucket).

A model is **FIT for a tier** only if it passes every capability that gates that
tier. That's the tier→model assignment.

## What we learned (a strong fleet needs the right tests)

Running the single-capability suite: **the shipped fleet is uniformly fit** — it
passes every baseline, hard-behaviour AND correctness case. That validates the
current tier assignments, but means **behaviour tests ("did it call X") don't
discriminate a strong fleet**. Discrimination shows via:
- **Comparators** (the qualification use-case): Mistral Nemo **fails vision** →
  the matrix refuses it for balanced/deep but keeps it fit for fast; Ministral
  3B passes everything → a candidate for a cheaper fast (or balanced) slot.
- **Multi-step scenarios + repeats** (`--scenarios`, below) — the axis that
  finally separates the strong fleet. At repeats=2, **no model passes all three
  scenarios cleanly** — each flakes on a *different* one:

  | scenario | Haiku | Sonnet 4.6 | Large 3 | Min-14B | Min-8B | Nemo | Min-3B |
  |----------|-------|-----------|---------|---------|--------|------|--------|
  | deal-to-task | **1/2** | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
  | data-import-answer | 2/2 | 2/2 | **1/2** | 2/2 | 2/2 | 2/2 | 2/2 |
  | mail-reply-signoff | 2/2 | **1/2** | 2/2 | **1/2** | 2/2 | **0/2** | 2/2 |

  Reads: **reliability, not capability**, is the separator — Haiku drops the 2nd
  step of a 2-tool turn ~half the time; Nemo (weak comparator) **can't do the
  multi-turn ask→draft flow at all** (0/2, "no reply drafted"); the cheap
  Mistrals (8B/3B) are the *only* ones 2/2 across all three in this sample.
  These flakes are invisible to the single-probe pass (all 2/2). Caveat:
  repeats=2 is smoke-level — a firm per-model *rate* needs repeats≥5 (a costlier
  deliberate run); the stable finding is that these scenarios discriminate where
  the probes don't.

The map is grounded in a **tier→jobs recon** (which tier does which job in the
engine): FAST = forced-tool structured extraction (KG/reranker/classifier/
DAG-planner) + free-text short gen (title/HyDE/compaction); BALANCED = the main
chat + sub-agents + pipeline steps; DEEP = user-elected heavy/complex work. A
tier's fitness = the union of its jobs' requirements. (Full map + file:line in
the design doc.)

**Adding points:** append to `CAPABILITIES`. Remaining: action-routing,
correct-first-call, compaction-fidelity, language-fidelity.

## Candidates + the FREE pre-filter (`models.ts`)

A model earns a row only with a `prefilter` reason — a public agentic/tool-use
leaderboard standing (**BFCL v4**, **τ-bench/τ²-bench**, **MCP-Bench**) or a
known fact. The public leaderboards cost nothing and keep us from burning budget
scoring models that can't do baseline tool-use; the lynox suite then runs only
on the survivors. `FLEET` = the models lynox tier-routes today; add a
`COMPARATOR` (with a leaderboard reason) to evaluate qualifying a new model.

Dated snapshots only — never a `-latest` tag (rate limits).

## Multi-step scenarios — the shared substrate (`scenarios.ts`, BUILT)

Run with `--scenarios` (swaps the cheap probes for the multi-step set). Borrowed
from the public multi-step tests (τ-bench triad), each scenario is:
1. a realistic multi-step task (not a single call);
2. a **simulated user** — a fixed cheap Haiku that answers the agent's
   `ask_user` clarifications from a persona + goal, so the info the task needs
   lives in the *user's head*, not the prompt (the model must ASK for it);
3. a **state-based assertion** — the scenario's tools mutate a shared `state`
   object; the assert checks the END STATE (deal advanced? task created? table
   filled? mail drafted with the right amount + sign-off?), not the words.

The three v1 scenarios: `deal-to-task` (2 tools) · `data-import-answer` (3 tools
+ a reasoning conclusion) · `mail-reply-signoff` (multi-turn: ask → draft, and
it exercises lynox's **real permission-guard** flow — the sim-user clicks
*Allow* on the "sends external mail" confirmation).

**Two harness bugs the build surfaced** (both would have made the test measure
nothing — 100% fail): (1) a multi-turn scenario needs the real `ask_user`
builtin in its tool list, else the agent can never reach the sim-user; (2) a
send/write tool trips the permission guard's `promptUser` confirmation — the
sim-user must recognise a `[Allow, Deny]` dialog and approve, or the tool is
blocked and never mutates state. Lesson for any new scenario: wire `ask_user`
and let the sim-user approve permission dialogs.

The same golden set is meant to serve THREE consumers (one substrate, three
gates): **model-fitness** (here) · **release-regression** (run on the RC to
catch multi-step regressions the single-probes miss) · **CI/release skills**
(`/staging-walk --release` + `/release-harden` gate on it). Wiring the latter
two is the next slice.

**Cost/reliability:** each scenario is a full tool-loop (+ sim-user turns for
mail), so it's on-demand (`--scenarios`), not every pass. The tier-fitness read
is strict (`passes === runs`) — one flake across repeats disqualifies, because a
model that completes a task only half the time is not *reliably* fit. Pair
`--scenarios` with `--repeats ≥5` when you want a stable per-model rate rather
than a smoke.
