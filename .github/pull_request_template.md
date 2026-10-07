## Summary

<!-- What does this PR do? Keep it brief. -->

## Changes

- 

## Test plan

- [ ] Existing tests pass (`npx vitest run`)
- [ ] New tests added (if applicable)
- [ ] Tested manually

## Deploy impact

- [ ] No Docker/container changes
- [ ] Requires staging validation before release
- [ ] Database migration needed

## Gate record

Required by the `gate-record` check for any PR that changes code. **Every field
below ships as a placeholder the check REJECTS** — filling one in has to be a
deliberate act, because a template that pre-fills its own answers turns the whole
thing into a ritual you satisfy by pasting a SHA.

**CI cannot verify that `gates`, `review`, `delta` or `mutations` are TRUE** — it checks their
value, not that the work happened: an unknown gate name is always rejected, and a
`delta` that is not `clean` or a surviving mutant are rejected wherever a delta round
was owed (a markdown-only legal change owes none). They are your attestation and they
are on the record. `head` is the **load-bearing** check: it must equal this
PR's current head, so **update it after every push**. That is the difference between
"the gates ran" and "the gates ran on THIS code". CI also establishes on its own which
gates the diff OWES, derived from the real file list, so leaving out a required
`security` or `legal` is caught rather than attested.

- `head` — this PR's **current** head, which is also the SHA the gates ran against:
  `git rev-parse --short HEAD`. Update it after every push.
- `gates` — which ran, from: `code-review`, `delta`, `security`, `prd`, `staging-walk`, `legal`.
  `legal` is required for `SUBPROCESSORS.md`, the one binding text `LEGAL_PATHS` covers, and
  then the record also needs `approved: <who> <YYYY-MM-DD>`, naming who signed off on the
  WORDING. A binding customer text does not ship on an assistant's judgement, and a name
  without a date cannot be told apart from a sign-off carried over from an earlier revision.
  `code-review` and `delta` are required for any code change. `security` is
  required when the diff touches one of the paths the check lists — every module
  under `src/tools/builtin/`, `src/server/`, `src/integrations/`,
  `data-boundary`, `output-guard`, `input-guard`, `permission-guard`,
  `resolve-tools` (the one exit every tool grant to a child passes through),
  `secret-store` or `migration-crypto`. That list is a **floor**: a change can
  open a trust boundary somewhere it does not name, and then the gate is still
  yours to run. It reaches wider than it strictly must, on purpose — too narrow
  fails open, too broad costs one gate run.
- `review` — what the `code-review` round FOUND, which is the one thing `gates:` cannot
  say. `<n> <model> <round|rounds>, <result>`, where the result is `no findings` or
  `<N> findings, <breakdown>`; the breakdown is `all fixed` or counts that **sum to N**:
  `3 fixed` · `2 fixed, 1 filed` · `3 fixed, 1 filed, 1 refuted`. A finding is fixed in
  this diff, **filed** as a register row, or **refuted** on inspection — the third slot
  exists because a format that cannot say "checked and rejected" forces a lie. The model
  is the one that RAN the round (your own, if you reviewed it yourself). Why it is
  mandatory: a PR once listed `code-review` with no round behind it, the check went green
  because the line was there, and the review — run late — found five things, four with
  code effect.
- `delta` — the verdict of the delta round ON THE FIXES. `clean` or don't merge.
  `clean` does **not** mean the round found nothing — a round that found things and
  handled them is clean. It means: nothing it found is left unhandled (fixed here, or
  filed as a register row — **not** listed in `closes:`, which names rows this PR
  *settles*), and it ran at the head above. No exception: every fix makes a new head,
  so it is fix, re-run, attest, and it ends when a round finds nothing.
- `mutations` — mutations of the CHANGED LINES, killed vs survived. A survivor
  means no test covers that line and fails the check.

A documentation-only diff needs none of this — delete the block. (A binding text is
NOT documentation for this purpose: `SUBPROCESSORS.md` is markdown, and it is the
document the managed DPA points customers at, so it needs the `legal` gate and an
`approved:` line naming who signed off on the wording and when. `delta` and `mutations`
are dropped for a markdown-only legal change: there is no delta round to report, and a
fabricated line is worse than none.)

```gate-record
head: <short SHA>
gates: <which gates ran>
review: <n> <model> <round|rounds>, <result>
security: <origin>, <result>
delta: <clean?>
mutations: <n> killed, <n> survived
closes: <DEF-… ids this PR settles, or none>
```

**`closes:` is required, and `none` is a valid answer.** That is deliberate: an
optional field is missing both when a PR settles no register row and when its
author was in a hurry, so nobody can tell those apart afterwards — which is how
two rows sat at `open` for four days after their fix merged, and how a query for
"which merged PR closed this row" comes back empty. Writing `none` costs four
characters and makes the silence a statement.

**`security:` is only due when the diff touches the security path map**, and its
first half says WHERE the round came from, not what it asked. Three origins,
and the third is a full answer rather than an admission:

- `security: own round, no findings`
- `security: leaning on the v1/v2 parity run, no findings` — a round run for
  another question, which is a different claim and should read as one
- `security: origin unclear, findings filed privately` — **use this when you do
  not know whether the round was yours.** Writing `own round` instead is the lie
  the field exists to prevent; one PR on record carried the gate on a parity
  run whose brief was behavioural equality, and only a question caught it.

A `leaning on …` reference carries no comma: the comma separates origin from
result. The result half is the same grammar as `review:`.

**⛔ THIS REPO IS PUBLIC, so neither field counts findings that are still open.**
Write `findings filed privately` — the number belongs in the private register
row. A security finding that is not yet closed must not be named in public
text, and that includes its mere EXISTENCE, which is what a `filed` count
states. The rule binds the
FIELD, not the gate: it applies whether the diff owes `security`, merely lists
it, or just carries the line, and the count is refused anywhere in the value —
including inside a `leaning on …` reference. `review:` is read the same way
whenever security is in play at all, because the same findings are routinely
counted in both halves and the two numbers are then one set, not two.

Still allowed, and deliberately: `no findings`, `<N> findings, all fixed`, and a
`<N> filed` in `review:` on a diff with no security dimension — a filed CODE
defect is not a security finding, and hiding those would cost measurability for
nothing.

⚠ The example above USED to read `1 finding, 1 filed`, so a template reader
produced the very thing the rule forbids. If you are reading this in an old
checkout, the field grammar changed under you and the check will say so.

## Notes

<!-- Anything reviewers should know? Breaking changes, migration steps, related issues? -->
