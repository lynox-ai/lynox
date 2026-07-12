# lynox Roadmap

The public-facing slice of what's next for lynox. Strategic details (pricing, business model, go-to-market) live in the private Pro repo; this page is the engineering-and-feature view that an evaluator or contributor needs.

This roadmap is intentionally short and **directional, not a set of dated commitments** — priorities shift as customers and contributors weigh in. The Managed-hosting tier funds the project, so engineering capacity is one full-time maintainer plus occasional help; multi-year speculative roadmaps would be theatre.

---

## next
- Event-driven automation — triggers that fire a workflow on a schedule or when something changes ("when X happens, do Y")
- Connect any API — teach lynox a service once, reuse it everywhere
- Calendar Integration (CalDAV + ICS imports, then create)
- OpenAI Native Provider (first-class, alongside Anthropic + Mistral)
- MCP Client (connect to Smithery catalog + custom servers)
- STT Provider Multiplexing (Whisper / Voxtral / Gladia.io in evaluation)
- OAuth Authorization-Code Callbacks (one-click connect for services that sign in with OAuth)
- Memory that compounds — knowledge carries across every conversation, and stays trustworthy as it grows

## later
- Inbound Webhook Receivers (external events — e.g. Stripe / GitHub / Twilio — trigger workflows)
- Browser Use / Playwright Tool (automate sites without APIs)
- PDF / Image Multimodal first-class (drag-and-drop document understanding)

## under evaluation
- iOS / Android native apps (PWA exists today — gauging demand)

## beyond
(focus is on the items above)

---

## How priorities get decided

In rough order:

1. **Critical bugs in production** — anything that affects the currently-running customer deployments.
2. **Issues that gate the next release.** The release-cut flow has a "no opens that block this version" gate.
3. **Items the maintainer has personally hit** while using lynox for his own business.
4. **Issues with a credible repro** from anyone running lynox.
5. **Strategic features** from this roadmap.

A vocal customer with a real repro outranks a strategic feature most of the time. That's by design — lynox needs to keep working for the people who already trust it before it can scale.

---

## Telling us what to prioritize

[Open an issue](https://github.com/lynox-ai/lynox/issues) with the use case. The roadmap above is the maintainer's best-guess priority; real customers move items up.

GitHub Discussions are also open if you want to think out loud about something before filing an issue: [github.com/lynox-ai/lynox/discussions](https://github.com/lynox-ai/lynox/discussions).
