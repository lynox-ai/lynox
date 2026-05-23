# Corpus

200 synthetic memories across 3 scopes and 4 namespaces, hand-authored so the gold-set for each query is known a-priori.

| File | Scope | Count | Namespaces (k/m/s/l) | Notes |
|---|---|---|---|---|
| `acme.jsonl` | `context:acme` | 80 | ~45/13/12/10 | Fake retail-tech "Acme". 10-15 PostgreSQL-related facts (mem-001..014) make the Postgres queries meaningful. Mix of business + tech + ops. |
| `beta.jsonl` | `context:beta` | 80 | ~40/13/12/15 | Fake B2B SaaS "Beta Inc". Deliberately picks DIFFERENT stack from Acme (MongoDB / GCP / Vercel / Adyen) so scope-bleed is detectable. |
| `personal.jsonl` | `user:me` | 40 | ~20/8/5/7 | First-person user-scope notes. Mostly distinct vocabulary so it doesn't bleed into either company. |

## Why these proportions

- **80/80/40** gives both `context` scopes enough density to support multi-fact queries and the recency-decay test.
- **Acme = Postgres-heavy** is the explicit calibration request: 10–15 facts means a "tell me about Acme's Postgres setup" query has a real multi-hit gold set rather than one trivial answer.
- **createdDaysAgo spread** (1d..90d) covers the namespace half-life scoring in RetrievalEngine. Without backdating, every memory looks 0d old and the recency-decay term is constant.

## Adversarial design (to keep MRR honest)

- Both Acme and Beta have a CTO, CEO, frontend, mobile app, search engine, observability stack, deployment process. The same query text ("Which database does the company use?") returns the right answer ONLY when the retrieval respects the scope filter — that's the scope-isolation test.
- Acme uses Auth0, Beta uses Firebase Auth — same topic, different stacks.
- Personal-scope uses overlapping verbs ("uses", "runs") so token-overlap alone wouldn't sort correctly.
- A few `no-match` queries probe topics not in any corpus (Salesforce Marketing Cloud, quantum supercomputers) so we measure the no-content path too.

## Adding entries

Append a line to the relevant JSONL file:

```json
{"fixtureId":"acme-mem-NNN","namespace":"knowledge|methods|status|learnings","text":"…","scope":{"type":"context","id":"acme"},"createdDaysAgo":14}
```

Then add at least one query in `../queries/catalog.jsonl` that references the new fixture-id in its `expected_topK_ids`.

## Don't

- Don't add real PII or customer-identifiable data — use the Acme / Beta / "me" placeholders.
- Don't duplicate texts across corpora — the bench's scope-isolation test depends on each company having unique facts.
- Don't author queries against fixture-ids that aren't in the corpus — the runner will silently treat them as 0-recall.
