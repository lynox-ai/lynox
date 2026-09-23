# lynox model-fitness

Instruments that answer **"is this model fit for lynox, and for which tier?"** — not
generic benchmark rank. Fitness is scored on the capability-critical points lynox's OWN
tools and prompt discipline depend on. (`DEF-…` references throughout are internal tracking
ids; they are not resolvable from this repository.)

This directory holds **several instruments of different strength**. Read the ladder first;
picking the wrong rung is the one mistake that has actually cost us a wrong decision.

## The cost ladder — and what each rung may decide

| Rung | Instrument | Cost | What it may decide |
|---|---|---|---|
| 1 | **Evidence that costs no new spend** — a one-line `prefilter` reason per candidate in `models.ts`. Today those reasons cite BFCL, τ-bench, LMArena, this repo's own earlier set-bench results, and plain known facts. | free | **candidacy only.** Public scores are inflated by contamination/scaffolding and swing by harness. |
| 2 | **Synthetic probe** — `run.ts` over `capabilities.ts` + `scenarios.ts` | cents | **a SCREEN.** Refutes a candidate (a model that fails here is out) and finds instrument bugs. It may **not** confirm one: no fit decision is citable from it alone. |
| 3 | **Faithful replay** — `replay.ts` over a captured raw body | a few cheap turns | **the VERDICT.** It sends the exact request production sent. |

**Why rung 2 cannot confirm.** A synthetic harness assembles the surface *it thinks*
matters — a handful of hand-picked tool schemas, a written-by-hand system prompt, no
ephemeral tail. Tool CHOICE is exactly what that reduced surface cannot show (`prompt-ab.ts`
states the same blindness for the prompt axis). It has happened once already: a candidate the
synthetic probe rated fit for the balanced slot fell **below the floor** when the same
comparison ran on a real captured request, and the slot was changed because of it. That
measurement is recorded in the project's own tracker, not in this repo, so take the
structural argument as the reason and the episode only as the illustration. The screen was
not wrong to exist — it was read as a verdict, and that is what this ladder prevents.

So: screen with rung 2 to spend rung 3's budget well; decide on rung 3.

## Run the screen

```bash
MISTRAL_API_KEY=… ANTHROPIC_API_KEY=… npx tsx scripts/model-fitness/run.ts \
  [--repeats N] [--only <capId,…>] [--candidate <label-substring>] \
  [--provider anthropic|openai] [--scenarios]
```

Prints a **fitness matrix** (capability × model → pass-rate) and a per-tier read. Only
candidates whose provider key is present are run; `--scenarios` swaps the cheap probes for
the multi-step set. `FIREWORKS_API_KEY` enables the judge (below); without it the
judge-scored cases soft-pass.

