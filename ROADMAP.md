# lynox Roadmap

The public-facing slice of where lynox is going. This is a **directional outlook, not a commitment** — priorities shift as real usage teaches us what matters. Strategic details (pricing, business model, go-to-market) live in the private Pro repo; this page is the engineering-and-feature view an evaluator or contributor needs.

This roadmap is intentionally short. The Managed-hosting tier funds the project, so engineering capacity is one full-time maintainer plus occasional help — multi-year speculative roadmaps would be theatre.

---

## Shipped

Live today in the current release:

- **Durable Knowledge** — an archival memory tier that keeps facts long-term without the size cap of the working store, with a review queue for anything learned from external content and an in-chat surface to see and correct what lynox remembers. Opt-in per instance.
- **Model choice as a first-class control** — pick the model for a new chat from the composer, set a per-thread execution policy, and the engine enforces your plan's tier ceiling on every path.
- **Provider presets** — one-click tiles for local runtimes and gateways (Ollama, LM Studio, vLLM, LocalAI, Groq, Together AI, Fireworks), each with the endpoint filled in. Tool-calling is verified end-to-end where it's proven, and the tile says so where it isn't — lynox is an agent, and a model that can't call tools can't run it.
- **Portable workflows** — export a saved workflow to a versioned, self-contained format and import it on another instance across a re-consent boundary, so secret references and reachable hosts are re-approved, never trusted implicitly from the file.
- **Provider-agnostic by design** — Anthropic and Mistral are both first-class native; any OpenAI-compatible endpoint connects through the generic tile.

## Building

The current direction — actively in progress, no dates:

- **Named model strategies** — pick a mode (and a hybrid strategy) that combines the strengths of different providers into one setup, instead of hand-wiring a model per tier. Optimized for cost, sovereignty, and context — measured, not asserted.
- **Honest model fitness** — measuring which models are genuinely fit for *agent* work (tool selection, routing, multi-step execution), so lynox can qualify and offer more models on evidence rather than leaderboard rank.
- **Delegated OAuth connectors** — authorization-code callbacks so the agent can connect delegated APIs (Google Workspace and beyond) and pull your data in.
- **MCP client** — connect lynox to external MCP servers and catalogs.
- **Calendar integration** — CalDAV + ICS import, then create.

## Exploring

Directions we're weighing — genuinely uncertain, may change:

- **Per-job specialist routing** — the right model for the job (image understanding, very-large-context ingest, image generation/editing), chosen automatically.
- **Speech-to-text provider choice** — Whisper / Voxtral / Gladia.io under evaluation.
- **Browser use** — automate sites that have no API.
- **Inbound webhook receivers** — external events (Stripe, GitHub, Twilio) trigger workflows.
- **A public model-fitness dataset** — an auto-updating, citable matrix of tool-calling reliability per provider/model.
- **Native mobile apps** — a PWA exists today; we're gauging demand before building native.

---

## How priorities get decided

In rough order:

1. **Critical bugs in production** — anything that affects currently-running deployments.
2. **Issues that gate the next release.** The release flow has a "no opens that block this version" gate.
3. **Items the maintainer has personally hit** while running his own business on lynox.
4. **Issues with a credible repro** from anyone running lynox.
5. **Strategic features** from this roadmap.

A vocal user with a real repro outranks a strategic feature most of the time. That's by design — lynox needs to keep working for the people who already trust it before it can scale.

---

## Telling us what to prioritize

[Open an issue](https://github.com/lynox-ai/lynox/issues) with the use case. The roadmap above is the maintainer's best-guess priority; real usage moves items up.

GitHub Discussions are also open if you want to think out loud before filing: [github.com/lynox-ai/lynox/discussions](https://github.com/lynox-ai/lynox/discussions).
