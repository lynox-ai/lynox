# Model-fitness harnesses

Live measurement scripts for production model slots. Everything verdict-shaped is
exported from testable modules (`replay.ts`, `fast-bench-lib.ts`) and covered by
`tests/model-fitness-replay.test.ts` / `tests/model-fitness-fast-bench.test.ts` —
`scripts/` is outside the tsconfig and vitest includes, so an inline helper would be
neither typechecked nor executed by CI.

API keys for all runners: `ANTHROPIC_API_KEY` / `MISTRAL_API_KEY` / `FIREWORKS_API_KEY`
env vars, falling back to `~/.lynox/config.json`.

## replay.ts — balanced/main-slot wire replay (WS2)

Replays a captured raw agent request against the main-slot candidates and scores
escalate-vs-inline. See the file header. The `ministral-14b` control gate decides the
exit code — a run that does not reproduce the known-fail control is not quotable.

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
  length without a megabyte of literal JSON (the corpus test enforces that literals
  never live in pads, so pad expansion can never affect ground truth).
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
  (DEF-replay-judge-self-family): Anthropic candidates are judged by the
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