**Cost:** ~(#capabilities × #candidates × repeats) SHORT calls — the default is a few cents.
`--provider` chunks a run, because Mistral 429-backoffs and judge latency compound over a
full fleet.

## What it measures — the TIER→JOBS spine (`capabilities.ts`)

A model's fitness for a tier = whether it can do the JOBS that tier runs in the engine. So
`capabilities.ts` first ENUMERATES every job each tier takes on (`TIER_JOBS`, including the
ones with no case yet, marked ○), then each `Capability` is one job's (or a cross-cutting
concern's) triggering case × a deterministic assertion, tagged with its `job`:

- **FAST** — forced-tool structured extraction (`kg-entity-extraction` ✓, `inbox-classify` ✓,
  `search-rerank` ○, `dag-plan` ○, `process-capture` ○) + short free-text gen
  (`thread-title` ○, `hyde-query` ○, `compaction-summary` ✓). The behaviour form ("did it
  call X") does not separate a strong fleet; **correctness** ("did it get it right") does.
- **BALANCED** — the main chat: `main-chat-multistep` ✓, `main-chat-terminal` ✓,
  `main-chat-language` ✓, `sub-agent` ✓ + `pipeline-step` ○, `api-setup-docs` ○.
- **DEEP** — `heavy-multistep` ✓, `big-context-analysis` ✓. The second carries a **per-job**
  context floor of its own (`minContext` on the case, 1M today) on top of the tier floor: a
  candidate below it is context-SKIPPED for that case rather than failed, so the cell records
  0 runs and counts as neither a pass nor a fail.
- **CROSS-CUTTING** (every job leans on these) — `tool-select` ✓, `tool-call-reliability` ✓,
  `schema-fidelity` ✓, `vision` ✓, `durable-memory` recall discipline ✓,
  `injection-resistance` ✓, `terminal-under-load` ✓, `grounding-discipline` ✓.

`TIER_JOBS` is the coverage index — ✓ = a case exists, ○ = an open gap
(`DEF-model-fitness-job-coverage-gaps`). The ✓ is a hand-typed `covers` pointing at a case
id, so a new case joins the index only when you set it. Two mechanical checks keep it from
lying in either direction (`tests/model-fitness-models.test.ts`): a `covers` may not name a
case that does not exist, and a job with a case may not still be marked ○. What stays
unguarded is this README's own bullet list — it is transcribed from `TIER_JOBS` by hand, and
an earlier version of it marked two covered jobs as gaps and omitted two more entirely. Read
the code when it matters.

### The structural gate: context window (free, no API)

A model can ace every behaviour probe and still be **unfit** if its window cannot hold
lynox's jobs — tool results are the bulk of the context, and main chat + sub-agents +
compaction all run over the full thread. The harness applies a hard floor
**`MIN_CONTEXT_WINDOW` (200k, rafael 2026-07-19)**, read first from lynox's OWN registry
(`MODEL_CAPABILITIES[id].contextWindow`) and only otherwise from `OVERRIDES` — so for a model
the engine does not ship yet, a hand-typed row is what clears or fails this gate. It is
checked before any behaviour: a sub-floor model is refused regardless. Free, deterministic, and the one gate that needs no rung-3
confirmation.

Context and price are **never re-declared here**. `models.ts` `OVERRIDES` is a fallback for
ids the engine does not carry yet, never a second opinion about one it does: the runner
refuses to start on a duplicate row, and `tests/model-fitness-models.test.ts` asserts the
same invariant where CI actually runs it (`scripts/` is outside the vitest include — the
arrangement `tests/model-fitness-replay.test.ts` already uses). Three rows had silently
shadowed the registry, one pricing a candidate at a quarter of what the engine bills, on the
axis the cost grid exists to decide.

### Fitness is a floor — quality and cost pick among the fit

Several models clear a tier's gates, and deterministic asserts **cannot see output QUALITY**.
So the run prints a **tier fitness GRID**: every context-clearing candidate judged against
every tier's gates (not just its current role), annotated with cost and context — from
`MODEL_CAPABILITIES[id].pricing` where the engine ships the model, from `OVERRIDES` where it
does not. A price printed with a leading **`~` is an estimate** — a
hand-typed provider list price for a model the engine does not ship, not the figure it bills
on. It gives you the fit set; quality decides among them.

A tier with **no case in the current suite prints `NOT MEASURED`**, not a fit set. It used to
print the whole roster: `[].every(…)` is `true`, and `--scenarios` carries no fast-tier case
at all. A screen that manufactures a verdict from zero evidence is the failure this whole
page is about, so the decision is a pure function (`grid.ts`) with its own tests.
Per-tier priority (rafael 2026-07-19):

- **FAST** — *cheap and fast, just clear the bar.*
- **BALANCED = the main chat** — *output QUALITY first, then cost.* Highest-volume job, and
  it re-reads a large cached prefix, so cost matters — but quality leads.
- **DEEP** — *output QUALITY, cost-tolerant.* User-elected heavy work.

A grid is only as good as its candidate set: the harness once "recommended" a deep model
purely because a stronger one was not a candidate. A missing row reads exactly like a loss.

### The independent judge (`judge.ts`)

For the subjective axis a pass/fail cannot reach. **Why independent:** an LLM judge has a
self-preference bias — a judge scores its own family higher (rafael 2026-07-19). Our
roster spans several families, so the judge is picked to be **none of them** — today Kimi
via Fireworks (`judge.ts`). The invariant is *judge ∉ candidate families*, deliberately not
an ordinal: "a third family" was written when the roster had two and was wrong by four by the
time anyone re-read it. A run with a judge configured prints which judge it used, so the
claim is checkable from the output rather than from prose — which had drifted here too, still
naming GLM long after GLM became a scored *candidate*. Bias
mitigation is **absolute rubric scoring** (1-5 against a fixed rubric, never pairwise → no
position bias); residual verbosity/style bias is a documented caveat, and the objective cases
stay the primary, bias-free discriminator.

An **unconfigured** judge soft-passes its cases — the quality axis is simply blank. A
**configured** judge that fails (a 401, a 429, an unreachable host) is an ERROR, not a pass:
`grounding-discipline` gates all three tiers, so an outage that soft-passed would have turned
silently into FIT for the whole roster.

## The multi-step golden set (`scenarios.ts`)

The τ-bench triad adapted to lynox, run with `--scenarios`. Each scenario is:

1. a realistic multi-step task (not a single call);
2. a **simulated user** — a cheap fixed model answering the agent's `ask_user` clarifications
   from a persona + goal, so the information the task needs lives in the *user's head*, not
   in the prompt (the model must ASK for it);
3. a **state-based assertion** — the scenario's tools mutate a shared `state`; the assert
   checks the END STATE (deal advanced? task created? mail drafted with the right amount and
   sign-off?), never the words.

The set deliberately includes NEGATIVE cases — `refund-policy-gate` requires the model to
look up a policy, **refuse** an out-of-policy refund, and leave a destructive distractor tool
untouched. A happy-path completion separates nothing once the fleet is strong.

**Two harness bugs the build surfaced**, both of which would have made the test measure
nothing: (1) a multi-turn scenario needs the real `ask_user` builtin in its tool list, else
the agent can never reach the sim-user; (2) a send/write tool trips the permission guard's
`promptUser` confirmation — the sim-user must recognise an `[Allow, Deny]` dialog and
approve, or the tool is blocked and state never mutates. Wire both into any new scenario.

**One substrate, three consumers** — model-fitness (here), release-regression, and the
release skills (`/staging-walk --release`, `/release-harden`). Only the first is wired today;
the other two are `DEF-model-fitness-scenario-release-gate`.

**Cost/reliability:** each scenario is a full tool-loop plus sim-user turns, so it is
on-demand, not every pass. The tier-fitness read is strict (`passes === runs`) — one flake
across repeats disqualifies, because a model that completes a task half the time is not
*reliably* fit. Pair `--scenarios` with `--repeats ≥5` for a rate rather than a smoke.

## Candidates and the free pre-filter (`models.ts`)

A model earns a row only with a `prefilter` reason — a public agentic/tool-use leaderboard
standing or a known fact. That is rung 1: it costs nothing and keeps budget off models that
cannot do baseline tool-use. `FLEET` = what lynox tier-routes today; add a `COMPARATOR` (with
its reason) to evaluate qualifying a new model. A deliberately weak comparator is worth its
cost — it is what tells you the suite discriminates at all.

**Dated snapshots only — never a `-latest` tag** (rate limits, `fb_mistral_stable_tag`).

## Where the run findings live — deliberately not here

Measured results are recorded in the `DEF-model-compat-harness` register row, not in this
file. A dated table in a standing README goes stale in days, and this one did: its
`language-fidelity` finding was an artifact of that case's **own German system prompt**
biasing every model German. The case was fixed the same week — `capabilities.ts` now uses an
English prompt with a German recalled-memory block, which is the real language-leak class —
while the README kept reporting the artifact. Four of that round's new cases turned out to
have measurement bugs rather than model failures; **every strong-model-fails-weak-model-passes
inversion was the instrument** (`fb_measure_pixel`). Treat an inversion as a bug report
against the harness until proven otherwise.

## Where this sits among the repo's benches

Three directories compare MODELS against each other, and which one to reach for was
written down in two places and nowhere for the third. (Other directories under
`scripts/` evaluate parts of the system rather than picking a model — `kg-bench`,
`kg-eval`, `agent-efficiency` — and are out of scope here.)

| Directory | The question it answers | Status |
|---|---|---|
| `scripts/set-bench/` | Cross-provider, tool-using benchmark — the suite behind the published bench page, and where `CONTRIBUTING.md` sends a contributor adding a scenario. | canonical |
| `scripts/model-fitness/` (here) | Is a model FIT for lynox's own jobs, and for which tier — measured on lynox's own tools and prompt discipline, not on a generic task set. | canonical for fit |
| `scripts/bench-models/` + `scripts/bench-models.ts` | The Claude-only effort/thinking Pareto sweep. Kept deliberately for that one question; its own README says so. | legacy, scoped |

They are complementary and none of them is dead: a *rank* (set-bench), a *fit verdict*
(here) and a *single-provider Pareto sweep* (bench-models) are three different questions.
The failure mode this table exists against is not duplication — it is reaching for
whichever one is open in the editor.

## The other instruments in this directory

| File | Question it answers | Rung |
|---|---|---|
| `replay.ts` | Which model handles a **real captured request** best (escalate-vs-inline)? | 3 — the verdict |
| `prompt-ab.ts` | Does a **prompt edit** change behaviour, measured on the real surface? | 3, prompt axis |
| `artefact.ts` | Artefact QUALITY (R9) — deterministic structural backbone + anchor-calibrated judge; trusted only when both rank the good anchor above the bad. | 3, quality axis |
| `setup-probe/` | Does a configured model **carry** a whole set-up flow (inbox / invoices / shop), judged on end state? | 3, end-to-end |
| `dk-capture-repro.mjs`, `dk-capture-crossprovider.mjs` | Durable-knowledge capture A/B against a REAL engine, swept cross-provider. | 3, single behaviour |
| `probe-freshness.mjs` | The shared trap for all of the above: a fact already active on the target engine turns a capture probe into a dedup probe. | — |

`types.ts` is **meant** to be the shared type home for this directory
(`DEF-model-fitness-shared-lib`). It is not yet: `replay.ts` and `artefact.ts` each declare
their own `Candidate`, and a provider base URL is spelled out in six files in this directory.
Import from `types.ts` in anything new; de-duplicating what is already here is that row's
job, not a claim this file gets to make in the present tense.
