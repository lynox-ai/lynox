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

<!--
Required by the `gate-record` check for any PR that changes code. Fill it in when
the gates are done, not before — and UPDATE `head:` after every push, because the
check compares it against the PR's current head and goes red when they diverge.
That is the whole point: it is the difference between "the gates ran" and "the
gates ran on THIS code".

  head       the SHA the gates were run against (`git rev-parse --short HEAD`)
  gates      which ran: code-review, delta, security, prd, staging-walk.
             `code-review` and `delta` are required for any code change;
             `security` is required when the diff touches a trust boundary
             (data-boundary, permission-guard, secrets, the HTTP server, spawn).
  delta      the verdict of the delta round ON THE FIXES — must be `clean`
  mutations  how many mutations of the CHANGED LINES were killed vs survived.
             A survivor means no test covers that line, and fails the check.

A documentation-only diff needs none of this — delete the block.
-->

```gate-record
head: 
gates: code-review, delta
delta: clean
mutations: 0 killed, 0 survived
```

## Notes

<!-- Anything reviewers should know? Breaking changes, migration steps, related issues? -->
