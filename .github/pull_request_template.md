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

**CI cannot verify `gates`, `delta` or `mutations`.** They are your attestation
and they are on the record. The one thing CI does establish by itself is `head`:
it must equal this PR's current head, so **update it after every push**. That is
the difference between "the gates ran" and "the gates ran on THIS code".

- `head` — the SHA the gates ran against: `git rev-parse --short HEAD`
- `gates` — which ran, from: `code-review`, `delta`, `security`, `prd`, `staging-walk`.
  `code-review` and `delta` are required for any code change. `security` is
  required when the diff touches one of the paths the check lists — every module
  under `src/tools/builtin/`, `src/server/`, `data-boundary`, `output-guard`,
  `input-guard`, `permission-guard`, `secret-store`, `migration-crypto`, or an
  integration's auth/oauth. That list is a **floor**: a change can open a trust
  boundary somewhere it does not name, and then the gate is still yours to run.
- `delta` — the verdict of the delta round ON THE FIXES. `clean` or don't merge.
- `mutations` — mutations of the CHANGED LINES, killed vs survived. A survivor
  means no test covers that line and fails the check.

A documentation-only diff needs none of this — delete the block.

```gate-record
head: <short SHA>
gates: <which gates ran>
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

## Notes

<!-- Anything reviewers should know? Breaking changes, migration steps, related issues? -->
