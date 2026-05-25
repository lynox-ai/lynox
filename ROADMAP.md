# lynox Roadmap

The public-facing slice of what's next for lynox. Strategic details (pricing, business model, go-to-market) live in the private Pro repo; this page is the engineering-and-feature view that an evaluator or contributor needs.

This roadmap is intentionally short. The Managed-hosting tier funds the project, so engineering capacity is one full-time maintainer plus occasional help — multi-year speculative roadmaps would be theatre.

---

## Currently in main

The state of `lynox/main` at the time of this post (see [CHANGELOG.md](CHANGELOG.md) for the version-by-version history):

- **Engine + Web UI** — chat, knowledge graph, workflow capture, background worker, mail integration, 4 specialized agent roles
- **Multi-provider LLM routing** — Anthropic (primary), Mistral (secondary + fallback profile), any OpenAI-compatible endpoint (Ollama, LM Studio, LiteLLM, Groq, vLLM)
- **Magic-link OTP login** for managed instances (Settings v3)
- **Set-Bench harness** — 220-run public benchmark on agent-loop completion (`core/scripts/set-bench/`)
- **Stripe billing + Customer Portal** on the managed tier (BYOK Hosted / Managed / Managed Pro)

If you're skimming, that's the shipped surface — the rest of this page is "what's next".

---

## Next quarter (Q3 2026)

Three roughly-parallel workstreams. Order is best-effort; if launch traffic surfaces new priorities they'll override.

### MCP Client (self-hosted → managed → remote HTTP)

Finish the half-wired MCP client in core so lynox can talk to user-installed MCP servers (filesystem, shell, custom integrations). PRD is sprint-ready. The previously shipped MCP **server** was removed pre-HN-launch pending re-introduction with full E2E test coverage; see `pro/docs/internal/PRD-MCP-SUPPORT.md`. Three phases:

1. **Self-hosted stdio** — local MCP servers via stdio transport, configured per-instance.
2. **Managed CP plumbing** — managed customers can register MCP server endpoints via the control plane; CP injects credentials.
3. **Remote HTTP** — MCP-over-HTTP transport, so lynox can connect to MCP servers that don't live on the same host.

Self-hosted is the priority — Managed customers can wait for it to land via release.

### Calendar Integration (CalDAV + ICS)

Read-only first (Phase 1a, ~6–8 days), then create (Phase 1b, ~5–7 days). Avoids the Google OAuth verification gauntlet short-term — CalDAV covers iCloud, Fastmail, Nextcloud, and most enterprise calendar setups.

Phase 0 spike already done; library choices locked: `tsdav` for CalDAV, `node-ical` for ICS. UX decisions for Phase 3 are gated on Phase 1 actually shipping — won't over-design upfront.

### Native OpenAI Provider

Today OpenAI works through the OpenAI-compatible adapter (sufficient but doesn't expose prompt caching, reasoning_effort, or structured outputs). Native provider adapter for BYOK + self-host, with first-class prompt caching and `reasoning_effort` parameter. Managed-tier integration deferred — Anthropic + Mistral cover the managed routing today.

Driven by Set-Bench data: `gpt-5.4` fills Mistral's only weak axis (tool-chain), and `o3` ties `magistral-medium` at the opus-tier price/pass point. Having a native adapter unlocks routing to them at lower cost than the adapter path.

---

## Backlog (next 2–3 quarters)

Smaller items where the design is clear but the timing is open. Listed roughly in priority order — the maintainer's actual order may shuffle based on the kind of issues that arrive.

- **STT providers** — multi-provider speech-to-text (Whisper, Voxtral, Gladia). Currently single-provider Voxtral or whisper.cpp.
- **Design-system primitives** — Checkbox, Icon, Scrollbar as proper DS primitives in `packages/web-ui/`. Currently inline-styled in components.
- **Native GA4 + GSC** — Google Analytics 4 + Search Console as built-in data sources, beyond the API-store generic plumbing.
- **STT no-auto-send** — voice transcription goes to the input box, doesn't auto-submit. Settings toggle. Driver: non-English users find auto-send too eager.
- **Ads optimizer** — pluggable feature behind the `ads-optimizer` flag (currently in a worktree branch, default off).

---

## Not on the roadmap (intentionally)

To set honest expectations:

- **Mobile native apps** — the PWA is the mobile story. Native apps duplicate work and lock the user into our update cadence. Not planned.
- **Browser extension** — no plans. The Web UI works, and a browser extension would multiply the auth surface.
- **Enterprise SSO** — out of scope for now. Single-user self-hosted is the model; multi-user belongs on the Managed tier where the team account model can be designed properly.
- **Hosted SaaS at scale** — the Managed tier is "per-tenant container on shared Hetzner host." We're not building a multi-tenant SaaS where one process serves thousands of customers. That's a fundamentally different architecture and we don't think it's better for SMB workloads.
- **AI training on customer data** — never. Customer data is for inference only. This is in the [DPA](https://lynox.ai/dpa) and is not negotiable.

---

## How priorities get decided

In rough order:

1. **Critical bugs in production** — anything that affects the three currently-running customer deployments.
2. **Issues that gate the next release.** The release-cut flow has a "no opens that block this version" gate.
3. **Items the maintainer has personally hit** while using lynox for his own business.
4. **Issues with a credible repro** from anyone running lynox.
5. **Strategic features** from this roadmap.

A vocal customer with a real repro outranks a strategic feature most of the time. That's by design — lynox needs to keep working for the people who already trust it before it can scale.

---

## Telling us what to prioritize

[Open an issue](https://github.com/lynox-ai/lynox/issues) with the use case. The roadmap above is the maintainer's best-guess priority; real customers move items up.

GitHub Discussions are also open if you want to think out loud about something before filing an issue: [github.com/lynox-ai/lynox/discussions](https://github.com/lynox-ai/lynox/discussions).
