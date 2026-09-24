# lynox model-fitness

Instruments that answer **"is this model fit for lynox, and for which tier?"** — not
generic benchmark rank. Fitness is scored on the capability-critical points lynox's OWN
tools and prompt discipline depend on.

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
comparison ran on a real captured request, and the slot moved because of it. That episode is
recorded in this repository, not only in the argument — `src/types/models.ts`
(`MISTRAL_MODEL_MAP`) and `src/core/tier-presets.ts` both carry it, the second explicitly as
evidence it no longer accepts. The screen was not wrong to exist; it was read as a verdict,
and that is what this ladder prevents.

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

**Cost:** the run prints its own arithmetic at startup. It counts CASE RUNS, and a case is a
tool loop, so the API calls are a multiple of it. `--provider` chunks a run, because Mistral
429-backoffs and judge latency compound over a full roster.

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

`TIER_JOBS` is the coverage index — ✓ = a case exists, ○ = a job no case covers yet.
The ✓ is a hand-typed `covers` pointing at a case
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
checked before any behaviour is *judged* — but not before it is *run*: a sub-floor candidate
still executes every case and only then fails the gate. Only the per-job `minContext` below
actually skips work. Free, deterministic, and the one gate that needs no rung-3
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

The τ-bench triad adapted to lynox, run with `--scenarios`. Twelve scenarios today, and the
triad is the design rather than a description of all twelve — counted, because the sentence
that used to stand here claimed all three parts for every one of them:

1. **a realistic multi-step task** (not a single call) — all twelve;
2. **a simulated user** — a cheap fixed model answering the agent's `ask_user` clarifications
   from a persona and goal, so the information the task needs lives in the *user's head* and
   the model must ASK for it. **One** scenario wires this (`mail-reply-signoff`); the rest
   pass a callback that only approves permission dialogs, because their task is
   self-contained by design;
3. **a state-based assertion** — the scenario's tools mutate a shared `state` and the assert
   checks the END STATE (deal advanced? task created? mail drafted with the right amount?),
   not the words. **Nine** of twelve assert on state alone. Two more assert on state *and* on
   the answer text (`data-import-answer` wants three rows AND the right month;
   `research-multihop` wants two fetches AND the right figure in the reply). One —
   `balanced:conversation-quality` — has no state at all and rests entirely on the judge's
   score. That last one is where the assertion is weakest, so it is named here rather than
   averaged into a claim about all twelve.

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
the other two are not wired to anything yet.

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

**Never a `-latest` tag** — it resolves to whatever the provider ships today and carries the
shallow rate limits. A dated snapshot is preferred where the provider offers one;
nine of the fifteen ids in the roster carry no date today, so the rule is the `-latest`
prohibition, not a claim that every id is dated.

## Where the run findings live — deliberately not here

Measured results are recorded where they are maintained, not in this
file. A dated table in a standing README goes stale in days, and this one did: its
`language-fidelity` finding was an artifact of that case's **own German system prompt**
biasing every model German. The case was fixed the same week — `capabilities.ts` now uses an
English prompt with a German recalled-memory block, which is the real language-leak class —
while the README kept reporting the artifact. Four of that round's new cases turned out to
have measurement bugs rather than model failures; **every strong-model-fails-weak-model-passes
inversion was the instrument** (`fb_measure_pixel`). Treat an inversion as a bug report
against the harness until proven otherwise.

## Where this sits among the repo's benches

Two directories compare MODELS against each other, and which one to reach for was written
down in one of them and nowhere in the other. (Other directories under `scripts/` evaluate
parts of the system rather than picking a model — `kg-bench`, `kg-eval`,
`agent-efficiency` — and are out of scope here.)

| Directory | The question it answers |
|---|---|
| `scripts/set-bench/` | Cross-provider, tool-using benchmark — the suite behind the published bench page, and where `CONTRIBUTING.md` sends a contributor adding a scenario. |
| `scripts/model-fitness/` (here) | Is a model FIT for lynox's own jobs, and for which tier — measured on lynox's own tools and prompt discipline, not on a generic task set. |

