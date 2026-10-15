# `scripts/guard-patterns/` — guard patterns with one source

A pattern that guards PUBLIC text, or a PR record, and is needed by this repo's CI and by the
private control-plane repo lives here once. The private repo vendors this whole directory
byte-identically, the same way it vendors `src/contract/`: a SHA-pinned lock with git blob
hashes, one sync script, and a check that fails on any difference.

Before this directory existed, the open-findings-count pattern was kept as two hand-maintained
copies. Within a day the copy here had grown five forms the other did not catch.

| File | Used here by | What it finds |
|---|---|---|
| `prose-open-count.mjs` | `scripts/gate-record.mjs` | an open-findings COUNT in a PR body's prose |
| `legal-sign-off.mjs` | `scripts/gate-record.mjs` | whether an `approved:` line is a legal sign-off: an approver from `LEGAL_APPROVERS` and a date |
| `legal-sign-off.cases.json` | `tests/gate-record.test.ts` | the cases both repos' gate records must judge the same |

Rules — the same as for `src/contract/`, because the same lock depends on them:
- **Dependency-free.** No imports at all, not even from this directory or from `node:`; no
  re-exports and no `getBuiltinModule`. The private repo runs these files standalone.
- **No eol normalisation, no `.gitattributes`, no formatter** on this path: the lock compares
  git blob hashes.
- **A change here is never local.** After it merges, the private repo has to sync; until then its
  check reports the copy as behind.
- **Membership:** only a pattern both repos enforce on the same kind of text. A pattern only one
  side uses stays in that side's script.
