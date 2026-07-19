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

Running the whole suite: **the shipped fleet is uniformly fit** — it passes
every baseline, hard-behaviour AND correctness case. That validates the current
tier assignments, but means **behaviour tests ("did it call X") don't
discriminate a strong fleet**. Discrimination shows via:
- **Comparators** (the qualification use-case): Mistral Nemo **fails vision** →
  the matrix refuses it for balanced/deep but keeps it fit for fast; Ministral
  3B passes everything → a candidate for a cheaper fast (or balanced) slot.
- **Hard multi-step scenarios** (below) — separate even strong models.

The map is grounded in a **tier→jobs recon** (which tier does which job in the
engine): FAST = forced-tool structured extraction (KG/reranker/classifier/
DAG-planner) + free-text short gen (title/HyDE/compaction); BALANCED = the main
chat + sub-agents + pipeline steps; DEEP = user-elected heavy/complex work. A
tier's fitness = the union of its jobs' requirements. (Full map + file:line in
the design doc.)

**Adding points:** append to `CAPABILITIES`. Remaining: action-routing,
correct-first-call, compaction-fidelity, language-fidelity, and the multi-step
scenario (below).

## Candidates + the FREE pre-filter (`models.ts`)

A model earns a row only with a `prefilter` reason — a public agentic/tool-use
leaderboard standing (**BFCL v4**, **τ-bench/τ²-bench**, **MCP-Bench**) or a
known fact. The public leaderboards cost nothing and keep us from burning budget
scoring models that can't do baseline tool-use; the lynox suite then runs only
on the survivors. `FLEET` = the models lynox tier-routes today; add a
`COMPARATOR` (with a leaderboard reason) to evaluate qualifying a new model.

Dated snapshots only — never a `-latest` tag (rate limits).

## Multi-step scenarios — the shared substrate (next slice)

Borrowed from the public multi-step tests (τ-bench triad): a realistic
multi-step task · a **simulated user** (LLM-as-user answers the agent's
clarifications) · a **state-based assertion** (check the end state — task
created? draft sent? table filled? — not the words) + policy compliance.

The same small **golden scenario set** (mail-reply-with-signoff · workflow
build+run · deal→task · data import+query) serves THREE consumers:
- **model-fitness** — capability point 8 (does model X complete the scenario);
- **release-regression** — run on the release candidate to catch multi-step
  regressions the single-capability probes miss;
- **CI/release skills** — `/staging-walk --release` + `/release-harden` gate on
  it.

Seed: `scripts/agent-efficiency/scenarios.ts` already runs scenarios through the
REAL engine — it needs (i) state-based auto-assertions (not the manual quality
rubric) and (ii) the simulated user for multi-turn. Kept small + on-demand
(multi-step is costly).