They answer different questions — a *rank* against a *fit verdict* — and the failure mode
this table exists against is not duplication but reaching for whichever one is open in the
editor.

A third, `scripts/bench-models/`, was retired in 2026-09. <!-- drift-guard:allow: the path is named precisely because it no longer exists; a reader who remembers the directory needs to know it was removed rather than moved --> It ran a Claude-only
effort/thinking Pareto sweep and had been labelled legacy since June, which is the state
this table was written to end: a directory kept alive by a label rather than by a question
somebody still asks. Nothing here inherited its scope — a single-provider sweep is simply
not a question being asked any more. Its history is in the log.

## The other instruments in this directory

| File | Question it answers | Rung |
|---|---|---|
| `replay.ts` | Which model handles a **real captured request** best (escalate-vs-inline)? | 3 — the verdict |
| `prompt-ab.ts` | Does a **prompt edit** change behaviour, measured on the real surface? | 3, prompt axis |
| `fast-bench.ts` | Does a cheaper model still write a usable **compaction summary** — measured on the production prompt against planted ground truth? | 3, fast slot |
| `fast-classify-replay.ts` | Does it still **classify inbox mail** correctly, replayed from captured requests? | 3, fast slot |
| `artefact.ts` | Artefact QUALITY (R9) — deterministic structural backbone + anchor-calibrated judge; trusted only when both rank the good anchor above the bad. | 3, quality axis |
| `setup-probe/` | Does a configured model **carry** a whole set-up flow (inbox / invoices / shop), judged on end state? | 3, end-to-end |
| `dk-capture-repro.mjs`, `dk-capture-crossprovider.mjs` | Durable-knowledge capture A/B against a REAL engine, swept cross-provider. | 3, single behaviour |
| `probe-freshness.mjs` | The shared trap for all of the above: a fact already active on the target engine turns a capture probe into a dedup probe. | — |

`types.ts` is **meant** to be the shared type home for this directory. It is not yet: `replay.ts` and `artefact.ts` each declare
their own `Candidate`, and a provider base URL is spelled out in six files in this directory.
Import from `types.ts` in anything new; de-duplicating what is already here is that row's
job, not a claim this file gets to make in the present tense.


## The rule these runners follow

Everything verdict-shaped is exported from a testable module (`replay.ts`,
`fast-bench-lib.ts`, `grid.ts`) and covered under `tests/` — `scripts/` is outside
both the tsconfig and the vitest include, so an inline helper here would be neither
typechecked nor executed by CI. A decision that lives only in a script is a decision
nothing checks.

API keys for every runner: `ANTHROPIC_API_KEY` / `MISTRAL_API_KEY` /
`FIREWORKS_API_KEY` from the environment, falling back to `~/.lynox/config.json`.
Those two are not always the same value — a stale copy in one of them produced a 401
that looked like a missing key and cost an hour (2026-09-23).

### `replay.ts` — the control gate decides the exit code

It replays a captured raw agent request against the main-slot candidates and scores
escalate-vs-inline (details in the file header). What is worth repeating here: a
known-fail control model gates the run, and **a run that does not reproduce that
control is not quotable**. A harness that cannot fail on a case it is supposed to
fail on is not measuring — the same discipline the corpus caveat below applies to the
fast slot.

## What the corpus guarantees, and what it does not

Measured 2026-09-24, before trusting any number out of `fast-bench.ts`, because a
checklist is the instrument and therefore the first suspect.

**It guarantees** that no planted literal lives ONLY inside a pad: the corpus test
asserts every literal occurs in hand-authored transcript text, so a literal that
exists nowhere the candidate can read cannot silently cap recall for every model.

**It does not guarantee** the stronger thing an earlier version of this page claimed —
that pad expansion "can never affect ground truth". Expanding every pad in the shipped
corpus and matching it the way the scorer matches: **10 of 104 literals also occur in
the filler**. None as a whole token any more — the one that was (`180` in `t08`) is
now planted as `180d`, the form the transcript carries, and an assertion keeps that
class out. The remaining ten are reachable only as a SUBSTRING of a longer pad token.
For those, a summary that quotes filler scores a hit without having retained the
planted fact — two different things producing the same check result, which is the
failure mode a checklist exists to avoid.

