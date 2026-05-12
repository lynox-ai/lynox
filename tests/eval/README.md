# core/tests/eval

LLM-eval scaffolding that lives outside the standard `vitest run` budget. Eval suites measure model behavior against committed ground-truth fixtures; they're slow, cost real money, and need provider credentials, so they MUST NOT run on every CI commit.

## Convention

| File | Purpose |
|---|---|
| `<feature>-eval.test.ts` | Real-LLM eval. `describe.skip` gate fires unless `LYNOX_EVAL=1` and the provider api-key are set, so default `vitest run` is a no-op. |
| `<feature>-runner.ts` | Pure library — the eval algorithm, no vitest, no LLM coupling. Both the eval-test and the runner-contract-test consume this. |
| `<feature>-runner.test.ts` | Stubbed-LLM contract test for the runner. Pins the confusion-matrix bookkeeping + per-category shape without burning tokens. Runs in every `vitest run`. |
| `<feature>-fixtures.json` | Gen-once-commit ground-truth. Re-run the generator only when the prompt or model bumps invalidate the corpus. |

## Gating

`-eval.test.ts` files self-skip when env isn't set. To run them locally:

```bash
LYNOX_EVAL=1 \
  MISTRAL_API_KEY=$(jq -r .mistral_api_key ~/.lynox/config.json) \
  npx vitest run tests/eval/inbox-classifier-eval.test.ts
```

The `-runner.test.ts` companion runs in every `vitest run` (no LLM, just shape tests).

## Fixture generation (gen-once-commit)

Generators live in `core/scripts/<feature>-eval-gen.ts`. They:

1. **Phase 1**: generate synthetic samples per category, no labels yet.
2. **Phase 2**: re-read each sample in fresh context and emit the ground-truth label. Separation prevents "cheat-and-match" where the generator emits the label it just decided on.
3. **EU pin**: per the lynox positioning, fixture-generation runs through the **Mistral EU** caller (no US-egress for synthetic mail content that mirrors real customer data shapes). Set `LYNOX_INBOX_LLM_REGION=eu` + `MISTRAL_API_KEY`.
4. **Anti-PII lint**: `scripts/<feature>-eval-lint.ts` greps the generated corpus for placeholder-only names (`Mustermann` / `Acme` / `example.com` allowed). `lynox.cloud` or real first-name+last-name pairs that match a CRM contacts pattern fail the lint — the operator reviews + manually replaces before merging the fixture file.

Re-running the generator overwrites the committed JSON. Do this only when:
- the production prompt changes (`core/src/integrations/inbox/classifier/prompt.ts` bump),
- the model id changes (`CLASSIFIER_VERSION` in `classifier/index.ts`),
- the bucket-set evolves (PRD design change).

## Why eval lives in `tests/` not `scripts/`

Vitest's discovery pattern picks up `tests/**/*.test.ts` and `tests/**/*.eval.ts` — keeping eval next to unit tests means the same test runner reports both, with the same junit/json output shape. CI's normal job uses the default file mask (`*.test.ts`); the eval job opts in explicitly.
