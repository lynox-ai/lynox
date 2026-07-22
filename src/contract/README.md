# `src/contract/` — the core↔pro wire contract (single source of truth)

Everything in this directory is **wire contract**: values and shapes that the
engine (this repo), the web-ui package, and the private control plane
(`lynox-pro`) must agree on because they are parsed off the wire — env vars the
control plane writes into tenant containers, JSON blobs inside them, and (in
later waves) HTTP request/response bodies and the capability boot-marker.

**A change here is never local.** Two consumers compile byte-identical vendored
copies of these files:

| Consumer | Copy | Guard |
|---|---|---|
| web-ui (`packages/web-ui/src/lib/contract/`) | in-repo, currently `vocab.ts` only | every file present there must be byte-equal to its twin here (`tests/contract-drift.test.ts`) |
| control plane (private repo, `packages/managed/src/vendor/contract/`) | SHA-pinned (`CONTRACT.lock`, git tree hash) | required `contract-sync` CI job + a release-path freshness gate | <!-- drift-guard:allow: path lives in the private lynox-pro repo (created by its contract-sync wave) -->

Rules:
- **Dependency-free.** Pure literals, types, and functions only — consumers
  compile these files standalone.
- **Membership**: an item belongs here ONLY if the wire depends on both sides
  agreeing on it. Value-equality alone is not membership; single-owner values
  (budgets, pricing, provider catalogs) stay out.
- **Public-exposure check** per addition: is the downstream detail this
  publishes already public via this repo, or inferable from it? (This repo is
  public; the control plane is not.)
- **No eol-normalization / no `.gitattributes` / no reformatting on this path**
  — the vendored tree-hash equality depends on byte-identical content, so the
  copies keep core's indentation style even inside the tab-indented web-ui
  package. Never run a formatter over a vendored copy.
- Symbols that migrated here are listed in `migrated.ts`; redefining one
  locally anywhere else fails CI (pure re-export shims are the permitted form).

Design + wave plan: `lynox-pro` `docs/internal/PRD-CORE-PRO-CONTRACT.md` <!-- drift-guard:allow: doc lives in the private lynox-pro repo -->
(ROOT A / DEF-0030).