Mostly short numerics, and the fix is a property of the CORPUS rather than of the
scorer: a planted literal has to be distinctive enough that generated noise cannot
supply it. Until that holds, read a recall figure as an upper bound.

## fast-bench.ts — FAST-slot compaction benchmark (P3)

The fast slot does no conversation: it writes compaction summaries
(`Session.compact()`, `compaction_model ?? 'fast'`), classifies inbox mail, and
recovers follow-up chips. This bench measures the summarizer job:

- **Corpus**: 12 hand-authored stress transcripts in `fast-corpus/*.json`, mirroring
  real lynox thread FORM — tool_use/tool_result blocks, long tool outputs, DE+EN
  mixed, topic switches, masked-secret placeholders, 20k-80k tokens expanded. Every
  transcript carries a PLANTED ground-truth checklist: `literals` (paths/ids/amounts a
  correct summary MUST contain) and an 8-element judge `rubric`
  (decisions/context/next-steps). Contents are fictional (no real customers). The
  conversational spine and every planted fact are hand-written `text` blocks;
  `pad` blocks deterministically expand seeded log/table noise to reach real thread
  length without a megabyte of literal JSON (the corpus test enforces that no literal lives ONLY in a pad — see the
  caveat under *What the corpus guarantees* below, which is narrower than it sounds).
- **Prompt**: the EXACT production summarizer prompt, imported from
  `src/core/compaction-prompt.ts` (extracted from `Session.compact()` so it cannot
  drift from what production sends).
- **Scoring**: (1) mechanical literal recall — contained or not, no LLM. The
  matcher folds formatting, not content: digit-group separators (`48'200'113` ==
  `48,200,113`), slash/percent spacing, typographic quotes/dashes. A checklist
  literal may be an ANY-OF array of variants for content a summarizer
  legitimately re-renders (`["24 von 31", "24 of 31", "24/31"]`); the first
  variant is canonical and must occur in the transcript. (2) an 8-element rubric
  judged by a DEEP model that never shares a model family with the candidate
  (a judge scores its own family higher): Anthropic candidates are judged by the
  Fireworks deep slot (glm-5p2) and vice versa. The judge budget is 8192 tokens —
  1024 made glm-5p2 (a reasoning model) burn the whole budget on its hidden
  reasoning phase and return an empty verdict (run 2026-08-09T21-18: 19/24
  reference rows judge-INVALID with stop_reason max_tokens).
- **Served-model guard, three states**: `verified` / `unreported` / `mismatch`.
  Only a MISMATCH (positive substitution evidence) invalidates a run.
  `unreported` is the structural norm for every openai-wire candidate — the
  `OpenAIAdapter` emits `model: ''` and drops the wire's model field — so a
  fail-closed boolean would invalidate 5 of 6 candidates by construction
  (observed 2026-08-09). Degraded providers are caught instead by the
  **input-sanity tripwire**: a reported input-token count under 5% of the
  transcript's known size (e.g. `tok in=1` from a suspended account) marks the
  run invalid — the model cannot have seen the thread.
- **Decision rule (P3)**: a candidate HOLDS the fast slot iff literal recall ≥ 95%
  AND its judge mean is within-noise of the haiku-4.5 reference
  (noise = max(reference std, 0.5 rubric points)). **Bar resolvability**: if the
  REFERENCE itself misses the 95% bar, every verdict is INVALID with an explicit
  "recalibrate the checklist" reason — a bar the current prod model cannot reach
  measures the checklist, not the candidates.
- **Aggregation**: means over VALID rows only; an aggregate goes invalid when
  fewer than half its rows are valid — a transient 412 burst must not zero an
  otherwise-measured matrix, and an outage must not be quoted as a measurement.
- **Preflight**: refuses to run if any planted literal does not occur in its
  transcript or any transcript misses the 20k-80k band — a broken instrument returns
  a plausible number with no symptom, so it must not run at all.
- **Offline re-judge**: rows persist the candidate summary and the raw judge
  reply, so `--rejudge <results.json>` re-scores stored summaries (recall re-runs
  free against the current checklist/matcher, only judge calls are paid) —
  a matcher/checklist/judge fix is re-measurable for cents instead of a full
  $10-20 pass. Only works on results files that stored summaries (all runs from
  2026-08-09 evening on).

```bash
npx tsx scripts/model-fitness/fast-bench.ts                 # full matrix, 2 runs each
npx tsx scripts/model-fitness/fast-bench.ts --runs 3
npx tsx scripts/model-fitness/fast-bench.ts --only deepseek # reference is force-included
npx tsx scripts/model-fitness/fast-bench.ts --transcript t01
npx tsx scripts/model-fitness/fast-bench.ts --rejudge scripts/model-fitness/results/fast-bench-<ts>.json
```

Output: Markdown matrix + JSON under `scripts/model-fitness/results/` (gitignored
artifacts of a paid run — quote the md, keep the json).

Cost note: a full pass is 12 transcripts × 6 candidates × runs × (20k-80k input
tokens) plus judge calls — budget $10-20.

**Known fidelity gap** (documented, deliberate): the bench sends a minimal system
frame, not the full agent system prompt an in-engine compaction run carries. The
transcript preload is the real thread form; closing the system-prompt gap needs a
raw-sink capture of a real compaction turn (below) replayed through this same
scorer — planned once captures exist.

## fast-classify-replay.ts — FAST-slot classification replay

Replays CAPTURED tier=fast request bodies against the same candidate set and scores
each reply against the KNOWN correct classification, parsed through the REAL
production parser (`parseClassifierResponse` — same fail-closed semantics production
has). Decision rule: ZERO missed `requires_user` (the asymmetric-risk miss: a mail
the user had to act on, silently swallowed) AND accuracy within noise of the
haiku-4.5 reference.

```bash
npx tsx scripts/model-fitness/fast-classify-replay.ts \
  --captures ~/captures/fast-bodies --labels ~/captures/labels.json [--runs N]
```

Labels file shape:

```json
{ "entries": [
  { "file": "raw-<runid>-t0-<ts>.json", "expected": "requires_user" },
  { "file": "raw-<runid>-t1-<ts>.json", "expected": "auto_handled" }
] }
```

The runner exists ahead of the data: the measurement itself happens once captures
are pulled.

### How to pull tier=fast captures (raw wire sink)

The engine's raw-body sink (`src/core/wire-capture.ts`) writes the FULL, unredacted
assembled request of every agent-level LLM call when its gate file exists. It is
**dev/staging-eval only, on your OWN instance** — the raw body contains the secrets
catalog, memory blocks and KG, and the sink refuses outright on a provisioned
instance (`captureRefused`).

1. Enable the gate on the dev/staging engine (default gate path is
   `<dataDir>/wire-sink-raw-on`; both paths are overridable):

   ```bash
   touch "$LYNOX_DATA_DIR/wire-sink-raw-on"       # or LYNOX_DEBUG_WIRE_RAW_GATE_FILE=...
   # bodies land in <dataDir>/wire-sink-raw/       (or LYNOX_DEBUG_WIRE_RAW_SINK=...)
   ```

2. Drive the surface you want to measure so tier=fast calls happen:
   - compaction summaries: run `/compact` on a long thread (the summarizer runs on
     `compaction_model ?? 'fast'`),
   - inbox classification: let the inbox classifier process mail on a fast-tier
     configuration.

3. Collect `raw-*.json` files whose `model` field is the fast-tier model, copy them
   OFF the instance into a local captures dir, and **remove the gate file**:

   ```bash
   rm "$LYNOX_DATA_DIR/wire-sink-raw-on"
   ```

4. Write the labels file: for classification bodies the ground truth is the KNOWN
   correct bucket for that mail (from the triage ground-truth set, or hand-labeled).

Captures contain unredacted personal data — keep them out of every git repo.
